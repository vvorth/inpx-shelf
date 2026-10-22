const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const profilePassword = require('./ProfilePassword');
const {withFileTransaction, writeFileAtomic} = require('./FilePersistence');
const {t} = require('./i18n');

//level - имя: LM_* объявляет Logger, его может ещё не быть до первого require
function logMessage(level, message) {
    try {
        const logger = new (require('./AppLogger'))();
        logger.log(global[level], message);
    } catch (e) {
        console.warn(message);
    }
}

function logWarning(message) {
    logMessage('LM_WARN', message);
}

class ReadingListStore {
    constructor(config) {
        this.config = config;
        this.file = path.join(config.dataDir, 'reading-lists.json');
    }

    makeDefaultData() {
        return {
            version: 5,
            users: [this.makeDefaultUser()],
            lists: [],
            sharedDiscoveryConfig: this.normalizeSharedDiscoveryConfig(),
            metadataOverrides: {},
            bookNotes: {},
        };
    }

    async ensureData() {
        await fs.ensureDir(path.dirname(this.file));

        if (!await fs.pathExists(this.file)) {
            await this.save(this.makeDefaultData());
        }
    }

    makeId() {
        return crypto.randomBytes(8).toString('hex');
    }

    nowIso() {
        return new Date().toISOString();
    }

    normalizeName(name) {
        return String(name || '').replace(/\s+/g, ' ').trim();
    }

    validateName(name) {
        const normalized = this.normalizeName(name);
        if (!normalized)
            throw new Error(t('readingLists.listNameRequired'));
        if (normalized.length > 120)
            throw new Error(t('errors.listNameTooLong'));
        return normalized;
    }

    validateUserName(name) {
        const normalized = this.normalizeName(name);
        if (!normalized)
            throw new Error(t('errors.userNameRequired'));
        if (normalized.length > 80)
            throw new Error(t('errors.userNameTooLong'));
        return normalized;
    }

    normalizeLogin(login) {
        return String(login || '').trim().toLowerCase();
    }

    validateLogin(login) {
        const normalized = this.normalizeLogin(login);
        if (!normalized)
            return '';
        if (!/^[a-z0-9._-]{3,64}$/i.test(normalized))
            throw new Error(t('errors.loginFormat'));
        return normalized;
    }

    adminLogin() {
        return this.validateLogin(this.config.adminLogin || 'admin');
    }

    // Without a configured password the admin gets a random one, printed once to the log:
    // a fixed default would let anyone who reaches the server in as admin.
    adminPassword() {
        if (!this.config.adminPassword) {
            this.config.adminPassword = crypto.randomBytes(12).toString('base64url');
            //INFO: строки WARN и выше копируются в журнал событий админки, пароль туда не попадает
            logMessage('LM_INFO', `Admin profile "${this.adminLogin()}" password: ${this.config.adminPassword} `
                + '(generated; set INPX_ADMIN_PASSWORD or --admin-password to choose one)');
        }
        return String(this.config.adminPassword);
    }

    // Installs made before the random default still have admin/admin.
    async warnIfDefaultAdminPassword() {
        const admin = (await this.load()).users.find(item => item.isAdmin);
        if (admin && admin.passwordHash && await profilePassword.verify(admin.passwordHash, admin.login, 'admin'))
            logWarning(`Admin profile "${admin.login}" still uses the password "admin": change it in the profile settings`);
    }

    makeAdminUser() {
        const now = this.nowIso();
        const login = this.adminLogin();
        return {
            id: 'admin',
            name: t('profiles.defaultAdminName'),
            login,
            passwordHash: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: false,
            opdsPasswordHash: '',
            isAdmin: true,
            readerProgressGeneration: 0,
            readerProgressResetAt: '',
            //заново созданный профиль с прежним id не принимает cookie прежнего
            sessionsValidAfter: Date.now(),
            createdAt: now,
            updatedAt: now,
        };
    }

    //Завершает сессии профиля: cookie, выданные раньше, недействительны (ProfileAccess.resolve).
    //Значение только растёт: две смены пароля в одну миллисекунду тоже видны проверке входа (loginUserProfile)
    endSessions(user) {
        user.sessionsValidAfter = Math.max(Date.now(), user.sessionsValidAfter || 0) + 1;
        return user.sessionsValidAfter;
    }

