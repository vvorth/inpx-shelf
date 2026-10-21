# inpx-shelf

Self-hosted web catalog for INPX e-book libraries: Node.js 24 server, Vue 3 + Quasar client, OPDS, Kobo sync, online reader.

## Where things are

| Path | What | Rules |
|---|---|---|
| `server/` | HTTP server, library DB, OPDS, Kobo, user data | [server/AGENTS.md](server/AGENTS.md) |
| `client/` | Web app (Vue 3, Quasar) | [client/AGENTS.md](client/AGENTS.md) |
| `shared/` | Code used by both server and client | [shared/AGENTS.md](shared/AGENTS.md) |
| `scripts/` | Tests and maintenance scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| `docs/` | User docs (Russian), project docs, research, plans | [docs/AGENTS.md](docs/AGENTS.md) |
| `build/` | Webpack configs, pkg packaging, release, Windows installer | |
| `README.md` | Entry point (English): overview, Docker quick start, links to `README.ru.md` and `docs/` | |
| `README.ru.md` | Entry point (Russian): overview, Docker quick start, links to `docs/` | |
| `CHANGELOG.md` | Release notes (Russian), newest first | |
| `CHANGELOG-inpx-web.md` | Upstream history before the fork. Frozen, do not edit | |
| `NOTICE.md`, `DOCKERHUB.md`, `Dockerfile`, `docker-compose*.yml` | Credits, Docker Hub page, images | |

## How to work

- Make the smallest complete change. Reuse existing helpers, components and patterns; add no options or abstractions nobody asked for.
- If the user only asks a question, answer it. Change code only after they agree.
- Keep the repo tidy: no stray files in the root, temporary files outside the repo, delete dead code instead of commenting it out.
- Commit only when asked or agreed, one commit per logical step. Subject in English, imperative; body says why. Never push unless asked.
- Code comments: short, explain why, in the language of the surrounding code (Russian in most of the codebase).

## Docs

- `README.md`, `README.ru.md`, `docs/` and `AGENTS.md` files describe the current state only: short, on point. No history, no "since version X", no stories of how it came to be.
- Change history goes only to `CHANGELOG.md`: user-facing, in Russian, under the `Не выпущено` heading at the top (add the heading if it is missing). The release workflow renames it to the version.
- Research goes to `docs/research/`, multi-step plans to `docs/plans/`. Project docs never link to them. See [docs/AGENTS.md](docs/AGENTS.md).
- When behavior changes, update the doc that describes it in the same commit.

## Before finishing

- `npm run test:release` passes (`fail 0` in the summary).
- UI text changed: `npm run test:i18n`. Client changed: `npm run build:client`.
- `npx eslint --quiet server shared scripts build client --ext .js,.vue` reports no errors (CI runs it).

## Invariants

- A book is identified by `_uid`, the SHA-256 of its INPX line (`server/core/InpxParser.js`). Lists, progress, metadata edits, Kobo and backups refer to it: never change how it is computed.
- User data lives in the data directory (`reading-lists.json`, `kobo-sync.json`, `config.json`, `secret.key`) and is exactly what backups contain. `library.sqlite` and `state.sqlite` are rebuildable.
- Target: a 700k-book library in a 2 GB container. No full scans of the library in the main thread.
