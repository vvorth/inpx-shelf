const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');

const WorkerState = require('./WorkerState');//singleton
const CatalogSearch = require('./search/CatalogSearch');
const StateStore = require('./StateStore');
const InpxHashCreator = require('./InpxHashCreator');
const RemoteLib = require('./RemoteLib');//singleton
const FileDownloader = require('./FileDownloader');
const ReadingListStore = require('./ReadingListStore');
const {withFileTransaction} = require('./FilePersistence');
const epubRestorer = require('./EpubRestorer');
const bookConverter = require('./BookConverter');

const asyncExit = new (require('./AsyncExit'))();
const appLogger = new (require('./AppLogger'))();//singleton
const log = appLogger.log;
const utils = require('./utils');
const genreTree = require('./genres');
const Fb2Helper = require('./fb2/Fb2Helper');
const i18n = require('./i18n');
const {t, msg} = i18n;
const {normalizeVersionTag, compareReleaseVersions} = require('../../shared/release');
const {READ_PERCENT, isReadingInProgress, readerProgressOf} = require('./ReaderProgress');

//server states
const ssNormal = 'normal';
const ssDbLoading = 'db_loading';
const ssDbCreating = 'db_creating';

const stateToText = {
    [ssNormal]: '',
    [ssDbLoading]: 'server.dbLoading',
    [ssDbCreating]: 'server.dbCreating',
};

const checkReleaseInterval = 7*60*60*1000;//каждые 7 часов
const bookAssetVersion = 'fblibrary-assets-v5';
const fb2AssetVersion = 'fb2-encoding-v6';
const bookInfoVersion = 'fb2-encoding-v8';

function assetVersionFor(ext) {
    return String(ext || '').toLowerCase() === 'fb2' ? fb2AssetVersion : bookAssetVersion;
}

function isRcReleaseTag(value = '') {
    return /-(?:alpha|beta|rc)(?:[.\-]?\d+)?$/i.test(normalizeVersionTag(value));
}

function resolveReleaseChannel(config = {}) {
    const raw = String(config.updateChannel || '').trim().toLowerCase();
    if (raw === 'rc' || raw === 'stable')
        return raw;

    return (isRcReleaseTag(config.version) ? 'rc' : 'stable');
}

const externalWarmInterval = 60*60*1000;

function buildReleaseCheckRequest(checkReleaseLink = '', channel = 'stable') {
    const baseLink = String(checkReleaseLink || '').trim();
    if (!baseLink)
        return null;

    if (channel === 'rc') {
        const rcLink = baseLink.replace(/\/latest\/?$/i, '');
        const separator = (rcLink.includes('?') ? '&' : '?');
        return {url: `${rcLink}${separator}per_page=20`};
    }

    return {url: baseLink};
}

function pickReleaseFromPayload(payload, channel = 'stable') {
    const list = (Array.isArray(payload) ? payload : [payload])
        .filter(item => item && item.tag_name && !item.draft);

    if (channel === 'rc') {
        return list
            .filter(item => item.prerelease || isRcReleaseTag(item.tag_name))
            .sort((a, b) => compareReleaseVersions(b.tag_name, a.tag_name))[0] || null;
    }

    return list
        .filter(item => !item.prerelease)
        .sort((a, b) => compareReleaseVersions(b.tag_name, a.tag_name))[0] || null;
}

//singleton
let instance = null;

class WebWorker {
    constructor(config) {
        if (!instance) {
            this.config = config;
            this.workerState = new WorkerState();
            this.catalogSearch = new CatalogSearch(config, this);
            this.stateStore = new StateStore(config);

            this.remoteLib = null;
            if (config.remoteLib) {
                this.remoteLib = new RemoteLib(config);
            }
            
            this.inpxHashCreator = new InpxHashCreator(config);
            this.readingListStore = new ReadingListStore(config);
            this.fb2Helper = new Fb2Helper();
            this.profileSessions = new Map();
            this.inpxFileHash = '';
            this.discoveryCache = new Map();
            this.sharedDiscoveryConfig = null;
            this.resetLibraryAssetCaches();
            this.cacheCleanTimer = null;
            this.cacheCleanRunning = false;

            this.wState = this.workerState.getControl('server_state');
            this.myState = '';
            this.adminEvents = [];
            const cpuUsage = process.cpuUsage();
            this.adminCpuSnapshot = {
                at: Date.now(),
                totalMicros: cpuUsage.user + cpuUsage.system,
            };
            appLogger.setEventListener((level, message) => {
                const eventLevel = (level >= LM_ERR ? 'error' : 'warn');
                this.addAdminEvent(eventLevel, 'system', message);
            });

            asyncExit.add(this.closeDb.bind(this));

            this.loadOrCreateDb();//no await
            this.periodicLogServerStats();//no await

            this.periodicCleanDir();//no await
            this.periodicCheckInpx();//no await
            this.periodicCheckNewRelease();//no await
            this.periodicWarmExternalDiscovery();//no await

            instance = this;
        }

        return instance;
    }

    checkMyState() {
        if (this.myState != ssNormal)
            throw new Error('server_busy');
    }

    async getIndexStatus() {
        const workerState = this.wState.get() || {};
        const ready = this.myState === ssNormal && this.catalogSearch.ready;
        const result = {
            ready,
            state: this.myState || workerState.state || '',
            serverMessage: i18n.render(workerState.serverMessage),
            job: workerState.job || '',
            jobMessage: i18n.render(workerState.jobMessage),
            jobStep: workerState.jobStep || 0,
            jobStepCount: workerState.jobStepCount || 0,
            progress: workerState.progress || 0,
            recsLoaded: workerState.recsLoaded || 0,
            inpxFileHash: this.inpxFileHash || '',
            dbLoaded: this.catalogSearch.ready,
            searchReady: this.catalogSearch.ready,
            version: this.config.version,
            sources: (Array.isArray(this.config.librarySources) ? this.config.librarySources : []).map(source => ({
                id: source.id,
                name: source.name,
                enabled: source.enabled !== false,
            })),
        };

        if (ready) {
            try {
                const dbConfig = await this.dbConfig();
                result.inpxHash = dbConfig.inpxHash || '';
                result.stats = dbConfig.stats || {};
                result.inpxInfo = dbConfig.inpxInfo || {};
            } catch (e) {
                result.ready = false;
                result.error = e.message;
            }
        }

        return result;
    }