    async endAllSessions() {
        const data = await this.load();
        data.users.forEach(user => this.endSessions(user));
        await this.save(data);
    }

    normalizeBookUid(bookUid) {
        return String(bookUid || '').trim();
    }

    //_uid - base64 от SHA-256 строки INPX (InpxParser), у книг удалённой библиотеки тот же. Uid в пути API проверяет
    //apiRoutes, здесь - uid из файла импорта; загрузка своего файла uid не проверяет: прежние строки не теряются
    isBookUid(bookUid) {
        return /^[A-Za-z0-9+/]{43}=$/.test(bookUid);
    }

    normalizeVisibility(value) {
        return (value === 'opds' ? 'opds' : 'private');
    }

    normalizeMetadataPatch(value = {}) {
        const result = {};
        if (Object.prototype.hasOwnProperty.call(value, 'title')) {
            result.title = this.normalizeName(value.title);
            if (!result.title)
                throw new Error(t('errors.bookTitleRequired'));
        }
        if (Object.prototype.hasOwnProperty.call(value, 'author')) {
            result.author = this.normalizeName(value.author);
            if (!result.author)
                throw new Error(t('errors.bookAuthorRequired'));
        }
        if (Object.prototype.hasOwnProperty.call(value, 'series'))
            result.series = this.normalizeName(value.series);
        if (Object.prototype.hasOwnProperty.call(value, 'serno')) {
            const serno = parseInt(value.serno, 10);
            result.serno = Number.isFinite(serno) && serno > 0 ? serno : '';
        }
        return result;
    }

    normalizeMetadataOverrides(value = {}) {
        const result = {};
        for (const [bookUid, row] of Object.entries(value || {})) {
            const uid = this.normalizeBookUid(bookUid);
            if (!uid || !row || typeof(row) !== 'object')
                continue;

            let patch;
            try {
                patch = this.normalizeMetadataPatch(row);
            } catch (e) {
                //одна испорченная правка (например, пустое название) не ломает каждую загрузку файла
                this.warnRepaired(`metadata override "${uid}"`, e, 'skipped');
                continue;
            }
            if (Object.keys(patch).length) {
                result[uid] = Object.assign(patch, {
                    updatedAt: String(row.updatedAt || '').trim() || this.nowIso(),
                });
            }
        }
        return result;
    }

    makeDefaultUser() {
        const now = this.nowIso();
        return {
            id: 'default',
            name: t('profiles.defaultAnonymousName'),
            login: '',
            passwordHash: '',
            emailTo: '',
            telegramChatId: '',
            opdsEnabled: true,
            opdsPasswordHash: '',
            readerPreferences: this.normalizeReaderPreferences(),
            readerProgress: {},
            readerProgressGeneration: 0,
            readerProgressResetAt: '',
            readerBookmarks: {},
            discoveryPreferences: this.normalizeDiscoveryPreferences(),
            createdAt: now,
            updatedAt: now,
        };
    }

    normalizeEntries(entries) {
        const result = [];
        const seen = new Set();

        for (const row of (Array.isArray(entries) ? entries : [])) {
            let entry;
            if (typeof(row) === 'string') {
                entry = {bookUid: this.normalizeBookUid(row)};
            } else if (row && typeof(row) === 'object') {
                entry = {bookUid: this.normalizeBookUid(row.bookUid || row.uid || row.id)};
            } else {
                continue;
            }

            if (!entry.bookUid || seen.has(entry.bookUid))
                continue;

            seen.add(entry.bookUid);
            result.push(entry);
        }

        return result;
    }

