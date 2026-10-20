# Fully serverless on AWS: design and cost estimate (2026-10-20)

How inpx-shelf could run on AWS without servers (Lambda, managed storage, S3), how many resources it takes and
what it costs for a single user who opens the library once a week for 60 minutes. Nothing here is built or
measured; prices are us-east-1 list prices as known on this date, check them in the AWS Pricing Calculator.

## Starting point

- Libraries can already live in S3 (`server/core/S3Fs.js`, see `s3-library-2026-10-16.md`).
- The Fargate setup (`docs/docker.md`) keeps `DATA_DIR` on EFS and the cache on the task's ephemeral disk.
- The rest assumes one long-lived process: a WebSocket API, in-process locks over JSON files, timers, a local
  disk cache.

## What breaks on Lambda and the replacement

| Today | Problem on Lambda | Replacement |
|---|---|---|
| WebSocket API (`WebSocketController.js`, `WebSocketConnection.js`) | Lambda holds no long connection | HTTP `POST /api {action, ...}`. The protocol is already request/response (`requestId`), the server never pushes. API Gateway WebSocket API works too, but splits connection handling and adds resources |
| `reading-lists.json`, `kobo-sync.json`, `config.json`, `secret.key` in `DATA_DIR`, guarded by an in-process lock | Several instances write at the same time | S3 backend for `FilePersistence` with conditional writes (`If-Match` ETag, retry on 412), cached copies revalidated by ETag; reserved concurrency of about 5 |
| `state.sqlite` (sessions, prepared files, KOReader hashes) | Must not be opened by two instances | One DynamoDB table, on-demand |
| `library.sqlite` | Read-only between rebuilds, rebuildable | Built by a separate import Lambda (about 90 s for 708k books, 15 min limit) and stored in S3; the app Lambda downloads it to `/tmp` (up to 10 GB) on cold start, roughly 5-15 s per GB |
| Book and cover cache on disk, `CacheCleaner` | `/tmp` is per instance and short-lived | S3 prefix with a lifecycle expiration rule (replaces the cleaner), served by CloudFront |
| Converters (`fbc`, MuPDF, `dwebp`) | none | Fit in a container image (up to 10 GB) |
| Timers (INPX check, cache cleaning, shelf refresh) | The instance is frozen between requests | EventBridge Scheduler, or checks on cold start |
| Work continued after the reply (fire-and-forget) | Frozen after the reply | Finish before replying or invoke asynchronously |
| Web app unpacked to disk and served by `static.js` | none, but wasteful | Static files in S3 behind CloudFront |
| Large downloads | Buffered response limit 6 MB | Redirect to a presigned S3 URL of the prepared file, or response streaming |

Runtime: container image with AWS Lambda Web Adapter (the Express server runs unchanged), arm64, 3-4 GB
memory, Function URL behind CloudFront.

Rejected:

- **EFS for `DATA_DIR`.** No code change, but Lambda mounts EFS only inside a VPC, and the app needs the internet
  (Wikidata, Telegram, email, Kobo store proxy, release check). A NAT gateway costs about $33/month plus
  $0.045/GB, more than everything else together.
- **Aurora Serverless v2.** Scales to 0 ACU, but resumes in about 15 s, needs a VPC, and would mean rewriting the
  synchronous SQLite layer (`CatalogIndex*.js`). For a read-only rebuildable DB, SQLite in `/tmp` fits better.

## Resources

| # | Resource | Purpose |
|---|---|---|
| 1 | S3 bucket: library (exists) | INPX and archives |
| 2 | S3 bucket: data (versioning) | User JSON files, built `library.sqlite`, backups |
| 3 | S3 bucket: web and cache (lifecycle) | Static client, prepared books, covers |
| 4 | DynamoDB table | `state.sqlite` contents |
| 5 | ECR repository | Lambda image |
| 6 | App Lambda + Function URL | Web app, OPDS, Kobo, reader |
| 7 | Import Lambda | Builds `library.sqlite`; on INPX upload or on schedule |
| 8 | EventBridge Scheduler schedule | INPX check, shelf refresh |
| 9 | CloudFront distribution + 2 Origin Access Controls | One HTTPS origin: static, cache, `/api`, `/opds`, `/kobo` |
| 10-11 | 2 IAM roles with policies | One per function |
| 12-13 | 2 CloudWatch log groups | Logs |
| optional | ACM certificate, Route 53 zone and record, AWS Budgets alarm | Custom domain, cost guard |

About 13 core resources; 20-25 as CloudFormation/CDK/Terraform resources once policies, OACs, cache policies and
Lambda permissions are counted. No VPC, no NAT, no database server.

## Cost: one user, 60 minutes once a week

Assumptions: 4.3 sessions a month; per session about 600 API calls of 300 ms at 3 GB, one cold start and 10
conversions, about 1,200 GB-s; one import a week. Library archives about 500 GB (Flibusta-sized, assumed),
`library.sqlite` 1-2 GB (not measured).

| Item | Per month |
|---|---|
| Lambda, app and import (about 5,000 GB-s) | about $0.10, inside the always-free 400k GB-s |
| Function URL, CloudFront, data out | $0 (CloudFront free tier: 1 TB, 10M requests) |
| DynamoDB on-demand, under 1 GB | about $0 |
| S3 data and cache, 3-5 GB, requests | about $0.10 |
| ECR image, 0.5-1 GB | $0.05-0.10 |
| CloudWatch Logs | about $0.05 |
| **Everything except library storage** | **$0.30-0.50** |
| Library 500 GB, S3 Standard | $11.50 |
| Library 500 GB, S3 Intelligent-Tiering after 90 days (Archive Instant Access) | $2-3 |
| Route 53 hosted zone (optional) | $0.50 |

Total: about $3/month with Intelligent-Tiering, about $12/month on S3 Standard. Library storage dominates;
compute costs cents. For comparison, an always-on Fargate task (1 vCPU, 2 GB) with EFS is about $30/month.

Side effects: the first request of a session waits 5-15 s for the cold start. Kobo devices sync outside the
weekly hour as well, which adds a few cheap invocations.

## Effort

Medium: HTTP transport instead of WebSocket (useful without Lambda too), an S3 backend with conditional writes
for user data, a DynamoDB backend for `state.sqlite`, the S3 cache with presigned redirects, the import Lambda
split out, and the infrastructure template. Search and import code stay as they are.
