# shared

Code used by both the server and the client bundle: `i18nEngine.js` (translation engine; `i18n.js` adds all dictionaries for the server, the client loads only the selected one), `safeHtml.js` (cleaning library HTML), `release.js` (comparing release versions), `readerPreferences.js` (reader defaults and settings migration), `readMark.js` (when reading marks a book read: crossing 95%), `genres.en.js` (English genre names), `apiRoutes.js` (HTTP API route table: method, path and parameter types of every action; the server routes by it, the client builds URLs from it), `LockQueue.js` (one lock with a queue of waiters: the client opens one busy dialog at a time).

- Must run in Node.js and in the browser: no Node-only or browser-only APIs, no new dependencies.
- CommonJS exports, as in the existing files.