    // repair: a stored row that fails validation keeps its data; the name is cut to size, the login kept as is.
    normalizeUser(item, fallback = {}, repair = false) {
        const now = this.nowIso();
        const normalized = Object.assign({}, fallback, item);
        normalized.id = String(normalized.id || '').trim() || this.makeId();
        const name = normalized.name || fallback.name || t('profiles.defaultUserName');
        normalized.name = (repair ? this.normalizeName(name).slice(0, 80) || t('profiles.defaultUserName') : this.validateUserName(name));
        normalized.login = (repair ? this.normalizeLogin(normalized.login) : this.validateLogin(normalized.login || ''));
        normalized.passwordHash = String(normalized.passwordHash || '').trim();
        normalized.emailTo = String(normalized.emailTo || '').trim();
        normalized.telegramChatId = String(normalized.telegramChatId || '').trim();
        normalized.opdsEnabled = (normalized.opdsEnabled !== false);
        //вход OPDS - отдельным паролем; прежний флаг входа OPDS паролем профиля отброшен
        normalized.opdsPasswordHash = String(normalized.opdsPasswordHash || '').trim();
        delete normalized.opdsAuthEnabled;
        normalized.readerPreferences = this.normalizeReaderPreferences(normalized.readerPreferences);
        normalized.readerProgress = this.normalizeReaderProgress(normalized.readerProgress);
        normalized.readerProgressGeneration = Math.max(0, parseInt(normalized.readerProgressGeneration, 10) || 0);
        normalized.readerProgressResetAt = String(normalized.readerProgressResetAt || '').trim();
        normalized.readerBookmarks = this.normalizeReaderBookmarks(normalized.readerBookmarks);
        normalized.discoveryPreferences = this.normalizeDiscoveryPreferences(normalized.discoveryPreferences);
        normalized.isAdmin = !!normalized.isAdmin;
        normalized.sessionsValidAfter = Math.max(0, Number(normalized.sessionsValidAfter) || 0);
        normalized.createdAt = normalized.createdAt || now;
        normalized.updatedAt = normalized.updatedAt || now;
        return normalized;
    }

    normalizeList(item, defaultUserId, repair = false) {
        const now = this.nowIso();
        const normalized = Object.assign({}, item);
        normalized.id = String(normalized.id || '').trim() || this.makeId();
        normalized.userId = String(normalized.userId || defaultUserId || '').trim();
        normalized.name = (repair ? this.normalizeName(normalized.name).slice(0, 120) || normalized.id : this.validateName(normalized.name));
        normalized.visibility = this.normalizeVisibility(normalized.visibility);
        normalized.createdAt = normalized.createdAt || now;
        normalized.updatedAt = normalized.updatedAt || now;
        normalized.books = this.normalizeEntries(normalized.books);
        return normalized;
    }

    normalizeData(data) {
        const defaultUser = this.makeDefaultUser();
        const source = Object.assign({version: 5, users: [], lists: [], sharedDiscoveryConfig: {}, metadataOverrides: {}, bookNotes: {}}, data || {});
        let users = [];

        // A row failing validation is repaired, never dropped: the next save would delete the profile's
        // data and hand its lists to the first profile.
        for (const item of (Array.isArray(source.users) ? source.users : [])) {
            if (!item || typeof(item) !== 'object')
                continue;
            try {
                users.push(this.normalizeUser(item, defaultUser));
            } catch (e) {
                this.warnRepaired(`profile "${item.id}"`, e);
                users.push(this.normalizeUser(item, defaultUser, true));
            }
        }

        if (!users.length) {
            users = [defaultUser];
        }

        const seenUserIds = new Set();
        users = users.filter((item) => {
            if (!item.id || seenUserIds.has(item.id))
                return false;
            seenUserIds.add(item.id);
            return true;
        });

        const defaultUserId = users[0].id;
        const lists = [];
        for (const item of (Array.isArray(source.lists) ? source.lists : [])) {
            if (!item || typeof(item) !== 'object')
                continue;
            let normalized;
            try {
                normalized = this.normalizeList(item, defaultUserId);
            } catch (e) {
                this.warnRepaired(`list "${item.id}"`, e);
                normalized = this.normalizeList(item, defaultUserId, true);
            }
            if (!seenUserIds.has(normalized.userId))
                normalized.userId = defaultUserId;
            //раньше отметка «прочитано» хранилась в записи списка: она становится прогрессом владельца
            this.applyListReadMarks(users.find((user) => user.id === normalized.userId), item.books, normalized.updatedAt);
            lists.push(normalized);
        }

        return {
            version: 5,
            users,
            lists,
            sharedDiscoveryConfig: this.normalizeSharedDiscoveryConfig(source.sharedDiscoveryConfig),
            metadataOverrides: this.normalizeMetadataOverrides(source.metadataOverrides),
            bookNotes: this.normalizeBookNotes(source.bookNotes),
        };
    }

