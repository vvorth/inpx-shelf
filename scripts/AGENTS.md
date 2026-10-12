# scripts

Tests and maintenance scripts.

- `release-smoke-tests.js` — the test suite (`npm run test:release`, runs on `node:test`). It runs its own tests and the test lists exported by `*-tests.js` modules; standalone scripts such as `opds-index-tests.js` are run from it as a child process.
- `i18n-check.js` — locale files match, keys used in code exist, no unused keys, no Russian text in code (`npm run test:i18n`).
- `binary-smoke-test.js`, `proxmox-lxc-install.sh`, `bundle-windows-tools.ps1` — packaging and installation.

## Rules

- Put a test into the `*-tests.js` module of its area and add it to the exported list (or to `tests` in `release-smoke-tests.js`).
- Prefer a real library DB built in a temp dir (`CatalogIndex` + `beginBuild`/`insertBooks`/`finishBuild`) over mocks of it.
- Tests clean up their temp dirs and never touch real data directories.