    setMyState(newState, workerState = {}) {
        this.myState = newState;
        this.wState.set(Object.assign({}, workerState, {
            state: newState,
            serverMessage: stateToText[newState]
        }));
    }

    async closeDb() {
        if (this.catalogSearch)
            await this.catalogSearch.close();
        if (this.stateStore)
            this.stateStore.close();
    }

    //Одна сборка БД за раз: вызов во время сборки ставит в очередь не больше одной следующей
    loadOrCreateDb(recreate = false) {
        if (!this.dbLoad) {
            this.dbLoad = this.loadOrCreateDbOnce(recreate).finally(() => {
                this.dbLoad = null;
            });
            return this.dbLoad;
        }

        this.dbReloadRecreate = !!(this.dbReloadRecreate || recreate);
        if (!this.dbReload) {
            this.dbReload = this.dbLoad.then(() => {
                const force = this.dbReloadRecreate;
                this.dbReload = null;
                this.dbReloadRecreate = false;
                return this.loadOrCreateDb(force);
            });
        }
        return this.dbReload;
    }

    //Открывает БД библиотеки или строит её из INPX. Пока строится впервые - сервер занят;
    //пересборка готовой БД (переиндексирование, новый INPX) идёт в фоне, прежняя БД отвечает до замены.
    async loadOrCreateDbOnce(recreate = false) {
        const config = this.config;
        const firstLoad = !this.catalogSearch.ready;
        if (firstLoad)
            this.setMyState(ssDbLoading);

        let progressTimer = null;
        try {
            this.inpxFileHash = await this.inpxHashCreator.getInpxFileHash();
            const inpxHash = await this.inpxHashCreator.getHash();

            if (firstLoad) {
                progressTimer = setInterval(() => {
                    if (this.catalogSearch.building)
                        this.setMyState(ssDbCreating, {job: 'build library', jobMessage: 'db.loadInpx', jobStep: 1, jobStepCount: 1, progress: this.catalogSearch.progress});
                }, 500);
            }

            const ok = await this.catalogSearch.ensure(inpxHash, {force: !!(config.recreateDb || recreate), keepReady: !firstLoad});
            config.recreateDb = false;
            if (!ok)
                throw new Error('Library database is not available');

            this.resetLibraryAssetCaches();
            if (firstLoad) {
                this.setMyState(ssNormal);
                log('Library DB ready');
                this.logServerStats();
                await this.removeLegacyDb();
            }
        } catch (e) {
            if (!firstLoad) {
                log(LM_ERR, `Library DB rebuild: ${e.message}`);
                return;
            }
            log(LM_FATAL, e.message);
            asyncExit.exit(1);
        } finally {
            clearInterval(progressTimer);
        }
    }

    //Данные прежних версий: основная БД, её сессии доступа и индекс поиска. Всё перестроено в library.sqlite и state.sqlite.
    async removeLegacyDb() {
        const dataDir = this.config.dataDir;
        for (const name of ['db', 'web-access', 'catalog-index.sqlite', 'catalog-index.sqlite.tmp']) {
            const file = path.join(dataDir, name);
            if (await fs.pathExists(file)) {
                await fs.remove(file);
                log(`Removed legacy data: ${name}`);
            }
        }
    }

    async recreateDb() {
        await this.loadOrCreateDb(true);
    }

    resetLibraryAssetCaches() {
        this.libraryAssetGeneration = (this.libraryAssetGeneration || 0) + 1;
        this.fblibraryArchives = {};
        this.bookAssetArchives = new Map();
        this.authorInfoCache = new Map();
        this.authorInfoIndex = null;
        this.reviewArchiveStates = new Map();
        this.preparedBookSizes = new Map();
    }

    async dbConfig() {
        this.checkMyState();
        return this.catalogSearch.libraryConfig();
    }

    //Поиск книг по полям с пометками прежнего поиска («=» точно, «*» подстрока, «~» RegExp...):
    //Audiobookshelf, сопоставление внешней витрины. Ответ: {found: записи с правками, totalFound}
    async bookSearch(query) {
        this.checkMyState();

        const {ids, totalFound} = await this.catalogSearch.call('findBooks', query);
        const result = {found: await this.catalogSearch.loadBooks(ids), totalFound};
        result.inpxHash = (await this.dbConfig()).inpxHash || '';
        return result;
    }

    async getAuthorBookList(authorId, author) {
        this.checkMyState();

        //книги ищутся по имени автора; id авторов прежней БД больше не используются
        return await this.catalogSearch.authorBooks(author || '');
    }

    async getSeriesBookList(series) {
        this.checkMyState();

        return {books: (series ? await this.catalogSearch.seriesBooks(series) : [])};
    }

    async getGenreTree() {
        this.checkMyState();

        const config = await this.dbConfig();

        let result;
        const cacheKey = String(config.inpxHash || '');
        if (!this.genreTreeCache || this.genreTreeCache.key !== cacheKey) {
            const genres = _.cloneDeep(genreTree);
            const last = genres[genres.length - 1];

            const genreValues = new Set();
            for (const section of genres) {
                for (const g of section.value)
                    genreValues.add(g.value);
            }

            //добавим к жанрам те, что нашлись в библиотеке
            const values = await this.catalogSearch.facetValues();
            const genreParsed = new Set();
            for (const value of new Set(values.genre.map(item => item.toLowerCase()))) {
                genreParsed.add(value);

                if (!genreValues.has(value))
                    last.value.push({name: value, value});
            }

            //уберем те, которые не нашлись при парсинге
            for (let j = 0; j < genres.length; j++) {
                const section = genres[j];
                for (let i = 0; i < section.value.length; i++) {
                    const g = section.value[i];
                    if (!genreParsed.has(g.value))
                        section.value.splice(i--, 1);
                }

                if (!section.value.length)
                    genres.splice(j--, 1);
            }

            const langs = [...values.lang].sort();
            const exts = [...values.ext].sort();

            result = {
                genreTree: genres,
                langList: langs,
                extList: exts,
                inpxHash: (config.inpxHash ? config.inpxHash : ''),
            };

            this.genreTreeCache = {key: cacheKey, result};
        } else {
            result = this.genreTreeCache.result;
        }

        return result;
    }