    // Every save normalizes the store again: say it once per row and problem.
    warnRepaired(what, error, outcome = 'kept with its invalid field repaired') {
        const message = `reading-lists.json: ${what} ${outcome}: ${error.message}`;
        this.repairWarnings = this.repairWarnings || new Set();
        if (!this.repairWarnings.has(message)) {
            this.repairWarnings.add(message);
            logWarning(message);
        }
    }

    async applyAdminBootstrap(data) {
        const source = this.normalizeData(data);
        const users = [...source.users];
        let changed = false;

        const adminTemplate = this.makeAdminUser();
        let admin = users.find((item) => item.isAdmin) || users.find((item) => item.id === adminTemplate.id) || null;

        if (!admin) {
            adminTemplate.passwordHash = await profilePassword.hash(this.adminPassword());
            users.unshift(adminTemplate);
            changed = true;
        } else {
            if (!admin.isAdmin) {
                admin.isAdmin = true;
                changed = true;
            }

            if (!admin.login) {
                admin.login = adminTemplate.login;
                changed = true;
            }

            const duplicate = users.find((item) => item.id !== admin.id && item.login === adminTemplate.login);
            if (duplicate && this.config.resetAdminPassword)
                throw new Error(`Admin login "${adminTemplate.login}" already used by another profile`);

            if (!admin.passwordHash || this.config.resetAdminPassword) {
                admin.login = adminTemplate.login;
                admin.passwordHash = await profilePassword.hash(this.adminPassword());
                admin.updatedAt = this.nowIso();
                changed = true;
            }

            if (admin.opdsEnabled !== false) {
                admin.opdsEnabled = false;
                changed = true;
            }

            if (admin.opdsPasswordHash) {
                admin.opdsPasswordHash = '';
                changed = true;
            }
        }

        //сброс пароля администратора завершает все сессии
        if (this.config.resetAdminPassword) {
            users.forEach(user => this.endSessions(user));
            changed = true;
        }

        const adminIndex = users.findIndex((item) => item.id === adminTemplate.id || item.isAdmin);
        if (adminIndex > 0) {
            const [adminUser] = users.splice(adminIndex, 1);
            users.unshift(adminUser);
            changed = true;
        }

        return {
            data: {
                version: 5,
                users,
                lists: source.lists,
                sharedDiscoveryConfig: source.sharedDiscoveryConfig,
                metadataOverrides: source.metadataOverrides,
                bookNotes: source.bookNotes,
            },
            changed,
        };
    }

    // Parsing and normalizing the whole file costs tens of milliseconds on a few MB of reading
    // state, and nearly every request loads it. Reuse the last result while the file is unchanged;
    // a write anywhere (atomic rename) changes its inode. Callers get a copy they may mutate.
    async load() {
        await this.ensureData();
        const stamp = this.fileStamp(await fs.stat(this.file));
        if (this.loaded && this.loaded.stamp === stamp && !this.config.resetAdminPassword)
            return structuredClone(this.loaded.data);
        this.loaded = null;
        let raw = null;
        let reset = false;
        // A read error (EMFILE, EACCES, EIO) is not a broken file: let it fail this request
        // instead of replacing every profile with an empty store.
        const text = await fs.readFile(this.file, 'utf8');
        try {
            const normalized = String(text || '').trim();
            if (!normalized)
                throw new Error('reading-lists.json is empty');
            raw = JSON.parse(normalized);
        } catch (e) {
            const backupFile = await this.backupBrokenStore(e);
            //ошибка попадает и в журнал событий админки: профили и списки надо вернуть из копии или бэкапа
            logMessage('LM_ERR', `reading-lists.json is unreadable (${e.message}): profiles and lists start empty, `
                + `the broken file is saved as ${backupFile}; restore it from that copy or a backup`);
            raw = this.makeDefaultData();
            await this.save(raw);
            reset = true;
        }

        const {data, changed} = await this.applyAdminBootstrap(raw);
        if (changed)
            await this.writeData(data);
        this.config.resetAdminPassword = false;
        // After a write the stamp read above is stale: the next load reads the file again.
        if (!changed && !reset)
            this.persisted = this.loaded = {stamp, data: structuredClone(data)};
        return data;
    }

