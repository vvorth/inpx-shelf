# Kobo sync: code review findings

Review of the Kobo sync work on the `kobo-sync` branch (`b48a9e5..4d0e6dd`): `server/core/kobo/`,
the hooks in `WebWorker`, `ReadingListStore`, `Security`, the backup code, and the Kobo tab in
`UserProfilesDialog.vue`. `scripts/kobo-sync-tests.js` passed at the time of the review.

Status values: **open**, **fixed** (with the commit that fixed it), **won't fix**.

## Bugs and logic issues

### 1. A book finished on one Kobo is never marked finished on the profile's other Kobos

**Status:** fixed in "Send Finished from one Kobo to the profile's other Kobos"

`putState` (`server/core/kobo/index.js`) set `listRead = true` on the rows of *every* device of the
profile when a device reported `Finished`. On the other devices' next sync, step 4 compares
`row.listRead === item.read`, finds `true === true`, and sends nothing, so those devices never receive
`ChangedReadingState: Finished`.

Repro: two devices bound to one list; device 1 PUTs `StatusInfo.Status = Finished`. The list entry
becomes `read: true`, and device 2's next sync returns `[]`.

Fix: only the device that reported the status records that its list flag is about to flip; the others
pick the change up through step 4 like any web-side edit.

Fixing the flag alone was not enough: reading state is stored per profile, so step 4's
`state.status === status` check also found the state already `Finished` (written by device 1's PUT).
Step 4 now compares against `row.status`, the status *this* device was told. Covered by
`testKoboFinishedReachesOtherDevices`.

### 2. A sync can briefly undo `Finished` on the device that reported it

**Status:** fixed in "Update the reading list before the Kobo state on Finished"

`putState` saved `listRead = true` first and called `markRead()` (which updates the reading list)
afterwards. A sync landing between the two, or a failed `markRead()` (it only logs), saw
`listRead = true` against a list that still said unread, and sent `ReadyToRead` back to the device.
It corrected itself on a later sync, but the device flipped state in between.

Fix: update the reading list first, then save the device state; record the list flag only when the
list update succeeded. A sync running in between can now at most send `Finished` to a device that is
already finished, which is harmless. Web progress from the same PUT is skipped when the book was just
marked read, since that already set it to finished. Covered by
`testKoboFinishedIsNotUndoneWhenTheListUpdateFails`.

### 3. Deleting a book on the device marks it read and overwrites web progress

**Status:** fixed in "Stop marking books read when they are deleted on the Kobo"

`deleteBook` called `setBooksRead(userId, [uid], true)`, which marks the book read in **all** the
profile's lists and sets `readerProgress[uid]` to 100%. A reader deleting a half-read book to free
space lost the web reader position.

Decision: §4.10 decision 1 ("a delete marks the book read") was wrong. A delete on the device only
stops the book being sent to that device again while it stays listed. It does not touch the list's
`read` flag or reading progress. `testKoboDeleteOnDeviceAndKeepRemovedBooks` checks both; the README
and the design doc (§4.10) were updated.

### 4. Devices of a profile that no longer exists act on the first profile

**Status:** fixed in "Refuse Kobo devices whose profile no longer exists"

`ReadingListStore.resolveUser()` falls back to `data.users[0]` (usually the admin) for an unknown
user id. Devices whose profile is gone keep working tokens when:

* the profile was deleted while Kobo sync was disabled (`koboService` was null, so
  `deleteUserDevices` was skipped), or
* an older `reading-lists.json` was restored.

Their `PUT …/state` and `DELETE` requests then ran `markRead()` and `syncWebProgress()` against
`users[0]`.

Fix: a device whose profile does not exist is refused (401), and is never used to read or write
profile data. The check uses the new exact `ReadingListStore.hasUser()`. The device record is kept, so
restoring the profile from a backup brings the device back. Covered by
`testKoboRefusesDevicesOfDeletedProfiles`.

### 5. Smaller robustness issues

**Status:** fixed in "Harden Kobo error handling, startup and the preparation cache"

* `download()` turned a busy conversion queue into `500`. It should be `503` with `Retry-After`.
* The route error handler chose `404` with `e.message.includes('404')`, which is fragile.
* The router's async auth middleware runs on Express 4, which does not catch a rejection from
  `store.load()`; the request would hang.
* `isAuthorizedRequest` returned false until `kobo-sync.json` had loaded, so with `requireAuth`
  devices were rejected for a moment at startup.
* The `prepared` map evicted its oldest entry only if that entry had finished, so it could grow past
  `preparedEntryLimit`.
* `collectWanted` looked duplicate uids up with `[...wanted.values()].find`, which is quadratic.

Fixes, in the same order:

* A busy converter answers `503` with `Retry-After: 60` (`testKoboRetriesBusyConversionOnNextSync`).
* `errorStatus()` maps the converter's busy codes to `503` and only a *leading* `404 ` (the worker's
  convention) to `404`. Route errors are logged with the token masked.
* The auth middleware catches a failed `store.load()` and answers `503`.
* `kobo.init()` exposes `service.ready`, and `server/index.js` awaits it before the server listens.
* Eviction drops the oldest *finished* entry, skipping running ones (`testKoboPreparedCacheStaysBounded`).
* `collectWanted` keeps a `bookUid → item` map.

The new fast test exposed a flaky fixture: `createDevice` starts `prewarmLists()` without awaiting it,
and that task's `ReadingListStore.load()` recreated `reading-lists.json` while the fixture deleted its
temp dir (`ENOTEMPTY`, about half of the runs). `KoboService.idle()` now resolves once background
preparation is done, and the fixture awaits it before cleanup.

## UI/UX (Kobo tab in `UserProfilesDialog.vue`)

Not addressed in this round.

1. Adding a device takes two steps that aren't obvious: it is created with no lists, and the user then
   has to tick lists on the new card and press Save. The endpoint box doesn't say which device it
   belongs to.
2. Every save, create, reset or delete reloads all devices and discards unsaved edits on other cards;
   there is no "unsaved changes" indicator.
3. Books that never sync (PDF/DJVU, failed or pending conversions) are invisible. The design doc
   (§4.8) planned an "n books can't sync" count.
4. The endpoint URL comes from the request host. Opened via `localhost`/a LAN IP, or behind a proxy
   without `X-Forwarded-*`, it is unreachable from the Kobo, with no warning.
5. Copying the endpoint fails silently when the clipboard API is unavailable (plain HTTP). The address
   is shown only once, so "Hide" could ask for confirmation.
6. Unticking a list and saving deletes its books from the Kobo on the next sync, without a confirm.
7. Minor: the loading state is a bare "…", and after a profile switch with `preserveState` the tab
   can show the previous profile's devices.
