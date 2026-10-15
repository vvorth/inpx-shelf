# server

Node.js 24 server. Entry: `index.js`.

## Map

- `config/` — `base.js` defaults; `index.js` `propsToSave` lists the keys read from and written to `config.json`. `application_env` = `development` runs webpack inside the server: measure memory and speed without it (the release binary runs in production mode).
- `controllers/WebSocketController.js` — WebSocket API: one `switch` on `action`, handlers call `WebWorker` methods. Read-only actions are listed in `readOnlyActions`; every other action needs the CSRF token.
- `static.js` — HTTP routes for books, covers, downloads. `core/opds/` — OPDS feed. `core/kobo/` — Kobo sync: `index.js` (service, routes, sync phases) with mixins `Preparation`, `Covers`, `StoreProxy`. `core/HealthRoutes.js` — health and metrics.
- `core/WebWorker.js` — the application service (`webWorker` everywhere): library DB state, books and prepared files, reader, reading lists. Mixins in their own files add methods to `WebWorker.prototype` (`this` is the worker):
  - `ProfileSessions.js` — profile login, sessions, `requireAdmin`; `AdminService.js` — admin dashboard, events, sources, runtime config; `AdminBackup.js` — settings export and backups.
  - `LibraryAssets.js` — books from archives, covers and images, author info, reviews; `BookDelivery.js` — sending books.
  - `CacheCleaner.js` — book and cover cache cleaning (schedule maths in `CacheSchedule.js`).
  - `discovery/ExternalShelf.js` — discovery config, shelf cache, Wikidata awards shelf; `discovery/PersonalShelves.js` — personal shelves and reading stats.
- `core/search/` — library database:
  - `CatalogSearch.js` imports INPX (`LibraryImport.js`, `InpxParser.js`) into `library.sqlite` and is the main-thread API (`catalogSearch` on the worker).
  - `CatalogIndex.js` (schema, build, search, book records) and `CatalogIndexQueries.js` (OPDS and field queries) run synchronously inside the worker thread (`CatalogIndexThread.js`).
- `core/ZipReader.js` — reads library archives (zip with any method, 7z) with 7-Zip compiled to WebAssembly in `core/archive/`: worker threads (`ArchivePool`), a fresh 7-Zip instance per call (`SevenZipEngine`).
- `core/StateStore.js` — `state.sqlite`: prepared-book file cache, access-password sessions.
- `core/ReadingListStore.js` — `reading-lists.json`: loading, normalizing, saving, metadata overrides; `core/readingLists/` mixins add profiles (`Users`), lists (`Lists`), reader state, reader settings and discovery. Every async method except the password checks runs in the store lock. `core/kobo/KoboStore.js` — `kobo-sync.json`. Writes go through `FilePersistence` transactions.
- `core/BackupTransaction.js` — the files a full backup contains and restores.

## Rules

- SQLite (`node:sqlite`) is synchronous: library queries run only in the library thread. Add a method to `CatalogIndex`/`CatalogIndexQueries` and call it via `catalogSearch.call(...)` or a wrapper. A query that answers with book ids gets the records in the same call (`catalogSearch.callWithBooks`): a rebuild may swap the DB between two calls. Small point lookups in `state.sqlite` may run in the main thread.
- Changing the `library.sqlite` schema: bump `schemaVersion` in `CatalogIndex.js`; it is rebuilt from INPX on start.
- Book records keep the original INPX fields. Metadata overrides are applied on read (`applyMetadataOverridesToSearchResult`) and to search columns and author links at build and in `updateBook`.
- While the library DB builds for the first time the server is busy (`server_busy`); later rebuilds run in a separate thread while the current DB keeps serving.
- Library DB builds go only through `catalogSearch.ensure`: one build at a time, requests made during a build merge into one next build.
- Cache per-user results that are expensive to build, and let identical concurrent requests share one build.
- User-facing server text comes from `shared/locales/*.json` via `core/i18n.js`: `t(key)` renders in the request language (WebSocket `uiLang`, `inpx_lang` cookie, `Accept-Language`); `msg(key, params)` stores a descriptor for cached or saved data (shelves, admin events), which the client renders. A time in such a descriptor goes as `{time: ISO}`: the browser formats it in its own locale and time zone. No Russian literals in code; data is marked `i18n-ignore`.
