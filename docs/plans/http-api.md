# Plan: HTTP API instead of WebSocket (hybrid)

Status: in progress. Delete this file when the migration is merged.

## Why

The WebSocket carries only request/response traffic (`requestId`); the server never pushes. It costs a
connection layer that re-implements HTTP (`server/core/WebSocketConnection.js`: request matching, timeouts,
`_rok` acks, reconnects), and workarounds: uploads already go over HTTP through a fake socket
(`uploadHandler`), the session cookie after login needs a second request (`/session/rotate`), proxies need
`Upgrade` headers, forward-auth sees only the upgrade. Plain HTTP removes all of it, lets every request pass
proxy auth and same-origin checks, and opens `GET` semantics: reads are safe, need no CSRF token and may be
retried.

## Shape

- **Reads** with a natural id are resources: `GET <root>/api/books/:bookUid`. Query-style reads take flat
  query parameters; a nested object goes as one JSON-encoded parameter named after the field (`query=`,
  `filters=`, `options=`).
- **Writes** and commands stay actions: `POST <root>/api/<action>` with a JSON object body, the same
  parameter names as today.
- **Uploads** (`import-admin-backup`, `import-reading-lists`, `import-admin-settings`) are the same
  `POST <root>/api/<action>` with an `application/octet-stream` body; scalar parameters in the query string.
  `POST /upload` is removed.
- One declarative table, `shared/apiRoutes.js`, maps every action to its method, path and parameter types.
  The server builds its router from it; the client builds URLs from it, so `Api.vue` keeps calling
  `request({action, ...params})`. Handlers keep receiving one params object with today's field names.
- Ids in the path only when opaque (`bookUid`, `listId`, `deviceId`, `workerId`, remote access `id`).
  Names (author, series) go in the query string: they contain `/` and other characters proxies decode.
- Tokens never go in URLs: profile token and user id are headers.

## Route table

Base: `<root>/api/` (the client uses the relative URL `api/...`: the page is always `<root>/`).

Reads (`GET`, no CSRF token, retried by the client after a connection error):

| Action | Route | Parameters |
|---|---|---|
| `test` | `GET api/ping` | none; connection probe |
| `get-config` | `GET api/config` | |
| `get-worker-state` | `GET api/worker-state/:workerId` | |
| `get-genre-tree` | `GET api/genres` | |
| `get-author-book-list` | `GET api/author/books` | `author`, `authorId` (int), `query` (json) |
| `get-author-info` | `GET api/author/info` | `author`, `authorId` (int) |
| `get-author-aliases` | `GET api/author/aliases` | `author` |
| `get-series-book-list` | `GET api/series/books` | `series`, `query` (json) |
| `catalog-search` | `GET api/catalog/search` | `q`, `filters` (json), `sort`, `offset`, `limit` (int), `hideCopies`, `showDeleted` (bool), `facets` |
| `catalog-suggest` | `GET api/catalog/suggest` | `q` |
| `catalog-names` | `GET api/catalog/names` | `kind`, `q`, `offset`, `limit` (int) |
| `get-book` | `GET api/books/:bookUid` | |
| `get-book-info` | `GET api/books/:bookUid/info` | `fetchRemote` (bool) |
| `get-book-link` | `GET api/books/:bookUid/link` | |
| `get-reader-state` | `GET api/books/:bookUid/reader-state` | |
| `get-discovery-shelves` | `GET api/discovery/shelves` | the current scalar fields, typed |
| `get-reading-lists` | `GET api/reading-lists` | `bookUid`, `options` (json) |
| `export-reading-lists` | `GET api/reading-lists/export` | |
| `get-reading-list` | `GET api/reading-lists/:listId` | `options` (json) |
| `get-reading-now` | `GET api/me/reading-now` | `hidden` (bool) |
| `get-user-reading-library` | `GET api/me/library` | `options` (json) |
| `get-reading-stats` | `GET api/me/reading-stats` | |
| `get-user-profiles` | `GET api/profiles` | |
| `get-kobo-devices` | `GET api/kobo-devices` | |
| `get-remote-access` | `GET api/remote-access` | |
| `get-admin-dashboard` | `GET api/admin/dashboard` | |
| `get-admin-dashboard-metrics` | `GET api/admin/dashboard/metrics` | |
| `get-admin-events` | `GET api/admin/events` | `options` (json) |
| `admin-author-names-status` | `GET api/admin/author-names/:table` | |
| `export-admin-settings` | `GET api/admin/settings/export` | |

`get-book-states` takes up to hundreds of 64-char uids: it becomes `POST api/get-book-states` (a read over
`POST`, so it needs the CSRF token like every `POST`).

Writes: every other action is `POST api/<action>`. Types listed as `json` are objects or arrays; the exact
type of each field is taken from the current handler and client call. Static segments are matched before
`:listId` (`export`); ids are validated by pattern.

## Request and response rules

- `GET` handlers change no user data. Filling a cache (`get-book-link`, `get-discovery-shelves`
  `forceRefresh`) is allowed.
