# server

Node.js 24 server. Entry: `index.js`.

## Map

- `config/` — `base.js` defaults; `index.js` `propsToSave` lists the keys read from and written to `config.json`. `application_env` = `development` runs webpack inside the server: measure memory and speed without it (the release binary runs in production mode).
- `controllers/WebSocketController.js` — WebSocket API: one `switch` on `action`, handlers call `WebWorker` methods. CSRF-protected actions are listed in `isCsrfProtectedAction`.
- `static.js` — HTTP routes for books, covers, downloads. `core/opds/` — OPDS feed. `core/kobo/` — Kobo sync. `core/HealthRoutes.js` — health and metrics.
- `core/WebWorker.js` — the application service: library access, books, reader, shelves, admin. `AdminBackup.js` is mixed into it.
- `core/search/` — library database:
  - `CatalogSearch.js` imports INPX (`LibraryImport.js`, `InpxParser.js`) into `library.sqlite` and is the main-thread API (`catalogSearch` on the worker).
  - `CatalogIndex.js` (schema, build, search, book records) and `CatalogIndexQueries.js` (OPDS and field queries) run synchronously inside the worker thread (`CatalogIndexThread.js`).
- `core/StateStore.js` — `state.sqlite`: prepared-book file cache, access-password sessions.
- `core/ReadingListStore.js` — users, lists, progress, metadata overrides (`reading-lists.json`). `core/kobo/KoboStore.js` — `kobo-sync.json`. Writes go through `FilePersistence` transactions.
- `core/BackupTransaction.js` — the files a full backup contains and restores.

## Rules

- SQLite (`node:sqlite`) is synchronous: library queries run only in the library thread. Add a method to `CatalogIndex`/`CatalogIndexQueries` and call it via `catalogSearch.call(...)` or a wrapper. Small point lookups in `state.sqlite` may run in the main thread.
- Changing the `library.sqlite` schema: bump `schemaVersion` in `CatalogIndex.js`; it is rebuilt from INPX on start.
- Book records keep the original INPX fields. Metadata overrides are applied on read (`applyMetadataOverridesToSearchResult`) and to search columns and author links at build and in `updateBook`.
- While the library DB builds for the first time the server is busy (`server_busy`); later rebuilds run in a separate thread while the current DB keeps serving.
- Cache per-user results that are expensive to build, and let identical concurrent requests share one build.
- User-facing server text comes from `shared/locales/*.json` via `core/i18n.js`: `t(key)` renders in the request language (WebSocket `uiLang`, `inpx_lang` cookie, `Accept-Language`); `msg(key, params)` stores a descriptor for cached or saved data (shelves, admin events), which the client renders. No Russian literals in code; data is marked `i18n-ignore`.
