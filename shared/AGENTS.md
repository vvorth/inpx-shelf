# shared

Code used by both the server and the client bundle: `safeHtml.js` (cleaning library HTML), `release.js` (comparing release versions), `readerPreferences.js` (reader defaults and settings migration), `genres.en.js` (English genre names).

- Must run in Node.js and in the browser: no Node-only or browser-only APIs, no new dependencies.
- CommonJS exports, as in the existing files.
