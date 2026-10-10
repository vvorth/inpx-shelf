# inpx-web: UI/UX redesign

**Goal:** turn inpx-web from "a search form with dialogs bolted on" into a home library
product: one search box that finds things, real pages for books, authors and series, a
personal area for each reader, and an admin console that is separate from all of that.

Clickable prototype: [`prototype.html`](prototype.html) (open it in a browser; no build step).

---

## 1. What is wrong today

Everything below comes from reading the current client, not from taste.

### 1.1 One page holds the whole product

`Search.vue` (2,900 lines) is the only real route. `/author`, `/series`, `/title`, `/books`,
`/extended`, `/for-you`, `/newest`, `/popular` all mount the same component and switch its mode.
Everything else lives in modal dialogs on top of it:

| Area | Where it lives now |
|---|---|
| Personal preferences (theme, language, page size) | `SettingsDialog` |
| Display toggles (show counts, rates, genres, dates, Info button) | `SettingsDialog` |
| Server admin: dashboard, cache rotation, backups, OPDS, Telegram, SMTP, library sources, event log | the same `SettingsDialog`, in collapsible blocks (2,650 lines) |
| Log in / switch user | a `q-select` "Profile" in the toolbar, plus a status chip, plus a round button |
| User management (create, reset password, delete) | `UserProfilesDialog`, above the list of profiles |
| My account, my lists, my progress, Kobo devices | tabs inside **the current user's card** in that same list |
| Reading lists | `ReadingListsDialog` (a second, different list editor) |
| Book details, metadata editing | `BookInfoDialog` |

Results:
- Nothing has a URL. A book, an author, a list or an admin screen cannot be bookmarked, shared or
  reached with the Back button.
- Admin settings sit next to "show genres". A reader sees server knobs; an admin hunts through
  collapsible blocks.
- Reading lists have three editors: the profile card, `ReadingListsDialog`, and the discovery shelves.

### 1.2 Search makes the user do the database's work

- The user picks the entity first (Authors / Series / Titles / Books / Extended), then fills
  separate Author, Series, Title fields. Real people type "мастер и маргарита" or "булгаков" into
  one box.
- Matching is prefix-only, with operators the user has to learn from a help popup:
  `=` exact, `*` substring, `#` non-letters, `~` regex.
- There is no relevance ranking and no typo tolerance. "булгоков", "стругацкий", "ghbdtn"
  (wrong keyboard layout) and "ё" vs "е" all fail or depend on luck.
- Filters (language, genre, rating, file type) are read-only inputs that open a dialog each.
  That is two clicks per filter, and you see no counts until you pick.

### 1.3 Identity is modelled as a shared TV

The profile dropdown in the toolbar is a Netflix-style "who is watching" switcher, while the
server has real logins, passwords, SSO (`profileBoundId`) and per-user OPDS credentials. The UI
should be a normal account model: sign in once, an avatar menu, and a sign-out button.

### 1.4 Visual layer

- Defaults from Quasar's palette (`bg-cyan-2` toolbar, `bg-yellow-1` round icon buttons), with no
  design tokens. Dark mode is `$q.dark` flipping Quasar's colors.
- Main actions are unlabeled round icons with a 1.5 s tooltip delay (settings, lists, sign out,
  profiles).
- Design decisions are pushed onto the user as settings: "show counts", "show rates",
  "show Info button", "show genres", "show dates", "card view", "cache requests".

### 1.5 What to keep

The reader (`Reader.vue`) is the most finished part: themes, fonts, paged/scroll modes, TTS,
bookmarks, wake lock, its own PWA manifest. Keep it. Change only how you get into it and out of
it. The server features (Kobo sync, OPDS, delivery, discovery shelves, backups,
Audiobookshelf metadata) are solid. This is about structure and presentation.

---

## 2. Principles

1. **Everything is a page with a URL.** Dialogs are only for confirmations and quick actions
   (add to list, send to device).
2. **One search box.** It finds authors, series, books and genres. Filters narrow results and
   show counts.
3. **Three spaces that never mix:** *Library* (everyone), *Me* (my account, devices, lists),
   *Admin* (server). Admin is a separate area with its own navigation.
4. **Opinionated defaults instead of toggles.** Counts, ratings and dates are shown where they
   help and left out where they don't. Remove the display checkboxes.