    async backupBrokenStore(error = null) {
        if (!await fs.pathExists(this.file))
            return;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let backupFile = `${this.file}.broken-${stamp}`;
        try {
            await fs.copy(this.file, backupFile, {overwrite: false});
        } catch (copyError) {
            // No copy - no overwrite: the load fails and the file stays as it is.
            backupFile = `${backupFile}-${crypto.randomBytes(3).toString('hex')}`;
            await fs.copy(this.file, backupFile, {overwrite: false});
        }

        if (error && error.message)
            await fs.writeFile(`${backupFile}.error.txt`, String(error.stack || error.message));
        return backupFile;
    }

    async save(data) {
        const out = this.normalizeData(data);
        await this.writeData(out);
    }

    async writeData(data) {
        const snapshot = JSON.parse(JSON.stringify(data));
        return await this.writeDataNow(await this.preserveReaderProgressResetState(snapshot));
    }

    // What the file holds now: the copy this instance last read or wrote while the file is unchanged,
    // otherwise (another writer, a restore) the file itself. Read only; null when missing or unparsable.
    async persistedData() {
        let stat;
        try {
            stat = await fs.stat(this.file);
        } catch (e) {
            return null;
        }
        if (this.persisted && this.persisted.stamp === this.fileStamp(stat))
            return this.persisted.data;
        try {
            return JSON.parse(await fs.readFile(this.file, 'utf8'));
        } catch (e) {
            return null;
        }
    }

    fileStamp(stat) {
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    }

    async rebaseReaderProgressGeneration(data) {
        const current = await this.persistedData();
        const currentUsers = Array.isArray(current && current.users) ? current.users : [];
        const targetUsers = Array.isArray(data && data.users) ? data.users : [];
        const resetAt = this.nowIso();
        for (const target of targetUsers) {
            const source = currentUsers.find((item) => String(item && item.id || '') === String(target && target.id || ''));
            const sourceGeneration = Math.max(0, parseInt(source && source.readerProgressGeneration, 10) || 0);
            const targetGeneration = Math.max(0, parseInt(target && target.readerProgressGeneration, 10) || 0);
            const generation = Math.max(sourceGeneration, targetGeneration) + 1;
            target.readerProgressGeneration = generation;
            target.readerProgressResetAt = resetAt;
            target.readerProgress = Object.fromEntries(
                Object.entries(this.normalizeReaderProgress(target.readerProgress))
                    .map(([bookUid, row]) => [bookUid, Object.assign({}, row, {generation})])
            );
        }

        return data;
    }

    // A save of a snapshot loaded before a progress reset must not bring the reset progress back.
    async preserveReaderProgressResetState(data) {
        const current = await this.persistedData();
        if (!current)
            return data;

        const currentUsers = Array.isArray(current && current.users) ? current.users : [];
        const targetUsers = Array.isArray(data && data.users) ? data.users : [];
        for (const target of targetUsers) {
            const source = currentUsers.find((item) => String(item && item.id || '') === String(target && target.id || ''));
            if (!source)
                continue;

            const sourceGeneration = Math.max(0, parseInt(source.readerProgressGeneration, 10) || 0);
            const targetGeneration = Math.max(0, parseInt(target.readerProgressGeneration, 10) || 0);
            if (sourceGeneration > targetGeneration) {
                const sourceProgress = this.normalizeReaderProgress(source.readerProgress);
                const targetProgress = this.normalizeReaderProgress(target.readerProgress);
                target.readerProgressGeneration = sourceGeneration;
                target.readerProgressResetAt = String(source.readerProgressResetAt || '').trim();
                target.readerProgress = Object.assign(
                    {},
                    Object.fromEntries(Object.entries(sourceProgress).filter(([, row]) => row.generation >= sourceGeneration)),
                    Object.fromEntries(Object.entries(targetProgress).filter(([, row]) => row.generation >= sourceGeneration)),
                );
                continue;
            }

            target.readerProgressGeneration = targetGeneration;
            target.readerProgress = Object.fromEntries(
                Object.entries(this.normalizeReaderProgress(target.readerProgress))
                    .filter(([, row]) => row.generation >= targetGeneration)
            );
            if (sourceGeneration === targetGeneration) {
                const sourceResetTime = Date.parse(String(source.readerProgressResetAt || '').trim());
                const targetResetTime = Date.parse(String(target.readerProgressResetAt || '').trim());
                if (Number.isFinite(sourceResetTime) && (!Number.isFinite(targetResetTime) || sourceResetTime > targetResetTime))
                    target.readerProgressResetAt = String(source.readerProgressResetAt || '').trim();
            }
        }

        return data;
    }

