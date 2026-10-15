# client

Vue 3 + Quasar 2 web app, built by webpack (`npm run build:client`).

## Map

- `main.js`, `quasar.js`, `router.js` — bootstrap and routes. Hash URLs; every route is kept alive (`activated`/`deactivated`).
- `components/vueComponent.js` — class-based components: getters become computed; only `components`, `watch` and `emits` are taken from `_options`. Class fields become deep-reactive `data`: keep big or non-UI structures (caches, Maps, DOM/canvas objects) out of them — assign them in `beforeCreate`/`created`, or store big arrays that are only replaced as a whole with `markRaw` (see `Reader/Reader.vue`).
- `components/Shell/` — app frame: navigation rail, top bar with search, tab bar.
- `components/Library/` — home, search, book, author and series pages. `BookCollection`, `BookCard`, `BookCover`, `BookQuickActions` are the only way to show books: reuse them so a change shows up everywhere.
- `components/Lists/`, `Me/`, `Admin/`, `Login/`, `Reader/` — lists, profile, administration, sign-in, reader.
- `components/Api/Api.vue` — WebSocket API calls, the busy dialog while the server builds the library.
- `components/App.vue` — global styles (`.page`, `.card`, `.tabs` …): use them instead of new one-off styles.
- `share/` — client helpers (session, book actions, genres, languages, views, i18n). `store/` — vuex settings persisted in localStorage.

## Rules

- UI text lives in `shared/locales/ru.json` and `en.json`; code uses semantic keys only (`$t('settings.darkTheme')`, `t()`; `$tm`/`tm()` for server text or `{key, params}` descriptors). Add the key to both files and run `npm run test:i18n`.
- Keep the UI consistent: same components, spacing and patterns as the existing pages.
- Write icon names in full (`'la la-check'`), never build them at runtime: the build keeps only the Line Awesome icons found in `client/` (`build/css-subset-loader.js`). A Quasar component listed there as unused has no styles: remove it from that list before registering it in `quasar.js`.