- Every `/api` request carries `X-Inpx-Api: 1`. A navigation or `<img>`/`<form>` from another site cannot set
  it, and setting it cross-origin needs a CORS preflight the server never answers.
- `Sec-Fetch-Site`, when present, must be `same-origin` or `none`; `Origin`, when present, must pass
  `Security.sameOriginCheck`. Otherwise 403.
- Every `POST`: `Content-Type: application/json` (octet-stream only for upload actions; else 415) and a valid
  `X-CSRF-Token` (else 403 `bad_csrf_token`).
- Headers: `X-User-Id`, `X-Profile-Token`, `X-Ui-Lang`, `X-CSRF-Token`. Body and query never carry them.
- Limits: JSON body up to `apiMessageLimitMb` (today's `wsMessageLimitMb`, default 1 MiB, max 16) else 413;
  a body that is not a JSON object 400; unknown query parameter or bad type 400; URL over 8 KiB 414.
  Uploads keep their per-action limits and the two-phase check (access first, then the body to disk).
- Concurrency: up to 8 active requests per session (by client IP without a session), 64 per server, one large
  body at a time; over it 429 with `Retry-After: 1`.
- Responses: JSON, `Cache-Control: no-store`. Success 200 with the handler result. Errors `{error}` with a
  status: 400 invalid request or handler error, 401 `need_profile_login`, 403 denied / `bad_csrf_token`,
  404 unknown route (JSON, never the web app page), 405 wrong method (with `Allow`), 413, 414, 415, 429
  `too_many_requests`, 503 `server_busy`, 500 unexpected. `errorText` keeps hiding server paths. An error
  with `status` keeps it.
- Session: the response sets the session cookie when the request had none the server knows (after a
  restart). Login and logout rotate the session id and set the new cookie in the same response;
  `/session/rotate` and its one-time tokens are removed.
- Logging (`logQueries`): method, path, query, body with `hideSecrets`; never header tokens.
- Online metrics count sessions with a request in the last 5 minutes. Metrics renamed:
  `inpx_web_ws_clients` → `inpx_web_active_clients`, `inpx_web_ws_anonymous_clients` →
  `inpx_web_anonymous_clients`; `inpx_web_users_online` stays.

Client:

- `client/components/Api/apiConnection.js` replaces `server/core/WebSocketConnection.js` and
  `webSocketConnection.js`: `call(action, params, {timeoutSecs, headers})` with `fetch` and `AbortController`,
  built on `shared/apiRoutes.js`. Errors: `errors.apiConnectFailed` (fetch failed), `errors.apiNoResponse`
  (timeout), `errors.apiBadResponse` (non-JSON reply, e.g. a proxy 502 page); a JSON `{error}` passes through.
- `canRetryRequest`: connection errors are retried only for `GET` routes. `retrySafeActions` and the server's
  `readOnlyActions` disappear: the method is the rule.
- `probeConnection` → `GET api/ping`; `rotateSession` and the `_rok` handling are removed; `upload()` posts
  to `api/<action>`.

Removed: the WebSocket server and `ws` dependency, `Security.verifyWebSocket`, `upgradeCookie`,
`sessionRotateHandler`, the per-IP socket cap, `POST /upload`, `POST /session/rotate`, the `errors.ws*` keys
and `errors.uploadOverHttp`. `ExposedPaths` lists `<root>/api/` instead of `(WebSocket)`, `/upload` and
`/session/rotate`.

Renames: `server/controllers/WebSocketController.js` → `ApiController.js`; config `wsMessageLimitMb` /
`INPX_WS_MESSAGE_LIMIT_MB` → `apiMessageLimitMb` / `INPX_API_MESSAGE_LIMIT_MB`.

## Steps

1. `shared/apiRoutes.js`: the table, `encode(action, params)` → `{method, path, query, body}` and
   `match(method, path)` + `decode(route, pathParams, query, body)` → params; unit tests. Everything else
   builds on it.
2. In parallel, disjoint files:
   - **Controller**: `ApiController.js` — handlers return results instead of `this.send`; `router()` builds the
     Express router from the table: body parsing, limits, concurrency, CSRF, profile access, dispatch, status
     codes, uploads, online activity; `RequestLimits.js`.
   - **Transport and security**: `server/index.js`, `Security.js` (`apiGuard()` middleware: `X-Inpx-Api`,
     `Sec-Fetch-Site`, `Origin`, session cookie refresh; `rotateSession(req, res)`; WebSocket code removed),
     `HealthRoutes.js`, `ExposedPaths.js`, config rename, `ws` dependency removed.
   - **Client**: `apiConnection.js`, `Api.vue`, `client/share/connection.js`, locales.
   - **Docs**: `docs/admin.md`, `auth-monitoring.md`, `nginx-https.md`, `development.md`, `config.md`,
     `DOCKERHUB.md`, `server/AGENTS.md`, `CHANGELOG.md`.
3. Tests: every WebSocket test in `scripts/` moves to HTTP; new tests for the rules above.
4. Integration: `npm run test:release`, `npm run test:i18n`, `npm run build:client`, eslint; run the server and
   click through login, search, a book, reader progress, lists, an upload, admin.
