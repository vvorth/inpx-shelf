# client

Vue 3 + Quasar 2 web app, built by webpack (`npm run build:client`).

## Map

- `main.js`, `quasar.js`, `router.js` — bootstrap and routes. Hash URLs; every route is kept alive (`activated`/`deactivated`).
- `components/vueComponent.js` — class-based components: getters become computed; only `components`, `watch` and `emits` are taken from `_options`.
- `components/Shell/` — app frame: navigation rail, top bar with search, tab bar.
- `components/Library/` — home, search, book, author and series pages. `BookCollection`, `BookCard`, `BookCover`, `BookQuickActions` are the only way to show books: reuse them so a change shows up everywhere.
- `components/Lists/`, `Me/`, `Admin/`, `Login/`, `Reader/` — lists, profile, administration, sign-in, reader.
- `components/Api/Api.vue` — WebSocket API calls, the busy dialog while the server builds the library.
- `components/App.vue` — global styles (`.page`, `.card`, `.tabs` …): use them instead of new one-off styles.
- `share/` — client helpers (session, book actions, genres, languages, views, i18n). `store/` — vuex settings persisted in localStorage.

## Rules

- Russian strings are the i18n keys: write UI text in Russian via `$t`/`t()`, add the English translation to `share/i18n/en.js`, run `npm run test:i18n`.
- Keep the UI consistent: same components, spacing and patterns as the existing pages.
- ESLint `vue/no-v-for-template-key` errors are false positives (a Vue 2 rule).
