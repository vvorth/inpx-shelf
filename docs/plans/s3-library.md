# Plan: library on S3 (optional backend)

Written 2026-10-16. Status: step 0 (spike) done, step 1 next.

**Goal.** A library source whose path is an S3 URI (`s3://bucket/prefix`) is read straight from S3:
the INPX, the book archives, and the library's asset folders (covers, illustrations, author info, reviews).
Any other path keeps today's file access, unchanged. This is an additional backend, not a replacement.

**Target deployment.** A container on AWS Fargate. There is no FUSE, so `rclone` and `mountpoint-s3`
are out. `dataDir` sits on EFS; caches sit on ephemeral storage.

**Accepted constraints.**
- The library is read-only. Nothing writes to `libDir`.
- Solid 7z archives cost a read of the whole solid block that holds the book. This is accepted.
- The first read of a book costs a few ranged GETs. After that, `bookDir` serves it.

## Design

### 1. Backend selection: `server/core/LibraryFs.js`

One module with the file operations the library code uses today. A path that starts with `s3:/` goes
to S3; any other path goes to `fs-extra`, unchanged.

| Function | Local | S3 |
|---|---|---|
| `pathExists(p)` | `fs.pathExists` | `HeadObject`, falling back to `ListObjectsV2(prefix=p/, MaxKeys=1)` for a "directory" |
| `readdir(p, {withFileTypes})` | `fs.readdir` | `ListObjectsV2(prefix=p/, delimiter=/)`, paginated; `CommonPrefixes` → dirs |
| `stat(p)` | `fs.stat` | `HeadObject` → `{size, mtimeMs, etag, isDirectory()}` |
| `readFile(p)` | `fs.readFile` | `GetObject` (small files only: reviews, author info) |
| `readRange(p, offset, length)` | `fs.promises.open` + `read` | `GetObject` with `Range` |
| `copyToLocal(p, out)` | `fs.copy` | stream `GetObject` to `out` (loose book files not in an archive) |
| `contentHash(p)` | sha256 of the file (today's behaviour) | `etag + ':' + size` from `HeadObject` |

- Listings and HEAD results are cached in memory. The library is read-only, so the cache is dropped
  only by the periodic INPX check (`WebWorker.periodicCheckInpx`) or by a restart.
- **Path pitfall:** `path.join('s3://b/x', 'y')` returns `s3:/b/x/y`. `LibraryFs` must accept both
  `s3://` and `s3:/`. `path.resolve` on an S3 path is wrong: guard `LibraryAssets.js:701`.
- **Client:** `@aws-sdk/client-s3`, using the default credential chain (Fargate task role).
  Endpoint and region come from the standard env vars (`AWS_REGION`, `AWS_ENDPOINT_URL_S3`).
  One config flag, `s3.forcePathStyle`, covers MinIO and R2.
- Check that `pkg` bundles the SDK (`npm run build:linux`). The SDK is loaded lazily, only when an S3
  path is configured.

### 2. INPX

The raw INPX is read only in three places. The SQLite catalog serves everything else.

1. **Change check:** `InpxHashCreator.getHash` runs at startup and every `inpxCheckInterval`
   (60 min by default). Today it computes a sha256 over the whole file. On S3, use `contentHash`
   (a HEAD request) instead.
2. **Rebuild:** `InpxParser.parse` reads the INPX through `ZipReader` and runs only when the hash
   changes. On S3 it goes through the archive path below, with no download.
3. **Remote libraries:** `WebWorker` `get-inpx-file` (`WebWorker.js:1599`) sends the INPX to a remote
   instance. Use `LibraryFs.readFile` here.

There is no local copy of the INPX. A multipart re-upload of identical content changes the ETag and
causes one unnecessary rebuild. This is acceptable.

### 3. Archives: S3-backed file in the 7-Zip WebAssembly FS

7-Zip runs in `worker_threads` (`archive/ArchivePool.js`), and a worker thread is allowed to block.
So all formats stay on 7-Zip:

- `SevenZipEngine.withArchive`: for an S3 path, it creates an Emscripten file node instead of the
  NODEFS mount. Model it on Emscripten's `FS.createLazyFile`: a custom `stream_ops.read` and a size
  taken from `HeadObject`.
- **Sync bridge:**
  1. Each archive worker owns a fetcher worker.
  2. `read(position, length)` posts `{key, offset, length}` to the fetcher, then calls `Atomics.wait`
     on a `SharedArrayBuffer`.
  3. The fetcher performs the ranged GET, writes the bytes into the buffer, and calls `Atomics.notify`.
- **Block cache:** module-level LRU of 1 MiB blocks keyed by `(key, etag, block)`, about 64 MiB per
  worker. 7-Zip makes many small reads, so this cache is essential. It must sit at module level
  because every call creates a new 7-Zip instance.
- `ZipReader.open` reads a 6-byte signature with `fs.promises.open`. Change it to `LibraryFs.readRange`.
- Expected cost: 3–5 ranged GETs per book from a zip (central directory + entry).

### 4. Callers to switch from `fs` to `LibraryFs`

Each item is a file to change:

1. `LibrarySources.js`: `findSingleInpx`, the `pathExists(libDir)` checks (lines 64–142).
2. `LibraryAssets.js`: `extractBook`, `resolveLibraryArchivePath` (folder probing → many LIST calls,
   cached), `resolveArchiveNameInDir`, `resolveExistingPath`, `resolveLibraryAssetDir(s)`,
   `getBookAssetArchives`, `buildAuthorInfoIndex`.
3. `LibraryAssets.libraryToolDirs`: `bin/` inside the library holds executables. These can't run from
   S3, so skip this lookup for S3 sources. Tools come from the container image.
4. `LibraryReviews.js`: `snapshot` (`readdir` + `stat` mtime for the signature).
5. `InpxHashCreator.js`, `InpxParser.js`, `ZipReader.js`, `archive/SevenZipEngine.js`.
6. `AdminService.js`: library check (`findFilesByExt`, `countArchives`, `walkFiles`, `pathExists`).
7. `static.js:322` `reader-lab-source`: a debug route; return 404 for S3.

Find any others with `grep -rn "libDir\|sourceLibDir" server/core server/static.js`.

### 5. Storage split: EFS vs ephemeral

Add one config option, `cacheDir` (default: `dataDir`, so existing installs don't change). Move these
under it:

| Item | Today | Where on Fargate | Why |
|---|---|---|---|
| `state.sqlite`, `secret.key`, `reading-lists.json`, `kobo-sync.json`, backups, `discovery-cache.json`, Wikidata tables, config | `dataDir` | **EFS** (`dataDir`) | Users, profiles, progress, settings: must survive restarts |
| `library.sqlite` | `dataDir` | **ephemeral** (`cacheDir`) | Catalog only (`CatalogIndex.js:32`), rebuilt from the INPX. EFS latency per page would slow down search |
| `public-files/book` | `dataDir` | **ephemeral** | Rebuilt on demand from S3 |
| `public-files/cover` | `dataDir` | **ephemeral** | See "Covers" below |
| `tmp` | `dataDir/tmp` (emptied at start) | **ephemeral** | Already throwaway |

**Covers.** Every cover comes from the library itself (`getBookCover`). Losing the cache costs one
archive read plus a resize per cover, spread over browsing after the restart. Browsers also keep covers
for 30 days (`Cache-Control: immutable`, `static.js`). **Don't cache covers on S3:** it needs write
access to a second bucket, and a cached cover would still cost one GET with about the same latency.
If restarts turn out to be frequent and the first browse is too slow, move `public-files/cover` to EFS.
Covers are small files, a few GB at most.

**`library.sqlite` rebuild time.** Not measured yet. Measure it on the full Flibusta INPX from S3. If
startup takes too long, keep `library.sqlite` on EFS and accept slower searches, or keep it in
`cacheDir` and accept the rebuild.

**SQLite on EFS.** `state.sqlite` uses WAL (`StateStore.js:17`). WAL is safe on NFS only while a single
host has the file open. ECS rolling deploys start the new task before stopping the old one, so set the
service to `minimumHealthyPercent: 0`, `maximumPercent: 100`: never two tasks at once.

## Steps

| # | Step | Estimate | Done when |
|---|---|---|---|
| 0 | **Spike:** a custom FS node + sync bridge; `7z l` on a zip in MinIO | 0.5–1 day | Listing and extraction work from MinIO. If not, stop and reconsider |
| 1 | `LibraryFs` (local passthrough + S3 + caches) + unit tests for path handling | 0.5 day | Tests pass for `s3://`/`s3:/` and local paths, and for a source with an S3 `libDir` + local `inpx` and the reverse |
| 2 | Archive engine on S3 (from the spike), block cache, `ZipReader.open` | 1 day | A book opens from an S3 library |
| 3 | INPX: `contentHash`, parse via S3, `get-inpx-file` | 2–3 h | A rebuild runs from S3; the periodic check costs one HEAD |
| 4 | Switch the callers in §4 | 0.5–1 day | Covers, illustrations, author info, reviews and the admin library check work on S3 |
| 5 | `cacheDir` option | 0.5 day | `library.sqlite`, `public-files` and `tmp` follow `cacheDir` |
| 6 | Docs: `docs/config.md` (S3 paths, `cacheDir`), `docs/docker.md` Fargate section (IAM `s3:GetObject` + `s3:ListBucket`, EFS for `dataDir`, deployment percentages), both READMEs if a new doc appears | 2–3 h | — |
| 7 | Integration test against MinIO in Docker + a measurement on the real Flibusta library (rebuild time, cold book latency) | 0.5 day | Numbers recorded in `docs/research/` |

Total: about 4–5 days. Delete this plan once it is implemented (`docs/AGENTS.md`).

## Step 0 results (2026-10-16)

The bridge works. 7-Zip lists and extracts zip, solid 7z and INPX from S3, and the bytes match the
local files. Test server: SeaweedFS S3 gateway in Docker, because Docker Hub no longer serves the MinIO
image and quay.io requires a login:

```bash
docker run -d --name s3spike -p 8333:8333 chrislusf/seaweedfs:3.80 server -s3 -dir=/data
# client: endpoint http://localhost:8333, forcePathStyle: true, region us-east-1, any key/secret
```

Measured with 1 MiB blocks, local server, so latency is not representative:

| Operation | GETs | Bytes |
|---|---|---|
| zip (43 MB, 2000 entries): list, cold | 3 (start, tail, central directory) | 2.1 MiB |
| zip: extract one book after the listing | 1 | 1 MiB |
| zip: a second book in a cached block | 0 | 0 |
| solid 7z (12 MB, one solid block): list | 2 | 1 MiB |
| solid 7z: extract one book | 11 | 11 MiB (the whole block, as expected) |
| INPX (38 MB): list + extract one `.inp` | 2 | 1.2 MiB |

How it is built (port this into `SevenZipEngine` in step 2):

- **Node:** `FS.createFile(dir, name, {}, true, false)`, then set `node.contents = new Uint8Array(0)`
  so MEMFS doesn't choke, define a `usedBytes` getter that returns the object size (MEMFS `getattr`
  and `llseek` read it), and replace `stream_ops.read`. `write` throws `EROFS(63)` and `mmap` throws
  `ENODEV(43)`.
- **Buffer type:** the `buffer` that `read` receives is `HEAP8` (an `Int8Array`). Copy through
  `new Uint8Array(buffer.buffer, buffer.byteOffset)` so the bytes go across unchanged and fast.
- **Bridge:**
  1. Use a `MessageChannel` plus a 4-byte `SharedArrayBuffer`.
  2. The archive thread posts the request, then calls `Atomics.wait(sig, 0, 0, 60000)`.
  3. The fetcher replies with `port.postMessage` (the byte array is transferred), then calls
     `Atomics.store` + `Atomics.notify`.
  4. The archive thread takes the reply with `receiveMessageOnPort`, which needs no event loop.
  5. The fetcher worker is created once per archive thread and `unref()`'d.
- **First request:** HEAD returns size + ETag. The ETag goes into the block-cache key.

Findings for step 2:

- **Block size:** with 1 MiB blocks, every cold book costs at least 1 MiB of transfer. Try 256 KiB:
  more GETs, less transfer. Measure on real S3, where each GET costs about 20–50 ms.
- **Errors:** a HEAD error has no body, so the SDK reports `NotFound: UnknownError`. Map
  `$metadata.httpStatusCode` 404/403 to `not found` / `access denied` + the URI.
- **Path form:** `s3:/bucket/key` (after `path.join`) and `s3://bucket/key` both parse.

## Decisions (2026-10-16)

- **Logs:** CloudWatch collects stdout, which is enough. `logDir` is already configurable; point it at
  ephemeral storage on Fargate. `cacheDir` does not include logs.
- **Bucket layout:** each path is resolved on its own. Every source's `libDir` and every source's
  `inpx` goes through `LibraryFs` separately, so any mix is valid:
  - two libraries under different prefixes of one bucket
  - separate buckets per library
  - library on S3 with the INPX on NFS or a local path
  - library in one bucket with the INPX in another
  
  Code must never derive the INPX location from `libDir` or the reverse, except for today's
  `findSingleInpx`, which runs only when `inpx` is empty. That lookup works on both backends.
- **One S3 client** for all buckets, with `followRegionRedirects: true` so buckets in different regions
  work. Credentials and endpoint are shared. `shortcut:` buckets on different providers (AWS + R2) or
  with different credentials are not supported; per-URI endpoint/credential config would be the upgrade.
- **IAM:** the task role needs `s3:GetObject` + `s3:ListBucket` on every bucket/prefix the sources
  name. `docs/docker.md` gets an example policy with two buckets.
