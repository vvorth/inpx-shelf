# Kobo Sync for inpx-web: integration research

**Goal:** a Kobo e-reader syncs **only the books in a chosen inpx-web reading list**, using
the Kobo's built-in sync (no USB, no sideloading), modelled on Calibre-Web's Kobo sync.

**Related files:**

* [`docs/kobo-protocol.md`](./kobo-protocol.md): the Kobo sync protocol (endpoints, sync exchange,
  payloads, reading state, collections, store proxying), Calibre-Web's reference implementation and
  how inpx-web handles its quirks.
* [`README.md`](../README.md), section «Синхронизация с Kobo»: setup and behaviour from the user's side.
* [`server/core/kobo/`](../server/core/kobo/) and [`scripts/kobo-sync-tests.js`](../scripts/kobo-sync-tests.js):
  the code and the tests, which show the expected behaviour.

> **Status:** Option C was chosen and **Phase 1 is implemented** (see [§6](#6-phase-1-implementation)).

---

## TL;DR / recommendation

| | Option | Verdict |
|---|---|---|
| A | **Separate bridge service that reads an inpx-web OPDS reading-list URL** (the original idea) | Works as a read-only MVP, but it fights OPDS at every step: N+1 crawling, fake `updated` timestamps, no KEPUB link in the feed, no way to write "finished" back. Making it robust needs inpx-web changes anyway. |
| B | **Calibre-Web as the Kobo server, fed by inpx-web** (import list → calibre library → kobo shelf) | Quickest way to a working device because all of Calibre-Web's Kobo code is reused, but it adds a second library, duplicate files, read status kept in the wrong app, and Calibre-Web's shelf-removal gap. Good stopgap only. |
| C | **Native `kobo` module inside inpx-web, scoped to reading lists bound to a device** | **Recommended.** It sits next to the data it needs (lists, conversion, covers, read flags), and it allows real two-way read status and removal from the device. About the size of the existing OPDS module. |

The core of the "better logic" (it applies to A and C):

1. **Bind a device to one or more reading lists**, not to the whole library. The list is the
   single source of truth: *in the list ⇒ on the Kobo; out of the list ⇒ removed from the Kobo.*
2. **Diff snapshots instead of timestamps.** inpx-web list entries have no `addedAt`, and
   OPDS `updated` is always "now", so Calibre-Web's timestamp cursors don't fit. Keep a per-device
   set of books already sent and compute `added = list − sent` and `removed = sent − list` on every sync.
   Lists are small, so this is cheap and naturally correct for removals, which Calibre-Web's shelf mode
   doesn't handle.
3. **Two-way "read":** *Finished* on the Kobo sets the entry's `read` flag in the inpx-web list,
   and ticking "read" in the web UI sends `ChangedReadingState` to the Kobo. Optionally, books
   finished more than N days ago drop off the device automatically, so the list works as a **reading queue**.
4. **Each bound list appears as a Kobo collection** (`Tag`) on the device.
5. **Convert before announcing.** FB2 → KEPUB happens when a book is added to a Kobo-bound
   list (or at the latest during sync). A book is announced only once the file and its exact
   `Size` exist, so the device never gets a link to a file that's still being converted.
6. **Stable Kobo IDs:** a UUIDv5 derived from `sourceId:libid` (falling back to `_uid`), so
   re-indexing an INPX doesn't make the Kobo delete and re-download books.

---

## 1. What inpx-web already has (relevant facts)

| Area | Facts (source) |
|---|---|
| Profiles | Users in `reading-lists.json` (`server/core/ReadingListStore.js`): `id`, `login`, scrypt `passwordHash`, `opdsEnabled`, `opdsAuthEnabled`, `readerProgress{bookUid→{percent,…,updatedAt}}` |
| Reading lists | `{id, userId, name, visibility:'private'|'opds', createdAt, updatedAt, books:[{bookUid, read}]}`. **No per-entry timestamp.** Changed via `setBookMembership`, `addBooks`, `setBookRead`, `setBooksRead` (also updates global progress) |
| Book identity | `_uid` = **base64 SHA-256 of the whole INP line** (`server/core/InpxParser.js:140`). It contains `+ / =` and **changes if the INP line changes**, for example when a library update rewrites it. Records also carry `libid`, `sourceId`, `folder`, `file`, `ext`, `lang`, `series`, `serno`, `author`, `title`, `genre`, `date`, `size` |
| OPDS reading list | `GET /opds/reading-lists/list?id=<listId>&user=<profile>` (`server/core/opds/ReadingListPage.js`): a **navigation** feed. Each entry is `id=_uid`, the title is decorated (`✓ `, `serno.`, `(fb2)`), there's a localized subtitle, and it links to `/opds/book?uid=…`. No acquisition links, no metadata, `updated` = request time (`BasePage.makeEntry`) |
| OPDS book | `GET /opds/book?uid=` (`BookPage.js`): FB2 calls `getBookInfo` (prepares the book and parses FB2), then links only the **raw** file (fb2/epub/…). **No EPUB/KEPUB link in OPDS** |
| Downloads and conversion | `GET /book/by-uid?uid=&format=kepub` → `302` to `/book/<hash>/kepub` → `BookConverter.prepareConvertedFile` (fb2cng), cached per hash. Conversion works only from **FB2** (`canConvertSourceTo`): EPUB sources are served as-is. Queue: 2 concurrent, 16 waiting, 120 s timeout. `runtime-lite` image has no conversion |
| Covers | `GET /cover/by-uid?uid=` (cached; FB2 cover, FLibrary covers) |
| Auth | Optional proxy SSO (`Security.verifyRequiredAuth`), `allowAnonymousAccess`, OPDS Basic auth per profile (`opds/Auth.js`, `ProfileAccess.basicIdentity`), login rate limiting. **Precedent:** the Audiobookshelf provider authenticates its own routes with a dedicated token and bypasses `verifyRequiredAuth` (`Security.js:360`, `AudiobookshelfProvider.js`) — the same pattern fits Kobo |
| App wiring | `server/index.js`: `security.middleware` → `requiredAuthMiddleware` → `opds(...)` → ABS → health → static. Server-side actions go through `WebWorker` (`server/core/WebWorker.js`: `getReadingList`, `getBookRecordByUid`, `getBookLink`, `getBookInfo`, `getBookCover`, `setBooksRead`, …) |

### What a Kobo needs vs. what's available

| Kobo needs | inpx-web today | Gap |
|---|---|---|
| Stable UUID per book | `_uid` (not a UUID, not stable across re-index) | Derive UUIDv5 and keep a map |
| Book set + changes | List of `bookUid`s, no timestamps | Snapshot diff per device |
| EPUB/KEPUB file + exact `Size` | On-demand FB2→KEPUB (slow), raw EPUB | Pre-convert, then report the real size |
| Metadata (title, authors, series, language, description, date) | INPX record + FB2 annotation (`getBookInfo`) | Map fields |
| Cover by UUID with requested size | `/cover/by-uid` (original size) | Resize, or serve original |
| Reading state store | `readerProgress` (web FB2 reader positions, not Kobo locations) and list `read` flag | Separate Kobo state; map only *Finished* ↔ `read` (+ % for display) |
| Collections | Reading lists | List → `Tag` |
| Token auth in URL | ABS-style token precedent | New per-device token |

---

## 2. Option A: separate bridge reading an OPDS URL

**How it would work.** A small service (in Python, port Calibre-Web's `kobo.py` + `SyncToken.py`)
is configured with an inpx-web base URL, profile, list id and Basic-auth credentials. On each
`/v1/library/sync`:

1. `GET /opds/reading-lists/list?id=L&user=P`, collecting entry `<id>`s (= `_uid`s).
2. Diff against the bridge's `synced` table.
3. For each new uid: `GET /opds/book?uid=…` to get metadata, then
   `GET /book/by-uid?uid=…&format=kepub` (not an OPDS link; inpx-specific) to download and cache
   the file locally to learn its size, plus the cover from `/cover/by-uid`.
4. Emit entitlements. Removed uids get `IsRemoved:true`.
5. Serve downloads and covers from the bridge cache, and store reading state in the bridge DB.

**Pros:** zero changes to inpx-web; easy to drop or replace; could in principle work with
other OPDS servers (but step 3 is inpx-specific).

**Cons and blockers:**

* **N+1 crawling.** The list feed is navigation-only, so one request is needed per book, and for FB2 the `/opds/book` page prepares the book and parses it (slow on first hit).
* **Titles are decorated and localized** (`✓ 3. Title (fb2)`, `Серия: …`), so metadata has to come from the per-book page and be scraped from HTML content.
* **No useful timestamps** (`updated` = now) and no `addedAt`, so diffing is the only option (fine, but it means bookkeeping in the bridge).
* **Read-only.** OPDS can't set the `read` flag back, so finishing a book on the Kobo never reaches inpx-web. There's no other HTTP API (writes go over WebSocket with profile sessions).
* A **second file cache**: the bridge has to hold KEPUBs to know `Size` and to stay fast.
* Auth on `/book/*` accepts Basic credentials only when `allowAnonymousAccess=false`, otherwise it's open. The bridge needs to handle both.
* Two services, two configs, two places to back up.

**Making A decent requires small inpx-web changes anyway:**

1. An **acquisition** feed for lists (`/opds/reading-lists/list?…&kind=acquisition` or `.json`)
   with full entries: clean title, authors, series/serno, lang, `dc:identifier` (uid + libid),
   annotation, cover link, **direct `kepub`/`epub` acquisition links**, and list entry `read`.
2. A token-authenticated write endpoint to set `read` on a list entry.

Once those exist, about 70% of the work is already inside inpx-web, which is the argument for Option C.

## 3. Option B: Calibre-Web as the Kobo server, inpx-web as the source

Add a scheduled task to Calibre-Web: "mirror an inpx-web OPDS list into shelf X":

* Poll the list feed; for each new uid, download `format=epub` (fb2cng) from inpx-web, add it to
  the Calibre library through `uploader`, and put it on a shelf with `kobo_sync=1`.
* For uids gone from the list, archive the book (`change_archived_books(..., True)`) so the Kobo
  removes it. This is needed because Calibre-Web doesn't remove books from the device when they leave a shelf
  (see [`kobo-protocol.md`](./kobo-protocol.md) §11, quirk 1).

**Pros:** all of the Kobo protocol is already done and tested (state, tags, store proxy, KEPUB through kepubify).
**Cons:** you run Calibre-Web plus a Calibre library just as a sync cache, with duplicate files and
metadata reduced to what's embedded in the converted EPUB. Read status ends up in Calibre-Web,
not inpx-web, unless you also build a write-back. Two apps to keep in sync forever.

It's a reasonable **weekend stopgap** if you want a Kobo syncing today. It's not the long-term design.

## 4. Option C (recommended): native Kobo module in inpx-web

### 4.1 User-facing model

* **Profile → "Kobo devices"**: *Add device* (name + one or more of *my* reading lists). This
  shows the line `api_endpoint=https://<host>/kobo/<token>` **once**; you paste it into
  `.kobo/Kobo/Kobo eReader.conf` under `[OneStoreServices]`. Other actions: *Revoke*, *Force resync*,
  *Remove finished after N days* (off by default).
* **List menu → "Sync to Kobo…"** is a shortcut for binding the list to a device. Binding is
  independent of `private/opds` visibility.
* **Admin:** global enable switch, public base URL (needed for absolute URLs behind a reverse
  proxy, the same issue as Calibre-Web's `config_external_port`), and optional proxying to the Kobo Store.

### 4.2 Storage (`<dataDir>/kobo-sync.json`, written atomically through `FilePersistence` like the other stores)

```js
{
  version: 1,
  devices: [{
    id, userId, name,
    tokenHash,            // sha256 of the token; the token is shown once (like the ABS token)
    listIds: [],          // lists owned by userId
    removeFinishedAfterDays: 0,
    createdAt, lastSyncAt,
    generation: 0,        // bump = force resync (device sees an unknown token → full)
    books: {              // what the device has been told
      [koboUuid]: { bookUid, stableKey, sentAt, revision, size, format, removed: false,
                    lastStatus: 'ReadyToRead'|'Reading'|'Finished' }
    },
    tags: { [listId]: { tagId, name, itemsHash, deleted: false } },
  }],
  states: {               // per user, Kobo-native reading state (opaque to the web reader)
    [userId]: { [koboUuid]: { bookmark:{ProgressPercent, ContentSourceProgressPercent, Location},
                              statistics:{SpentReadingMinutes, RemainingTimeMinutes},
                              status:{Status, TimesStartedReading, LastTimeStartedReading},
                              lastModified, priorityTimestamp } }
  }
}
```

Per **device**, not per user, so two Kobos on one profile don't fight (Calibre-Web quirk 6 in [`kobo-protocol.md`](./kobo-protocol.md) §11).

### 4.3 IDs

```js
const stableKey = book.libid ? `${book.sourceId}:${book.libid}` : book._uid;
const koboUuid = uuidv5(stableKey, INPX_KOBO_NAMESPACE);
```

* `koboUuid` is used for every id field (`Id`, `RevisionId`, `CrossRevisionId`,
  `EntitlementId`, `WorkId`, `CoverImageId`).
* On each sync, re-resolve `koboUuid → current bookUid`. If a list entry's `_uid` no longer
  resolves (INP line rewritten), look the record up by `stableKey` and **re-key the list entry**
  instead of treating it as removed.
* **Never send `IsRemoved` for a book that is still in the list but missing from the DB** (for
  example during re-indexing). Hold it as "orphan" until it reappears or the user removes it.

### 4.4 Endpoints (`server/core/kobo/index.js`, mounted at `/kobo/:token`)

| Phase | Route | Implementation |
|---|---|---|
| 1 | `GET v1/initialization` | Built-in resources list (copy Calibre-Web's `NATIVE_KOBO_RESOURCES`), overriding `library_sync`, `image_host`, `image_url_template`, `image_url_quality_template` with public URLs; header `x-kobo-apitoken: e30=` |
| 1 | `POST v1/auth/device`, `v1/auth/refresh` | Dummy tokens (Calibre-Web's `make_calibre_web_auth_response`) |
| 1 | `GET v1/library/sync` | §4.5 |
| 1 | `GET v1/library/:uuid/metadata` | `[metadata(book)]` |
| 1 | `GET/PUT v1/library/:uuid/state` | §4.6 |
| 1 | `DELETE v1/library/:uuid` | User deleted the book on the device: remove it from the device's bound list(s) (configurable: *remove from list* or *mark read*); otherwise the next sync would push it again |
| 1 | `GET /:uuid/:w/:h[/:q]/:grey/image.jpg` | `getBookCover` (reuse the `/cover/by-uid` cache); serve the original, or add a resize step (there's no resizer in `ImageUtils` today); long cache |
| 1 | `GET download/:uuid.:fmt` | Serve the prepared KEPUB/EPUB **directly** (no 302), `Content-Type: application/epub+zip`, filename `*.kepub.epub` |
| 1 | everything else under `/kobo/:token/*` | `200 {}` (plus Calibre-Web's small stubs for `loyalty/benefits`, `analytics/gettests`) |
| 2 | `POST v1/library/tags`, `PUT/DELETE v1/library/tags/:id`, `POST …/items`, `…/items/delete` | Map device collection edits to list membership, or answer `404` for collections that aren't bound lists |
| 3 | Kobo Store proxying | Only if you have purchased Kobo books; port `redirect_or_proxy_request` and the store-token merge |

Wiring: register before `static`. In `Security.verifyRequiredAuth`, accept `/kobo/<valid token>/…`
the same way it already accepts ABS requests (the device can't do SSO), and count failed tokens
with `security.checkLoginRate(req, 'kobo')`. Don't apply `ProfileAccess.httpGuard` to these routes.

### 4.5 Sync algorithm (snapshot diff)

```
device = byToken(token); if !device → 401
if header token missing/foreign or token.generation != device.generation:
    device.books = {}  (full resync; tags too)

want = ordered union of entries of device.listIds (owner = device.userId)
       → resolve each to {book, koboUuid}; orphans skipped (not removed)
sent = device.books where !removed

results = []
# 1) removals (cheap, do first)
for uuid in sent − want:          results += ChangedEntitlement(IsRemoved: true); mark removed
# 2) finished-and-expired (optional queue mode)
for e in want where e.read && finishedAt + N days < now:  same as removal (and optionally drop from list)
# 3) additions, only when the file is ready
for e in want − sent (in list order):
    f = conversionCache.ready(e)  # KEPUB for fb2, raw EPUB for epub, skip others
    if !f: enqueue conversion; pending = true; continue
    results += NewEntitlement{BookEntitlement, BookMetadata(f.size), ReadingState?}
    device.books[uuid] = {..., revision: hash(metadata, f.size)}
    stop at 100 items → more = true
# 4) changes: metadata override / file revision changed → ChangedEntitlement
# 5) read flag ↔ Kobo status
for e in want ∩ sent where (e.read ? 'Finished' : state.status) != books[uuid].lastStatus:
    results += ChangedReadingState(...)
# 6) collections: per bound list, NewTag/ChangedTag when name or items hash changed;
#    DeletedTag when a list was unbound or deleted
headers: x-kobo-synctoken = b64({v:1, gen: device.generation, ts: now})
         x-kobo-sync: continue   only if `more` (NOT for `pending`: the device would spin)
save device
```

Pending conversions are picked up on the next sync. To make that rare, **pre-warm**: when a book
is added to a Kobo-bound list (hook `setBookMembership` / `addBooks` in `WebWorker`), enqueue the
KEPUB conversion in the background, respecting the existing conversion queue limits.

### 4.6 Reading state mapping

* `PUT …/state`: store bookmark, statistics and status in `states` (port Calibre-Web's handler 1:1)
  and reply `UpdateResults` with `LastModified`/`PriorityTimestamp`. Then:
  * `Status == 'Finished'` → `setBookRead(userId, listId, bookUid, true)` for each bound list
    containing it (or `setBooksRead`, which also marks global progress as finished).
  * `Status == 'Reading'` → optionally set `read=false`.
  * `ProgressPercent` → optional (phase 2): write `readerProgress[bookUid].percent` **only if**
    the web reader has no newer position, so the web UI's "continue reading" shows Kobo progress.
    The Kobo location (`kobo.N.M` span ids in KEPUB) can't be mapped to the FB2 reader's
    section/offset, so this is percent only.
* `GET …/state` and sync: return the stored Kobo state; if the list `read` flag disagrees, override
  `StatusInfo.Status` (Finished/ReadyToRead) and bump `LastModified` so the device accepts it.

### 4.7 Metadata mapping (inpx record → `BookMetadata`)

| Kobo | inpx-web |
|---|---|
| `Title` | `title` (metadata overrides applied via `applyMetadataOverridesToSearchResult`) |
| `Contributors` / `ContributorRoles` | `author.split(',')` |
| `Series{Name,Number,NumberFloat,Id}` | `series`, `serno`, `uuidv5(series)` |
| `Language` | `lang` (already 2-letter in most INPX) |
| `Description` | FB2 annotation (`getBookInfo` → `Fb2Parser.bookInfo().titleInfo.annotationHtml`), captured when the file is prepared |
| `PublicationDate` | FB2 publish year if present, else INPX `date` |
| `Publisher.Name` | FB2 publish-info if present |
| `DownloadUrls` | one entry: `KEPUB` (fb2 source) or `EPUB3`/`EPUB` (epub source; `EPUB3FL` if fixed layout) with **exact size** |
| `Created` / `LastModified` | list `createdAt` when first sent / `sentAt` or revision change time |

### 4.8 Edge cases

* **`runtime-lite` image (no converter):** offer only native EPUB books and skip FB2 (log it, show "n books can't sync" in the UI).
* **Non-FB2/EPUB formats** (pdf, djvu, mobi): skip them. The Kobo does read PDF, but Kobo sync for PDF is unreliable, so leave it as a later option.
* **Huge lists:** 100 items per batch with `continue`, like Calibre-Web.
* **Profile deleted or list deleted:** devices for that profile are revoked; a deleted list causes removals plus `DeletedTag` on the next sync.
* **Backups:** include `kobo-sync.json` in `BackupArchive`, excluding token hashes if backups are shareable.
* **Security:** the token is in the URL, so require HTTPS when publicly exposed and mask `/kobo/<token>` in logs (the ABS token travels in a header, so there's no existing URL masking to reuse).

### 4.9 Rough size and phases

* **Phase 1 (done, see §6):** several lists → Kobo, collections (server → device), add/remove with the
  "keep on device" option, covers, downloads, read status both ways, per-device store proxy, UI tab, release tests.
* **Done after Phase 1:** changed files are announced again (see §6, "File changes").
* **Phase 2:** collection edits from the device, percent → web progress, pre-warm hooks on list edits,
  re-keying orphaned list entries by `libid`, `kobo-sync.json` in admin backups.
* **Phase 3:** KEPUB for EPUB sources (bundle `kepubify`), cover resizing, per-device format preferences.

### 4.10 Decisions

1. A delete on the device (`DELETE v1/library/:uuid`) **marks the book read** and stops re-sending it to that
   device while it stays listed. It never edits list membership.
2. **No queue mode:** finished books stay on the device.
3. A device can be bound to **several lists**; each one becomes a Kobo collection.
4. Kobo Store proxying is a **per-device toggle, off by default** (moved from Phase 3 into Phase 1).
5. Added: per-device **"keep books on the device after they leave the list"**. When it's on, leaving every
   bound list sends no `IsRemoved`, and the book stays downloadable and keeps its reading state.

---

## 5. Prior art checked

* **Calibre-Web:** whole library, or only shelves flagged "Kobo sync"; timestamp cursors plus a synced-books table; KEPUB through kepubify; optional store proxy. Removing a book from a shelf doesn't remove it from the device.
* **[Komga](https://komga.org/docs/guides/kobo):** per-user API key in `api_endpoint=https://host/kobo/<api_key>`; EPUB only, KEPUB converted on the fly through kepubify; two-way progress (only approximate for KEPUB, chapter-level for plain EPUB); deletes and edits propagate; scope is all libraries, with one API key recommended per device.
* **[kobobridge](https://pypi.org/project/kobobridge/):** a separate bridge for Audiobookshelf, modelled on Calibre-Web's protocol. It filters by library or collection, stores reading state and **true file sizes** locally, keeps a "first seen in collection" record so books added to a collection later still sync, and can't write progress back to the source. It's a good illustration of Option A's trade-offs.
* **BookLore:** advertises Kobo sync with automatic KEPUB conversion and two-way progress; no public details on how shelves map to the device.

---

## 6. Phase 1 implementation

| Piece | Where |
|---|---|
| Kobo endpoints, sync diff, metadata, reading state, collections, covers, downloads, store proxy | `server/core/kobo/index.js` |
| Device and state persistence (`<dataDir>/kobo-sync.json`, token stored as SHA-256 only) | `server/core/kobo/KoboStore.js` |
| `v1/initialization` defaults (Kobo's own resource list) | `server/core/kobo/resources.js` |
| Token routes bypass proxy SSO; `kobo` login-rate bucket and metrics | `server/core/Security.js` |
| `INPX_KOBO_ENABLED`, `INPX_KOBO_PUBLIC_URL`; `koboEnabled` in the web config | `server/config/base.js` |
| WebSocket actions `get/create/update/delete-kobo-device`, `regenerate-kobo-device-token`, `reset-kobo-device` | `server/controllers/WebSocketController.js` |
| Devices removed with their profile | `WebWorker.deleteUserProfile` |
| Profile dialog → "Kobo" tab | `client/components/Search/UserProfilesDialog/UserProfilesDialog.vue`, `client/components/Api/Api.vue` |
| Release tests (fake Kobo and fake Kobo Store) | `scripts/kobo-sync-tests.js` |

How Phase 1 differs from the plan above:

* **Pre-warm:** there are no hooks on list edits. Conversion starts at sync time instead: at most 2 at once,
  with a 20 s wait budget per sync. Books that aren't ready yet are announced on a later sync, and
  `x-kobo-sync: continue` is never sent just because a conversion is pending.
* **Read flag:** the per-device book row remembers the list's `read` value it last saw (`listRead`). Only a
  change on the web side produces `ChangedReadingState`, so a status reported by the Kobo is never echoed back.
  *Finished* on the Kobo calls `setBooksRead` (all of the profile's lists plus global progress). *Reading* on
  the Kobo never clears the web flag.
* **Fresh sync** (no or foreign `x-kobo-synctoken`, or "Sync again" in the UI): everything is re-sent, except
  books deleted on the device, which stay suppressed.
* **Orphans:** a listed book whose record is missing (for example during a re-index) is skipped and never
  removed. Re-keying list entries by `libid` isn't done yet.
* **Store proxy (per device):** store `Resources` are used for `v1/initialization`; `auth/device|refresh` are
  relayed; store sync results are merged into our final page, with the store's own token carried inside ours;
  unknown books' metadata, state, delete and other store calls are forwarded (GET → `307`, other methods are
  relayed server-side); unknown covers go to `cdn.kobo.com`. With the toggle off, nothing leaves inpx-web: every
  `storeapi.kobo.com` resource URL is rewritten to the device's `/kobo/<token>` base and answered locally.
* **File changes:** Kobo downloads use the same conversion and cache as the web format buttons
  (`WebWorker.getPreparedBookFile` → `BookConverter.prepareConvertedFile`, with `INPX_FB2CNG_CONFIG`). Each
  announced book stores the conversion fingerprint (fb2cng config contents, fb2cng version, converter paths).
  A sync announces a `ChangedEntitlement` with the new `Size` and `LastModified` when the fingerprint changed,
  the target format changed (e.g. KEPUB disabled), or a download found the file regenerated with another size
  (flushed cache). The ids stay the same, so collections and reading state are kept. Whether a Kobo re-downloads
  a book it already has after such an update is untested on hardware.
* **Not yet:** collection edits made on the device (they get `{}`), percent → web reader progress, cover
  resizing (covers are served at original size and type), `kobo-sync.json` in admin backups, re-announcing
  metadata edits (title/author overrides), and KEPUB for EPUB sources. With `logQueries`/development logging on, request URLs
  (including the device token) are written to the log.
* **Untested on hardware:** everything is covered by protocol-level tests and a run against a live server
  (initialization, sync, collection, download, state PUT); it hasn't been tried on a physical Kobo yet.
