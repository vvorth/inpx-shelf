const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const express = require('express');

const KoboStore = require('./KoboStore');
const defaultResources = require('./resources');
const {BookMetadata} = require('../BookMetadata');
const {coverCacheKey} = require('../BookAssets');
const bookConverter = require('../BookConverter');

// Resolved lazily: Security requires this module before the logger may be initialized.
function log(...args) {
    return new (require('../AppLogger'))().log(...args);
}

const syncItemLimit = 100;
// Kobo sync requests must answer quickly; conversions that take longer finish
// in the background and are announced on a later sync.
const prepareBudgetMs = 20000;
const prepareRetryMs = 10*60*1000;
// Stay well below the shared conversion queue so web downloads keep working.
const prepareConcurrency = 2;
const preparedEntryLimit = 2000;
// Background preparation of books added to bound lists (one at a time, so sync keeps a slot).
const prewarmQueueLimit = 5000;
const prewarmAttempts = 3;
const prewarmBusyRetryMs = 5000;
const busyConversionCodes = new Set(['INPX_CONVERSION_QUEUE_FULL', 'INPX_CONVERSION_QUEUE_TIMEOUT']);
// Looking an orphan up by libid scans the whole book table: at most once an hour per book.
const rekeyRetryMs = 60*60*1000;
const rekeyCheckedLimit = 10000;
const uuidNamespace = 'b0f7c0a4-5a43-4b8e-9d0e-6f1a8c2e4d17';
const zeroUuid = '00000000-0000-0000-0000-000000000001';
const syncTokenHeader = 'x-kobo-synctoken';
const koboStoreUrl = 'https://storeapi.kobo.com';
const koboImageUrl = 'https://cdn.kobo.com/book-images';
const storeTimeoutMs = 10000;
// Hop-by-hop headers and ones fetch() already decoded must not be relayed.
const skippedStoreHeaders = new Set(['host', 'connection', 'content-length', 'content-encoding', 'transfer-encoding',
    'keep-alive', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cookie']);

let activeService = null;

function rootPath(config) {
    return `${String(config.rootPathStatic || '').replace(/\/$/, '')}/kobo`;
}

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

// Device tokens travel in the URL path: never write them to a log.
function maskTokens(url = '') {
    return String(url).replace(/\/kobo\/[0-9a-f]{32}(?=[/?#]|$)/gi, '/kobo/***');
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

function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        if (timer.unref)
            timer.unref();
    });
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
        this.prewarmBusyRetryMs = prewarmBusyRetryMs;
        this.rekeyChecked = new Map();
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
                throw new Error('Список не найден');
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

    // ------------------------------------------------------------------ list → device
    async collectWanted(device, rekey = true) {
        const store = this.worker.readingListStore;
        const lists = [];
        for (const listId of device.listIds) {
            const list = await store.getList(device.userId, listId);
            if (list)
                lists.push(list);
        }

        const overrides = await this.metadataOverrides();
        const wanted = new Map();
        const seenUids = new Set();
        // Listed books missing from the DB, with the lists they are in.
        const orphanUids = new Map();
        const readUids = new Set();
        for (const list of lists) {
            for (const entry of store.normalizeEntries(list.books)) {
                if (entry.read)
                    readUids.add(entry.bookUid);
                if (seenUids.has(entry.bookUid)) {
                    const known = [...wanted.values()].find(item => item.bookUid === entry.bookUid);
                    if (known && !known.listIds.includes(list.id))
                        known.listIds.push(list.id);
                    if (orphanUids.has(entry.bookUid))
                        orphanUids.get(entry.bookUid).push(list.id);
                    continue;
                }
                seenUids.add(entry.bookUid);
                const book = this.withOverrides(await this.worker.getBookRecordByUid(entry.bookUid), overrides);
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
                wanted.get(uuid).listIds.push(list.id);
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
        return this.worker.applyMetadataOverrideToBook(Object.assign({}, book), overrides);
    }

    async bookRecord(bookUid) {
        return this.withOverrides(await this.worker.getBookRecordByUid(bookUid), await this.metadataOverrides());
    }

    // The record-derived metadata a device was told. Description, publisher and year come from the
    // file itself and change only with it, which is re-announced through the file fingerprint and size.
    metadataHash(book) {
        return crypto.createHash('sha1')
            .update(JSON.stringify([book.title || '', book.author || '', book.series || '', String(book.serno || ''), book.lang || '']))
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

    targetFormat(book) {
        const ext = String(book.ext || '').toLowerCase();
        if (ext === 'epub')
            return {convertTo: '', koboFormats: ['EPUB3', 'EPUB']};
        if (ext !== 'fb2' || this.config.conversionEnabled === false)
            return null;
        const formats = (Array.isArray(this.config.conversionFormats) ? this.config.conversionFormats : []);
        if (formats.includes('kepub'))
            return {convertTo: 'kepub', koboFormats: ['KEPUB']};
        if (formats.includes('epub'))
            return {convertTo: 'epub', koboFormats: ['EPUB']};
        return null;
    }

    // Identifies how a converted file is produced (fb2cng config contents and version, converter
    // paths): the same signature the shared conversion cache is keyed by. Memoized per sync.
    async conversionFingerprint(book, target, memo) {
        if (!target.convertTo)
            return 'raw';
        const key = `${String(book.ext || '').toLowerCase()}:${target.convertTo}`;
        if (!memo.has(key)) {
            memo.set(key, bookConverter.getConversionCacheInfo({
                cacheBasePath: 'kobo-fingerprint',
                sourceFileName: `book.${String(book.ext || '').toLowerCase()}`,
                format: target.convertTo,
                config: this.config,
            }).then(info => info.fingerprint, error => {
                log(LM_WARN, `Kobo: cannot check the conversion settings: ${error.message}`);
                return null;
            }));
        }
        return await memo.get(key);
    }

    preparedKey(bookUid, convertTo, fingerprint) {
        return `${bookUid}:${convertTo}:${fingerprint || ''}`;
    }

    // Starts (once per conversion fingerprint) the file preparation and reports whether it is ready right now.
    async prepare(item, deadline, fingerprint = '') {
        const target = this.targetFormat(item.book);
        if (!target)
            return {unsupported: true};

        const key = this.preparedKey(item.bookUid, target.convertTo, fingerprint);
        let entry = this.prepared.get(key);
        if (entry && entry.error && Date.now() - entry.at > prepareRetryMs) {
            this.prepared.delete(key);
            entry = null;
        }
        if (!entry) {
            const inflight = [...this.prepared.values()].filter(item => !item.result && !item.error).length;
            if (inflight >= prepareConcurrency)
                return {pending: true};
            entry = {at: Date.now()};
            entry.promise = (async() => {
                const prepared = await this.worker.getPreparedBookFile(item.bookUid, target.convertTo);
                const stat = await fs.stat(prepared.rawFile);
                return Object.assign({}, target, {size: stat.size});
            })().then(result => {
                entry.result = result;
                return result;
            }, error => {
                entry.error = error;
                entry.at = Date.now();
                if (busyConversionCodes.has(error.code)) {
                    // The shared converter was busy: nothing wrong with the book, try again next time.
                    entry.busy = true;
                    if (this.prepared.get(key) === entry)
                        this.prepared.delete(key);
                } else {
                    log(LM_WARN, `Kobo: cannot prepare ${item.bookUid}: ${error.message}`);
                }
                return null;
            });
            this.prepared.set(key, entry);
            if (this.prepared.size > preparedEntryLimit) {
                const [oldestKey, oldest] = this.prepared.entries().next().value;
                if (oldest.result || oldest.error)
                    this.prepared.delete(oldestKey);
            }
        }

        if (entry.result || entry.error)
            return {ready: entry.result || null, failed: !!entry.error, busy: !!entry.busy};

        const remaining = deadline - Date.now();
        if (remaining > 0)
            await Promise.race([entry.promise, sleep(remaining)]);
        return {ready: entry.result || null, failed: !!entry.error, busy: !!entry.busy, pending: !entry.result && !entry.error};
    }

    // ------------------------------------------------------------------ pre-warm
    // Books added to a list bound to a device start preparing right away, so the next sync can
    // announce them instead of waiting for the conversion. Fire and forget: errors are only logged.
    prewarmBooks(userId, listId, bookUids = []) {
        const data = this.store.data;
        if (!data || !data.devices.some(device => device.userId === userId && device.listIds.includes(listId)))
            return;
        this.enqueuePrewarm(userId, bookUids);
    }

    // Every book of the given lists (a list was just bound, or lists were imported).
    prewarmLists(userId, listIds = null) {
        (async() => {
            await this.store.load();
            const bound = new Set(this.store.data.devices.filter(device => device.userId === userId)
                .flatMap(device => device.listIds));
            const store = this.worker.readingListStore;
            for (const listId of (listIds || [...bound])) {
                if (!bound.has(listId))
                    continue;
                const list = await store.getList(userId, listId);
                if (list)
                    this.enqueuePrewarm(userId, store.normalizeEntries(list.books).map(entry => entry.bookUid));
            }
        })().catch(e => log(LM_WARN, `Kobo: cannot queue books for preparation: ${e.message}`));
    }

    enqueuePrewarm(userId, bookUids = []) {
        // Books a device of this profile already has are prepared already.
        const sent = new Set(this.store.data.devices.filter(device => device.userId === userId)
            .flatMap(device => Object.values(device.books).map(row => row.bookUid)));
        for (const bookUid of bookUids) {
            if (bookUid && !sent.has(bookUid) && this.prewarmQueue.size < prewarmQueueLimit)
                this.prewarmQueue.add(bookUid);
        }
        if (this.prewarmQueue.size && !this.prewarmRunning) {
            this.prewarmRunning = this.runPrewarm()
                .catch(e => log(LM_WARN, `Kobo: book preparation stopped: ${e.message}`))
                .finally(() => {
                    this.prewarmRunning = null;
                });
        }
    }

    async runPrewarm() {
        const fingerprints = new Map();
        while (this.prewarmQueue.size) {
            const bookUid = this.prewarmQueue.values().next().value;
            this.prewarmQueue.delete(bookUid);
            const book = await this.worker.getBookRecordByUid(bookUid);
            const target = book && this.targetFormat(book);
            if (!target)
                continue;
            const fingerprint = await this.conversionFingerprint(book, target, fingerprints);
            const item = {bookUid, book};
            for (let attempt = 1; attempt <= prewarmAttempts; attempt++) {
                // Waits for this book's conversion; a slot taken by a running sync is retried.
                let prepared = await this.prepare(item, Date.now() + this.prewarmBusyRetryMs, fingerprint);
                while (prepared.pending && !prepared.ready && this.prepared.has(this.preparedKey(bookUid, target.convertTo, fingerprint)))
                    prepared = await this.prepare(item, Date.now() + this.prewarmBusyRetryMs, fingerprint);
                if (prepared.ready || (prepared.failed && !prepared.busy))
                    break;
                await sleep(this.prewarmBusyRetryMs);
            }
        }
    }

    async readExtraMetadata(book) {
        try {
            return await this.metadata.read(book);
        } catch (e) {
            return {};
        }
    }

    async bookMetadata(req, token, uuid, book, row) {
        const extra = await this.readExtraMetadata(book);
        const authors = String(book.author || '').split(',').map(name => name.trim()).filter(Boolean);
        const lang = String(extra.language || book.lang || '').trim().toLowerCase().slice(0, 2);
        const year = String(extra.publishedYear || book.year || '').match(/\b\d{4}\b/);
        const downloadUrl = `${this.deviceBase(req, token)}/download/${uuid}/${row.convertTo || 'raw'}`;
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
        const {lists, wanted, orphanUids} = await this.collectWanted(device);
        const startBooks = JSON.parse(JSON.stringify(device.books));
        const startTags = JSON.parse(JSON.stringify(device.tags || {}));
        const books = JSON.parse(JSON.stringify(device.books));
        // A book removed from a collection on the device stays out of it until it leaves that list here.
        for (const [uuid, row] of Object.entries(books)) {
            const item = wanted.get(uuid);
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
        const tagsBefore = (fresh ? {} : device.tags);
        const savedStates = this.store.data.states[device.userId] || {};
        const states = {};
        const stateFor = uuid => (states[uuid] || (savedStates[uuid] ? JSON.parse(JSON.stringify(savedStates[uuid])) : null));
        const now = new Date().toISOString();
        const results = [];

        // 1) books that left every bound list
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

        // 2) new books, announced only once their file (and exact size) exists
        const deadline = Date.now() + this.prepareBudgetMs;
        const fingerprints = new Map();
        let more = false;
        let newItems = 0;
        for (const item of wanted.values()) {
            if (books[item.uuid])
                continue;
            if (results.length >= syncItemLimit) {
                more = true;
                break;
            }
            const target = this.targetFormat(item.book);
            const fingerprint = (target ? await this.conversionFingerprint(item.book, target, fingerprints) : '');
            const prepared = await this.prepare(item, deadline, fingerprint);
            if (!prepared.ready)
                continue;

            const row = {
                bookUid: item.bookUid, stableKey: item.stableKey, title: item.book.title || '',
                convertTo: prepared.ready.convertTo, koboFormats: prepared.ready.koboFormats, size: prepared.ready.size,
                fingerprint: fingerprint || '', metaHash: this.metadataHash(item.book),
                sentAt: now, status: '', listRead: item.read, detached: false, deletedOnDevice: false, collectionRemoved: [],
            };
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
            newItems++;
        }

        // 3) books that changed after they were announced. The file: edited fb2cng config or version,
        //    another target format, or a flushed cache regenerated with a different size (noticed on
        //    download). The metadata: admin title/author/series edits, or a re-index that changed them.
        let refreshed = 0;
        for (const item of wanted.values()) {
            const row = books[item.uuid];
            if (more || !row || row.sentAt === now || row.deletedOnDevice)
                continue;
            const metaHash = this.metadataHash(item.book);
            // Announced before metadata hashes were recorded: adopt the current one.
            row.metaHash = row.metaHash || metaHash;
            const metaChanged = (row.metaHash !== metaHash);
            const target = this.targetFormat(item.book);
            const fingerprint = target && await this.conversionFingerprint(item.book, target, fingerprints);
            let fileChanged = false;
            if (target && fingerprint) {
                const sameFormat = (target.convertTo === row.convertTo);
                if (!row.fingerprint && sameFormat && !row.fileChanged)
                    row.fingerprint = fingerprint;
                else
                    fileChanged = (row.fingerprint !== fingerprint || !sameFormat || row.fileChanged);
            }
            if (!fileChanged && !metaChanged)
                continue;
            if (results.length >= syncItemLimit) {
                more = true;
                break;
            }
            if (fileChanged) {
                const prepared = await this.prepare(item, deadline, fingerprint);
                if (prepared.ready) {
                    Object.assign(row, {
                        convertTo: prepared.ready.convertTo, koboFormats: prepared.ready.koboFormats, size: prepared.ready.size,
                        fingerprint, fileChanged: false,
                    });
                    refreshed++;
                } else if (!metaChanged) {
                    continue;
                }
                // Otherwise the new metadata goes now, the new file on a later sync.
            }
            Object.assign(row, {metaHash, title: item.book.title || row.title, changedAt: now});
            results.push({ChangedEntitlement: {
                BookEntitlement: this.bookEntitlement(item.uuid, row),
                BookMetadata: await this.bookMetadata(req, token, item.uuid, item.book, row),
            }});
        }

        // 4) "read" ticked or unticked in the web UI since the last sync
        for (const item of wanted.values()) {
            const row = books[item.uuid];
            if (!row || row.sentAt === now || row.changedAt === now || row.deletedOnDevice || row.listRead === item.read)
                continue;
            if (results.length >= syncItemLimit) {
                more = true;
                break;
            }
            row.listRead = item.read;
            const state = stateFor(item.uuid) || this.emptyState(now);
            const status = (item.read ? 'Finished' : 'ReadyToRead');
            if (state.status === status)
                continue;
            this.setStatus(state, status, now);
            states[item.uuid] = state;
            row.status = status;
            results.push({ChangedReadingState: {ReadingState: this.readingStateResponse(item.uuid, row, state)}});
        }

        // 5) one collection per bound list (computed against the updated book set)
        const tags = this.syncTags(Object.assign({}, device, {books, tags: tagsBefore}), lists, wanted, results, orphanUids);

        await this.store.saveSync(device.id, (target, data) => {
            // A state PUT or delete may have landed while conversions were awaited: keep what it changed.
            for (const [uuid, row] of Object.entries(books)) {
                const live = target.books[uuid];
                const start = startBooks[uuid];
                if (!live || !start)
                    continue;
                for (const field of ['deletedOnDevice', 'status', 'listRead', 'fileChanged', 'collectionRemoved']) {
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
            target.lastSyncAt = now;
            // Only states changed by this sync: a concurrent state PUT must not be overwritten.
            data.states[device.userId] = Object.assign(data.states[device.userId] || {}, states);
        });

        if (newItems || results.length)
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

        res.set(syncTokenHeader, encodeSyncToken(device, storeToken));
        if (more)
            res.set('x-kobo-sync', 'continue');
        sendJson(res, results);
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
        let finished = false;
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
            const statusInfo = incoming.StatusInfo;
            if (statusInfo && ['ReadyToRead', 'Reading', 'Finished'].includes(statusInfo.Status)) {
                finished = (statusInfo.Status === 'Finished' && state.status !== 'Finished');
                this.setStatus(state, statusInfo.Status, now);
                result.StatusInfoResult = {Result: 'Success'};
            }
            state.lastModified = now;
            state.priorityTimestamp = now;
            if (target.books[uuid])
                target.books[uuid].status = state.status;
            if (finished) {
                // Every device of this profile already knows the list flag is about to flip.
                for (const other of data.devices.filter(item => item.userId === target.userId)) {
                    for (const otherRow of Object.values(other.books)) {
                        if (otherRow.bookUid === row.bookUid)
                            otherRow.listRead = true;
                    }
                }
            }
            return state;
        });

        if (progress)
            await this.syncWebProgress(device.userId, row.bookUid, progress.percent, progress.modified);
        if (finished)
            await this.markRead(device.userId, row.bookUid);

        result.LastModified = koboTime(saved ? saved.lastModified : now);
        result.PriorityTimestamp = koboTime(saved ? saved.priorityTimestamp : now);
        sendJson(res, {RequestResult: 'Success', UpdateResults: [result]});
    }

    // When the reader turned the page on the device (it may sync later); a clock far ahead counts as now.
    deviceTime(value, now) {
        const time = Date.parse(String(value || ''));
        return (Number.isFinite(time) && time <= Date.now() + 5*60*1000 ? new Date(time).toISOString() : now);
    }

    // Kobo progress shows up in the web reader's "continue reading". The newer side wins (the store
    // keeps a newer web position). Kobo locations can't be mapped onto the FB2 reader's pages, so only
    // the percent carries over and the web reader opens at that percent.
    async syncWebProgress(userId, bookUid, percent, modified) {
        const store = this.worker.readingListStore;
        try {
            const value = Math.max(0, Math.min(1, percent / 100));
            const {progress: current, progressGeneration} = await store.getReaderState(userId, bookUid);
            if (Math.abs((current.percent || 0) - value) < 0.0001 || (!current.updatedAt && value <= 0))
                return;
            await store.updateReaderProgress(userId, bookUid, {
                percent: value, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '',
                updatedAt: modified, generation: progressGeneration,
            });
        } catch (e) {
            log(LM_WARN, `Kobo: cannot update reader progress of ${bookUid}: ${e.message}`);
        }
    }

    async markRead(userId, bookUid) {
        try {
            await this.worker.readingListStore.setBooksRead(userId, [bookUid], true);
        } catch (e) {
            log(LM_WARN, `Kobo: cannot mark ${bookUid} read: ${e.message}`);
        }
    }

    // Deleting on the device marks the book read and stops re-sending it while it
    // stays listed; taking it off the list (or a resync) clears that.
    async deleteBook(req, res, device, token) {
        const uuid = req.params.uuid;
        const row = device.books[uuid];
        if (!row)
            return await this.storeOr(req, res, device, token, () => res.sendStatus(204));

        await this.store.saveSync(device.id, (target) => {
            const current = target.books[uuid];
            if (current) {
                current.deletedOnDevice = true;
                current.listRead = true;
            }
        });
        await this.markRead(device.userId, row.bookUid);
        res.sendStatus(204);
    }

    // ------------------------------------------------------------------ collection edits on the device
    // Collections are read-only from the device: inpx-web lists are never changed from here. A bound
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

    async cover(req, res, device) {
        const row = device.books[req.params.uuid];
        const book = row && await this.worker.getBookRecordByUid(row.bookUid);
        if (!book) {
            if (device.storeProxy && /^[0-9a-f-]{36}$/i.test(req.params.uuid)) {
                const {uuid, width, height} = req.params;
                return res.redirect(307, `${koboImageUrl}/${uuid}/${encodeURIComponent(width)}/${encodeURIComponent(height)}/false/image.jpg`);
            }
            return res.sendStatus(404);
        }

        const cacheDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const key = coverCacheKey(book);
        const staticModule = require('../../static');
        if (await staticModule.sendCachedCover(res, cacheDir, key))
            return;
        const cover = await this.worker.getBookCover(book);
        if (!cover)
            return res.sendStatus(404);
        await staticModule.writeCachedCover(cacheDir, key, cover);
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(cover.contentType).send(cover.data);
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

    // ------------------------------------------------------------------ Kobo Store proxy
    storeTarget(req, token) {
        const prefix = `${rootPath(this.config)}/${token}`;
        const url = String(req.originalUrl || '');
        const rest = (url.startsWith(prefix) ? url.slice(prefix.length) : url);
        return `${this.storeUrl}${rest || '/'}`;
    }

    async storeRequest(req, token, extraHeaders = {}) {
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!skippedStoreHeaders.has(key.toLowerCase()) && value !== undefined)
                headers[key] = (Array.isArray(value) ? value.join(', ') : String(value));
        }
        for (const [key, value] of Object.entries(extraHeaders)) {
            if (value)
                headers[key] = value;
            else
                delete headers[key];
        }
        const hasBody = !['GET', 'HEAD'].includes(req.method) && req.rawBody && req.rawBody.length;
        return await fetch(this.storeTarget(req, token), {
            method: req.method,
            headers,
            body: (hasBody ? req.rawBody : undefined),
            redirect: 'manual',
            signal: AbortSignal.timeout(storeTimeoutMs),
        });
    }

    async relayStoreResponse(res, response) {
        for (const [key, value] of response.headers) {
            const name = key.toLowerCase();
            if (!skippedStoreHeaders.has(name) && name !== 'set-cookie')
                res.set(key, value);
        }
        res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    }

    // Requests inpx-web does not answer itself go to the Kobo Store when the device
    // opted in (purchased books, store pages); otherwise they get `fallback`.
    async storeOr(req, res, device, token, fallback) {
        if (!device.storeProxy)
            return fallback();
        // The firmware turns redirected POSTs into GETs, so only GETs are redirected.
        if (req.method === 'GET')
            return res.redirect(307, this.storeTarget(req, token));
        try {
            await this.relayStoreResponse(res, await this.storeRequest(req, token));
        } catch (e) {
            log(LM_WARN, `Kobo: store request ${req.method} ${req.path} failed: ${e.message}`);
            if (!res.headersSent)
                fallback();
        }
    }

    async mergeStoreSync(req, token, storeToken) {
        const response = await this.storeRequest(req, token, {[syncTokenHeader]: storeToken});
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const items = await response.json();
        const headers = {};
        for (const name of ['x-kobo-sync-mode', 'x-kobo-recent-reads']) {
            const value = response.headers.get(name);
            if (value)
                headers[name] = value;
        }
        return {
            items: (Array.isArray(items) ? items : []),
            token: response.headers.get(syncTokenHeader) || storeToken,
            more: response.headers.get('x-kobo-sync') === 'continue',
            headers,
        };
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

        router.use(async(req, res, next) => {
            res.set('Cache-Control', 'no-store');
            await this.store.load();
            const device = this.store.findDeviceByToken(req.params.token);
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
                log(LM_ERR, `Kobo: ${req.method} ${req.path}: ${e.message}`);
                if (!res.headersSent)
                    res.status(String(e.message).includes('404') ? 404 : 500).send('Kobo sync error');
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

function init(app, config, worker, security) {
    if (!config.koboEnabled)
        return null;

    const service = new KoboService(config, worker, security);
    activeService = service;
    worker.koboService = service;
    service.store.load().catch(e => log(LM_ERR, `Kobo: cannot load ${service.store.file}: ${e.message}`));
    app.use(`${rootPath(config)}/:token`, service.router());
    log(`Kobo sync enabled at ${rootPath(config)}/<device token>`);
    return service;
}

module.exports = {init, isAuthorizedRequest, rootPath, uuidv5, stableKey, maskTokens, KoboService};
