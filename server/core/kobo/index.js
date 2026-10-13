const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const express = require('express');

const {t} = require('../i18n');
const KoboStore = require('./KoboStore');
const defaultResources = require('./resources');
const {BookMetadata} = require('../BookMetadata');
const {log, rootPath, syncTokenHeader, busyConversionCodes} = require('./common');

const syncItemLimit = 100;
// Kobo sync requests must answer quickly; conversions that take longer finish
// in the background and are announced on a later sync.
const prepareBudgetMs = 20000;
const prewarmBusyRetryMs = 5000;
// Looking an orphan up by libid scans the whole book table: at most once an hour per book.
const rekeyRetryMs = 60*60*1000;
const rekeyCheckedLimit = 10000;
const uuidNamespace = 'b0f7c0a4-5a43-4b8e-9d0e-6f1a8c2e4d17';
const zeroUuid = '00000000-0000-0000-0000-000000000001';
const koboStoreUrl = 'https://storeapi.kobo.com';

let activeService = null;

function uuidv5(name, namespace = uuidNamespace) {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1').update(ns).update(String(name)).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// libid survives an INPX rewrite of the record line; _uid does not.
function stableKey(book) {
    const libid = String(book.libid || '').trim();
    return (libid ? `${book.sourceId || ''}:${libid}` : book._uid);
}

// Device tokens travel in the URL path, the metrics token may come in the query: never write them to a log.
function maskTokens(url = '') {
    return String(url).replace(/\/kobo\/[0-9a-f]{32}(?=[/?#]|$)/gi, '/kobo/***')
        .replace(/([?&]token=)[^&#]*/gi, '$1***');
}

function koboTime(value = null) {
    const date = (value ? new Date(value) : new Date());
    return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 19) + 'Z';
}

function tokenFromPath(req, config) {
    const pathname = String(req.path || '');
    const prefix = `${rootPath(config)}/`;
    if (!pathname.startsWith(prefix))
        return null;
    return pathname.slice(prefix.length).split('/')[0];
}

// The device cannot take part in SSO or profile logins: its URL token is the credential.
function isAuthorizedRequest(req, config) {
    if (!config.koboEnabled || !activeService)
        return false;
    const token = tokenFromPath(req, config);
    return !!(token && activeService.store.findDeviceByToken(token));
}

function encodeSyncToken(device, storeToken = '') {
    const data = {v: 1, d: device.id, g: device.generation};
    if (storeToken)
        data.s = storeToken;
    return Buffer.from(JSON.stringify(data)).toString('base64');
}

function decodeSyncToken(value = '') {
    // The first sync after switching api_endpoint carries the Kobo Store's own token.
    if (String(value).includes('.'))
        return {store: String(value)};
    try {
        const data = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
        return (data && data.v === 1 ? data : null);
    } catch (e) {
        return null;
    }
}

function sendJson(res, data, status = 200) {
    // Kobo firmware expects raw UTF-8, not \u-escaped text.
    res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(data));
}

// Worker errors carry their HTTP meaning in a code (a busy converter) or a leading "404 ".
function errorStatus(error) {
    if (busyConversionCodes.has(error && error.code))
        return 503;
    return (/^404\b/.test(String((error && error.message) || '')) ? 404 : 500);
}

class KoboService {
    constructor(config, worker, security) {
        this.config = config;
        this.worker = worker;
        this.security = security;
        this.store = new KoboStore(config);
        this.metadata = new BookMetadata(worker);
        this.prepared = new Map();
        this.prepareBudgetMs = prepareBudgetMs;
        this.prewarmQueue = new Set();
        this.prewarmRunning = null;
        this.prewarmListTasks = new Set();
        this.prewarmBusyRetryMs = prewarmBusyRetryMs;
        this.rekeyChecked = new Map();
        this.coverQueue = Promise.resolve();
        this.storeUrl = String(config.koboStoreApiUrl || koboStoreUrl).replace(/\/$/, '');
    }

    publicBase(req) {
        const security = this.security;
        const supplied = this.config.koboPublicUrl
            || `${security.forwardedProto(req) || security.requestProto(req)}://${security.forwardedHost(req) || security.requestHost(req)}${this.config.rootPathStatic || ''}`;
        const url = new URL(`${supplied.replace(/\/$/, '')}/`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
            throw new Error('Invalid Kobo public URL');
        return url.toString().replace(/\/$/, '');
    }

    deviceBase(req, token) {
        return `${this.publicBase(req)}/kobo/${token}`;
    }

    // ------------------------------------------------------------------ device management
    async ownListIds(userId) {
        const lists = await this.worker.readingListStore.getLists(userId);
        return new Set(lists.map(list => list.id));
    }

    async checkListIds(userId, settings = {}) {
        if (!Array.isArray(settings.listIds))
            return;
        const own = await this.ownListIds(userId);
        for (const listId of settings.listIds) {
            if (!own.has(String(listId || '').trim()))
                throw new Error(t('errors.listNotFound'));
        }
    }

    async getDevices(userId) {
        return {devices: await this.store.getDevices(userId)};
    }

    async createDevice(userId, settings, req) {
        await this.checkListIds(userId, settings);
        const {device, token} = await this.store.createDevice(userId, settings);
        this.prewarmLists(userId, device.listIds);
        return {device, endpoint: this.deviceBase(req, token)};
    }

    async updateDevice(userId, deviceId, settings) {
        await this.checkListIds(userId, settings);
        const result = await this.store.updateDevice(userId, deviceId, settings);
        if (Array.isArray(settings.listIds))
            this.prewarmLists(userId, result.device.listIds);
        return result;
    }

    async regenerateToken(userId, deviceId, req) {
        const {device, token} = await this.store.regenerateToken(userId, deviceId);
        return {device, endpoint: this.deviceBase(req, token)};
    }

    // The device's books go out again with their current metadata and file. Finished preparations are
    // forgotten, so the file's size and authors are read again from what the conversion cache holds now.
    async refreshDevice(userId, deviceId) {
        const result = await this.store.refreshDevice(userId, deviceId);
        const device = this.store.data.devices.find(item => item.id === deviceId);
        const uids = new Set(Object.values(device.books).filter(row => row.refresh).map(row => row.bookUid));
        for (const [key, entry] of this.prepared) {
            if ((entry.result || entry.error) && uids.has(key.slice(0, key.indexOf(':'))))
                this.prepared.delete(key);
        }
        return result;
    }

    // ------------------------------------------------------------------ list → device
    // The profile's lists among listIds, in that order, from one load of the profile store.
    async boundLists(userId, listIds) {
        const data = await this.worker.readingListStore.load();
        const own = new Map(data.lists.filter(list => list.userId === userId).map(list => [list.id, list]));
        return {data, lists: listIds.map(listId => own.get(listId)).filter(Boolean)};
    }

    async collectWanted(device, rekey = true) {
        const store = this.worker.readingListStore;
        const {data, lists} = await this.boundLists(device.userId, device.listIds);
        const overrides = data.metadataOverrides || {};
        const records = await this.worker.getBookRecordsByUids(lists.flatMap(list => store.normalizeEntries(list.books).map(entry => entry.bookUid)));
        const wanted = new Map();
        // bookUid → its wanted item (or null for an orphan), for books listed more than once.
        const seenUids = new Map();
        // Listed books missing from the DB, with the lists they are in.
        const orphanUids = new Map();
        const readUids = new Set();
        for (const list of lists) {
            for (const entry of store.normalizeEntries(list.books)) {
                if (entry.read)
                    readUids.add(entry.bookUid);
                if (seenUids.has(entry.bookUid)) {
                    const known = seenUids.get(entry.bookUid);
                    if (known && !known.listIds.includes(list.id))
                        known.listIds.push(list.id);
                    if (orphanUids.has(entry.bookUid))
                        orphanUids.get(entry.bookUid).push(list.id);
                    continue;
                }
                seenUids.set(entry.bookUid, null);
                const book = this.withOverrides(records.get(entry.bookUid) || null, overrides);
                if (!book) {
                    // Missing from the DB while still listed (re-index in progress,
                    // INPX line rewritten): never treat that as a removal.
                    orphanUids.set(entry.bookUid, [list.id]);
                    continue;
                }
                const key = stableKey(book);
                const uuid = uuidv5(key);
                if (!wanted.has(uuid))
                    wanted.set(uuid, {uuid, stableKey: key, bookUid: entry.bookUid, book, listIds: []});
                const item = wanted.get(uuid);
                if (!item.listIds.includes(list.id))
                    item.listIds.push(list.id);
                seenUids.set(entry.bookUid, item);
            }
        }

        if (rekey && orphanUids.size && await this.rekeyOrphans(device, orphanUids))
            return await this.collectWanted(device, false);

        for (const item of wanted.values())
            item.read = readUids.has(item.bookUid);

        return {lists, wanted, orphanUids};
    }

    async metadataOverrides() {
        const store = this.worker.readingListStore;
        return (typeof(store.getMetadataOverrides) === 'function' ? await store.getMetadataOverrides() : {});
    }

    // Admin edits of title, authors and series apply to the Kobo too.
    withOverrides(book, overrides) {
        if (!book || typeof(this.worker.applyMetadataOverrideToBook) !== 'function')
            return book;
        const result = this.worker.applyMetadataOverrideToBook(Object.assign({}, book), overrides);
        if (result.author !== book.author)
            result.authorOverridden = true;
        return result;
    }

    // The authors a device is told. The Kobo shows these, not the ones inside the file, so they come
    // from the announced file (written by fb2cng with its own name format) unless the admin edited
    // the author; the INPX record ("Last First") is the fallback.
    bookAuthors(book, row) {
        if (!book.authorOverridden && row && Array.isArray(row.fileAuthors) && row.fileAuthors.length)
            return {authors: row.fileAuthors, fromFile: true};
        return {authors: String(book.author || '').split(',').map(name => name.trim()).filter(Boolean), fromFile: false};
    }

    async bookRecord(bookUid) {
        return this.withOverrides(await this.worker.getBookRecordByUid(bookUid), await this.metadataOverrides());
    }

    // The record-derived metadata a device was told. Description, publisher and year come from the
    // file itself and change only with it, which is re-announced through the file fingerprint and size.
    // Authors from the record keep the hash they had before file authors existed.
    metadataHash(book, row = null) {
        const {authors, fromFile} = this.bookAuthors(book, row);
        const author = (fromFile ? `file:${authors.join('\n')}` : book.author || '');
        return crypto.createHash('sha1')
            .update(JSON.stringify([book.title || '', author, book.series || '', String(book.serno || ''), book.lang || '']))
            .digest('hex').slice(0, 16);
    }

    // An INPX update can rewrite a book's line, and with it its _uid. When a listed uid no longer
    // resolves but a device row remembers the book's `sourceId:libid`, find the new record and move
    // the profile's list entries, reader progress, bookmarks and device rows over to the new uid.
    // The Kobo id comes from the libid, so the device notices nothing.
    async rekeyOrphans(device, orphanUids) {
        if (typeof(this.worker.findBookRecordsByStableKeys) !== 'function')
            return false;
        const now = Date.now();
        const keys = new Map();
        for (const other of this.store.data.devices.filter(item => item.userId === device.userId)) {
            for (const row of Object.values(other.books)) {
                // Without a libid the stable key is the old _uid itself: nothing to look up.
                if (!orphanUids.has(row.bookUid) || row.stableKey === row.bookUid || !row.stableKey.includes(':'))
                    continue;
                const checked = this.rekeyChecked.get(row.stableKey);
                if (!checked || now - checked >= rekeyRetryMs)
                    keys.set(row.stableKey, row.bookUid);
            }
        }
        if (!keys.size)
            return false;
        if (this.rekeyChecked.size > rekeyCheckedLimit)
            this.rekeyChecked.clear();
        for (const key of keys.keys())
            this.rekeyChecked.set(key, now);

        const found = await this.worker.findBookRecordsByStableKeys([...keys.keys()]);
        const mapping = {};
        for (const [key, oldUid] of keys) {
            const rows = found[key] || [];
            // Several records with one libid (copies in other formats): ambiguous, stay an orphan.
            if (rows.length === 1 && rows[0]._uid && rows[0]._uid !== oldUid) {
                mapping[oldUid] = rows[0]._uid;
                this.rekeyChecked.delete(key);
            }
        }
        if (!Object.keys(mapping).length)
            return false;

        await this.worker.readingListStore.rekeyBooks(device.userId, mapping);
        await this.store.mutate((data) => {
            for (const other of data.devices.filter(item => item.userId === device.userId)) {
                for (const row of Object.values(other.books)) {
                    if (mapping[row.bookUid])
                        row.bookUid = mapping[row.bookUid];
                }
            }
        });
        log(`Kobo: ${Object.keys(mapping).length} listed book(s) of profile ${device.userId} moved to their re-indexed records`);
        return true;
    }

    // ------------------------------------------------------------------ book metadata
    async readExtraMetadata(book) {
        try {
            return await this.metadata.read(book);
        } catch (e) {
            return {};
        }
    }

    async bookMetadata(req, token, uuid, book, row) {
        const extra = await this.readExtraMetadata(book);
        const {authors} = this.bookAuthors(book, row);
        const lang = String(extra.language || book.lang || '').trim().toLowerCase().slice(0, 2);
        const year = String(extra.publishedYear || book.year || '').match(/\b\d{4}\b/);
        const downloadUrl = `${this.deviceBase(req, token)}/download/${uuid}/${row.convertTo || 'raw'}${row.revision ? `?rev=${row.revision}` : ''}`;
        const metadata = {
            Categories: [zeroUuid],
            CoverImageId: uuid,
            CrossRevisionId: uuid,
            CurrentDisplayPrice: {CurrencyCode: 'USD', TotalAmount: 0},
            CurrentLoveDisplayPrice: {TotalAmount: 0},
            Description: extra.description || null,
            DownloadUrls: row.koboFormats.map(format => ({Format: format, Size: row.size, Url: downloadUrl, Platform: 'Generic'})),
            EntitlementId: uuid,
            ExternalIds: [],
            Genre: zeroUuid,
            IsEligibleForKoboLove: false,
            IsInternetArchive: false,
            IsPreOrder: false,
            IsSocialEnabled: true,
            Language: (/^[a-z]{2}$/.test(lang) ? lang : 'en'),
            PhoneticPronunciations: {},
            PublicationDate: koboTime(year ? `${year[0]}-01-01T00:00:00Z` : row.sentAt),
            Publisher: {Imprint: '', Name: extra.publisher || null},
            RevisionId: uuid,
            Title: book.title || row.title || '',
            WorkId: uuid,
            Contributors: authors,
            ContributorRoles: authors.map(name => ({Name: name})),
        };
        if (book.series) {
            const number = parseFloat(book.serno);
            metadata.Series = {
                Name: book.series,
                Number: (Number.isFinite(number) ? number : 1),
                NumberFloat: (Number.isFinite(number) ? number : 1),
                Id: uuidv5(`series:${book.series}`),
            };
        }
        return metadata;
    }

    bookEntitlement(uuid, row, removed = false) {
        return {
            Accessibility: 'Full',
            ActivePeriod: {From: koboTime()},
            Created: koboTime(row.sentAt),
            CrossRevisionId: uuid,
            Id: uuid,
            IsRemoved: removed,
            IsHiddenFromArchive: false,
            IsLocked: false,
            LastModified: koboTime(row.changedAt || row.sentAt),
            OriginCategory: 'Imported',
            RevisionId: uuid,
            Status: 'Active',
        };
    }

    // ------------------------------------------------------------------ reading state
    emptyState(now = new Date().toISOString()) {
        return {
            lastModified: now, priorityTimestamp: now,
            status: 'ReadyToRead', statusModified: now, timesStartedReading: 0, lastTimeStartedReading: '',
            statistics: {lastModified: now},
            bookmark: {lastModified: now},
        };
    }

    readingStateResponse(uuid, row, rawState) {
        const state = Object.assign(this.emptyState(row.sentAt), rawState || {});
        state.statistics = state.statistics || {lastModified: state.lastModified};
        state.bookmark = state.bookmark || {lastModified: state.lastModified};
        const result = {
            EntitlementId: uuid,
            Created: koboTime(row.sentAt),
            LastModified: koboTime(state.lastModified),
            PriorityTimestamp: koboTime(state.priorityTimestamp),
            StatusInfo: {
                LastModified: koboTime(state.statusModified),
                Status: state.status || 'ReadyToRead',
                TimesStartedReading: state.timesStartedReading || 0,
            },
            Statistics: {LastModified: koboTime(state.statistics.lastModified)},
            CurrentBookmark: {LastModified: koboTime(state.bookmark.lastModified)},
        };
        if (state.lastTimeStartedReading)
            result.StatusInfo.LastTimeStartedReading = koboTime(state.lastTimeStartedReading);
        for (const field of ['SpentReadingMinutes', 'RemainingTimeMinutes']) {
            if (state.statistics[field])
                result.Statistics[field] = state.statistics[field];
        }
        for (const field of ['ProgressPercent', 'ContentSourceProgressPercent']) {
            const value = state.bookmark[field];
            if (value !== undefined && value !== null)
                result.CurrentBookmark[field] = (Number.isInteger(value) ? value : Number(value));
        }
        if (state.bookmark.Location && state.bookmark.Location.Value)
            result.CurrentBookmark.Location = state.bookmark.Location;
        return result;
    }

    setStatus(state, status, now) {
        if (status === 'Reading' && state.status !== 'Reading') {
            state.timesStartedReading = (state.timesStartedReading || 0) + 1;
            state.lastTimeStartedReading = now;
        }
        state.status = status;
        state.statusModified = now;
        state.lastModified = now;
        state.priorityTimestamp = now;
    }

    // ------------------------------------------------------------------ collections
    tagFor(list, wanted, device, orphanUids = new Map()) {
        const items = [];
        for (const item of wanted.values()) {
            const row = device.books[item.uuid];
            if (item.listIds.includes(list.id) && row && !row.deletedOnDevice && !row.collectionRemoved.includes(list.id))
                items.push({RevisionId: item.uuid, Type: 'ProductRevisionTagItem'});
        }
        // Books missing from the DB for a while (re-index) keep their place in the collection.
        for (const [uuid, row] of Object.entries(device.books)) {
            const listIds = orphanUids.get(row.bookUid);
            if (listIds && listIds.includes(list.id) && !row.deletedOnDevice && !wanted.has(uuid) && !row.collectionRemoved.includes(list.id))
                items.push({RevisionId: uuid, Type: 'ProductRevisionTagItem'});
        }
        // Stable order, so a book dropping in and out of the DB doesn't count as a collection change.
        items.sort((a, b) => a.RevisionId.localeCompare(b.RevisionId));
        return {
            Created: koboTime(list.createdAt),
            Id: this.tagId(list.id),
            Items: items,
            LastModified: koboTime(),
            Name: list.name,
            Type: 'UserTag',
        };
    }

    tagId(listId) {
        return uuidv5(`list:${listId}`);
    }

    syncTags(device, lists, wanted, results, orphanUids) {
        const tags = Object.assign({}, device.tags || {});
        const current = new Set();
        for (const list of lists) {
            current.add(list.id);
            const tag = this.tagFor(list, wanted, device, orphanUids);
            const signature = crypto.createHash('sha1').update(JSON.stringify([tag.Name, tag.Items])).digest('hex');
            const known = tags[list.id];
            if (known && known.signature === signature)
                continue;
            results.push({[known ? 'ChangedTag' : 'NewTag']: {Tag: tag}});
            tags[list.id] = {tagId: tag.Id, signature};
        }
        for (const [listId, known] of Object.entries(tags)) {
            if (current.has(listId))
                continue;
            results.push({DeletedTag: {Tag: {Id: known.tagId, LastModified: koboTime()}}});
            delete tags[listId];
        }
        return tags;
    }

    // ------------------------------------------------------------------ sync
    async sync(req, res, device, token) {
        const incoming = decodeSyncToken(req.headers[syncTokenHeader]);
        const fresh = !incoming || incoming.d !== device.id || incoming.g !== device.generation;
        const sync = await this.startSync(req, token, device, fresh);
        this.syncRemovedBooks(sync);
        await this.syncNewBooks(sync);
        await this.syncChangedBooks(sync);
        this.syncReadFlags(sync);
        // 5) one collection per bound list (computed against the updated book set)
        const tags = this.syncTags(Object.assign({}, device, {books: sync.books, tags: sync.tagsBefore}),
            sync.lists, sync.wanted, sync.results, sync.orphanUids);
        await this.saveSyncResult(sync, tags);

        const {results, refreshed} = sync;
        let more = sync.more;
        if (sync.newItems || results.length)
            log(`Kobo: sync for device ${device.id}: ${results.length} item(s)${refreshed ? `, ${refreshed} updated file(s)` : ''}${more ? ', more pending' : ''}`);

        // Store purchases join only the last page of our own items, as their token advances separately.
        let storeToken = (device.storeProxy && incoming ? incoming.store || incoming.s || '' : '');
        if (device.storeProxy && !more) {
            try {
                const store = await this.mergeStoreSync(req, token, storeToken);
                results.push(...store.items);
                storeToken = store.token;
                more = store.more;
                for (const [name, value] of Object.entries(store.headers))
                    res.set(name, value);
            } catch (e) {
                log(LM_WARN, `Kobo: store sync failed: ${e.message}`);
            }
        }

        res.set(syncTokenHeader, encodeSyncToken({id: device.id, generation: sync.generation}, storeToken));
        if (more)
            res.set('x-kobo-sync', 'continue');
        sendJson(res, results);
    }

    // What the phases of one sync share: the wanted books, the device's rows as this sync changes them,
    // the reading states it sets, and its results.
    async startSync(req, token, device, fresh) {
        // A reset from the UI while conversions are awaited bumps it in place: this sync must not undo it.
        const generation = device.generation;
        const {lists, wanted, orphanUids} = await this.collectWanted(device);
        const startBooks = JSON.parse(JSON.stringify(device.books));
        const startTags = JSON.parse(JSON.stringify(device.tags || {}));
        const books = JSON.parse(JSON.stringify(device.books));
        // A book removed from a collection on the device stays out of it until it leaves that list here.
        for (const [uuid, row] of Object.entries(books)) {
            const item = wanted.get(uuid);
            // The lists name another record for this Kobo id (re-keyed lists whose device rows were not
            // saved, another copy with the same libid): files, covers and metadata come from that one.
            if (item && row.bookUid !== item.bookUid)
                Object.assign(row, {bookUid: item.bookUid, stableKey: item.stableKey});
            const listIds = (item ? item.listIds : orphanUids.get(row.bookUid) || []);
            row.collectionRemoved = (row.collectionRemoved || []).filter(listId => listIds.includes(listId));
        }
        if (fresh) {
            // The device lost its library (new setup, sign-out, forced resync): send everything
            // again, but keep books the reader deleted on the device suppressed.
            for (const [uuid, row] of Object.entries(books)) {
                if (!row.deletedOnDevice)
                    delete books[uuid];
            }
        }
        if (device.resendDeletedBooks) {
            // The lists define what the device holds: a listed book deleted on it is announced again,
            // with the same ids and its saved reading state.
            for (const [uuid, row] of Object.entries(books)) {
                if (row.deletedOnDevice && wanted.has(uuid))
                    delete books[uuid];
            }
        }
        const savedStates = this.store.data.states[device.userId] || {};
        const states = {};
        return {
            req, token, device, generation, lists, wanted, orphanUids, startBooks, startTags, books, states,
            tagsBefore: (fresh ? {} : device.tags),
            stateFor: uuid => (states[uuid] || (savedStates[uuid] ? JSON.parse(JSON.stringify(savedStates[uuid])) : null)),
            now: new Date().toISOString(),
            results: [],
            fingerprints: new Map(),
            deadline: 0,
            more: false,
            newItems: 0,
            refreshed: 0,
        };
    }

    // 1) books that left every bound list
    syncRemovedBooks({device, books, wanted, orphanUids, results}) {
        for (const [uuid, row] of Object.entries(books)) {
            if (wanted.has(uuid)) {
                row.detached = false;
                continue;
            }
            if (orphanUids.has(row.bookUid) || row.detached)
                continue;
            if (row.deletedOnDevice) {
                delete books[uuid];
            } else if (device.keepRemovedBooks) {
                row.detached = true;
            } else {
                results.push({ChangedEntitlement: {
                    BookEntitlement: this.bookEntitlement(uuid, row, true),
                    BookMetadata: {EntitlementId: uuid, RevisionId: uuid, CrossRevisionId: uuid, Title: row.title || '', DownloadUrls: []},
                }});
                delete books[uuid];
            }
        }
    }

    // 2) new books, announced only once their file (and exact size) exists
    async syncNewBooks(sync) {
        const {req, token, books, wanted, states, stateFor, now, results} = sync;
        sync.deadline = Date.now() + this.prepareBudgetMs;
        for (const item of wanted.values()) {
            if (books[item.uuid])
                continue;
            if (results.length >= syncItemLimit) {
                sync.more = true;
                break;
            }
            const target = this.targetFormat(item.book);
            const fingerprint = (target ? await this.conversionFingerprint(item.book, target, sync.fingerprints) : '');
            const prepared = await this.prepare(item, sync.deadline, fingerprint);
            if (!prepared.ready)
                continue;

            const row = {
                bookUid: item.bookUid, stableKey: item.stableKey, title: item.book.title || '',
                convertTo: prepared.ready.convertTo, koboFormats: prepared.ready.koboFormats, size: prepared.ready.size,
                fileAuthors: prepared.ready.authors || [], fingerprint: fingerprint || '',
                sentAt: now, status: '', listRead: item.read, detached: false, deletedOnDevice: false, collectionRemoved: [],
            };
            row.metaHash = this.metadataHash(item.book, row);
            const entitlement = {
                BookEntitlement: this.bookEntitlement(item.uuid, row),
                BookMetadata: await this.bookMetadata(req, token, item.uuid, item.book, row),
            };
            let state = stateFor(item.uuid);
            if (item.read && (!state || state.status !== 'Finished')) {
                state = state || this.emptyState(now);
                this.setStatus(state, 'Finished', now);
                states[item.uuid] = state;
            }
            if (state) {
                entitlement.ReadingState = this.readingStateResponse(item.uuid, row, state);
                row.status = state.status;
            }
            results.push({NewEntitlement: entitlement});
            books[item.uuid] = row;
            sync.newItems++;
        }
    }

    // 3) books that changed after they were announced. The file: edited fb2cng config or version,
    //    another target format, or a flushed cache regenerated with a different size (noticed on
    //    download). The metadata: admin title/author/series edits, or a re-index that changed them.
    //    A refresh asked from the UI re-announces the book with both, changed or not.
    async syncChangedBooks(sync) {
        const {req, token, books, wanted, stateFor, now, results, deadline} = sync;
        for (const item of wanted.values()) {
            const row = books[item.uuid];
            if (sync.more || !row || row.sentAt === now || row.deletedOnDevice)
                continue;
            // Announced before metadata hashes were recorded: adopt the one of what was sent then.
            row.metaHash = row.metaHash || this.metadataHash(item.book);
            const target = this.targetFormat(item.book);
            const fingerprint = target && await this.conversionFingerprint(item.book, target, sync.fingerprints);
            let fileChanged = false;
            if (target && fingerprint) {
                const sameFormat = (target.convertTo === row.convertTo);
                if (!row.fingerprint && sameFormat && !row.fileChanged)
                    row.fingerprint = fingerprint;
                else
                    fileChanged = (row.fingerprint !== fingerprint || !sameFormat || row.fileChanged);
            }
            // Announced before file authors were read: read them once from the (cached) file. Until it's
            // ready the record's authors stand, and the change goes out with a later sync.
            if (!fileChanged && target && !Array.isArray(row.fileAuthors)) {
                const prepared = await this.prepare(item, deadline, fingerprint || '');
                if (prepared.ready)
                    row.fileAuthors = prepared.ready.authors || [];
                else if (prepared.failed)
                    row.fileAuthors = [];
            }
            let metaHash = this.metadataHash(item.book, row);
            const metaChanged = (row.metaHash !== metaHash);
            const forced = (row.refresh === true);
            if (!fileChanged && !metaChanged && !forced)
                continue;
            if (results.length >= syncItemLimit) {
                sync.more = true;
                break;
            }
            if (fileChanged || (forced && target)) {
                const prepared = await this.prepare(item, deadline, fingerprint || '');
                if (prepared.ready) {
                    Object.assign(row, {
                        convertTo: prepared.ready.convertTo, koboFormats: prepared.ready.koboFormats, size: prepared.ready.size,
                        fileAuthors: prepared.ready.authors || [], fingerprint: fingerprint || row.fingerprint, fileChanged: false,
                    });
                    // A new download URL, so the device takes the file again even when it is the same.
                    if (forced)
                        row.revision = (row.revision || 0) + 1;
                    metaHash = this.metadataHash(item.book, row);
                    sync.refreshed++;
                } else if (forced && !prepared.failed) {
                    // Still converting (or the converter is busy): the refresh goes out on a later sync.
                    continue;
                } else if (!metaChanged && !forced) {
                    continue;
                }
                // Otherwise the new metadata goes now, the new file on a later sync.
            }
            Object.assign(row, {metaHash, title: item.book.title || row.title, changedAt: now});
            delete row.refresh;
            const entitlement = {
                BookEntitlement: this.bookEntitlement(item.uuid, row),
                BookMetadata: await this.bookMetadata(req, token, item.uuid, item.book, row),
            };
            // Re-sent with the refresh, so a device replacing the file keeps its place in the book.
            const state = forced && stateFor(item.uuid);
            if (state)
                entitlement.ReadingState = this.readingStateResponse(item.uuid, row, state);
            results.push({ChangedEntitlement: entitlement});
        }
    }

    // 4) "read" ticked or unticked in the web UI since the last sync
    syncReadFlags(sync) {
        const {books, wanted, states, stateFor, now, results} = sync;
        for (const item of wanted.values()) {
            const row = books[item.uuid];
            if (!row || row.sentAt === now || row.changedAt === now || row.deletedOnDevice || row.listRead === item.read)
                continue;
            if (results.length >= syncItemLimit) {
                sync.more = true;
                break;
            }
            row.listRead = item.read;
            const state = stateFor(item.uuid) || this.emptyState(now);
            const status = (item.read ? 'Finished' : 'ReadyToRead');
            // The state is shared by the profile's devices (another one may have set it already):
            // what matters is the status this device was told.
            if (row.status === status)
                continue;
            this.setStatus(state, status, now);
            states[item.uuid] = state;
            row.status = status;
            results.push({ChangedReadingState: {ReadingState: this.readingStateResponse(item.uuid, row, state)}});
        }
    }

    async saveSyncResult({device, generation, books, startBooks, startTags, states, now}, tags) {
        await this.store.saveSync(device.id, (target, data) => {
            // Only states changed by this sync: a concurrent state PUT must not be overwritten.
            data.states[device.userId] = Object.assign(data.states[device.userId] || {}, states);
            target.lastSyncAt = now;
            if (target.generation !== generation)
                return;
            // A state PUT or delete may have landed while conversions were awaited: keep what it changed.
            for (const [uuid, row] of Object.entries(books)) {
                const live = target.books[uuid];
                const start = startBooks[uuid];
                if (!live || !start)
                    continue;
                for (const field of ['deletedOnDevice', 'status', 'listRead', 'fileChanged', 'collectionRemoved', 'refresh']) {
                    if (JSON.stringify(live[field]) !== JSON.stringify(start[field]))
                        row[field] = live[field];
                }
            }
            // A collection renamed or deleted on the device meanwhile is sent again on the next sync.
            for (const listId of Object.keys(Object.assign({}, startTags, target.tags || {}))) {
                if (JSON.stringify((target.tags || {})[listId]) !== JSON.stringify(startTags[listId]))
                    delete tags[listId];
            }
            target.books = books;
            target.tags = tags;
        });
    }

    // ------------------------------------------------------------------ per-book endpoints
    async metadataRequest(req, res, device, token) {
        const uuid = req.params.uuid;
        const row = device.books[uuid];
        const book = row && await this.bookRecord(row.bookUid);
        if (!book)
            return await this.storeOr(req, res, device, token, () => sendJson(res, [], 404));
        sendJson(res, [await this.bookMetadata(req, token, uuid, book, row)]);
    }

    async getState(req, res, device, token) {
        const uuid = req.params.uuid;
        const row = device.books[uuid];
        if (!row)
            return await this.storeOr(req, res, device, token, () => sendJson(res, [], 404));
        const state = this.store.getState(device.userId, uuid) || this.emptyState(row.sentAt);
        sendJson(res, [this.readingStateResponse(uuid, row, state)]);
    }

    async putState(req, res, device, token) {
        const uuid = req.params.uuid;
        const row = device.books[uuid];
        if (!row)
            return await this.storeOr(req, res, device, token, () => sendJson(res, {error: 'Unknown book'}, 404));

        const incoming = req.body && Array.isArray(req.body.ReadingStates) ? req.body.ReadingStates[0] : null;
        if (!incoming || typeof(incoming) !== 'object')
            return sendJson(res, {error: 'Malformed request data is missing ReadingStates'}, 400);

        const now = new Date().toISOString();
        const result = {EntitlementId: uuid};
        // The reading list is updated before the device state, so a sync running meanwhile never sees
        // this device's list flag flipped while the list still says unread (it would send ReadyToRead).
        const statusInfo = incoming.StatusInfo;
        const status = (statusInfo && ['ReadyToRead', 'Reading', 'Finished'].includes(statusInfo.Status) ? statusInfo.Status : '');
        const current = this.store.getState(device.userId, uuid);
        const finished = (status === 'Finished' && (!current || current.status !== 'Finished'));
        const markedRead = (finished && await this.markRead(device.userId, row.bookUid));
        let progress = null;
        const saved = await this.store.saveSync(device.id, (target, data) => {
            const rows = data.states[target.userId] = data.states[target.userId] || {};
            const state = rows[uuid] = rows[uuid] || this.emptyState(now);
            const bookmark = incoming.CurrentBookmark;
            if (bookmark && typeof(bookmark) === 'object') {
                for (const field of ['ProgressPercent', 'ContentSourceProgressPercent']) {
                    const value = Number(bookmark[field]);
                    if (Number.isFinite(value))
                        state.bookmark[field] = Math.max(0, Math.min(100, value));
                }
                const location = bookmark.Location;
                if (location && typeof(location) === 'object')
                    state.bookmark.Location = {Value: String(location.Value || '').slice(0, 512), Type: String(location.Type || '').slice(0, 64), Source: String(location.Source || '').slice(0, 512)};
                state.bookmark.lastModified = now;
                result.CurrentBookmarkResult = {Result: 'Success'};
                if (Number.isFinite(Number(bookmark.ProgressPercent)))
                    progress = {percent: state.bookmark.ProgressPercent, modified: this.deviceTime(bookmark.LastModified, now)};
            }
            const statistics = incoming.Statistics;
            if (statistics && typeof(statistics) === 'object') {
                for (const field of ['SpentReadingMinutes', 'RemainingTimeMinutes']) {
                    const value = parseInt(statistics[field], 10);
                    if (Number.isFinite(value) && value >= 0)
                        state.statistics[field] = value;
                }
                state.statistics.lastModified = now;
                result.StatisticsResult = {Result: 'Success'};
            }
            if (status) {
                this.setStatus(state, status, now);
                result.StatusInfoResult = {Result: 'Success'};
            }
            state.lastModified = now;
            state.priorityTimestamp = now;
            if (target.books[uuid]) {
                target.books[uuid].status = state.status;
                // This device already knows the list flag flipped. Other devices of the profile
                // don't: they get Finished from the list flag on their next sync.
                if (markedRead)
                    target.books[uuid].listRead = true;
            }
            return state;
        });

        // Marking the book read already set the web progress to finished.
        if (progress && !markedRead)
            await this.syncWebProgress(device.userId, row.bookUid, progress.percent, progress.modified);

        result.LastModified = koboTime(saved ? saved.lastModified : now);
        result.PriorityTimestamp = koboTime(saved ? saved.priorityTimestamp : now);
        sendJson(res, {RequestResult: 'Success', UpdateResults: [result]});
    }

    // When the reader turned the page on the device (it may sync later); a clock far ahead counts as now.
    deviceTime(value, now) {
        const time = Date.parse(String(value || ''));
        return (Number.isFinite(time) && time <= Date.now() + 5*60*1000 ? new Date(time).toISOString() : now);
    }

    // Kobo progress shows up in the web reader's "continue reading" when it is newer.
    async syncWebProgress(userId, bookUid, percent, modified) {
        try {
            await this.worker.readingListStore.mergeDeviceProgress(userId, bookUid, percent / 100, modified);
        } catch (e) {
            log(LM_WARN, `Kobo: cannot update reader progress of ${bookUid}: ${e.message}`);
        }
    }

    // True when the reading list now says read.
    async markRead(userId, bookUid) {
        try {
            await this.worker.readingListStore.setBooksRead(userId, [bookUid], true);
            return true;
        } catch (e) {
            log(LM_WARN, `Kobo: cannot mark ${bookUid} read: ${e.message}`);
            return false;
        }
    }

    // Deleting on the device stops re-sending the book to it while it stays listed (unless the device
    // has resendDeletedBooks); taking it off the list clears that. The list's read flag and web progress stay as they
    // are: deleting a book to free space says nothing about having read it.
    async deleteBook(req, res, device, token) {
        const uuid = req.params.uuid;
        const row = device.books[uuid];
        if (!row)
            return await this.storeOr(req, res, device, token, () => res.sendStatus(204));

        await this.store.saveSync(device.id, (target) => {
            if (target.books[uuid])
                target.books[uuid].deletedOnDevice = true;
        });
        res.sendStatus(204);
    }

    // ------------------------------------------------------------------ collection edits on the device
    // Collections are read-only from the device: inpx-shelf lists are never changed from here. A bound
    // list's collection that was renamed or deleted on the device is sent again as the list defines
    // it; a book removed from it stays out of it. Collections made on the device stay there.
    boundListId(device, tagId) {
        return device.listIds.find(listId => this.tagId(listId) === tagId) || null;
    }

    tagItemUuids(req) {
        const items = (req.body && Array.isArray(req.body.Items) ? req.body.Items : []);
        return items.map(item => String((item && item.RevisionId) || '')).filter(Boolean);
    }

    async createTag(req, res, device, token) {
        await this.storeOr(req, res, device, token, () => sendJson(res, crypto.randomUUID(), 201));
    }

    async updateTag(req, res, device, token) {
        const listId = this.boundListId(device, req.params.tagId);
        if (!listId)
            return await this.storeOr(req, res, device, token, () => res.status(200).send(' '));
        await this.store.saveSync(device.id, (target) => {
            // No stored signature: the next sync sends the collection again (ChangedTag, or NewTag after a delete).
            if (req.method === 'DELETE')
                delete target.tags[listId];
            else if (target.tags[listId])
                target.tags[listId] = Object.assign({}, target.tags[listId], {signature: ''});
        });
        res.status(200).send(' ');
    }

    async editTagItems(req, res, device, token, removed) {
        const listId = this.boundListId(device, req.params.tagId);
        if (!listId)
            return await this.storeOr(req, res, device, token, () => res.status(removed ? 200 : 201).send(''));
        const uuids = new Set(this.tagItemUuids(req));
        await this.store.saveSync(device.id, (target) => {
            for (const uuid of uuids) {
                const row = target.books[uuid];
                if (!row)
                    continue;
                const others = row.collectionRemoved.filter(id => id !== listId);
                // Putting a book back into the collection on the device lifts its suppression.
                row.collectionRemoved = (removed ? others.concat(listId) : others);
            }
        });
        res.status(removed ? 200 : 201).send('');
    }

    async download(req, res, device) {
        const row = device.books[req.params.uuid];
        if (!row)
            return res.sendStatus(404);

        const prepared = await this.worker.getPreparedBookFile(row.bookUid, row.convertTo || '');
        const filePath = path.resolve(prepared.rawFile);
        const size = (await fs.stat(filePath)).size;
        if (size !== row.size)
            await this.noteFileChanged(device, req.params.uuid, row, size);
        let fileName = path.basename(prepared.downFileName || 'book.epub');
        if (row.convertTo === 'kepub' && !/\.kepub\.epub$/i.test(fileName))
            fileName = fileName.replace(/\.kepub$/i, '').replace(/\.epub$/i, '') + '.kepub.epub';
        res.set('Content-Type', 'application/epub+zip');
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.sendFile(filePath);
        // KOReader on the Kobo may open this file too.
        require('../Kosync').rememberFile(this.worker, filePath, row.bookUid);
    }

    // The cached file was regenerated (cache flushed, converter output differs): announce the new
    // size on the next sync, and stop handing out the stale size from the preparation cache.
    async noteFileChanged(device, uuid, row, size) {
        const entry = this.prepared.get(this.preparedKey(row.bookUid, row.convertTo || '', row.fingerprint));
        if (entry && entry.result)
            entry.result = Object.assign({}, entry.result, {size});
        await this.store.saveSync(device.id, (target) => {
            if (target.books[uuid])
                target.books[uuid].fileChanged = true;
        });
    }

    async initialization(req, res, device, token) {
        const base = this.deviceBase(req, token);
        let resources = null;
        if (device.storeProxy) {
            try {
                const body = await (await this.storeRequest(req, token)).json();
                if (body && body.Resources && typeof(body.Resources) === 'object')
                    resources = body.Resources;
            } catch (e) {
                log(LM_WARN, `Kobo: store initialization failed: ${e.message}`);
            }
        }
        resources = resources || defaultResources();
        // Every store API call comes back here: answered locally, or forwarded when the device proxies the store.
        for (const [key, value] of Object.entries(resources)) {
            if (typeof(value) === 'string' && value.startsWith('https://storeapi.kobo.com'))
                resources[key] = base + value.slice('https://storeapi.kobo.com'.length);
        }
        resources.library_sync = `${base}/v1/library/sync`;
        resources.image_host = this.publicBase(req);
        resources.image_url_template = `${base}/{ImageId}/{Width}/{Height}/false/image.jpg`;
        resources.image_url_quality_template = `${base}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`;
        res.set('x-kobo-apitoken', 'e30=');
        sendJson(res, {Resources: resources});
    }

    async auth(req, res, device, token) {
        if (device.storeProxy) {
            try {
                const response = await this.storeRequest(req, token);
                if (response.status < 500)
                    return await this.relayStoreResponse(res, response);
            } catch (e) {
                log(LM_WARN, `Kobo: store auth failed, answering locally: ${e.message}`);
            }
        }
        this.authResponse(req, res);
    }

    authResponse(req, res) {
        const body = (req.body && typeof(req.body) === 'object' ? req.body : {});
        sendJson(res, {
            AccessToken: crypto.randomBytes(24).toString('base64'),
            RefreshToken: crypto.randomBytes(24).toString('base64'),
            TokenType: 'Bearer',
            TrackingId: crypto.randomUUID(),
            UserKey: String(body.UserKey || ''),
        });
    }

    // ------------------------------------------------------------------ routing
    router() {
        const router = express.Router({mergeParams: true});
        // Raw bodies so store-bound requests are forwarded byte for byte.
        router.use(express.raw({type: () => true, limit: '1mb'}));
        router.use((req, res, next) => {
            req.rawBody = (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
            try {
                req.body = (req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {});
            } catch (e) {
                req.body = {};
            }
            next();
        });

        // Express 4 does not catch rejections of async middleware: errors are answered here.
        router.use(async(req, res, next) => {
            res.set('Cache-Control', 'no-store');
            try {
                await this.store.load();
            } catch (e) {
                log(LM_ERR, `Kobo: cannot load ${this.store.file}: ${e.message}`);
                return res.sendStatus(503);
            }
            let device = this.store.findDeviceByToken(req.params.token);
            // A device outlives its profile when the profile was deleted while Kobo sync was off, or an
            // older profile store was restored. Profile lookups fall back to the first profile (usually
            // the admin), so such a device must not reach them.
            if (device && !await this.worker.readingListStore.hasUser(device.userId).catch(() => false)) {
                log(LM_WARN, `Kobo: device ${device.id} belongs to a profile that no longer exists; request refused`);
                device = null;
            }
            if (!device) {
                try {
                    this.security.checkLoginRate(req, 'kobo');
                    this.security.recordLoginAttempt(req, false, 'kobo');
                } catch (e) {
                    if (e.code === 'INPX_LOGIN_RATE_LIMIT') {
                        res.set('Retry-After', String(e.retryAfter));
                        return res.status(429).send('Too many attempts');
                    }
                }
                return res.sendStatus(401);
            }
            req.koboDevice = device;
            next();
        });

        const handle = (fn) => async(req, res) => {
            try {
                await fn(req, res, req.koboDevice, req.params.token);
            } catch (e) {
                const status = errorStatus(e);
                log((status === 500 ? LM_ERR : LM_WARN), `Kobo: ${req.method} ${maskTokens(req.originalUrl)}: ${e.message}`);
                if (res.headersSent)
                    return;
                // The device retries a failed download later; a busy converter is not a broken book.
                if (status === 503)
                    res.set('Retry-After', '60');
                res.status(status).send('Kobo sync error');
            }
        };

        router.get('/v1/initialization', handle((req, res, device, token) => this.initialization(req, res, device, token)));
        router.post(['/v1/auth/device', '/v1/auth/refresh'], handle((req, res, device, token) => this.auth(req, res, device, token)));
        router.get('/v1/library/sync', handle((req, res, device, token) => this.sync(req, res, device, token)));
        router.post('/v1/library/tags', handle((req, res, device, token) => this.createTag(req, res, device, token)));
        router.put('/v1/library/tags/:tagId', handle((req, res, device, token) => this.updateTag(req, res, device, token)));
        router.delete('/v1/library/tags/:tagId', handle((req, res, device, token) => this.updateTag(req, res, device, token)));
        router.post('/v1/library/tags/:tagId/items', handle((req, res, device, token) => this.editTagItems(req, res, device, token, false)));
        router.post('/v1/library/tags/:tagId/items/delete', handle((req, res, device, token) => this.editTagItems(req, res, device, token, true)));
        router.get('/v1/library/:uuid/metadata', handle((req, res, device, token) => this.metadataRequest(req, res, device, token)));
        router.get('/v1/library/:uuid/state', handle((req, res, device, token) => this.getState(req, res, device, token)));
        router.put('/v1/library/:uuid/state', handle((req, res, device, token) => this.putState(req, res, device, token)));
        router.delete('/v1/library/:uuid', handle((req, res, device, token) => this.deleteBook(req, res, device, token)));
        router.get('/download/:uuid/:format', handle((req, res, device) => this.download(req, res, device)));
        router.get(['/:uuid/:width/:height/:greyscale/image.jpg', '/:uuid/:width/:height/:quality/:greyscale/image.jpg'],
            handle((req, res, device) => this.cover(req, res, device)));
        router.get('/v1/user/loyalty/benefits', handle((req, res, device, token) =>
            this.storeOr(req, res, device, token, () => sendJson(res, {Benefits: {}}))));
        router.all('/v1/analytics/gettests', handle((req, res, device, token) => this.storeOr(req, res, device, token,
            () => sendJson(res, {Result: 'Success', TestKey: String(req.headers['x-kobo-userkey'] || ''), Tests: {}}))));
        // Store, wishlist, recommendations, …
        router.all('*', handle((req, res, device, token) => this.storeOr(req, res, device, token, () => sendJson(res, {}))));

        return router;
    }
}

Object.assign(KoboService.prototype, require('./Preparation'), require('./Covers'), require('./StoreProxy'));

function init(app, config, worker, security) {
    if (!config.koboEnabled)
        return null;

    const service = new KoboService(config, worker, security);
    activeService = service;
    worker.koboService = service;
    // The server awaits this before it listens: Security.verifyRequiredAuth checks device tokens
    // synchronously, and before the load every device would be refused.
    service.ready = service.store.load().catch(e => log(LM_ERR, `Kobo: cannot load ${service.store.file}: ${e.message}`));
    app.use(`${rootPath(config)}/:token`, service.router());
    log(`Kobo sync enabled at ${rootPath(config)}/<device token>`);
    return service;
}

module.exports = {init, isAuthorizedRequest, rootPath, uuidv5, stableKey, maskTokens, KoboService};
