# shared

Code used by both the server and the client bundle: `i18nEngine.js` (translation engine; `i18n.js` adds all dictionaries for the server, the client loads only the selected one), `safeHtml.js` (cleaning library HTML), `release.js` (comparing release versions), `readerPreferences.js` (reader defaults and settings migration), `genres.en.js` (English genre names), `sha256.js` (password hash on the client: `crypto.subtle` needs https).

- Must run in Node.js and in the browser: no Node-only or browser-only APIs, no new dependencies.
- CommonJS exports, as in the existing files.
