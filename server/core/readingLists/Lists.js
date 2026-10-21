const utils = require('../utils');
const {t} = require('../i18n');
const {bookNote} = require('../search/bookMatch');

// Reading lists and their books, list export and import. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    countRead(entries, user) {
        return this.normalizeEntries(entries).filter((item) => this.isBookRead(user, item.bookUid)).length;
    },

    // user: the list owner, whose progress says which books are read
    listStats(item, user, bookUid = '') {
        const entries = this.normalizeEntries(item.books);
        const currentEntry = (bookUid ? this.findEntry(entries, bookUid) : null);
        return {
            id: item.id,
            userId: item.userId,
            name: item.name,
            visibility: this.normalizeVisibility(item.visibility),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            bookCount: entries.length,
            readCount: this.countRead(entries, user),
            containsBook: !!currentEntry,
        };
    },

    async ownerListStats(item, bookUid = '') {
        const {user} = await this.resolveUser(item.userId);
        return this.listStats(item, user, bookUid);
    },

    async getLists(userId = '', options = {}) {
        const {data, user} = await this.resolveUser(userId);
        const visibility = (options && options.visibility ? this.normalizeVisibility(options.visibility) : '');

        return data.lists
            .filter((item) => item.userId === user.id)
            .filter((item) => (!visibility || item.visibility === visibility))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    },

    async getList(userId = '', listId = '', options = {}) {
        const visibility = (options && options.visibility ? this.normalizeVisibility(options.visibility) : '');
        const normalizedListId = String(listId || '').trim();
        if (!normalizedListId)
            return null;

        const data = await this.load();
        let item = data.lists.find((row) => row.id === normalizedListId) || null;
        if (!item)
            return null;

        const {user} = await this.resolveUser(userId);
        if (item.userId !== user.id)
            return null;

        if (visibility && item.visibility !== visibility)
            return null;

        return item;
    },

    ensureUniqueListName(lists, userId, name, excludeId = '') {
        const duplicate = lists.find((item) => item.userId === userId && item.id !== excludeId && item.name.toLowerCase() === name.toLowerCase());
        if (duplicate)
            throw new Error(t('errors.listNameExists'));
    },

    async createList(userId = '', name, visibility = 'private') {
        const {data, user} = await this.resolveUser(userId);
        const normalized = this.validateName(name);
        this.ensureUniqueListName(data.lists, user.id, normalized);

        const now = this.nowIso();
        const item = this.normalizeList({
            id: this.makeId(),
            userId: user.id,
            name: normalized,
            visibility,
            createdAt: now,
            updatedAt: now,
            books: [],
        }, user.id);

        data.lists.push(item);
        await this.save(data);
        return item;
    },

    // patch: name and/or visibility
    async updateList(userId = '', listId, patch = {}) {
        const {data, user} = await this.resolveUser(userId);
        const item = this.ownList(data, user, listId);

        if (utils.hasProp(patch, 'name')) {
            const normalized = this.validateName(patch.name);
            this.ensureUniqueListName(data.lists, user.id, normalized, item.id);
            item.name = normalized;
        }
        if (utils.hasProp(patch, 'visibility'))
            item.visibility = this.normalizeVisibility(patch.visibility);
        item.updatedAt = this.nowIso();

        await this.save(data);
        return item;
    },

    async deleteList(userId = '', listId) {
        const {data, user} = await this.resolveUser(userId);
        data.lists.splice(data.lists.indexOf(this.ownList(data, user, listId)), 1);
        await this.save(data);
        return {success: true};
    },

    findEntry(entries, bookUid) {
        return this.normalizeEntries(entries).find((item) => item.bookUid === bookUid) || null;
    },

    async setBookMembership(userId = '', listId, bookUid, enabled) {
        const {data, user} = await this.resolveUser(userId);
        const item = this.ownList(data, user, listId);

        const normalizedBookUid = this.requireBookUid(bookUid);

        item.books = this.normalizeEntries(item.books);
        const existing = item.books.find((row) => row.bookUid === normalizedBookUid);

        if (enabled) {
            if (!existing)
                item.books.push({bookUid: normalizedBookUid});
        } else {
            item.books = item.books.filter((row) => row.bookUid !== normalizedBookUid);
        }

        item.updatedAt = this.nowIso();
        await this.save(data);
        return item;
    },

    async setBooksRead(userId = '', bookUids = [], read = true) {
        const {data, user: target} = await this.resolveUser(userId);

        const normalizedBookUids = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
            .map((bookUid) => this.normalizeBookUid(bookUid))
            .filter(Boolean)));
        if (!normalizedBookUids.length)
            throw new Error('bookUids is empty');

        const updatedAt = this.nowIso();
        this.applyBooksRead(target, normalizedBookUids, read, updatedAt);
        target.updatedAt = updatedAt;
        await this.save(data);
        return {
            success: true,
            read: !!read,
            bookUids: normalizedBookUids,
            changedBooks: normalizedBookUids.length,
        };
    },

    normalizeRekeyPairs(mapping = {}) {
        return new Map(Object.entries(mapping || {})
            .map(([from, to]) => [this.normalizeBookUid(from), this.normalizeBookUid(to)])
            .filter(([from, to]) => from && to && from !== to));
    },

    // A book's _uid changes when an INPX update rewrites its line. Move the profile's list entries
    // (keeping order), reader progress, bookmarks and the book's metadata edits
    // from old to new uids.
    async rekeyBooks(userId = '', mapping = {}) {
        const {data, user: target} = await this.resolveUser(userId);
        const pairs = this.normalizeRekeyPairs(mapping);
        if (!target || !pairs.size)
            return {lists: 0};

        const lists = this.rekeyData(data, [target], pairs);
        await this.save(data);
        return {lists};
    },

    // A replacement the reader chose for an unavailable book: the profile's list entries,
    // reader progress and bookmarks move to the other book. Shared data (metadata edits, book notes) stays:
    // other profiles may still refer to the old book.
    async replaceBook(userId = '', fromUid = '', toUid = '') {
        const {data, user: target} = await this.resolveUser(userId);
        const pairs = this.normalizeRekeyPairs({[fromUid]: toUid});
        if (!target || !pairs.size)
            return {lists: 0, userId: (target ? target.id : '')};

        const lists = this.rekeyData(data, [target], pairs, {shared: false});
        await this.save(data);
        return {lists, userId: target.id};
    },

    // Moves the uids of the given profiles in loaded data; returns the number of changed lists.
    // shared: false keeps metadata edits and book notes (they belong to all profiles).
    rekeyData(data, users, pairs, options = {}) {
        const userIds = new Set(users.map((user) => user.id));
        let lists = 0;
        for (const list of data.lists.filter((item) => userIds.has(item.userId))) {
            const entries = this.normalizeEntries(list.books);
            if (!entries.some((entry) => pairs.has(entry.bookUid)))
                continue;
            const seen = new Set();
            list.books = [];
            for (const entry of entries) {
                const bookUid = pairs.get(entry.bookUid) || entry.bookUid;
                if (seen.has(bookUid))
                    continue;
                seen.add(bookUid);
                list.books.push({bookUid});
            }
            list.updatedAt = this.nowIso();
            lists++;
        }
        // Admin metadata edits and book notes are keyed by uid too; the old uid no longer exists.
        data.metadataOverrides = this.normalizeMetadataOverrides(data.metadataOverrides);
        data.bookNotes = this.normalizeBookNotes(data.bookNotes);
        const shared = (options.shared === false ? [] : [data.metadataOverrides, data.bookNotes]);
        for (const [from, to] of pairs) {
            for (const rows of [...shared, ...users.flatMap((user) => [user.readerProgress, user.readerBookmarks])]) {
                if (!rows || typeof(rows) !== 'object' || !utils.hasProp(rows, from))
                    continue;
                if (!utils.hasProp(rows, to))
                    rows[to] = rows[from];
                delete rows[from];
            }
        }
        return lists;
    },

    normalizeBookNotes(value = {}) {
        const result = {};
        for (const [bookUid, note] of Object.entries(value && typeof(value) === 'object' ? value : {})) {
            const uid = this.normalizeBookUid(bookUid);
            if (uid && note && typeof(note) === 'object' && note.title)
                result[uid] = bookNote(note);
        }
        return result;
    },

    // Every uid the store refers to: list entries, reader progress, bookmarks, metadata edits.
    referencedBookUids(data) {
        const uids = new Set(Object.keys(this.normalizeMetadataOverrides(data.metadataOverrides)));
        for (const list of data.lists) {
            for (const entry of this.normalizeEntries(list.books))
                uids.add(entry.bookUid);
        }
        for (const user of data.users) {
            for (const rows of [user.readerProgress, user.readerBookmarks])
                Object.keys(rows || {}).forEach((uid) => uids.add(uid));
        }
        return uids;
    },

    async getBookNoteState() {
        const data = await this.load();
        return {uids: [...this.referencedBookUids(data)], notes: this.normalizeBookNotes(data.bookNotes)};
    },

    // The same book after an INPX update (same library and libid, one record, new _uid): every profile's lists,
    // progress and bookmarks, and the shared metadata edits and notes move to the new uid. Saves only on change.
    async relinkBooks(mapping = {}) {
        const data = await this.load();
        const pairs = this.normalizeRekeyPairs(mapping);
        const referenced = this.referencedBookUids(data);
        for (const from of [...pairs.keys()]) {
            if (!referenced.has(from))
                pairs.delete(from);
        }
        if (!pairs.size)
            return {moved: 0, lists: 0};
        const lists = this.rekeyData(data, data.users, pairs);
        await this.save(data);
        return {moved: pairs.size, lists};
    },

    // `notes` are the current records of resolved uids. Notes of uids nothing refers to any more are dropped. Saves only on change.
    async saveBookNotes(notes = {}) {
        const data = await this.load();
        const before = JSON.stringify(data.bookNotes || {});
        const current = this.normalizeBookNotes(Object.assign({}, data.bookNotes, notes));
        const uids = this.referencedBookUids(data);
        data.bookNotes = Object.fromEntries(Object.entries(current).filter(([uid]) => uids.has(uid)));
        if (JSON.stringify(data.bookNotes) !== before)
            await this.save(data);
        return {notes: Object.keys(data.bookNotes).length};
    },

    async addBooks(userId = '', listId, bookUids = []) {
        const {data, user} = await this.resolveUser(userId);
        const item = this.ownList(data, user, listId);

        item.books = this.normalizeEntries(item.books);
        const existing = new Set(item.books.map((row) => row.bookUid));

        let added = 0;
        for (const rawUid of bookUids) {
            const bookUid = this.normalizeBookUid(rawUid);
            if (!bookUid || existing.has(bookUid))
                continue;

            existing.add(bookUid);
            item.books.push({bookUid});
            added++;
        }

        item.updatedAt = this.nowIso();
        await this.save(data);
        return {item, added};
    },

    async exportData(userId = '') {
        const {user} = await this.resolveUser(userId);
        const lists = await this.getLists(user.id);

        return {
            version: 4,
            exportedAt: this.nowIso(),
            user: {
                id: user.id,
                name: user.name,
                emailTo: user.emailTo,
                telegramChatId: user.telegramChatId,
                opdsEnabled: user.opdsEnabled,
                //только хеши паролей, как токены Kobo в разделе kobo
                opdsPasswordHash: user.opdsPasswordHash || '',
                kosyncKeyHash: user.kosyncKeyHash || '',
                kosyncProgress: user.kosyncProgress || {},
                readerPreferences: this.normalizeReaderPreferences(user.readerPreferences),
                readerProgress: this.normalizeReaderProgress(user.readerProgress),
                readerBookmarks: this.normalizeReaderBookmarks(user.readerBookmarks),
                discoveryPreferences: this.normalizeDiscoveryPreferences(user.discoveryPreferences),
            },
            lists: lists.map((item) => ({
                name: item.name,
                visibility: this.normalizeVisibility(item.visibility),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                books: this.normalizeEntries(item.books),
            })),
        };
    },

    async importData(userId = '', payload) {
        require('../RequestLimits').checkImport(payload, this.config);
        if (!payload || !Array.isArray(payload.lists))
            throw new Error(t('errors.listImportInvalid'));

        const {data, user} = await this.resolveUser(userId);
        const target = data.users.find((item) => item.id === user.id);
        const incomingUser = (payload.user && typeof(payload.user) === 'object') ? payload.user : {};
        let importedLists = 0;
        let importedBooks = 0;
        let importedProgress = 0;
        let importedBookmarks = 0;

        if (target) {
            if (utils.hasProp(incomingUser, 'name')) {
                const normalizedName = this.validateUserName(incomingUser.name);
                const duplicateName = data.users.find((item) => item.id !== target.id && item.name.toLowerCase() === normalizedName.toLowerCase());
                if (!duplicateName)
                    target.name = normalizedName;
            }
            //один адрес, как в updateUser; неверный не переносим, остальное импортируется
            if (utils.hasProp(incomingUser, 'emailTo')) {
                try {
                    target.emailTo = this.validateEmailTo(incomingUser.emailTo);
                } catch (e) {
                    //адрес остаётся прежним
                }
            }
            if (utils.hasProp(incomingUser, 'telegramChatId'))
                target.telegramChatId = String(incomingUser.telegramChatId || '').trim();
            if (utils.hasProp(incomingUser, 'opdsEnabled'))
                target.opdsEnabled = (incomingUser.opdsEnabled !== false);
            //пароль OPDS - только профилю с логином, как в setOpdsPassword
            if (/^scrypt:v1:[a-f0-9]{32}:[a-f0-9]{64}$/.test(incomingUser.opdsPasswordHash) && target.login)
                target.opdsPasswordHash = incomingUser.opdsPasswordHash;
            //ключ KOReader ищется по хешу: чужой профиль с тем же ключом его не получает
            if (/^[a-f0-9]{64}$/.test(incomingUser.kosyncKeyHash)
                && !data.users.some(item => item.id !== target.id && item.kosyncKeyHash === incomingUser.kosyncKeyHash))
                target.kosyncKeyHash = incomingUser.kosyncKeyHash;
            if (incomingUser.kosyncProgress && typeof(incomingUser.kosyncProgress) === 'object')
                target.kosyncProgress = this.mergeKosyncProgress(target.kosyncProgress, incomingUser.kosyncProgress);
            if (utils.hasProp(incomingUser, 'readerPreferences'))
                target.readerPreferences = this.normalizeReaderPreferences(incomingUser.readerPreferences);
            if (utils.hasProp(incomingUser, 'discoveryPreferences'))
                target.discoveryPreferences = this.normalizeDiscoveryPreferences(incomingUser.discoveryPreferences);

            if (utils.hasProp(incomingUser, 'readerProgress')) {
                const generation = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0);
                const current = target.readerProgress || {};
                //старый бэкап не откатывает позицию, сохранённую позже него
                const progress = Object.fromEntries(
                    Object.entries(this.normalizeReaderProgress(incomingUser.readerProgress))
                        .filter(([bookUid, row]) => {
                            const currentTime = Date.parse(current[bookUid] && current[bookUid].updatedAt);
                            return Number.isNaN(currentTime) || Date.parse(row.updatedAt) > currentTime;
                        })
                        .map(([bookUid, row]) => [bookUid, Object.assign({}, row, {generation})])
                );
                target.readerProgress = Object.assign({}, target.readerProgress || {}, progress);
                importedProgress = Object.keys(progress).length;
            }

            if (utils.hasProp(incomingUser, 'readerBookmarks')) {
                const bookmarks = this.normalizeReaderBookmarks(incomingUser.readerBookmarks);
                target.readerBookmarks = Object.assign({}, target.readerBookmarks || {});
                for (const [bookUid, incomingRows] of Object.entries(bookmarks)) {
                    const current = Array.isArray(target.readerBookmarks[bookUid]) ? target.readerBookmarks[bookUid] : [];
                    const seenIds = new Set(current.map((item) => String(item.id || '').trim()).filter(Boolean));
                    const merged = current.slice();
                    for (const bookmark of incomingRows) {
                        if (seenIds.has(bookmark.id))
                            continue;

                        seenIds.add(bookmark.id);
                        merged.push(bookmark);
                        importedBookmarks++;
                    }
                    target.readerBookmarks[bookUid] = this.normalizeReaderBookmarks({[bookUid]: merged})[bookUid] || [];
                }
            }

            target.updatedAt = this.nowIso();
        }

        for (const incoming of payload.lists) {
            const normalizedIncoming = this.normalizeList({
                name: incoming.name,
                visibility: incoming.visibility,
                books: incoming.books,
                createdAt: incoming.createdAt,
                updatedAt: incoming.updatedAt,
                userId: user.id,
            }, user.id);

            let item = data.lists.find((row) => row.userId === user.id && row.name.toLowerCase() === normalizedIncoming.name.toLowerCase());

            if (!item) {
                item = {
                    id: this.makeId(),
                    userId: user.id,
                    name: normalizedIncoming.name,
                    visibility: normalizedIncoming.visibility,
                    createdAt: normalizedIncoming.createdAt,
                    updatedAt: normalizedIncoming.updatedAt,
                    books: [],
                };
                data.lists.push(item);
                importedLists++;
            }

            item.visibility = this.normalizeVisibility(item.visibility || normalizedIncoming.visibility);
            item.books = this.normalizeEntries(item.books);
            const existing = new Map(item.books.map((row) => [row.bookUid, row]));

            for (const entry of normalizedIncoming.books) {
                if (!existing.has(entry.bookUid)) {
                    existing.set(entry.bookUid, {bookUid: entry.bookUid});
                    importedBooks++;
                }
            }
            //в старом экспорте отметка «прочитано» - в записи списка: она становится прогрессом профиля
            if (target)
                this.applyListReadMarks(target, incoming.books, normalizedIncoming.updatedAt);

            item.books = Array.from(existing.values());
            item.updatedAt = this.nowIso();
        }

        await this.save(data);
        return {importedLists, importedBooks, importedProgress, importedBookmarks};
    },
};
