# Kobo sync protocol reference

What a Kobo e-reader expects from a sync server, as learned from Calibre-Web's implementation
(`cps/kobo.py`, `cps/kobo_auth.py`, `cps/services/SyncToken.py` in
[janeczku/calibre-web](https://github.com/janeczku/calibre-web)). inpx-web's implementation in
`server/core/kobo/` follows this protocol. The design, decisions and phase status are in
[kobo-sync-integration.md](./kobo-sync-integration.md).

Sections 1–9 describe the protocol (what any server must do). Section 10 summarises how Calibre-Web
built it. Section 11 lists its quirks and how inpx-web handles each one.

## 1. How a Kobo finds the server

The firmware reads the address it syncs with from `api_endpoint` in `.kobo/Kobo/Kobo eReader.conf`,
section `[OneStoreServices]`. A sync server pretends to be the Kobo Store: set
`api_endpoint=https://<host>/kobo/<token>`. The device then calls that base URL for
`v1/initialization`, `v1/library/sync`, metadata, covers, reading state and collections, and
downloads book files from the URLs the server hands it.

Requests the server doesn't handle (store pages, wishlist, purchased books) can be passed on to the
real `https://storeapi.kobo.com`, with the store's sync results merged in, so Kobo Store purchases
keep working (§9).

## 2. Authentication

* Kobo's real auth uses a `UserKey`/`DeviceId` pair and Bearer tokens. A sync server can **ignore all of it**.
* The credential is a random token in the URL path (`/kobo/<token>/…`). An unknown token gets `401`.
* `POST v1/auth/device` and `v1/auth/refresh` only need a plausible answer to keep the device happy:
  `{AccessToken, RefreshToken, TokenType:"Bearer", TrackingId:<uuid>, UserKey:<echo of the request's UserKey>}`
  with random token values. When proxying the store, relay the store's real answer instead.
* Download URLs carry the same token (`/kobo/<token>/download/…`), so the device needs no cookies.
* Because the token is in the URL, it ends up in access logs, and HTTPS is effectively required on
  public networks.

## 3. Endpoints

| Device call | What the server must do |
|---|---|
| `GET v1/initialization` | Return `{Resources:{…}}` (Kobo's resource list; see `server/core/kobo/resources.js`) with `library_sync`, `image_host`, `image_url_template` and `image_url_quality_template` pointing at the server. Set header `x-kobo-apitoken: e30=` |
| `POST v1/auth/device`, `v1/auth/refresh` | Dummy tokens (§2) |
| `GET v1/library/sync` | The core: §4 |
| `GET v1/library/<uuid>/metadata` | `[BookMetadata]` (§5). Unknown UUID: forward to the store when proxying |
| `GET v1/library/<uuid>/state` | `[ReadingState]` (§6) |
| `PUT v1/library/<uuid>/state` | Store the reading state the device sends (§6) |
| `DELETE v1/library/<uuid>` | The user deleted the book on the device. Answer `204` |
| `POST v1/library/tags` | The device created a collection: body `{Name, Items}`, answer `201` with the new tag id as a JSON string |
| `PUT/DELETE v1/library/tags/<id>` | Rename or delete a collection |
| `POST v1/library/tags/<id>/items`, `…/items/delete` | Add or remove books in a collection; items are `{Type:"ProductRevisionTagItem", RevisionId:<book uuid>}` |
| `GET /<uuid>/<w>/<h>[/<quality>]/<greyscale>/image.jpg` | Cover for the book whose `CoverImageId` is `<uuid>`, at roughly the requested size. Unknown: `307` to `https://cdn.kobo.com/book-images/<uuid>/<w>/<h>/false/image.jpg` when proxying |
| `GET <DownloadUrls[].Url>` | The book file. KEPUB is named `*.kepub.epub` |
| `/v1/user/*`, `/v1/products/*`, `/v1/analytics/*`, `/v1/deals`, `/v1/affiliate`, `/v1/assets`, … | Not needed for a library: answer `{}` (or proxy them). `v1/user/loyalty/benefits` → `{Benefits:{}}`; `v1/analytics/gettests` → `{Result:"Success", TestKey:<x-kobo-userkey header>, Tests:{}}` |

The resource list from Kobo points most calls at `https://storeapi.kobo.com/…`. inpx-web rewrites
every such URL to the device's `/kobo/<token>` base, so nothing leaves the server unless the device
opted into store proxying.

## 4. The sync exchange

The device calls `GET v1/library/sync` repeatedly. The server answers with a **JSON array** of
change items and two headers:

* `x-kobo-synctoken`: an opaque cursor. The device sends it back on the next sync unchanged. A
  server can put anything in it (Calibre-Web: base64 JSON of timestamps; inpx-web: base64 JSON of
  device id and a generation counter). A token containing `.` is a **real Kobo Store token**: it
  shows up on the first sync after `api_endpoint` is changed, and must be kept for store proxying.
  No token, or a token the server doesn't recognise, means the device should get a full sync.
* `x-kobo-sync: continue`: more items are waiting; the device calls again immediately. Omit it on
  the last page. Don't send it while work is merely pending (e.g. a conversion), or the device spins.

Change items (each is an object with one key):

| Item | Meaning |
|---|---|
| `NewEntitlement: {BookEntitlement, BookMetadata, ReadingState?}` | A book the device doesn't have yet |
| `ChangedEntitlement: {BookEntitlement, BookMetadata}` | Updated metadata or file; with `BookEntitlement.IsRemoved:true` the book is removed from the device |
| `ChangedReadingState: {ReadingState}` | Reading state changed on the server side |
| `NewTag` / `ChangedTag: {Tag}` | A collection and its full item list |
| `DeletedTag: {Tag:{Id, LastModified}}` | A collection to remove |

Pages are capped at about 100 items (Calibre-Web's `SYNC_ITEM_LIMIT`).

## 5. Payload shapes

`BookEntitlement`:
`{Accessibility:"Full", ActivePeriod:{From:now}, Created, CrossRevisionId:uuid, Id:uuid,
IsRemoved:bool, IsHiddenFromArchive:false, IsLocked:false, LastModified, OriginCategory:"Imported",
RevisionId:uuid, Status:"Active"}`

`BookMetadata`:
`{Categories:[<zero-uuid>], CoverImageId:uuid, CrossRevisionId, EntitlementId, RevisionId, WorkId (all = uuid),
CurrentDisplayPrice:{CurrencyCode:"USD",TotalAmount:0}, CurrentLoveDisplayPrice:{TotalAmount:0},
Description, DownloadUrls:[{Format:"KEPUB"|"EPUB3"|"EPUB"|"EPUB3FL", Size:<bytes>, Url, Platform:"Generic"}],
ExternalIds:[], Genre:<zero-uuid>, IsEligibleForKoboLove:false, IsInternetArchive:false, IsPreOrder:false,
IsSocialEnabled:true, Language:<ISO-639-1>, PhoneticPronunciations:{}, PublicationDate,
Publisher:{Imprint:"",Name}, Title, Contributors:[names], ContributorRoles:[{Name}],
Series:{Name, Number, NumberFloat, Id:<stable uuid from the series name>}}`

`<zero-uuid>` is `00000000-0000-0000-0000-000000000001`.

Rules that matter:

* **One stable UUID per book**, used for every id field. Covers are requested by the same UUID
  (`CoverImageId`). Changing it makes the device treat the book as a different one.
* Offer KEPUB when available (only KEPUB URLs, then); otherwise an EPUB as both `EPUB3` and `EPUB`.
  Fixed-layout EPUBs (`rendition:layout = pre-paginated`) are `EPUB3FL`.
* `Size` should be the exact size of the file behind `Url`.
* Timestamps are `YYYY-MM-DDTHH:MM:SSZ` (UTC, no fractions).
* Send raw UTF-8 JSON (`Content-Type: application/json; charset=utf-8`); the device is sensitive to
  `\u`-escaped text.

## 6. Reading state

The Kobo tracks four timestamped objects per book:

| Object | Fields |
|---|---|
| `ReadingState` | `EntitlementId`, `Created`, `LastModified`, `PriorityTimestamp` (in practice equal to `LastModified`), plus the three below |
| `StatusInfo` | `Status` (`ReadyToRead` / `Reading` / `Finished`), `TimesStartedReading`, `LastTimeStartedReading`, `LastModified` |
| `Statistics` | `SpentReadingMinutes`, `RemainingTimeMinutes`, `LastModified` |
| `CurrentBookmark` | `ProgressPercent`, `ContentSourceProgressPercent`, `Location{Value, Type, Source}`, `LastModified` |

* `PUT …/state` sends `{ReadingStates:[{CurrentBookmark?, Statistics?, StatusInfo?}]}`. Answer
  `{RequestResult:"Success", UpdateResults:[{EntitlementId, CurrentBookmarkResult:{Result:"Success"},
  StatisticsResult:{…}, StatusInfoResult:{…}, LastModified, PriorityTimestamp}]}` (only the results
  for parts that were sent).
* Server-side changes reach the device as `ChangedReadingState` on the next sync, or inside a
  `NewEntitlement`. Bump `LastModified` so the device accepts them.
* Send whole-number progress values as integers; the firmware expects that.
* Plain EPUB progress is only tracked at chapter starts; KEPUB tracks within chapters (`kobo.N.M`
  span locations), which don't map to positions in other readers.

## 7. Collections

* A collection is `{Tag:{Id, Name, Created, LastModified, Type:"UserTag",
  Items:[{RevisionId:<book uuid>, Type:"ProductRevisionTagItem"}]}}`, sent as `NewTag` or `ChangedTag`
  with the full item list, and removed with `DeletedTag`.
* Collection edits made on the device arrive through the `v1/library/tags*` endpoints (§3).

## 8. File formats and KEPUB

* KEPUB is an EPUB with Kobo span markup; the device reads it with its native engine (better
  progress tracking, statistics). Calibre-Web converts EPUB → KEPUB with `kepubify`; inpx-web
  converts FB2 → KEPUB with fb2cng and sends EPUB sources as plain EPUB.
* Serve KEPUB with a `*.kepub.epub` file name and `Content-Type: application/epub+zip`.

## 9. Kobo Store proxying

Needed only to keep Kobo Store purchases working alongside the library.

* `v1/initialization`: use the store's `Resources` (still overriding the sync and image URLs).
* `v1/auth/*`: relay the store's answer; fall back to dummy tokens if the store is unreachable.
* `v1/library/sync`: on the **last** page of the server's own items, call the store's sync with the
  store token from the cursor, append its items, and carry its new `x-kobo-synctoken` inside your
  own token. Pass on the store's `x-kobo-sync`, `x-kobo-sync-mode` and `x-kobo-recent-reads` headers.
* Unknown book UUIDs (metadata, state, delete) belong to the store: forward them.
* Everything else: `GET` → `307` redirect to the store; other methods must be proxied server-side,
  because the device turns redirected `POST`/`PUT` requests into `GET`s.
* Unknown covers: `307` to `cdn.kobo.com/book-images/…`.

## 10. Calibre-Web's implementation (reference)

### Code map

| File | Role |
|---|---|
| `cps/kobo.py` | Flask blueprint `/kobo/<auth_token>/…`: every endpoint, the sync algorithm, metadata/entitlement builders, reading-state mapping, collections, store proxying, the fallback `NATIVE_KOBO_RESOURCES` list |
| `cps/kobo_auth.py` | Per-user token generation and deletion, the `requires_kobo_auth` decorator, research notes on Kobo's real auth |
| `cps/services/SyncToken.py` | The `x-kobo-synctoken` cursor (base64 JSON) |
| `cps/kobo_sync_status.py` | Helpers for `kobo_synced_books` (what's on the device) and `archived_book` (what to remove) |
| `cps/ub.py` | Models: `RemoteAuthToken`, `KoboSyncedBooks`, `ArchivedBook`, `KoboReadingState`, `KoboBookmark`, `KoboStatistics`, `ReadBook`, `Shelf.kobo_sync`, `ShelfArchive`, `User.kobo_only_shelves_sync` |
| `cps/main.py` | Registers the blueprints only when `config_kobo_sync` is on; a `3/minute` limiter that authenticated handlers clear |
| `cps/shelf.py`, `cps/web.py`, `cps/admin.py`, `cps/editbooks.py` | Per-shelf "sync to Kobo" flag, per-user "only sync selected shelves", force full sync, clearing the synced flag on edit, archive or format delete |
| `cps/helper.py` | Downloads: KEPUB metadata embedding, `.kepub.epub` file name for Kobo |
| `cps/epub.py` | `get_epub_layout()` detects fixed-layout EPUBs (`EPUB3FL`) |

Config flags: `config_kobo_sync` (needs a restart), `config_kobo_proxy`, `config_external_port`
(used when not behind a reverse proxy), `config_kepubifypath`.

### Sync algorithm

State: the cursor (`books_last_created`, `books_last_modified`, `reading_state_last_modified`,
`tags_last_modified`, `archive_last_modified`, `raw_kobo_store_token`) and the server tables
`kobo_synced_books` (user × book already sent) and `archived_book`.

```
require download role
if user has 0 rows in kobo_synced_books:  # first sync or "force full sync"
    reset all cursor timestamps
reconnect calibre DB  # pick up books added outside Calibre-Web

candidates = books with a KEPUB/EPUB file, not in kobo_synced_books(user), visible to the user
  if "only sync selected shelves": on a kobo_sync shelf, added to it after books_last_modified
  order by last_modified, id

for book in candidates.limit(100):
    convert EPUB→KEPUB with kepubify if missing (synchronously)
    NewEntitlement if max(book.timestamp, shelf.date_added) > books_last_created, else ChangedEntitlement
      (+ ReadingState if it changed after the cursor)
    insert into kobo_synced_books
continue = candidates remain

changed reading states after the cursor (limit 100) → ChangedReadingState
shelves changed after the cursor → NewTag / ChangedTag; deleted shelves (shelf_archive) → DeletedTag
if proxying and last page: merge the store's sync
```

How changes propagate:

* **New books:** not in `kobo_synced_books`, so they're picked up.
* **Edited books:** edit hooks delete the book's `kobo_synced_books` rows; it goes out again as `ChangedEntitlement`.
* **Removed books:** the web UI's archive flag, or a delete on the device, sets `ArchivedBook.is_archived`; the book is re-sent with `IsRemoved:true`.
* **Force full sync** deletes the user's `kobo_synced_books` rows.
* **Reading state:** a SQLAlchemy `before_flush` listener bumps `KoboReadingState.last_modified` when a child row changes, so a "mark as read" in the web UI reaches the device as `ChangedReadingState`. `StatusInfo` is stored in `book_read_link`, the table behind the web UI's read flag.

## 11. Calibre-Web's quirks, and how inpx-web handles them

| # | Calibre-Web quirk | inpx-web |
|---|---|---|
| 1 | Removing a book from a sync shelf doesn't remove it from the device; only collection membership changes | The bound lists are the source of truth: a book leaving every list is removed, unless the device's "keep books on the device" option is on |
| 2 | Change detection relies on edit hooks; changes made outside Calibre-Web (desktop Calibre) aren't noticed | The sync diffs the bound lists against what the device was told on every request; file changes are detected by conversion fingerprint and size, metadata changes (including admin edits) by a hash of the record's fields |
| 3 | `archive_last_modified` is stored in the cursor but never used | The cursor only carries device id, generation and the store token |
| 4 | `not ub.Shelf.kobo_sync` in `sync_shelves` is a Python `not`, not SQL `NOT`, so that query likely never returns rows | Collections are diffed per list by a signature of name and items |
| 5 | `SyncToken.from_headers` validates the wrong object against the data schema | n/a |
| 6 | Sync state is per user: two devices on one account fight over `kobo_synced_books` | Sync state is per device |
| 7 | KEPUB conversion runs synchronously inside the sync request and can time out large first syncs | Books are announced only once their file is ready; conversions run in the background (2 at a time, 20 s wait per sync) and pending ones don't set `x-kobo-sync: continue`. Adding a book to a bound list starts its conversion right away |

## 12. Minimal recipe

1. Route `/kobo/<token>/…` to your service and authenticate by token.
2. Serve `v1/initialization` with resources that point `library_sync` and the image templates back at you.
3. Keep a per-device record of the books already sent, with one stable UUID per book.
4. On `v1/library/sync`, send new or changed books as `NewEntitlement`/`ChangedEntitlement` and removed books with `IsRemoved:true`. Page with `x-kobo-sync: continue` and round-trip an opaque `x-kobo-synctoken`.
5. Serve covers by UUID and files at the `DownloadUrls` you advertised, with an accurate `Size`. Prefer KEPUB.
6. Accept `PUT v1/library/<uuid>/state` and return server-side changes as `ChangedReadingState`.
7. Optionally, send collections as `NewTag`/`ChangedTag`/`DeletedTag` and handle `v1/library/tags*`.
8. Answer or proxy everything else so the firmware doesn't complain.
