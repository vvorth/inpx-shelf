const {t} = require('../i18n');
const {READ_PERCENT} = require('../ReaderProgress');

function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

// Доля прочитанного до отметки «прочитано» (setBooksRead): снятие отметки возвращает её вместе с местом в книге
function percentBeforeRead(row = {}) {
    const value = Number(row && row.percentBeforeRead);
    return (Number.isFinite(value) && value >= 0 && value < READ_PERCENT ? {percentBeforeRead: value} : {});
}

// Reader progress, bookmarks and preferences of a profile. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    normalizeReaderProgress(value = {}) {
        const result = {};
        for (const [bookUid, row] of Object.entries(value || {})) {
            const normalizedBookUid = this.normalizeBookUid(bookUid);
            if (!normalizedBookUid || !row || typeof(row) !== 'object')
                continue;

            const percent = Number(row.percent);
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
                ...percentBeforeRead(row),
            };
        }
        return result;
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
            progress: Object.assign({percent: 0, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '', updatedAt: '', hidden: false}, user.readerProgress[normalizedBookUid] || {}),
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
        const {data, user: target} = await this.resolveUser(userId);

        const normalizedBookUid = this.requireBookUid(bookUid);

        if (!target.readerProgress || typeof(target.readerProgress) !== 'object')
            target.readerProgress = {};

        const current = target.readerProgress[normalizedBookUid] || {};
        const percent = Number(utilsHasProp(patch, 'percent') ? patch.percent : current.percent);
        const sectionId = String(utilsHasProp(patch, 'sectionId') ? patch.sectionId : current.sectionId || '').trim();
        const pageIndex = Number(utilsHasProp(patch, 'pageIndex') ? patch.pageIndex : current.pageIndex);
        const textOffset = Number(utilsHasProp(patch, 'textOffset') ? patch.textOffset : current.textOffset);
        const textSnippet = String(utilsHasProp(patch, 'textSnippet') ? patch.textSnippet : current.textSnippet || '').trim().slice(0, 240);
        const hidden = (utilsHasProp(patch, 'hidden') ? patch.hidden === true : current.hidden === true);
        const patchUpdatedAt = String(utilsHasProp(patch, 'updatedAt') ? patch.updatedAt : '').trim();
        const currentUpdatedAt = String(current.updatedAt || '').trim();
        const patchTime = Date.parse(patchUpdatedAt);
        const currentTime = Date.parse(currentUpdatedAt);
        const generation = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0);
        const explicitHiddenPatch = utilsHasProp(patch, 'hidden') && !patchUpdatedAt;
        const patchGeneration = utilsHasProp(patch, 'generation')
            ? Math.max(0, parseInt(patch.generation, 10) || 0)
            : (explicitHiddenPatch ? generation : 0);
        const resetAt = String(target.readerProgressResetAt || '').trim();
        const force = patch.force === true;
        if (patchGeneration !== generation) {
            if (Object.keys(current).length && Math.max(0, parseInt(current.generation, 10) || 0) === generation)
                return Object.assign({}, current, {generationMismatch: true});

            return {
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
            };
        }
        if (
            !force
            &&
            Number.isFinite(patchTime)
            && Number.isFinite(currentTime)
            && patchTime < currentTime
        )
            return current;
        const nextPercent = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0;
        target.readerProgress[normalizedBookUid] = {
            percent: nextPercent,
            sectionId,
            pageIndex: Number.isFinite(pageIndex) ? Math.max(0, Math.round(pageIndex)) : 0,
            textOffset: Number.isFinite(textOffset) ? Math.max(-1, Math.round(textOffset)) : -1,
            textSnippet,
            updatedAt: patchUpdatedAt || this.nowIso(),
            hidden,
            generation,
            //читалка сохраняет место отмеченной книги: доля до отметки нужна, пока книга считается прочитанной
            ...(nextPercent >= READ_PERCENT ? percentBeforeRead(current) : {}),
        };
        target.updatedAt = this.nowIso();

        await this.save(data);
        return target.readerProgress[normalizedBookUid];
    },

    // Percent (0..1) read on an e-reader (Kobo, KOReader) goes to "continue reading" when it is newer than
    // the web position. Device locations can't be mapped onto the FB2 reader's pages: the reader opens at the percent.
    async mergeDeviceProgress(userId = '', bookUid = '', percent = 0, modified = '') {
        const value = Math.max(0, Math.min(1, Number(percent) || 0));
        const {progress: current, progressGeneration} = await this.getReaderState(userId, bookUid);
        if (Math.abs((current.percent || 0) - value) < 0.0001 || (!current.updatedAt && value <= 0))
            return;
        await this.updateReaderProgress(userId, bookUid, {
            percent: value, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '',
            updatedAt: modified, generation: progressGeneration,
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
        target.readerProgress = {};
        target.readerProgressGeneration = generation;
        target.readerProgressResetAt = resetAt;
        target.updatedAt = resetAt;
        await this.save(data);
        return {success: true, count, resetAt, generation, bookUids};
    },

    // Everything the profile knows about the books: progress (and so the hidden mark), bookmarks,
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
        current.unshift({
            id: this.makeId(),
            sectionId: String(bookmark.sectionId || '').trim(),
            title: this.normalizeName(bookmark.title || '') || t('reader.bookmark'),
            excerpt: this.normalizeName(bookmark.excerpt || ''),
            note: this.normalizeName(bookmark.note || ''),
            percent: Number.isFinite(Number(bookmark.percent)) ? Math.max(0, Math.min(1, Number(bookmark.percent))) : 0,
            createdAt: this.nowIso(),
        });

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