    async getGenreMap() {
        this.checkMyState();

        const genreTree = await this.getGenreTree();
        if (!this.genreMapCache || this.genreMapCache.tree !== genreTree) {
            const result = new Map();
            for (const section of genreTree.genreTree) {
                for (const g of section.value)
                    result.set(g.value, g.name);
            }
            this.genreMapCache = {tree: genreTree, result};
        }

        return this.genreMapCache.result;
    }

    //Запись книги для страницы книги: с правками метаданных, без подготовки файла
    async getBook(bookUid = '') {
        this.checkMyState();

        const book = await this.getBookRecordByUid(String(bookUid || '').trim());
        if (!book)
            throw new Error(t('errors.bookNotFound'));

        const result = {books: [Object.assign({}, book)]};
        await this.applyMetadataOverridesToSearchResult(result);
        return {book: result.books[0]};
    }

    //Прогресс текущего читателя по набору книг и есть ли книга в его списках: {uid: {percent, read, hidden, inList}}
    getUserBookStates(user = null, bookUids = [], lists = []) {
        const progressMap = readerProgressOf(user);
        const listed = new Set(lists.flatMap(list => this.readingListStore.normalizeEntries(list.books).map(entry => entry.bookUid)));
        const states = {};
        for (const value of (Array.isArray(bookUids) ? bookUids : []).slice(0, 2000)) {
            const bookUid = String(value || '').trim();
            const progress = bookUid && progressMap[bookUid];
            const inList = listed.has(bookUid);
            if (!progress && !inList)
                continue;

            const percent = (progress ? Math.max(0, Math.min(1, Number(progress.percent || 0) || 0)) : 0);
            states[bookUid] = {percent, read: percent >= READ_PERCENT, hidden: !!progress && progress.hidden === true, inList};
        }
        return {states};
    }

    async getBookRecordByUid(bookUid) {
        const rows = await this.catalogSearch.getBooksByUids([String(bookUid || '')]);
        return (rows.length ? rows[0] : null);
    }

    //Записи по набору _uid одним запросом к потоку БД: Map _uid -> запись
    async getBookRecordsByUids(bookUids = []) {
        const uids = Array.from(new Set(bookUids.map(uid => String(uid || '').trim()).filter(Boolean)));
        const rows = (uids.length ? await this.catalogSearch.getBooksByUids(uids) : []);
        return new Map(rows.map(row => [row._uid, row]));
    }

    // Records by `sourceId:libid` (the key Kobo ids are derived from), for list entries whose _uid
    // changed in a re-index. Indexed in the library DB.
    async findBookRecordsByStableKeys(keys = []) {
        return await this.catalogSearch.getBooksByStableKeys(keys);
    }

    sortReadingListBooks(books = [], order = []) {
        const orderMap = new Map(order.map((uid, index) => [uid, index]));
        return books.sort((a, b) => {
            const ai = orderMap.has(a._uid) ? orderMap.get(a._uid) : Number.MAX_SAFE_INTEGER;
            const bi = orderMap.has(b._uid) ? orderMap.get(b._uid) : Number.MAX_SAFE_INTEGER;
            if (ai !== bi)
                return ai - bi;

            return (a.title || '').localeCompare(b.title || '', 'ru');
        });
    }

