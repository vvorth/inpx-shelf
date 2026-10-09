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

> **Status:** Option C was chosen. **Phase 1 and Phase 2 are implemented** (see [§6](#6-implementation); Phase 2
> decisions in [§4.11](#411-phase-2-decisions-and-work-order)). **Phase 3 is implemented** (cover resizing only,
> [§4.12](#412-phase-3-decisions-and-work-order)), and nothing has been tried on a physical Kobo yet.

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
* **Phase 2 (done, decided in §4.11):** collection edits from the device (read-only collections, but a book removed
  from a collection stays out of it), percent → web progress, pre-warm hooks on list edits, re-keying orphaned
  list entries by `libid`, `kobo-sync.json` in admin backups, token masking in logs, re-announcing metadata edits.
* **Phase 3 (done, decided in §4.12):** cover resizing. KEPUB for EPUB sources and per-device format preferences were
  dropped.

### 4.10 Decisions

1. A delete on the device (`DELETE v1/library/:uuid`) stops re-sending the book to that device while it stays
   listed. It never edits list membership, the list's read flag or reading progress. (Phase 1 also marked the
   book read; that was reverted after the review in [`kobo-sync-review.md`](./kobo-sync-review.md), item 3,
   because deleting a book to free space says nothing about having read it.)
2. **No queue mode:** finished books stay on the device.
3. A device can be bound to **several lists**; each one becomes a Kobo collection.
4. Kobo Store proxying is a **per-device toggle, off by default** (moved from Phase 3 into Phase 1).
5. Added: per-device **"keep books on the device after they leave the list"**. When it's on, leaving every
   bound list sends no `IsRemoved`, and the book stays downloadable and keeps its reading state.

### 4.11 Phase 2 decisions and work order

Agreed with the owner on 2026-10-09 so that Phase 2 can be built without further questions. Phase 3 is **out of
scope** for this round. Commits go straight to the `kobo-sync` branch, each one validated with `npm run test:release`
and the matching §6 update.

**Decisions**

1. **Collections stay read-only from the device.** inpx-web lists remain the only source of truth for list
   membership and names. No change made on the Kobo ever adds, removes, renames, deletes or creates a reading list.
   * **A book removed from a bound collection on the Kobo stays out of that collection.** The device keeps the book,
     and the list is not edited. The device row remembers the suppression per list (for example
     `collectionRemoved: [listId, …]`), `tagFor` leaves the book out of that list's `Items`, and later syncs never
     put it back. The suppression for a list is cleared when the book leaves that list in inpx-web, so adding it
     again later puts it back in the collection.
   * **Adding a book to a bound collection on the device:** accept it (`201`/`200`) and change nothing. The next
     `ChangedTag` that the list's own changes produce brings the device back in line with the list.
   * **Renaming or deleting a bound collection on the device:** accept it and change nothing on the server. The
     tag's stored signature is invalidated, so the next sync sends the collection again as the list defines it
     (`ChangedTag`, or `NewTag` after a delete).
   * **Collections created on the device** (not bound lists) stay local: `POST v1/library/tags` answers `201`
     with a fresh id and nothing is stored, and edits to unknown tag ids answer `200`/`204` without storing
     anything. With the store proxy on, requests for unknown tags are relayed to the Kobo Store as today.
   * **Deleting a book on the device** follows decision 1 in §4.10: it's never re-sent or re-downloaded while it
     stays listed.
   * Removing a book from a collection never affects reading state: *Finished* and percent keep syncing for it.
2. **Kobo percent → web reader progress: the newer side wins.** On `PUT …/state`, when the Kobo's
   `LastModified` for the book is newer than `readerProgress[bookUid].updatedAt` (or there's no web entry), write
   `percent = ProgressPercent / 100` and that timestamp. The section, page and text offset are reset, so the web
   reader opens at the percent; the exact page position is lost by design. A newer web position is never
   overwritten. Respect `readerProgressGeneration` and `hidden` the way the web reader does, and don't raise
   `percent` to 1 for *Finished* beyond what `setBooksRead` already does. Web → Kobo percent is not part of Phase 2.
3. **Pre-warm conversion on list edits.** When books are added to a list bound to any device
   (`setBookMembership(…, true)` and `addBooks` going through `WebWorker`), queue the KEPUB/EPUB preparation in the
   background through the same `getPreparedBookFile` path. Don't wait for it, respect the existing converter
   queue limits (a full queue is fine: sync time still converts), and log failures without surfacing them to
   the web request. Binding a list to a device (create or update device) pre-warms that list's books too.
4. **Re-key orphaned list entries by `libid`.** When a listed `bookUid` doesn't resolve but the device row (or
   the stored Kobo uuid) gives a `stableKey` of the form `sourceId:libid`, look the record up by
   `sourceId` + `libid`. If exactly one record matches, rewrite the list entry's `bookUid` in place (keeping `read`
   and order), move `readerProgress`/bookmarks keyed by the old uid, and update the device row. Kobo ids don't
   change, so the device sees nothing. If zero or several records match, keep treating it as an orphan (skip,
   never remove). Entries without a `libid` aren't re-keyed.
5. **`kobo-sync.json` is part of admin backups, token hashes included.** After a restore, devices keep syncing
   without being set up again. The backup already holds `secret.key` and password hashes, so this adds no new kind
   of secret. Restoring a backup without the file leaves the current `kobo-sync.json` alone. Restore validates the
   format the same way `reading-lists.json` is validated.
6. **Mask the device token in logs.** Every place that logs a request URL (`logQueries` in `server/index.js` and
   `server/dev.js`, error logs in the Kobo router, store-proxy logs) writes `/kobo/***/…` instead of the token.
7. **Re-announce metadata edits.** Book metadata is built with the admin's metadata overrides applied
   (`applyMetadataOverridesToSearchResult`). Each device row stores a hash of the announced metadata, and a change
   (title, authors, series, language, description and so on) sends a `ChangedEntitlement` with the same ids,
   the same way file changes are re-announced.

**Work order** (one commit each, tests added to `scripts/kobo-sync-tests.js`):

1. Token masking in logs (6).
2. `kobo-sync.json` in backups (5).
3. Pre-warm on list edits and on binding (3).
4. Re-keying orphans by `libid` (4).
5. Metadata edits re-announced (7).
6. Percent → web progress (2).
7. Collection endpoints: read-only with per-list removal suppression (1).

Afterwards, update §6 (move the items out of "Not yet") and the README section «Синхронизация с Kobo» wherever
the user-visible behaviour changed.

### 4.12 Phase 3 decisions and work order

Agreed with the owner on 2026-10-09. The same rules as Phase 2 apply: commits go straight to `kobo-sync`, each one
validated with `npm run test:release` and the matching §6 update, with tests in `scripts/kobo-sync-tests.js`.

**Decisions**

1. **Covers are resized with a pure-JS library.** No native modules (they break the `pkg` standalone builds and
   complicate arm64/Windows) and no new external binary. The library is picked when the work starts, as the
   smallest one that decodes JPEG and PNG, resizes and encodes JPEG, and it has to survive a `build:linux` `pkg` build.
   * The cover route (`/:uuid/:w/:h[/:q]/:grey/image.jpg`) answers with a JPEG that fits inside the requested
     width and height, keeping the aspect ratio. Covers are never enlarged; a cover already small enough is only
     re-encoded when it isn't JPEG, so the reply always matches the `image.jpg` URL.
   * The source image is the shared cover (`getBookCover` and the `/cover/by-uid` cache, which already turns JXL and
     WebP into PNG). Resized covers are cached on disk per cover cache key and output size, next to the shared cover
     cache, and are served with the existing long `Cache-Control`.
   * `Quality` from the URL is used as the JPEG quality when it's a sane number (clamped), otherwise a fixed default.
     `IsGreyscale` is ignored, because the device converts covers itself.
   * Resizing runs one at a time per process, and a cover that fails to decode or resize is served at its original
     size and type, as it is today. A missing or broken cover never fails the request beyond today's `404`.
2. **No KEPUB for EPUB sources.** The libraries inpx-web hosts are FB2, so `kepubify` would go unused. EPUB
   sources keep being sent as they are (`EPUB3`/`EPUB`).
3. **No per-device format preferences.** The server-wide settings decide the format, as today.

**Work order:** one commit, cover resizing (1).

Afterwards, update §6 ("Not yet") and the README section «Синхронизация с Kobo».

---

## 5. Prior art checked

* **Calibre-Web:** whole library, or only shelves flagged "Kobo sync"; timestamp cursors plus a synced-books table; KEPUB through kepubify; optional store proxy. Removing a book from a shelf doesn't remove it from the device.
* **[Komga](https://komga.org/docs/guides/kobo):** per-user API key in `api_endpoint=https://host/kobo/<api_key>`; EPUB only, KEPUB converted on the fly through kepubify; two-way progress (only approximate for KEPUB, chapter-level for plain EPUB); deletes and edits propagate; scope is all libraries, with one API key recommended per device.
* **[kobobridge](https://pypi.org/project/kobobridge/):** a separate bridge for Audiobookshelf, modelled on Calibre-Web's protocol. It filters by library or collection, stores reading state and **true file sizes** locally, keeps a "first seen in collection" record so books added to a collection later still sync, and can't write progress back to the source. It's a good illustration of Option A's trade-offs.
* **BookLore:** advertises Kobo sync with automatic KEPUB conversion and two-way progress; no public details on how shelves map to the device.

---

## 6. Implementation

| Piece | Where |
|---|---|
| Kobo endpoints, sync diff, metadata, reading state, collections, covers, downloads, store proxy | `server/core/kobo/index.js` |
| Device and state persistence (`<dataDir>/kobo-sync.json`, token stored as SHA-256 only) | `server/core/kobo/KoboStore.js` |
| `v1/initialization` defaults (Kobo's own resource list) | `server/core/kobo/resources.js` |
| Token routes bypass proxy SSO; `kobo` login-rate bucket and metrics | `server/core/Security.js` |
| `INPX_KOBO_ENABLED`, `INPX_KOBO_PUBLIC_URL`; `koboEnabled` in the web config | `server/config/base.js` |
| WebSocket actions `get/create/update/delete-kobo-device`, `regenerate-kobo-device-token`, `reset-kobo-device`, `refresh-kobo-device` | `server/controllers/WebSocketController.js` |
| Devices removed with their profile | `WebWorker.deleteUserProfile` |
| Profile dialog → "Kobo" tab | `client/components/Search/UserProfilesDialog/UserProfilesDialog.vue`, `client/components/Api/Api.vue` |
| Release tests (fake Kobo and fake Kobo Store) | `scripts/kobo-sync-tests.js` |
| Phase 3: Kobo cover resizing to JPEG (`fitToJpeg`) | `server/core/ImageUtils.js` |
| Phase 2: pre-warm hooks on list edits, lookup by `sourceId:libid`, `kobo-sync.json` in admin backups | `server/core/WebWorker.js`, `server/core/BackupArchive.js`, `server/core/BackupTransaction.js` |
| Phase 2: re-keying list entries, progress, bookmarks and metadata edits to a new uid (`rekeyBooks`) | `server/core/ReadingListStore.js` |
| Phase 2: device tokens masked in request logs (`kobo.maskTokens`) | `server/index.js`, `server/dev.js` |

How Phase 1 differs from the plan above:

* **Pre-warm:** conversion also starts at sync time: at most 2 at once, with a 20 s wait budget per sync. Books
  that aren't ready yet are announced on a later sync, and `x-kobo-sync: continue` is never sent just because a
  conversion is pending. Since Phase 2, list edits pre-warm too (see below).
* **Read flag:** the per-device book row remembers the list's `read` value it last saw (`listRead`). Only a
  change on the web side produces `ChangedReadingState`, so a status reported by the Kobo is never echoed back.
  *Finished* on the Kobo calls `setBooksRead` (all of the profile's lists plus global progress). *Reading* on
  the Kobo never clears the web flag.
* **Fresh sync** (no or foreign `x-kobo-synctoken`, or "Sync again" in the UI): everything is re-sent, except
  books deleted on the device, which stay suppressed.
* **Send back books deleted on the device** (per-device `resendDeletedBooks`, off by default): a listed book
  deleted on the device is announced again as a `NewEntitlement` on the next sync, with the same ids and the saved
  `ReadingState`. Off, it stays suppressed until it leaves the device's lists.
* **Refresh books on device** (UI, `refresh-kobo-device`): every book the device has (not deleted on it, not
  kept after leaving the lists) is flagged `refresh`, and the following syncs send each one as a `ChangedEntitlement`
  with the same ids: current title, authors and series, the file's size read again from the conversion cache, a
  new `LastModified`, a download URL with `?rev=<n>` bumped per refresh, and the saved `ReadingState`. A book whose
  file is still converting waits for a later sync. Collections are sent again too. Unlike "Sync again", nothing is
  re-added, so progress and notes on the device stay attached to the book.
* **Orphans:** a listed book whose record is missing (for example during a re-index) is skipped and never
  removed, and it keeps its place in the device's collections. Since Phase 2, entries are re-keyed by `libid` (see below).
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
* **Not planned:** KEPUB for EPUB sources, per-device format preferences (both dropped in §4.12), Web → Kobo
  reading percent.

**Phase 2** (decisions and order in §4.11):

* **Token masking in logs (done):** `kobo.maskTokens()` turns `/kobo/<token>` into `/kobo/***` in the request logs
  of `logQueries` (`server/index.js`) and development mode (`server/dev.js`). The Kobo router's own error and
  store-proxy logs only use the path below the token.
* **Backups (done):** the admin backup ZIP includes `kobo-sync.json` with token hashes (`WebWorker.createAdminBackupSnapshot`,
  `BackupTransaction.targets`). Restore checks that `devices` is an array and `states` an object
  (`BackupArchive.read`), normalizes the file through `KoboStore.normalizeData`, writes it in the same journalled
  transaction as the other files, and swaps the running service's copy so restored tokens work without a restart.
  A backup without the file leaves the current one alone. The device rows are restored as they were at backup time:
  books sent after the backup are announced again (harmless), and a book sent after the backup that's no longer
  in the restored list stays on the device until it's deleted there.
* **Pre-warm on list edits (done):** `WebWorker.updateReadingListBook` (adding), `addSeriesToReadingList` and
  `importReadingLists` call `KoboService.prewarmBooks` / `prewarmLists`; creating a device or changing its lists
  pre-warms every book of its lists. Only lists bound to a device of the list's owner count, and books a device of
  that profile already has are skipped. A background queue (deduplicated, at most 5000 books) prepares one book at
  a time through the same `prepare()` cache the sync uses, so the next sync finds the file ready. A busy shared
  converter (`INPX_CONVERSION_QUEUE_FULL`/`_TIMEOUT`) is no longer treated as a failed book: the entry is dropped
  and retried (by the queue after a short wait, up to 3 times, and by every sync) instead of being blocked for the
  10-minute error back-off. Real conversion errors keep the back-off and are logged once.
* **Re-keying orphans by `libid` (done):** `collectWanted` passes listed uids that don't resolve to
  `KoboService.rekeyOrphans`. For each one that a device row of the profile knows by a `sourceId:libid` stable key,
  `WebWorker.findBookRecordsByStableKeys` looks the keys up in one scan of the book table (there's no `libid`
  index). When exactly one record matches, `ReadingListStore.rekeyBooks` rewrites the profile's list entries (order
  and `read` kept; if both uids were listed they're merged), moves `readerProgress` and `readerBookmarks`, and the
  device rows of the profile's devices get the new `bookUid`. The Kobo id doesn't change, so the device sees
  nothing. Zero or several matches leave the entry an orphan; each key is looked up at most once an hour. Entries
  without a `libid`, entries never sent to a device, and other profiles' lists aren't re-keyed. Collection items
  are now sorted by id and include orphans, so a book dropping out of the DB for a while doesn't change its collection.
  The book's admin metadata edit moves to the new uid as well.
* **Metadata edits re-announced (done):** records are read with the admin's metadata overrides applied
  (`WebWorker.applyMetadataOverrideToBook`: title, authors, series, number), for new books, the metadata endpoint
  and change detection. Each device row stores `metaHash`, a hash of the record-derived fields (title, authors,
  series, number, language). When it differs, the sync sends a `ChangedEntitlement` with the same ids and file
  (combined with a file update when both changed; if the new file isn't ready yet, the metadata goes first).
  Rows from before this change adopt the current hash silently. Description, publisher and year come from the file
  and change only with it, which is already re-announced through the fingerprint and size.
* **Percent → web reader (done):** a state `PUT` with `CurrentBookmark.ProgressPercent` calls
  `KoboService.syncWebProgress`, which writes `readerProgress[bookUid]` through `ReadingListStore.updateReaderProgress`
  as `{percent, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: ''}` with the profile's current progress
  generation. The timestamp is the bookmark's `LastModified` from the device (a page turn read offline keeps its
  time; a clock more than 5 minutes ahead counts as now), and the store keeps a newer web position. `hidden` is left
  as it was. Nothing is written when the percent didn't change or when the Kobo reports 0% for a book with no web
  position. The web reader already restores percent-only positions. Web → Kobo percent isn't sent.
* **Collection edits on the device (done):** `v1/library/tags*` are answered by `KoboService.createTag`,
  `updateTag` and `editTagItems`; no reading list is ever changed from the device. A bound list's tag id is
  `uuidv5('list:<listId>')`.
  * Removing books from a bound collection (`…/items/delete`) records the list in the book row's
    `collectionRemoved`; `tagFor` leaves those books out of that list's collection (orphans too), so they stay on
    the device but outside the collection. At the start of each sync, a row drops the lists the book is no longer in,
    so taking it off the list in inpx-web and adding it again puts it back. Adding books to a bound collection
    (`…/items`, `201`) only lifts that suppression; anything else it added isn't stored and disappears from the
    collection with the next `ChangedTag` the list's own changes produce.
  * Renaming (`PUT`) a bound collection clears its stored signature and deleting (`DELETE`) drops its tag row, so
    the next sync sends it again as the list defines it (`ChangedTag` / `NewTag`). The list stays bound.
  * Collections made on the device and unknown tag ids: `POST v1/library/tags` answers `201` with a fresh id, other
    calls `200`/`201`, and nothing is stored. With the store proxy on, they're relayed to the Kobo Store instead.
  * The sync merges concurrent edits: `collectionRemoved` changed during a sync is kept, and a tag renamed or
    deleted during a sync is sent again on the next one.

**After Phase 3:**

* **Authors from the converted file (done):** the Kobo shows the authors from the sync's `BookMetadata`
  (`Contributors`), not the ones inside the downloaded file, so the record's INPX order ("Фамилия Имя Отчество")
  used to win over a `creator_name_template` in the fb2cng config. Now `prepare()` reads the prepared file's OPF
  `dc:creator` entries without a role or with `opf:role="aut"` (`epubMetadata().authors`), and the device row keeps
  them as `fileAuthors`. `bookAuthors()` sends them unless the admin edited the book's author, which wins; with no
  creators in the file it falls back to the record. They're part of `metaHash`, so a changed name template
  (re-announced through the file fingerprint) or an admin author edit sends a `ChangedEntitlement` with the same
  file. Rows sent before this change read their file once (from the conversion cache) on the next sync and, when the
  names differ, are re-announced the same way, without a download. Rows still using the record's authors keep their
  old hash. Checked against fb2cng 1.2.3 output with the default and a "first name first" template. The title still
  comes from the record.

**Phase 3** (decisions in §4.12):

* **Cover resizing (done):** `KoboService.cover` answers `/:uuid/:w/:h[/:q]/:grey/image.jpg` with a JPEG that fits
  inside the requested box, aspect ratio kept and never enlarged (`ImageUtils.fitToJpeg`, built on the pure-JS
  `jpeg-js` and `pngjs`; transparency is flattened onto white). The source is the shared cover cache that
  `/cover/by-uid` fills, made through `getBookCover` when missing. Results are stored flat in the cover cache as
  `<cover key>-kobo-<w>x<h>-q<quality>.jpg`, so the admin's cover cache limit and cleaning cover them too. Width and
  height are capped at 3000, `Quality` is used when it's 1–100 (raised to at least 30), otherwise 85, and
  `IsGreyscale` is ignored. A JPEG that already fits is stored and sent unchanged. Resizing runs one cover at a time
  on the main thread: a typical FB2 cover takes about 0.1 s and a 1600×2400 JPEG about 0.7 s, once per size. A cover
  that can't be resized (GIF, a damaged file, more than 25 megapixels) is sent at its original size and type, as
  before. Checked with a `build:linux` `pkg` build and `scripts/binary-smoke-test.js`.

* **Untested on hardware:** everything is covered by protocol-level tests. Phase 1 was also run against a live
  server (initialization, sync, collection, download, state PUT); Phases 2 and 3 only by the tests. Nothing has been
  tried on a physical Kobo yet, in particular collection edits, cover sizes and whether a Kobo re-downloads a book
  after a `ChangedEntitlement`.