5. **Reading comes first.** "Continue reading" is the first thing on Home. "Read" is the main
   button on every book.
6. **Mobile is a first-class layout.** It gets a bottom tab bar and bottom-sheet filters, not a
   collapsed toolbar.

---

## 3. Information architecture

```
Library                         Me                          Admin (role = admin)
├─ Home            /            ├─ Account     /me          ├─ Overview      /admin
├─ Search          /search?q=   ├─ Devices     /me/devices  ├─ Users         /admin/users
├─ Book            /book/:uid   │   (OPDS, Kobo)            │   └─ User      /admin/users/:id
├─ Author          /author/:id  ├─ Delivery    /me/delivery ├─ Library       /admin/library
├─ Series          /series/:id  │   (email, Telegram)       │   (sources, reindex, filters)
├─ Genre           /genre/:code ├─ Preferences /me/prefs    ├─ Integrations  /admin/integrations
├─ For you         /discover    └─ Data        /me/data     │   (Telegram bot, SMTP, ABS)
├─ Lists           /lists           (export, import)        ├─ Storage       /admin/storage
│  └─ List         /lists/:id                               ├─ Backups       /admin/backups
└─ Reader          /read/:uid                               └─ Event log     /admin/log
```

Routes keep the `#/` prefix the app uses today (`/#/book/123`, `/#/admin/users`). The server
already owns `/book`, `/cover`, `/opds` and `/kobo` for files and device protocols, and the hash
keeps app pages out of their way with no server change. Old routes (`/#/author?...`,
`/#/reader?bookUid=`) redirect to the new ones, so existing
bookmarks and PWA shortcuts keep working.

### App shell

- **Desktop (≥ 1024 px):** a left rail (Home, Search, For you, Lists, and Admin for admins),
  a top bar with the omnibox, an avatar menu (Account, Devices, Preferences, theme, Sign out),
  and the content area.
- **Tablet:** the rail collapses to icons with labels underneath.
- **Phone:** a bottom tab bar (Home · Search · Lists · Me). Filters open as a bottom sheet.
  Admin is reached from Me.
- **Reader:** full screen with no shell. Its Back button returns to the page you came from.

### Sign-in

- A real `/login` page replaces the profile dropdown, status chip and lock icon.
- Guests can browse the catalog **by default** (admin can turn it off). Guests see the
  library, and personal features show a "Sign in to keep lists and progress" prompt.
- Accounts are created by the admin only. There is no sign-up page.
- SSO (`profileBoundId`) skips `/login`. The avatar menu shows "Signed in via SSO".

---

## 4. Screens

### 4.1 Home

In order:
1. **Continue reading:** covers with progress bars, opening the reader at your last position.
   This replaces the profile dialog's "Reading" tab.
2. **New in the library:** last import, grouped by date ("Added 3 Oct · 1,284 books").
3. **From your lists** and **Unfinished series** (existing discovery shelves).
4. **Browse:** genre tiles with counts and languages present.

Shelves are horizontally scrollable on mobile. Each one has a "See all" link that goes to a
search with the matching filter (`/search?added=7d`).

### 4.2 Search (the main change)

**Omnibox with typeahead.** Suggestions are grouped while typing (debounced at 150 ms):

```
булгоков
  Did you mean Булгаков?
  AUTHORS   Булгаков Михаил Афанасьевич        214 books
  SERIES    —
  BOOKS     Мастер и Маргарита — Булгаков М.   fb2 · ru
            Собачье сердце — Булгаков М.
  GENRES    —
  ↵ Search everything for "булгоков"
```

Picking an author goes straight to `/author/:id`. Enter goes to `/search?q=...`.

**Results page:**
- Tabs with counts: *Books (1,240) · Authors (12) · Series (31)*. Books is the default. The tab
  that best matches the query comes first: if the query exactly matches an author, an author
  card is pinned above the books.
- **Facet sidebar** (a bottom sheet on mobile): Language, Genre (tree, top 8 + "more"),
  Format, Rating, Added (7 d / 30 d / 1 y / range), Source (multi-INPX), and "Hide copies".
  Each value shows its count for the current query. Applied facets appear as removable chips
  above the results.