    async buildUserReadingSummary(user = null, limit = 6) {
        const progressMap = readerProgressOf(user);

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, progress || {}),
            }))
            .filter((item) => item.bookUid && isReadingInProgress(item.progress))
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')))
            .slice(0, Math.max(0, limit));

        const result = [];
        const booksByUid = await this.getBookRecordsByUids(rows.map(item => item.bookUid));
        for (const item of rows) {
            const book = booksByUid.get(item.bookUid);
            if (!book)
                continue;

            //полная запись книги: «Читаю сейчас» показывается теми же карточками, что и каталог
            result.push(Object.assign({}, book, {
                bookUid: item.bookUid,
                title: book.title || t('common.untitled'),
                author: book.author || '',
                series: book.series || '',
                serno: book.serno || '',
                ext: book.ext || '',
                percent: Math.max(0, Math.min(1, Number(item.progress.percent || 0) || 0)),
                sectionId: String(item.progress.sectionId || '').trim(),
                pageIndex: Math.max(0, Math.round(Number(item.progress.pageIndex || 0) || 0)),
                textOffset: Math.max(-1, Math.round(Number(item.progress.textOffset || -1) || -1)),
                textSnippet: String(item.progress.textSnippet || '').trim(),
                updatedAt: String(item.progress.updatedAt || '').trim(),
            }));
        }

        return {
            count: Object.values(progressMap).filter(isReadingInProgress).length,
            items: result,
        };
    }

    async getUserReadingLibrary(user = null, options = {}) {
        this.checkMyState();

        const progressMap = readerProgressOf(user);
        const state = ['reading', 'read', 'hidden', 'all'].includes(String(options.state || '').trim())
            ? String(options.state || '').trim()
            : 'reading';
        const query = String(options.query || '').trim().toLowerCase();
        const sort = String(options.sort || 'updatedDesc').trim();
        const limit = Math.max(1, Math.min(500, Number(options.limit || 200) || 200));

        const counters = {
            all: 0,
            reading: 0,
            read: 0,
            hidden: 0,
        };
        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => {
                bookUid = String(bookUid || '').trim();
                if (!bookUid)
                    return null;
                const normalizedProgress = Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, progress || {});
                const percent = Math.max(0, Math.min(1, Number(normalizedProgress.percent || 0) || 0));
                const hidden = normalizedProgress.hidden === true;
                const rowState = hidden ? 'hidden' : (percent >= READ_PERCENT ? 'read' : 'reading');
                counters.all++;
                counters[rowState]++;
                return {
                    bookUid,
                    progress: Object.assign(normalizedProgress, {percent, hidden}),
                    state: rowState,
                };
            })
            .filter((item) => item && (state === 'all' || item.state === state));

        const items = [];
        const booksByUid = await this.getBookRecordsByUids(rows.map(item => item.bookUid));
        for (const item of rows) {
            const book = booksByUid.get(item.bookUid) || null;
            const metadata = book || {};

            const resultItem = {
                bookUid: item.bookUid,
                title: metadata.title || (book ? t('common.untitled') : t('reader.bookUnavailable')),
                author: metadata.author || '',
                series: metadata.series || '',
                serno: metadata.serno || '',
                ext: metadata.ext || '',
                unavailable: !book,
                percent: item.progress.percent,
                hidden: item.progress.hidden === true,
                state: item.state,
                sectionId: String(item.progress.sectionId || '').trim(),
                updatedAt: String(item.progress.updatedAt || '').trim(),
            };
            if (query) {
                const haystack = `${resultItem.title} ${resultItem.author} ${resultItem.series}`.toLowerCase();
                if (!haystack.includes(query))
                    continue;
            }
            items.push(resultItem);
        }

        const compareText = (a, b, field) => String(a[field] || '').localeCompare(String(b[field] || ''), 'ru');
        items.sort((a, b) => {
            switch (sort) {
                case 'updatedAsc':
                    return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
                case 'titleAsc':
                    return compareText(a, b, 'title');
                case 'authorAsc':
                    return compareText(a, b, 'author') || compareText(a, b, 'title');
                case 'progressDesc':
                    return (Number(b.percent || 0) - Number(a.percent || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
                case 'progressAsc':
                    return (Number(a.percent || 0) - Number(b.percent || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
                case 'updatedDesc':
                default:
                    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
            }
        });

        return {
            state,
            query,
            sort,
            progressGeneration: Math.max(0, parseInt(user && user.readerProgressGeneration, 10) || 0),
            counters,
            count: items.length,
            items: items.slice(0, limit),
        };
    }

    async getOpdsUsers() {
        this.checkMyState();
        return await this.readingListStore.getOpdsUsers();
    }

    async getOpdsUserReadingLibrary(publicId = '', options = {}) {
        this.checkMyState();
        const user = await this.readingListStore.getOpdsUser(publicId);
        if (!user)
            throw new Error(t('errors.opdsProfileNotFound'));

        return await this.getUserReadingLibrary(user, options);
    }

    async verifyOpdsPassword(publicId = '', login = '', password = '') {
        this.checkMyState();
        return await this.readingListStore.verifyOpdsPassword(publicId, login, password);
    }

    async getReaderState(userId = '', bookUid = '') {
        this.checkMyState();
        return await this.readingListStore.getReaderState(userId, bookUid);
    }

    async updateReaderPreferences(userId = '', patch = {}) {
        this.checkMyState();
        const preferences = await this.readingListStore.updateReaderPreferences(userId, patch);
        return {preferences};
    }

    async updateDiscoveryPreferences(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        const preferences = await this.readingListStore.updateDiscoveryPreferences(user.id, patch);
        return {preferences};
    }

    async recordDiscoveryEvents(userId = '', profileAccessToken = '', events = []) {
        this.checkMyState();
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        return await this.readingListStore.recordDiscoveryEvents(user.id, events);
    }

    async updateBookMetadata(userId = '', profileAccessToken = '', bookUid = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const override = await this.readingListStore.updateMetadataOverride(bookUid, patch);

        const book = await this.getBookRecordByUid(bookUid);
        if (book && this.catalogSearch) {
            this.applyMetadataOverrideToBook(book, await this.readingListStore.getMetadataOverrides());
            await this.catalogSearch.updateBook(book);
        }
        return {bookUid, override};
    }

    async updateReaderProgress(userId = '', bookUid = '', patch = {}) {
        this.checkMyState();
        const progress = await this.readingListStore.updateReaderProgress(userId, bookUid, patch);
        return {progress};
    }

    async deleteReaderProgress(userId = '', bookUid = '') {
        this.checkMyState();
        return await this.readingListStore.deleteReaderProgress(userId, bookUid);
    }

    async clearReaderProgress(userId = '') {
        this.checkMyState();
        return await this.readingListStore.clearReaderProgress(userId);
    }

    async addReaderBookmark(userId = '', bookUid = '', bookmark = {}) {
        this.checkMyState();
        const bookmarks = await this.readingListStore.addReaderBookmark(userId, bookUid, bookmark);
        return {bookmarks};
    }

    async deleteReaderBookmark(userId = '', bookUid = '', bookmarkId = '') {
        this.checkMyState();
        const bookmarks = await this.readingListStore.deleteReaderBookmark(userId, bookUid, bookmarkId);
        return {bookmarks};
    }

    async getReadingLists(userId = '', bookUid = '', options = {}) {
        this.checkMyState();

        const lists = await this.readingListStore.getLists(userId, options);
        return {
            lists: lists
                .map((item) => this.readingListStore.listStats(item, bookUid))
                .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        };
    }

    async getReadingList(userId = '', listId, options = {}) {
        this.checkMyState();

        const item = await this.readingListStore.getList(userId, listId, options);
        if (!item)
            throw new Error(t('errors.listNotFound'));

        const listEntries = this.readingListStore.normalizeEntries(item.books);
        const books = [];
        const booksByUid = await this.getBookRecordsByUids(listEntries.map(entry => entry.bookUid));
        for (const entry of listEntries) {
            const book = booksByUid.get(entry.bookUid);
            if (book) {
                book._readingListRead = !!entry.read;
                books.push(book);
            }
        }

        this.sortReadingListBooks(books, listEntries.map((entry) => entry.bookUid));

        //английские имена авторов нужны фильтру списка в браузере
        let aliases = {};
        try {
            aliases = await this.catalogSearch.authorAliasesOf(Array.from(new Set(books.map(book => String(book.author || '')))));
        } catch (e) {
            //поиск по английским именам не обязателен
        }
        for (const book of books)
            book._authorAliases = aliases[String(book.author || '')] || [];

        return {
            list: {
                id: item.id,
                userId: item.userId,
                name: item.name,
                visibility: item.visibility,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                bookCount: (item.books || []).length,
                readCount: this.readingListStore.countRead(item.books),
            },
            books,
        };
    }

    async createReadingList(userId = '', name, visibility = 'private') {
        this.checkMyState();

        const item = await this.readingListStore.createList(userId, name, visibility);
        return {
            list: this.readingListStore.listStats(item),
        };
    }

    async renameReadingList(userId = '', listId, name) {
        this.checkMyState();

        const item = await this.readingListStore.renameList(userId, listId, name);
        return {list: this.readingListStore.listStats(item)};
    }

    async setReadingListVisibility(userId = '', listId, visibility) {
        this.checkMyState();
        const item = await this.readingListStore.setListVisibility(userId, listId, visibility);
        return {list: this.readingListStore.listStats(item)};
    }

    async deleteReadingList(userId = '', listId) {
        this.checkMyState();
        return await this.readingListStore.deleteList(userId, listId);
    }

    async exportReadingLists(userId = '') {
        this.checkMyState();
        return await this.readingListStore.exportData(userId);
    }

    async importReadingLists(userId = '', data) {
        this.checkMyState();
        const result = await this.readingListStore.importData(userId, data);
        if (this.koboService)
            this.koboService.prewarmLists(userId);
        return result;
    }

    async updateReadingListBook(userId = '', listId, bookUid, enabled) {
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error(t('errors.fileNotFound'));

        const item = await this.readingListStore.setBookMembership(userId, listId, bookUid, enabled);
        if (enabled && this.koboService)
            this.koboService.prewarmBooks(item.userId, item.id, [bookUid]);
        return {
            list: this.readingListStore.listStats(item),
            bookUid,
            enabled: !!enabled,
        };
    }

    async setReadingListBookRead(userId = '', listId, bookUid, read) {
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error(t('errors.fileNotFound'));

        //одна запись файла: setBooksRead с listIds сам ставит отметку в списке
        return withFileTransaction(this.readingListStore.file, async() => {
            const item = await this.readingListStore.getList(userId, listId);
            if (!item)
                throw new Error(t('errors.listNotFound'));
            const normalizedBookUid = String(bookUid || '').trim();
            if (!this.readingListStore.normalizeEntries(item.books).some(entry => entry.bookUid === normalizedBookUid))
                throw new Error(t('errors.bookNotInList'));

            const result = await this.readingListStore.setBooksRead(userId, [normalizedBookUid], read, {listIds: [item.id]});
            return {
                list: result.updatedLists.find(list => list.id === item.id) || this.readingListStore.listStats(item),
                bookUid,
                read: !!read,
            };
        });
    }

    async markReaderBooksRead(userId = '', bookUids = [], read = true, options = {}) {
        this.checkMyState();

        const normalized = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
            .map((bookUid) => String(bookUid || '').trim())
            .filter(Boolean)));
        if (!normalized.length)
            throw new Error('bookUids is empty');

        const booksByUid = await this.getBookRecordsByUids(normalized);
        if (normalized.some(bookUid => !booksByUid.has(bookUid)))
            throw new Error(t('errors.fileNotFound'));

        return await this.readingListStore.setBooksRead(userId, normalized, read, options);
    }

    async markSeriesRead(userId = '', series = '', read = true) {
        this.checkMyState();

        const seriesName = String(series || '').trim();
        if (!seriesName)
            throw new Error('series is empty');

        const result = await this.getSeriesBookList(seriesName);
        const bookUids = (result.books || []).map((book) => book._uid).filter(Boolean);
        const markResult = await this.readingListStore.setBooksRead(userId, bookUids, read);

        return Object.assign({}, markResult, {
            series: seriesName,
        });
    }

    async addSeriesToReadingList(userId = '', listId, series) {
        this.checkMyState();

        const seriesName = String(series || '').trim();
        if (!seriesName)
            throw new Error('series is empty');

        const result = await this.getSeriesBookList(seriesName);
        const bookUids = (result.books || []).map((book) => book._uid).filter(Boolean);
        const added = await this.readingListStore.addBooks(userId, listId, bookUids);
        if (this.koboService)
            this.koboService.prewarmBooks(added.item.userId, added.item.id, bookUids);

        return {
            list: this.readingListStore.listStats(added.item),
            series: seriesName,
            addedBooks: added.added,
        };
    }

    async restoreBook(bookUid, libFolder, libFile, downFileName, sourceLibDir = '') {
        let extractedFile = '';
        let hash = '';

        if (!this.remoteLib) {
            extractedFile = await this.extractBook(libFolder, libFile, sourceLibDir);
            if (path.extname(libFile).toLowerCase() === '.fb2') {
                try {
                    const data = await fs.readFile(extractedFile);
                    const normalized = this.fb2Helper.checkEncoding(await this.fb2Helper.decompressIfNeeded(data));
                    if (!normalized.equals(data))
                        await fs.writeFile(extractedFile, normalized);
                    const libid = parseInt(path.basename(libFile, path.extname(libFile)), 10);
                    if (libid && await this.shouldInjectFblibraryImages(extractedFile, libFolder))
                        await this.injectFblibraryImages(extractedFile, libid, sourceLibDir, libFolder);
                } catch (error) {
                    await fs.remove(extractedFile);
                    throw error;
                }
            } else if (path.extname(libFile).toLowerCase() === '.epub') {
                const libid = path.basename(libFile, path.extname(libFile));
                const archiveCache = new Map();
                const readerCache = new Map();
                try {
                    await epubRestorer.restore(extractedFile, this.config,
                        (num, name) => this.getEpubImage(libid, num, name, libFolder, sourceLibDir, archiveCache, readerCache));
                } catch (error) {
                    await fs.remove(extractedFile);
                    throw error;
                } finally {
                    await Promise.all([...readerCache.values()].map(reader => reader.close()));
                }
            }
            hash = await utils.getFileHash(extractedFile, 'sha256', 'hex');
        } else {
            hash = await this.remoteLib.downloadBook(bookUid);
        }

        const link = `${this.config.bookPathStatic}/${hash}`;
        const bookFile = `${this.config.bookDir}/${hash}`;
        const bookFileDesc = `${bookFile}.d.json`;
        const size = extractedFile ? (await fs.stat(extractedFile)).size : 0;

        if (!await fs.pathExists(bookFile) || !await fs.pathExists(bookFileDesc)) {
            if (!await fs.pathExists(bookFile) && extractedFile) {
                const tmpFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;
                await utils.gzipFile(extractedFile, tmpFile, 4);
                await fs.remove(extractedFile);
                await fs.move(tmpFile, bookFile, {overwrite: true});
            } else {
                if (extractedFile)
                    await fs.remove(extractedFile);
                await utils.touchFile(bookFile);
            }
        } else {
            if (extractedFile)
                await fs.remove(extractedFile);

            await utils.touchFile(bookFile);
            await utils.touchFile(bookFileDesc);
        }

        const assetVersion = assetVersionFor(path.extname(libFile).slice(1));
        await fs.writeFile(bookFileDesc, JSON.stringify({libFolder, libFile, sourceLibDir, downFileName, size, assetVersion}));
        this.scheduleCacheClean(msg('admin.cleanReasonAfterBook'));

        this.stateStore.putBookFile({id: bookUid, hash, size, assetVersion});

        return link;
    }

    async getBookLink(bookUid) {
        this.checkMyState();
        const notFound = () => Object.assign(new Error(t('errors.fileNotFound')), {status: 404});

        try {
            let link = '';
            let size = 0;

            //найдем downFileName, libFolder, libFile
            const book = await this.getBookRecordByUid(bookUid);
            if (!book)
                throw notFound();

            let downFileName = book.file;
            const authors = book.author.split(',');
            let author = authors[0];
            author = author.split(' ').filter(r => r.trim());
            for (let i = 1; i < author.length; i++)
                author[i] = `${(i === 1 ? ' ' : '')}${author[i][0]}.`;
            if (authors.length > 1)
                author.push(t('common.etAl'));

            const at = [author.join(''), (book.title ? `_${book.title}` : '')];
            downFileName = utils.makeValidFileNameOrEmpty(at.filter(r => r).join(''))
                || utils.makeValidFileNameOrEmpty(at[0])
                || utils.makeValidFileNameOrEmpty(at[1])
                || downFileName;
            if (downFileName.length > 50)
                downFileName = `${downFileName.substring(0, 50)}_`;

            const ext = `.${book.ext}`;
            if (downFileName.substring(downFileName.length - ext.length) != ext)
                downFileName += ext;

            const libFolder = book.folder;
            const libFile = `${book.file}${ext}`;
            const sourceLibDir = book.sourceLibDir || this.config.libDir;

            //найдем хеш
            const rows = this.stateStore.getBookFiles([bookUid]);
            if (rows.length) {//хеш найден по bookUid
                const hash = rows[0].hash;
                const bookFile = `${this.config.bookDir}/${hash}`;
                const bookFileDesc = `${bookFile}.d.json`;

                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    try {
                        const desc = JSON.parse(await fs.readFile(bookFileDesc, 'utf8'));
                        if (desc.assetVersion === assetVersionFor(book.ext)) {
                            link = `${this.config.bookPathStatic}/${hash}`;
                            size = desc.size || 0;
                        }
                    } catch(e) {
                        link = '';
                    }
                }
            }

            if (!link) {
                if (!this.pendingBookRestores)
                    this.pendingBookRestores = new Map();
                const pending = this.pendingBookRestores;
                const key = JSON.stringify([bookUid, libFolder, libFile, sourceLibDir, this.libraryAssetGeneration]);
                if (!pending.has(key)) {
                    pending.set(key, this.restoreBook(bookUid, libFolder, libFile, downFileName, sourceLibDir)
                        .finally(() => pending.delete(key)));
                }
                link = await pending.get(key);
                const desc = await fs.readJson(`${this.config.bookDir}/${path.basename(link)}.d.json`);
                size = desc.size || 0;
            }

            if (!link)
                throw notFound();

            return {link, libFolder, libFile, downFileName, size};
        } catch(e) {
            log(LM_ERR, `getBookLink error: ${e.message}`);
            if (e.status !== 404 && e.message.indexOf('ENOENT') >= 0)
                throw notFound();
            throw e;
        }
    }

    async getPreparedBookFile(bookUid, format = '') {
        const {link, downFileName, size} = await this.getBookLink(bookUid);
        const hash = path.basename(link);
        const gzipFile = `${this.config.bookDir}/${hash}`;
        const rawFile = `${gzipFile}.raw`;

        let cacheChanged = await utils.ensureGunzipFile(gzipFile, rawFile, size);

        //описание (.d.json) нужно вместе с файлом: очистка кеша удаляет самые старые файлы первыми
        await utils.touchFile(gzipFile);
        await utils.touchFile(`${gzipFile}.d.json`);
        await utils.touchFile(rawFile);

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error(t('errors.fileNotFound'));

        let preparedFile = rawFile;
        let preparedFileName = downFileName;
        const targetFormat = String(format || '').toLowerCase();
        const sourceFormat = String(book.ext || '').toLowerCase();

        if (targetFormat && targetFormat !== sourceFormat) {
            const prepared = await bookConverter.prepareConvertedFile({
                inputFile: rawFile,
                cacheBasePath: gzipFile,
                format: targetFormat,
                sourceFileName: downFileName,
                downFileName,
                config: this.config,
                unsupportedMessage: t('errors.unsupportedDeliveryFormat', {format: targetFormat}),
                disabledMessage: t('list.bookConversionDisabledImage'),
            });
            preparedFile = prepared.filePath;
            preparedFileName = prepared.downloadName;
            if (prepared.created)
                cacheChanged = true;
            await utils.touchFile(preparedFile);
        }

        if (cacheChanged)
            this.scheduleCacheClean(msg('admin.cleanReasonAfterCacheUpdate'));

        return {
            book,
            rawFile: preparedFile,
            downFileName: preparedFileName,
        };
    }

    extractFb2Contents(parser) {
        const result = [];
        const walk = (sections, level = 0) => {
            for (const section of sections) {
                const titleNode = section.$$('\/title/');
                let title = '';
                if (titleNode && titleNode.count)
                    title = this.extractFb2NodeText(titleNode, parser);

                if (title)
                    result.push({title, level});

                const childSections = section.$$array('/section');
                if (childSections.length)
                    walk(childSections, level + 1);
            }
        };

        for (const body of parser.$$array('/body')) {
            const attrs = body.attrs() || {};
            const bodyName = String(attrs.name || '').trim().toLowerCase();
            if (bodyName === 'notes')
                continue;

            walk(body.$$array('/section'));
        }

        return result.slice(0, 200);
    }

    extractFb2NodeText(node, parser) {
        if (!node)
            return '';

        const parts = [];
        node.eachDeepSelf((item) => {
            if (item.type === parser.TEXT || item.type === parser.CDATA)
                parts.push(item.value);
        });

        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    extractFb2AnnotationMeta(parser) {
        const result = {
            epigraph: [],
            epigraphAuthor: '',
            stats: {
                letters: 0,
                words: 0,
                pages: 0,
                images: 0,
            },
        };

        const topEpigraphs = parser.$$array('/body/epigraph');
        if (topEpigraphs.length) {
            const lines = [];
            let author = '';

            for (const epigraph of topEpigraphs) {
                for (const p of epigraph.$$array('/p')) {
                    const text = this.extractFb2NodeText(p, parser);
                    if (text)
                        lines.push(text);
                }

                if (!author) {
                    const textAuthor = epigraph.$$('\/text-author/');
                    const value = this.extractFb2NodeText(textAuthor, parser);
                    if (value)
                        author = value;
                }
            }

            result.epigraph = lines.slice(0, 12);
            result.epigraphAuthor = author;
        }

        const textParts = [];
        for (const body of parser.$$array('/body')) {
            body.eachDeepSelf((item) => {
                if (item.type === parser.TEXT || item.type === parser.CDATA)
                    textParts.push(item.value);
            });
        }

        const fullText = textParts.join(' ').replace(/\s+/g, ' ').trim();
        const letters = fullText.replace(/\s+/g, '').length;
        const words = (fullText ? fullText.split(/\s+/).filter(Boolean).length : 0);
        const pages = (words ? Math.max(1, Math.round((words / 250) * 10) / 10) : 0);

        let images = 0;
        for (const node of parser.$$array('/binary')) {
            const attrs = node.attrs() || {};
            const contentType = String(attrs['content-type'] || '').toLowerCase();
            if (contentType.startsWith('image/'))
                images++;
        }

        result.stats = {letters, words, pages, images};

        return result;
    }

    metadataBookUid(book = {}) {
        return String(book._uid || book.uid || book.bookUid || '').trim();
    }

    applyMetadataOverrideToBook(book = {}, overrides = {}) {
        const uid = this.metadataBookUid(book);
        const override = uid ? overrides[uid] : null;
        if (!override)
            return book;

        for (const field of ['title', 'author', 'series', 'serno']) {
            if (utils.hasProp(override, field))
                book[field] = override[field];
        }
        book.metadataOverridden = true;
        book.metadataOverrideUpdatedAt = override.updatedAt || '';
        return book;
    }

    applyMetadataOverridesToRows(rows = [], overrides = {}) {
        for (const row of (Array.isArray(rows) ? rows : [])) {
            this.applyMetadataOverrideToBook(row, overrides);
            if (Array.isArray(row.books))
                row.books.forEach((book) => this.applyMetadataOverrideToBook(book, overrides));
        }
    }

    applyPreparedBookSize(book, size) {
        if (!Number.isSafeInteger(size) || size <= 0)
            return;
        if (!utils.hasProp(book, 'inpxSize'))
            book.inpxSize = book.size;
        book.size = size;
    }

    async applyPreparedBookSizesToRows(rows = []) {
        const books = rows.flatMap(row => [row, ...(Array.isArray(row.books) ? row.books : [])])
            .filter(book => this.metadataBookUid(book));
        if (!books.length || !this.config.bookDir)
            return;
        const ids = Array.from(new Set(books.map(book => this.metadataBookUid(book))));
        const versions = new Map(books.map(book => [this.metadataBookUid(book), assetVersionFor(book.ext)]));
        const hashes = this.stateStore.getBookFiles(ids);
        const sizes = new Map();
        if (!this.preparedBookSizes)
            this.preparedBookSizes = new Map();
        for (const item of hashes) {
            if (typeof item.hash !== 'string' || !item.hash || path.basename(item.hash) !== item.hash)
                continue;
            const version = versions.get(item.id);
            let size = item.assetVersion === version ? item.size : 0;
            if (!Number.isSafeInteger(size) || size <= 0) {
                const key = JSON.stringify([item.id, item.hash, version]);
                if (!this.preparedBookSizes.has(key)) {
                    size = 0;
                    try {
                        const desc = await fs.readJson(path.join(this.config.bookDir, `${item.hash}.d.json`));
                        if (desc.assetVersion === version)
                            size = desc.size;
                    } catch (_) {
                        // A missing or old prepared cache must not break the catalog.
                    }
                    if (this.preparedBookSizes.size >= 1000)
                        this.preparedBookSizes.delete(this.preparedBookSizes.keys().next().value);
                    this.preparedBookSizes.set(key, size);
                }
                size = this.preparedBookSizes.get(key);
            }
            sizes.set(item.id, size);
        }
        for (const book of books)
            this.applyPreparedBookSize(book, sizes.get(this.metadataBookUid(book)));
    }

    async applyMetadataOverridesToSearchResult(result = {}) {
        const overrides = await this.readingListStore.getMetadataOverrides();
        this.applyMetadataOverridesToRows(result.found || [], overrides);
        this.applyMetadataOverridesToRows(result.books || [], overrides);
        await this.applyPreparedBookSizesToRows([...(result.found || []), ...(result.books || [])]);
        return result;
    }

    async getBookInfo(bookUid) {
        this.checkMyState();

        try {
            let bookInfo = await this.getBookLink(bookUid);
            const hash = path.basename(bookInfo.link);
            const bookFile = `${this.config.bookDir}/${hash}`;
            const bookFileInfo = `${bookFile}.i.json`;

            const found = await this.getBookRecordByUid(bookUid);
            if (!found)
                throw new Error(t('errors.fileNotFound'));
            const book = {...found};
            this.applyPreparedBookSize(book, bookInfo.size);
            const reviewState = await this.getReviewArchiveState(book.sourceLibDir);
            const refreshReviews = async(info) => {
                [info.reviews, info.libraryRating] = await Promise.all([
                    this.getBookReviews(book, reviewState), this.getBookLibraryRating(book, reviewState),
                ]);
                info.reviewSignature = reviewState.signature;
            };

            const restoreBookInfo = async(info) => {
                const result = {};

                result.book = book;
                result.cover = '';
                result.fb2 = false;
                result.contents = [];
                result.annotationMeta = null;
                result.reviews = [];
                result.infoVersion = bookInfoVersion;
                let parser = null;

                if (book.ext == 'fb2') {
                    const {fb2, cover, coverExt} = await this.fb2Helper.getDescAndCover(bookFile);
                    parser = fb2;
                    result.fb2 = fb2.rawNodes;
                    result.contents = this.extractFb2Contents(fb2);
                    result.annotationMeta = this.extractFb2AnnotationMeta(fb2);

                    if (cover) {
                        result.cover = `${this.config.bookPathStatic}/${hash}${coverExt}`;
                        await fs.writeFile(`${bookFile}${coverExt}`, cover);
                    }
                }

                await refreshReviews(result);

                Object.assign(info, result);

                await fs.writeFile(bookFileInfo, JSON.stringify(info));

                if (this.config.branch === 'development') {
                    await fs.writeFile(`${bookFile}.dev`, `${JSON.stringify(info, null, 2)}\n\n${parser ? parser.toString({format: true}) : ''}`);
                }
            };

            if (!await fs.pathExists(bookFileInfo)) {
                await restoreBookInfo(bookInfo);
            } else {
                await utils.touchFile(bookFileInfo);
                const info = await fs.readFile(bookFileInfo, 'utf-8');
                const tmpInfo = JSON.parse(info);

                //проверим существование файла обложки, восстановим если нету
                let coverFile = '';
                if (tmpInfo.cover)
                    coverFile = `${this.config.publicFilesDir}${tmpInfo.cover}`;

                if (book.id != tmpInfo.book.id || tmpInfo.infoVersion !== bookInfoVersion || (coverFile && !await fs.pathExists(coverFile))) {
                    await restoreBookInfo(bookInfo);
                } else {
                    bookInfo = tmpInfo;
                    bookInfo.book = book;
                    if (tmpInfo.reviewSignature !== reviewState.signature) {
                        await refreshReviews(bookInfo);
                        await fs.writeJson(bookFileInfo, bookInfo);
                    }
                }
            }

            const overrides = await this.readingListStore.getMetadataOverrides();
            if (bookInfo && bookInfo.book)
                this.applyMetadataOverrideToBook(bookInfo.book, overrides);

            return {bookInfo};
        } catch(e) {
            log(LM_ERR, `getBookInfo error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error(t('errors.fileNotFound'));
            throw e;
        }
    }

    async getInpxFile(params) {
        let data = null;
        if (params.inpxFileHash && this.inpxFileHash && params.inpxFileHash === this.inpxFileHash) {
            data = false;
        }

        if (data === null)
            data = await fs.readFile(this.config.inpxFile, 'base64');

        return {data};
    }

    logServerStats() {
        try {
            const memUsage = process.memoryUsage().rss/(1024*1024);//Mb
            let loadAvg = os.loadavg();
            loadAvg = loadAvg.map(v => v.toFixed(2));

            log(`Server stats [ memUsage: ${memUsage.toFixed(2)}MB, loadAvg: (${loadAvg.join(', ')}) ]`);
        } catch (e) {
            log(LM_ERR, e.message);
        }
    }
    
    async periodicLogServerStats() {
        if (!this.config.logServerStats)
            return;

        while (1) {// eslint-disable-line
            this.logServerStats();
            await utils.sleep(60*1000);
        }
    }

    async periodicCheckInpx() {
        const inpxCheckInterval = this.config.inpxCheckInterval;
        if (!inpxCheckInterval)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            try {
                while (this.myState != ssNormal)
                    await utils.sleep(1000);

                //пока идёт пересборка, БД ещё со старым хешем: проверим в следующий раз
                if (!this.dbLoad) {
                    if (this.remoteLib) {
                        await this.remoteLib.downloadInpxFile();
                    }

                    const newInpxHash = await this.inpxHashCreator.getHash();

                    const dbConfig = await this.dbConfig();
                    const currentInpxHash = (dbConfig.inpxHash ? dbConfig.inpxHash : '');

                    if (newInpxHash !== currentInpxHash) {
                        log('inpx file: changes found, recreating DB');
                        await this.recreateDb();
                    }
                }
            } catch(e) {
                log(LM_ERR, `periodicCheckInpx: ${e.message}`);
            }

            await utils.sleep(inpxCheckInterval*60*1000);
        }
    }

    async periodicWarmExternalDiscovery() {
        while (1) {// eslint-disable-line no-constant-condition
            while (this.myState != ssNormal)
                await utils.sleep(1000);

            await this.warmExternalDiscoveryShelves();
            await utils.sleep(externalWarmInterval);
        }
    }

    async periodicCheckNewRelease() {
        const checkReleaseLink = this.config.checkReleaseLink;
        if (!checkReleaseLink)
            return;
        const down = new FileDownloader(1024*1024);
        const channel = resolveReleaseChannel(this.config);
        const request = buildReleaseCheckRequest(checkReleaseLink, channel);
        if (!request)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            try {
                let release = await down.load(request.url);
                release = JSON.parse(release.toString());
                const latestRelease = pickReleaseFromPayload(release, channel);

                if (latestRelease && compareReleaseVersions(latestRelease.tag_name, this.config.version) > 0) {
                    this.config.latestVersion = latestRelease.tag_name;
                    this.config.latestReleaseLink = latestRelease.html_url || this.config.latestReleaseLink;
                } else {
                    this.config.latestVersion = '';
                }
            } catch(e) {
                log(LM_ERR, `periodicCheckNewRelease: ${e.message}`);
            }

            await utils.sleep(checkReleaseInterval);
        }
    }
}

// Parts kept in their own files; their methods run on the worker like the ones above.
Object.assign(WebWorker.prototype,
    require('./AdminBackup'), require('./AdminService'), require('./BookDelivery'), require('./CacheCleaner'),
    require('./LibraryAssets'), require('./ProfileSessions'),
    require('./discovery/ExternalShelf'), require('./discovery/PersonalShelves'));

module.exports = WebWorker;

