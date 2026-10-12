const fs = require('fs-extra');

const {epubMetadata} = require('../BookMetadata');
const bookConverter = require('../BookConverter');
const {log, busyConversionCodes} = require('./common');

const prepareRetryMs = 10*60*1000;
// Stay well below the shared conversion queue so web downloads keep working.
const prepareConcurrency = 2;
const preparedEntryLimit = 2000;
// Background preparation of books added to bound lists (one at a time, so sync keeps a slot).
const prewarmQueueLimit = 5000;
const prewarmAttempts = 3;

function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        if (timer.unref)
            timer.unref();
    });
}

// Book files for the device: target format, conversion, background preparation.
// Mixed into KoboService.prototype: `this` is the service.
module.exports = {
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
    },

    async fileAuthors(file) {
        try {
            return (await epubMetadata(file, this.config)).authors || [];
        } catch (e) {
            return [];
        }
    },

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
    },

    preparedKey(bookUid, convertTo, fingerprint) {
        return `${bookUid}:${convertTo}:${fingerprint || ''}`;
    },

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
                return Object.assign({}, target, {size: stat.size, authors: await this.fileAuthors(prepared.rawFile)});
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
            // Drop the oldest finished entry; running ones (at most prepareConcurrency) stay.
            if (this.prepared.size > preparedEntryLimit) {
                for (const [oldKey, old] of this.prepared) {
                    if (old.result || old.error) {
                        this.prepared.delete(oldKey);
                        break;
                    }
                }
            }
        }

        if (entry.result || entry.error)
            return {ready: entry.result || null, failed: !!entry.error, busy: !!entry.busy};

        const remaining = deadline - Date.now();
        if (remaining > 0)
            await Promise.race([entry.promise, sleep(remaining)]);
        return {ready: entry.result || null, failed: !!entry.error, busy: !!entry.busy, pending: !entry.result && !entry.error};
    },

    // Books added to a list bound to a device start preparing right away, so the next sync can
    // announce them instead of waiting for the conversion. Fire and forget: errors are only logged.
    prewarmBooks(userId, listId, bookUids = []) {
        const data = this.store.data;
        if (!data || !data.devices.some(device => device.userId === userId && device.listIds.includes(listId)))
            return;
        this.enqueuePrewarm(userId, bookUids);
    },

    // Every book of the given lists (a list was just bound, or lists were imported).
    prewarmLists(userId, listIds = null) {
        const task = (async() => {
            await this.store.load();
            const bound = new Set(this.store.data.devices.filter(device => device.userId === userId)
                .flatMap(device => device.listIds));
            const store = this.worker.readingListStore;
            const {lists} = await this.boundLists(userId, (listIds || [...bound]).filter(listId => bound.has(listId)));
            for (const list of lists)
                this.enqueuePrewarm(userId, store.normalizeEntries(list.books).map(entry => entry.bookUid));
        })().catch(e => log(LM_WARN, `Kobo: cannot queue books for preparation: ${e.message}`))
            .finally(() => this.prewarmListTasks.delete(task));
        this.prewarmListTasks.add(task);
    },

    // Resolves once no background preparation is queued or running.
    async idle() {
        while (this.prewarmListTasks.size || this.prewarmRunning) {
            await Promise.all([...this.prewarmListTasks]);
            if (this.prewarmRunning)
                await this.prewarmRunning;
        }
    },

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
    },

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
    },
};