    // `data` is a private copy: it becomes what persistedData() compares the next save against.
    async writeDataNow(data) {
        this.persisted = null;
        await writeFileAtomic(this.file, JSON.stringify(data));
        this.persisted = {stamp: this.fileStamp(await fs.stat(this.file)), data};
    }

    // Every catalog read applies the overrides: keep them normalized per file version and read them without
    // the store lock. Every write (here, another instance, a backup restore) replaces the file, which changes
    // its stamp, so a completed write is never missed. The result is shared and frozen: callers only read it.
    async getMetadataOverrides() {
        let stamp = '';
        try {
            stamp = this.fileStamp(await fs.stat(this.file));
        } catch (e) {
            // No file yet: the locked load below creates it.
        }
        const cached = this.overridesCache;
        if (cached && stamp && cached.stamp === stamp)
            return cached.overrides;
        return await this.loadMetadataOverrides();
    }

    async loadMetadataOverrides() {
        const data = await this.load();
        const overrides = this.normalizeMetadataOverrides(data.metadataOverrides);
        for (const row of Object.values(overrides))
            Object.freeze(row);
        Object.freeze(overrides);
        // A load that had to write (bootstrap, repair) leaves no stamp: the next read loads again.
        if (this.loaded)
            this.overridesCache = {stamp: this.loaded.stamp, overrides};
        return overrides;
    }

    async updateMetadataOverride(bookUid = '', patch = {}) {
        const uid = this.normalizeBookUid(bookUid);
        if (!uid)
            throw new Error(t('errors.bookIdRequired'));

        const data = await this.load();
        const normalized = this.normalizeMetadataPatch(patch || {});
        if (!Object.keys(normalized).length)
            throw new Error(t('errors.noDataToSave'));

        data.metadataOverrides = this.normalizeMetadataOverrides(data.metadataOverrides);
        data.metadataOverrides[uid] = Object.assign({}, data.metadataOverrides[uid] || {}, normalized, {
            updatedAt: this.nowIso(),
        });
        await this.save(data);
        return data.metadataOverrides[uid];
    }

    async resolveUser(userId = '') {
        const data = await this.load();
        const normalizedUserId = String(userId || '').trim();
        const user = data.users.find((item) => item.id === normalizedUserId)
            || data.users.find((item) => item.login === normalizedUserId)
            || data.users[0];
        if (!user)
            throw new Error(t('errors.userNotFound'));

        return {
            data,
            user,
        };
    }

    ownList(data, user, listId) {
        const item = data.lists.find((row) => row.id === listId && row.userId === user.id);
        if (!item)
            throw new Error(t('errors.listNotFound'));
        return item;
    }

    requireBookUid(bookUid) {
        const normalizedBookUid = this.normalizeBookUid(bookUid);
        if (!normalizedBookUid)
            throw new Error('bookUid is empty');
        return normalizedBookUid;
    }

}

Object.assign(ReadingListStore.prototype,
    require('./readingLists/ReaderPreferences'),
    require('./readingLists/Discovery'),
    require('./readingLists/ReaderState'),
    require('./readingLists/Users'),
    require('./readingLists/Lists'),
    require('./readingLists/Kosync'));

// Every asynchronous store operation may read or change the persisted state (even
// load can bootstrap it). Keep its entire call tree in one reentrant transaction.
// Password checks only take the lock for their reads and writes; metadata overrides are read
// without it while the file is unchanged.
const unlocked = new Set(['verifyUserPassword', 'getMetadataOverrides']);
for (const name of Object.getOwnPropertyNames(ReadingListStore.prototype)) {
    const method = ReadingListStore.prototype[name];
    if (method.constructor.name === 'AsyncFunction' && !unlocked.has(name)) {
        ReadingListStore.prototype[name] = function(...args) {
            return withFileTransaction(this.file, () => method.apply(this, args));
        };
    }
}

module.exports = ReadingListStore;
