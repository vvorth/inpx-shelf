const utils = require('../utils');
const {t} = require('../i18n');
const {reachesReadMark, isProgressRead, readerProgressOf} = require('../ReaderProgress');
const limits = require('../RequestLimits').userData;

// Насколько время позиции может быть впереди часов сервера (как deviceTime у Kobo)
const FUTURE_TOLERANCE_MS = 5*60*1000;

// Записи без поля read - из прежних версий: там «прочитано» было долей от 99.9%, а отметка ставила 100%,
// запомнив долю до неё в percentBeforeRead
const LEGACY_READ_PERCENT = 0.999;

function legacyPercentBeforeRead(row) {
    const value = Number(row.percentBeforeRead);
    return (Number.isFinite(value) && value >= 0 && value < LEGACY_READ_PERCENT ? value : null);
}

// Есть ли место в книге: без него снятая отметка оставила бы пустую запись в «Читаю сейчас»
function hasPlace(row) {
    return (row.percent > 0.0001 || row.pageIndex > 0 || !!row.sectionId || row.textOffset >= 0 || !!row.textSnippet);
}

// Reader progress, bookmarks and preferences of a profile. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    // Read is the profile's flag on the book's progress row, whatever the percent: lists keep no mark of their own.
    isBookRead(user, bookUid = '') {
        return isProgressRead(readerProgressOf(user)[bookUid]);
    },

    // Marks the books read or unread in the profile record in place; the caller saves.
    //отметка и её снятие меняют только флаг (и время): место в книге и доля прочитанного остаются
    applyBooksRead(target, bookUids = [], read = true, updatedAt = this.nowIso()) {
        if (!target.readerProgress || typeof(target.readerProgress) !== 'object')
            target.readerProgress = {};

        const generation = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0);
        const progress = this.normalizeReaderProgress(target.readerProgress);
        for (const bookUid of bookUids) {
            const current = (progress[bookUid] && progress[bookUid].generation === generation ? progress[bookUid] : null);
            if (read) {
                target.readerProgress[bookUid] = Object.assign(
                    {percent: 0, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: ''},
                    current || {},
                    {read: true, updatedAt, hidden: false, generation},
                );
            } else if (current && hasPlace(current)) {
                target.readerProgress[bookUid] = Object.assign({}, current, {read: false, updatedAt});
            } else {
                delete target.readerProgress[bookUid];
            }
        }
    },

    // Read marks that list entries kept in older files and exports ({bookUid, read: true}) become the profile's progress.
    // accept: which uids may become progress (an import takes only real book uids).
    applyListReadMarks(target, entries = [], updatedAt = '', accept = () => true) {
        const bookUids = (Array.isArray(entries) ? entries : [])
            .filter((row) => row && typeof(row) === 'object' && row.read)
            .map((row) => this.normalizeBookUid(row.bookUid || row.uid || row.id))
            .filter((bookUid) => bookUid && accept(bookUid) && !this.isBookRead(target, bookUid));
        if (bookUids.length)
            this.applyBooksRead(target, bookUids, true, updatedAt || this.nowIso());
    },

    normalizeReaderProgress(value = {}) {
        const result = {};
        for (const [bookUid, row] of Object.entries(value || {})) {
            const normalizedBookUid = this.normalizeBookUid(bookUid);
            if (!normalizedBookUid || !row || typeof(row) !== 'object')
                continue;

            const legacyBefore = (utils.hasProp(row, 'read') ? null : legacyPercentBeforeRead(row));
            const percent = (legacyBefore !== null ? legacyBefore : Number(row.percent));
            const pageIndex = Number(row.pageIndex);
            const textOffset = Number(row.textOffset);
            result[normalizedBookUid] = {
                percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
                sectionId: String(row.sectionId || '').trim(),
                pageIndex: Number.isFinite(pageIndex) ? Math.max(0, Math.round(pageIndex)) : 0,
                textOffset: Number.isFinite(textOffset) ? Math.max(-1, Math.round(textOffset)) : -1,
                textSnippet: String(row.textSnippet || '').trim().slice(0, 240),
                updatedAt: String(row.updatedAt || '').trim(),
                hidden: (row.hidden === true),
                generation: Math.max(0, parseInt(row.generation, 10) || 0),
                read: (utils.hasProp(row, 'read')
                    ? row.read === true
                    : legacyBefore !== null || (Number(row.percent) || 0) >= LEGACY_READ_PERCENT),
            };
        }
        //позиций в профиле не больше предела: самые старые (по updatedAt) уходят, как события витрин
        const keys = Object.keys(result);
        if (keys.length > limits.progressPerProfile) {
            keys.sort((a, b) => result[a].updatedAt.localeCompare(result[b].updatedAt));
            for (const key of keys.slice(0, keys.length - limits.progressPerProfile))
                delete result[key];
        }
        return result;
    },

    // Bookmark text from the client or an import, cut to the limits.
    limitBookmarkText(row) {
        return Object.assign({}, row, {
            sectionId: String(row.sectionId || '').slice(0, limits.sectionId),
            title: String(row.title || '').slice(0, limits.bookmarkTitle),
            excerpt: String(row.excerpt || '').slice(0, limits.bookmarkExcerpt),
            note: String(row.note || '').slice(0, limits.bookmarkNote),
        });
    },

    // Keeps the newest bookmarks within the per-book and per-profile limits; returns how many were dropped.
    trimReaderBookmarks(target) {
        let trimmed = 0;
        const rows = [];
        for (const [bookUid, bookmarks] of Object.entries(target.readerBookmarks || {})) {
            const sorted = this.normalizeReaderBookmarks({[bookUid]: bookmarks})[bookUid] || [];
            trimmed += Math.max(0, sorted.length - limits.bookmarksPerBook);
            rows.push(...sorted.slice(0, limits.bookmarksPerBook).map((bookmark) => [bookUid, bookmark]));
        }
        rows.sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)));
        trimmed += Math.max(0, rows.length - limits.bookmarksPerProfile);
        target.readerBookmarks = {};
        for (const [bookUid, bookmark] of rows.slice(0, limits.bookmarksPerProfile))
            (target.readerBookmarks[bookUid] = target.readerBookmarks[bookUid] || []).push(bookmark);
        return trimmed;
    },

    normalizeReaderBookmarks(value = {}) {
        const result = {};

        for (const [bookUid, rows] of Object.entries(value || {})) {
            const normalizedBookUid = this.normalizeBookUid(bookUid);
            if (!normalizedBookUid || !Array.isArray(rows))
                continue;

            const seenIds = new Set();
            result[normalizedBookUid] = rows
                .map((row) => ({
                    id: String(row && row.id ? row.id : '').trim() || this.makeId(),
                    sectionId: String(row && row.sectionId ? row.sectionId : '').trim(),
                    title: this.normalizeName(row && row.title ? row.title : '') || t('reader.bookmark'),
                    excerpt: this.normalizeName(row && row.excerpt ? row.excerpt : ''),
                    note: this.normalizeName(row && row.note ? row.note : ''),
                    percent: Number.isFinite(Number(row && row.percent)) ? Math.max(0, Math.min(1, Number(row.percent))) : 0,
                    createdAt: String(row && row.createdAt ? row.createdAt : '').trim() || this.nowIso(),
                }))
                .filter((item) => {
                    if (!item.id || seenIds.has(item.id))
                        return false;
                    seenIds.add(item.id);
                    return true;
                })
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        }

        return result;
    },

    async getReaderState(userId = '', bookUid = '') {
        const {user} = await this.resolveUser(userId);
        const normalizedBookUid = this.requireBookUid(bookUid);

        return {
            preferences: this.normalizeReaderPreferences(user.readerPreferences),
            progress: Object.assign({percent: 0, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '', updatedAt: '', hidden: false, read: false}, user.readerProgress[normalizedBookUid] || {}),
            progressGeneration: Math.max(0, parseInt(user.readerProgressGeneration, 10) || 0),
            progressResetAt: String(user.readerProgressResetAt || '').trim(),
            bookmarks: (user.readerBookmarks && Array.isArray(user.readerBookmarks[normalizedBookUid]) ? user.readerBookmarks[normalizedBookUid] : []),
        };
    },

    async updateReaderPreferences(userId = '', patch = {}) {
        const {data, user: target} = await this.resolveUser(userId);

        target.readerPreferences = this.normalizeReaderPreferences(Object.assign({}, target.readerPreferences || {}, patch || {}));
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerPreferences;
    },

    async updateReaderProgress(userId = '', bookUid = '', patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const {progress, changed} = this.patchReaderProgress(user, bookUid, patch);
        if (changed)
            await this.save(data);
        return progress;
    },

    // Changes the profile record in place; the caller saves when changed.
    patchReaderProgress(target, bookUid = '', patch = {}) {
        const normalizedBookUid = this.requireBookUid(bookUid);

        if (!target.readerProgress || typeof(target.readerProgress) !== 'object')
            target.readerProgress = {};

        const current = target.readerProgress[normalizedBookUid] || {};
        const percent = Number(utils.hasProp(patch, 'percent') ? patch.percent : current.percent);
        const sectionId = String(utils.hasProp(patch, 'sectionId') ? patch.sectionId : current.sectionId || '').trim().slice(0, limits.sectionId);
        const pageIndex = Number(utils.hasProp(patch, 'pageIndex') ? patch.pageIndex : current.pageIndex);
        const textOffset = Number(utils.hasProp(patch, 'textOffset') ? patch.textOffset : current.textOffset);
        const textSnippet = String(utils.hasProp(patch, 'textSnippet') ? patch.textSnippet : current.textSnippet || '').trim().slice(0, 240);
        const hidden = (utils.hasProp(patch, 'hidden') ? patch.hidden === true : current.hidden === true);
        const sentUpdatedAt = String(utils.hasProp(patch, 'updatedAt') ? patch.updatedAt : '').trim();
        //часы устройства далеко впереди - время сервера: иначе все следующие сохранения окажутся «старее»
        const patchUpdatedAt = (Date.parse(sentUpdatedAt) > Date.now() + FUTURE_TOLERANCE_MS ? this.nowIso() : sentUpdatedAt);
        const currentUpdatedAt = String(current.updatedAt || '').trim();
        const patchTime = Date.parse(patchUpdatedAt);
        const currentTime = Date.parse(currentUpdatedAt);
        const generation = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0);
        const explicitHiddenPatch = utils.hasProp(patch, 'hidden') && !patchUpdatedAt;
        const patchGeneration = utils.hasProp(patch, 'generation')
            ? Math.max(0, parseInt(patch.generation, 10) || 0)
            : (explicitHiddenPatch ? generation : 0);
        const resetAt = String(target.readerProgressResetAt || '').trim();
        const force = patch.force === true;
        if (patchGeneration !== generation) {
            if (Object.keys(current).length && Math.max(0, parseInt(current.generation, 10) || 0) === generation)
                return {progress: Object.assign({}, current, {generationMismatch: true}), changed: false};

            return {changed: false, progress: {
                percent: 0,
                sectionId: '',
                pageIndex: 0,
                textOffset: -1,
                textSnippet: '',
                updatedAt: resetAt,
                hidden: false,
                reset: true,
                resetAt,
                generation,
            }};
        }
        if (
            !force
            &&
            Number.isFinite(patchTime)
            && Number.isFinite(currentTime)
            && patchTime < currentTime
        )
            return {progress: current, changed: false};
        const nextPercent = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0;
        //позиция отметку не снимает; дочитанная до порога (переход снизу) книга отмечается сама
        const markedRead = (current.read !== true && reachesReadMark(current.percent, nextPercent));
        target.readerProgress[normalizedBookUid] = {
            percent: nextPercent,
            sectionId,
            pageIndex: Number.isFinite(pageIndex) ? Math.max(0, Math.round(pageIndex)) : 0,
            textOffset: Number.isFinite(textOffset) ? Math.max(-1, Math.round(textOffset)) : -1,
            textSnippet,
            updatedAt: patchUpdatedAt || this.nowIso(),
            hidden,
            generation,
            read: current.read === true || markedRead,
        };
        target.updatedAt = this.nowIso();
        return {progress: target.readerProgress[normalizedBookUid], changed: true, markedRead};
    },

    // Percent (0..1) read on an e-reader (Kobo, KOReader) goes to "continue reading" when it is newer than
    // the web position. Device locations can't be mapped onto the FB2 reader's pages: the reader opens at the percent.
    // True when this position marked the book read (it crossed READ_AUTO_PERCENT).
    async mergeDeviceProgress(userId = '', bookUid = '', percent = 0, modified = '') {
        const {data, user} = await this.resolveUser(userId);
        const result = this.mergeUserDeviceProgress(user, bookUid, percent, modified);
        if (result.changed)
            await this.save(data);
        return result.markedRead === true;
    },

    // mergeDeviceProgress on a loaded profile record: {changed, markedRead}, the caller saves when changed.
    mergeUserDeviceProgress(user, bookUid = '', percent = 0, modified = '') {
        const value = Math.max(0, Math.min(1, Number(percent) || 0));
        const current = (user.readerProgress || {})[this.requireBookUid(bookUid)] || {};
        if (Math.abs((current.percent || 0) - value) < 0.0001 || (!current.updatedAt && value <= 0))
            return {changed: false};
        return this.patchReaderProgress(user, bookUid, {
            percent: value, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '',
            updatedAt: modified, generation: Math.max(0, parseInt(user.readerProgressGeneration, 10) || 0),
        });
    },

    async deleteReaderProgress(userId = '', bookUid = '') {
        const {data, user: target} = await this.resolveUser(userId);

        const normalizedBookUid = this.requireBookUid(bookUid);

        if (target.readerProgress && typeof(target.readerProgress) === 'object')
            delete target.readerProgress[normalizedBookUid];

        target.updatedAt = this.nowIso();
        await this.save(data);
        return {success: true};
    },

    async clearReaderProgress(userId = '') {
        const {data, user: target} = await this.resolveUser(userId);

        const current = (target.readerProgress && typeof(target.readerProgress) === 'object')
            ? target.readerProgress
            : {};
        const bookUids = Object.keys(current);
        const count = bookUids.length;
        const resetAt = this.nowIso();
        const generation = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0) + 1;
        //сбрасываются позиции, отметки «прочитано» остаются: запись без места с прежним временем
        target.readerProgress = Object.fromEntries(Object.entries(this.normalizeReaderProgress(current))
            .filter(([, row]) => row.read)
            .map(([bookUid, row]) => [bookUid, {
                percent: 0, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '',
                updatedAt: row.updatedAt, hidden: false, generation, read: true,
            }]));
        target.readerProgressGeneration = generation;
        target.readerProgressResetAt = resetAt;
        target.updatedAt = resetAt;
        await this.save(data);
        return {success: true, count, resetAt, generation, bookUids};
    },

    // Everything the profile knows about the books: progress (and so the hidden and read marks), bookmarks,
    // discovery history, KOReader sync rows and entries in the profile's own lists.
    async forgetBooks(userId = '', bookUids = []) {
        const {data, user: target} = await this.resolveUser(userId);
        const uids = new Set((Array.isArray(bookUids) ? bookUids : []).map(uid => this.normalizeBookUid(uid)).filter(Boolean));
        if (!uids.size)
            throw new Error('bookUids is empty');

        const dropKeys = (rows, keys) => {
            for (const key of keys)
                delete rows[key];
        };
        if (target.readerProgress)
            dropKeys(target.readerProgress, uids);
        if (target.readerBookmarks)
            dropKeys(target.readerBookmarks, uids);
        if (target.discoveryPreferences && target.discoveryPreferences.events)
            dropKeys(target.discoveryPreferences.events, uids);
        if (target.kosyncProgress)
            dropKeys(target.kosyncProgress, Object.keys(target.kosyncProgress).filter(key => uids.has((target.kosyncProgress[key] || {}).bookUid)));

        const now = this.nowIso();
        for (const item of data.lists) {
            if (item.userId !== target.id)
                continue;
            const books = this.normalizeEntries(item.books);
            item.books = books.filter(entry => !uids.has(entry.bookUid));
            if (item.books.length !== books.length)
                item.updatedAt = now;
        }

        target.updatedAt = now;
        await this.save(data);
        return {count: uids.size};
    },

    async addReaderBookmark(userId = '', bookUid = '', bookmark = {}) {
        const {data, user: target} = await this.resolveUser(userId);

        const normalizedBookUid = this.requireBookUid(bookUid);

        if (!target.readerBookmarks || typeof(target.readerBookmarks) !== 'object')
            target.readerBookmarks = {};

        const current = Array.isArray(target.readerBookmarks[normalizedBookUid]) ? target.readerBookmarks[normalizedBookUid] : [];
        const total = Object.values(target.readerBookmarks).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
        if (current.length >= limits.bookmarksPerBook || total >= limits.bookmarksPerProfile)
            throw new Error(t('errors.tooManyBookmarks', {perBook: limits.bookmarksPerBook, perProfile: limits.bookmarksPerProfile}));
        current.unshift(this.limitBookmarkText({
            id: this.makeId(),
            sectionId: String(bookmark.sectionId || '').trim(),
            title: this.normalizeName(bookmark.title || '') || t('reader.bookmark'),
            excerpt: this.normalizeName(bookmark.excerpt || ''),
            note: this.normalizeName(bookmark.note || ''),
            percent: Number.isFinite(Number(bookmark.percent)) ? Math.max(0, Math.min(1, Number(bookmark.percent))) : 0,
            createdAt: this.nowIso(),
        }));

        target.readerBookmarks[normalizedBookUid] = this.normalizeReaderBookmarks({[normalizedBookUid]: current})[normalizedBookUid] || [];
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerBookmarks[normalizedBookUid];
    },

    async deleteReaderBookmark(userId = '', bookUid = '', bookmarkId = '') {
        const {data, user: target} = await this.resolveUser(userId);

        const normalizedBookUid = this.requireBookUid(bookUid);

        const normalizedBookmarkId = String(bookmarkId || '').trim();
        if (!normalizedBookmarkId)
            throw new Error('bookmarkId is empty');

        const current = Array.isArray(target.readerBookmarks && target.readerBookmarks[normalizedBookUid])
            ? target.readerBookmarks[normalizedBookUid]
            : [];
        target.readerBookmarks = Object.assign({}, target.readerBookmarks, {
            [normalizedBookUid]: current.filter((item) => item.id !== normalizedBookmarkId),
        });
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.readerBookmarks[normalizedBookUid] || [];
    },
};