- Sort: Relevance (default), Title, Author, Newest, Rating.
- Views: **List** (dense rows: title, author, series #, language, format, size, rating) and
  **Covers** (grid). The choice is remembered per user. This replaces "card view" and the five
  "show X" toggles.
- Rows are grouped **by series** when sorted by author, as now, but with collapsible headers
  and "Read series" progress.
- Bulk select: add to list, download as zip, send to Kobo.

**Power syntax** is kept for experts, as field filters typed in the same box:
`author:стругацк lang:ru genre:sf_social series:"Мир Полудня" -genre:det`, plus the existing
`=`, `*`, `~` on a field (`title:=Пикник на обочине`). The help popover documents it. Nobody has
to read it to get good results.

### 4.3 Book page `/book/:uid`

- Cover, title, authors (links), series with number (link), genres (links), language, year,
  file size, date added, source, rating.
- Primary: **Read** (or **Continue · 43%**). Secondary: **Download** (split button with format:
  fb2, epub, mobi/azw3 when the converter is set up), **Add to list**, **Send** (Kobo / email /
  Telegram, showing only what is configured for this user), **Mark as read**.
- Annotation, table of contents, "About the author" (existing `BookInfoDialog` content).
- "More in this series" strip with read state, and "More by this author".
- Admin only: **Edit metadata** (inline, on the same page) and **Rebuild cover**.
- On desktop it opens as a **side panel** over the results when clicked from a list, so the
  user keeps their place, and as a full page when opened from a direct link.

### 4.4 Author `/author/:id` and series `/series/:id`

- Author: name, aliases, book count, languages. Series blocks with read progress
  ("Мир Полудня · 6 of 11 read"), then standalone books. Actions: "Add all to list",
  "Follow author", which feeds "New from authors you follow" on Home (new, cheap: query on import).
- Series: ordered list with numbers, gaps marked ("#4 missing in library"), "Read next" button,
  "Add series to list" (exists server-side as `add-series-to-reading-list`).

### 4.5 Lists `/lists`, `/lists/:id`

There is one place for lists. It replaces `ReadingListsDialog` and the profile "Lists" tab.

- Left: my lists with counts and progress (`12 / 30 read`), plus built-in lists
  **Reading now** (from reader progress) and **Finished**.
- Right: the list as a table with drag-to-reorder, a read checkbox, remove, and the same row
  layout as search results.
- List header shows where the list is available, each as a toggle:
  **Show in OPDS** (current `visibility: 'opds'`) and **Sync to Kobo: device name**
  (current Kobo list scoping). This is where those settings belong, because they belong to the list.
- Export / import (JSON) in the list menu.

"Add to list" everywhere is a small popover: a checkbox per list and "New list…".

### 4.6 Me (personal settings)

| Section | Contents (all exist server-side today) |
|---|---|
| **Account** | Display name, login, change password (current + new + confirm), sessions / sign out everywhere |
| **Devices** | **OPDS:** on/off for me, catalog URL with copy, "require password" toggle, the lists exposed via OPDS. **Kobo:** devices (name, last sync, books on device, pending refresh), "Add device" → shows `api_endpoint=` line and a 3-step setup guide, per device: synced lists, Refresh, Regenerate token, Remove |
| **Delivery** | Email address (Send-to-Kindle style), personal Telegram chat id, with a "Send test" button each |
| **Preferences** | Interface language, theme (system / light / dark), results per page, default view, Home shelves on/off and order, "only unread in For you" |
| **Data** | Export / import reading lists, progress and bookmarks; clear reading history |

Each section saves on its own with a "Saved" toast. There is no global Save button, unlike the
current profile card's floppy icon.

### 4.7 Admin console `/admin`

Its own layout: a second-level nav on the left and a "Back to library" link.

- **Overview:** health (worker state, DB loaded, last import, INPX hash), library stats
  (books, authors, series, languages, size), process (memory, uptime), storage use bars,
  recommendation quality (existing discovery metrics), recent events.
- **Users:** a table with name, login, role, last active, OPDS on, Kobo devices, lists and
  status. Actions: create user (name, login, temporary password or generated one shown once),
  reset password, disable, delete, "sign in as" (optional). The detail page `/admin/users/:id`
  edits the same fields as *Me*. Global settings live here too: guests can browse, require login,
  no self-registration: accounts are admin-created.
- **Library:** INPX sources (path, status, books, last scan, Diagnose), Reindex now, the
  author/book filter (`filter.json` editor with preview count), and the external discovery source.
- **Integrations:** Telegram bot, SMTP, Audiobookshelf, converter tools (`fb2cng`, Silero TTS)
  status, each with "Test".
- **Storage:** book cache and cover cache size and limits, the rotation schedule, and
  clean / clean broken covers.
- **Backups:** create, download, import/restore with a dry-run summary, and export/import of settings.
- **Event log:** filterable table (level, source, user, time). Retention settings at the bottom.

### 4.8 Reader

Keep it as it is. Change only these:
- Route `/read/:uid` (old `/reader?bookUid=` redirects).
- The top-left Back button returns to the previous page. A book-title tap opens the book page.
- The reader's "My places" and the start screen use the same "Continue reading" data as Home.

---

## 5. Visual system

- **Design tokens** (CSS custom properties) for color, type, radius, spacing and elevation, in
  one `tokens.css`, with light and dark sets. Quasar components are themed from these through
  its brand variables. No more `bg-cyan-2`/`bg-yellow-1` utility colors in templates.
- **Type:** a reading serif for book titles and the reader (Literata already fits; it has full
  Cyrillic), and a neutral sans for UI (IBM Plex Sans or the system stack). Tabular numbers for
  counts and sizes.
- **Color:** a calm neutral with a single accent (bookcloth green in the prototype). Semantic
  colors only for state: read, new, error, warning.
- **Covers:** generated typographic placeholder covers (title, author, a color from the genre)
  when a book has no cover. That is most INPX books, and today's grey boxes look broken.
- **Labels on actions.** Icon-only buttons only for universally known icons (close, more, search).
- **Density:** comfortable by default, with a compact mode in Preferences. That is the only
  display preference.
- Accessibility: visible focus, keyboard navigation in results (`j/k`, `Enter`, `/` focuses
  search, already partially present via `keyHooks`), `prefers-reduced-motion`.

---

## 6. Data layer: SQLite with FTS5

### 6.1 Why change

Search quality is the core of the product, and JembaDb has no full-text index, ranking or fuzzy
matching. Today every search mode is hand-built prefix scanning over per-field tables
(`DbSearcher.js`, 1,300 lines) plus a query cache. User data is kept in JSON files
(`reading-lists.json`, profile store, Kobo store) with hand-written atomic write and
backup logic (`ReadingListStore.js`, 2,000 lines).

### 6.2 Recommendation: `node:sqlite` (built into Node)

Node 24 ships SQLite 3.53 with FTS5 and the **trigram** tokenizer compiled in. I checked this
on the project's Node (v24.21.0). That means:
- No native module, so `pkg` single binaries, the Windows installer, Docker and LXC all keep
  working unchanged.
- One file per database, easy to back up (the existing backup feature copies a file).

Two databases:
- `catalog.db` is rebuilt from INPX exactly as JembaDb is now: disposable and derived.
- `user.db` holds users, sessions, lists, list items, reading progress, bookmarks, Kobo devices
  and sync state, discovery events and settings. It is transactional and replaces the JSON stores.

Note: `node:sqlite` is still marked release-candidate in Node 24 (it may print an
ExperimentalWarning). The fallback is `better-sqlite3` with the same SQL, at the cost of a native
module in packaging.

### 6.3 Catalog schema (sketch)

```sql
book(id, uid, title, title_norm, lang, ext, size, date_added, librate, year,
     source_id, file, folder, deleted, copy_key)
author(id, name, name_norm, book_count)
series(id, name, name_norm, book_count)
book_author(book_id, author_id, pos)
book_series(book_id, series_id, serno)
book_genre(book_id, genre_code)
-- full text
book_fts   USING fts5(title, authors, series, content='', tokenize='unicode61 remove_diacritics 2', prefix='2 3')
entity_tri USING fts5(kind UNINDEXED, ref UNINDEXED, name, tokenize='trigram remove_diacritics 1')
```

### 6.4 Matching pipeline

1. **Normalize** query and index the same way: lowercase, `ё→е`, strip punctuation and quotes
   (this replaces `titleSearchLeadingChars`), collapse spaces.
2. **Keyboard layout fix:** if the query is Latin and has no hits, retry it mapped through
   the QWERTY→ЙЦУКЕН table (`ghbdtn` → `привет`), and the other way round.
3. **Word prefix match** on `book_fts` (`булг* мастер*`), ranked by bm25 with column weights
   (title > authors > series).
4. **Substring** via `entity_tri` for authors and series (`гацк` finds Стругацкие).
5. **Typo tolerance:** if steps 3–4 return little, take trigram candidates (OR of the query's
   trigrams) from the small author and series name tables, re-rank in JS by
   Damerau-Levenshtein / trigram similarity, and show "Did you mean …".
6. **Boost:** exact > prefix > fuzzy, then by book count (authors) or rating and recency (books).
7. **Facet counts:** `GROUP BY` over the matched id set (a temp table) for lang, ext,
   genre and source. That is fast with indexes at INPX scale.

Measured on synthetic data at the target size (**700k books, 200k authors**), in memory, on the
current machine with Node 24.21:

| Operation | Time |
|---|---|
| Build both FTS indexes | 9 s |
| Word-prefix query on books (1,000 hits) | 2.5 ms |
| Substring match on authors (`улгак`) | 0.1 ms |
| Typo fix on authors (`булгоков`, `булгкаов` → Булгаков), trigram candidates + Levenshtein | 26–42 ms |
| Process memory | 300 MB |

The synthetic names are built from a small syllable set, so they look more alike than real names.
Real typo lookups should be the same speed or faster. Re-check on the real INPX in phase 3.

### 6.5 Alternatives considered

| Option | Verdict |
|---|---|
| Meilisearch / Typesense | Best typo tolerance with no code, but a second service: it breaks the single binary, Windows installer and LXC script, and adds 300–500 MB RAM. Could be an optional "advanced search backend" later. |
| FlexSearch / MiniSearch (in-process JS) | No new dependency, but the whole index sits in the JS heap (1–2 GB for a full library), rebuilds on every start, and does nothing for user data. |
| PostgreSQL + pg_trgm | Excellent, but too heavy for a home server app. |
| Keep JembaDb, add an n-gram table by hand | Reimplements FTS badly. The existing 1,300-line searcher is the evidence. |

OPDS keeps working: `opdsQuery`, `getAuthorBookList` and similar move onto SQL behind the
same method signatures.

---

## 7. API changes

The WebSocket action API stays. Additions:
- `suggest {q}` → grouped typeahead (authors, series, books, genres; 5 each, with counts).
- `search {q, filters, sort, page}` → `{items, total, facets, didYouMean}`, a single endpoint
  that replaces `search`, `bookSearch`, and the separate author/series/title modes.
- `get-book {uid}`, `get-author {id}`, `get-series {id}` for the entity pages.
- Admin actions are grouped under `admin-*` (most already are).

---

## 8. Delivery plan

Each phase can ship alone.

| Phase | Scope | Risk |
|---|---|---|
| **1. Shell and routes** | Tokens, app shell (rail / tab bar / avatar menu), `/login`, `/me/*` and `/admin/*` as pages built from the **existing** dialog components split up. Old routes redirect. No backend change. | Low. Mostly moving templates. |
| **2. Entity pages** | `/book`, `/author`, `/series`, `/lists`. Home with Continue reading. Reader route change. Placeholder covers. | Low–medium |
| **3. Search backend** | `catalog.db` on SQLite built alongside JembaDb behind a config flag. `suggest` and `search` actions. Re-benchmark on the real INPX (700k books). | Medium. The core of the work. |
| **4. Search UI** | Omnibox and typeahead, results with facets, power syntax. Remove the old 4-field form. | Medium |
| **5. User data** | `user.db`, a one-time migration from the JSON stores (keeping the JSON as a backup), drop JembaDb. | Medium. Needs a careful migration and a rollback path. |

**Remove along the way:** the display checkboxes (show counts / rates / Info / genres / dates),
"cache requests", the "Collection" header line, the logo-as-reset link, the profile dropdown and
status chip, `ReadingListsDialog`, and the admin blocks inside `SettingsDialog`.

---

## 9. Decisions

1. Accounts are created by the admin only. There is no self-registration.
2. Guest browsing is on by default, and the admin can turn it off.
3. Target size: 200,000 authors and 700,000 books (benchmarked above).
4. URLs keep the `#/` prefix. Every page still gets its own link, and Back works. Dropping the
   prefix would only make links look tidier, and the new page names would clash with the
   server's existing `/book` and `/cover` file paths.
