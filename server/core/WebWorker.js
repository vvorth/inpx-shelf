const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const _ = require('lodash');
const iconv = require('iconv-lite');
const axios = require('axios');

const ZipReader = require('./ZipReader');
const WorkerState = require('./WorkerState');//singleton
const CatalogSearch = require('./search/CatalogSearch');
const StateStore = require('./StateStore');
const InpxHashCreator = require('./InpxHashCreator');
const RemoteLib = require('./RemoteLib');//singleton
const FileDownloader = require('./FileDownloader');
const ReadingListStore = require('./ReadingListStore');
const {withFileTransaction} = require('./FilePersistence');
const sessionLifetime = require('./SessionLifetime');
const imageUtils = require('./ImageUtils');
const epubRestorer = require('./EpubRestorer');
const externalTools = require('./ExternalTools');
const libraryReviews = require('./LibraryReviews');
const bookAssets = require('./BookAssets');
const bookConverter = require('./BookConverter');
const runtimeMetrics = require('./RuntimeMetrics');

const asyncExit = new (require('./AsyncExit'))();
const appLogger = new (require('./AppLogger'))();//singleton
const log = appLogger.log;
const utils = require('./utils');
const genreTree = require('./genres');
const Fb2Helper = require('./fb2/Fb2Helper');
const ConfigManager = require('../config');
const {getEnabledLibrarySources} = require('./LibrarySources');
const i18n = require('./i18n');
const {t, msg} = i18n;
const {normalizeVersionTag, compareReleaseVersions} = require('../../shared/release');

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
const discoveryCacheTtl = 15*60*1000;//15 minutes
//наибольший срок обновления внешней витрины (externalTtlMinutes); записи без своего срока живут столько
const discoveryCacheMaxTtl = 10080*60*1000;
const personalDiscoveryCacheTtl = 10*60*1000;
const externalDiscoveryCacheVersion = 'v9';
const bookAssetVersion = 'fblibrary-assets-v5';
const fb2AssetVersion = 'fb2-encoding-v6';
const bookInfoVersion = 'fb2-encoding-v8';

function assetVersionFor(ext) {
    return String(ext || '').toLowerCase() === 'fb2' ? fb2AssetVersion : bookAssetVersion;
}

function cleanDirInterval(config) {
    const minutes = parseFloat(config.cacheCleanInterval);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return 0;

    return minutes*60*1000;
}

function cleanDirNextAlignedDelay(config, now = new Date()) {
    const interval = cleanDirInterval(config);
    if (!interval)
        return null;

    const date = now instanceof Date ? now : new Date(now);
    const localTime = date.getTime() - date.getTimezoneOffset()*60*1000;
    const remainder = ((localTime % interval) + interval) % interval;
    return Math.round(remainder === 0 ? 0 : interval - remainder);
}

function parseCronField(field, min, max, options = {}) {
    const text = String(field || '').trim().toLowerCase();
    const values = new Set();
    const aliases = options.aliases || {};
    const normalize = options.normalize || (value => value);
    const inputMin = options.inputMin === undefined ? min : options.inputMin;
    const inputMax = options.inputMax === undefined ? max : options.inputMax;
    const parseValue = (value) => {
        const normalized = aliases[String(value || '').toLowerCase()];
        const number = parseInt(normalized !== undefined ? normalized : value, 10);
        if (!Number.isFinite(number))
            throw new Error(t('errors.cronInvalidValue', {value}));

        if (number < inputMin || number > inputMax)
            throw new Error(t('errors.cronOutOfRange', {value}));

        return number;
    };

    if (!text)
        throw new Error(t('errors.cronEmptyField'));

    for (const token of text.split(',')) {
        const item = token.trim();
        if (!item)
            throw new Error(t('errors.cronEmptyValue'));

        const [rangeText, stepText] = item.split('/');
        const step = stepText === undefined ? 1 : parseInt(stepText, 10);
        if (!Number.isFinite(step) || step <= 0)
            throw new Error(t('errors.cronInvalidStep', {value: item}));

        let start;
        let end;
        if (rangeText === '*') {
            start = min;
            end = max;
        } else if (rangeText.includes('-')) {
            const parts = rangeText.split('-');
            if (parts.length !== 2)
                throw new Error(t('errors.cronInvalidRange', {value: item}));

            start = parseValue(parts[0]);
            end = parseValue(parts[1]);
        } else {
            start = parseValue(rangeText);
            end = start;
        }

        if (start > end)
            throw new Error(t('errors.cronInvalidRange', {value: item}));

        for (let value = start; value <= end; value += step) {
            const normalized = normalize(value);
            if (normalized < min || normalized > max)
                throw new Error(t('errors.cronOutOfRange', {value}));

            values.add(normalized);
        }
    }

    return values;
}

function parseCleanDirCron(schedule) {
    const fields = String(schedule || '').trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error(t('errors.cronFormat'));

    const monthAliases = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const weekAliases = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };

    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dayOfMonth: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12, {aliases: monthAliases}),
        dayOfWeek: parseCronField(fields[4], 0, 6, {
            aliases: weekAliases,
            inputMax: 7,
            normalize: value => value === 7 ? 0 : value,
        }),
        dayOfMonthAny: fields[2] === '*',
        dayOfWeekAny: fields[4] === '*',
    };
}

function cleanDirCronMatches(parsed, date) {
    if (!parsed.minute.has(date.getMinutes()) || !parsed.hour.has(date.getHours()) || !parsed.month.has(date.getMonth() + 1))
        return false;

    const dayOfMonthMatches = parsed.dayOfMonth.has(date.getDate());
    const dayOfWeekMatches = parsed.dayOfWeek.has(date.getDay());
    if (parsed.dayOfMonthAny && parsed.dayOfWeekAny)
        return true;
    if (parsed.dayOfMonthAny)
        return dayOfWeekMatches;
    if (parsed.dayOfWeekAny)
        return dayOfMonthMatches;

    return dayOfMonthMatches || dayOfWeekMatches;
}

function cleanDirNextCronDelay(schedule, now = new Date()) {
    const parsed = parseCleanDirCron(schedule);
    const current = now instanceof Date ? now : new Date(now);
    const candidate = new Date(current.getTime());
    candidate.setSeconds(0, 0);

    if (cleanDirCronMatches(parsed, candidate))
        return 0;

    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 366*24*60; i++) {
        if (cleanDirCronMatches(parsed, candidate))
            return Math.max(0, candidate.getTime() - current.getTime());

        candidate.setMinutes(candidate.getMinutes() + 1);
    }

    throw new Error(t('errors.cronNoNextRun'));
}

function cleanDirSchedule(config) {
    if (!utils.hasProp(config, 'cacheCleanSchedule'))
        return null;

    return String(config.cacheCleanSchedule || '').trim();
}

function cleanDirNextScheduledDelay(config, now = new Date()) {
    const schedule = cleanDirSchedule(config);
    if (schedule !== null)
        return schedule ? cleanDirNextCronDelay(schedule, now) : null;

    return cleanDirNextAlignedDelay(config, now);
}

function cleanDirMaxSize(value) {
    if (value === null || value === undefined || value === '')
        return null;

    const maxSize = Number(value);
    return (Number.isFinite(maxSize) && maxSize >= 0 ? maxSize : null);
}

// A book read to 99.9% or more counts as read, not in progress.
const READ_PERCENT = 0.999;

function isReadingInProgress(progress) {
    return !!progress && progress.hidden !== true && !((Number(progress.percent) || 0) >= READ_PERCENT);
}

function cleanDirTargetRatio(value) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio <= 0)
        return 0.8;

    return Math.max(0.1, Math.min(1, ratio));
}

function cleanDirTargetSize(maxSize, value, ratio) {
    const targetSize = cleanDirMaxSize(value);
    if (targetSize !== null)
        return Math.max(0, Math.min(maxSize, targetSize));

    return Math.floor(maxSize * cleanDirTargetRatio(ratio));
}

function getUserDisplayName(user = {}) {
    const name = String(user.name || '').trim();
    if (isAnonymousDefaultUser(user))
        return t('profiles.defaultAnonymousName');
    if (user.id === 'admin' && i18n.allTranslations('profiles.defaultAdminName').includes(name))
        return t('profiles.defaultAdminName');
    return name;
}

function isAnonymousDefaultUser(user = {}) {
    //имена профиля по умолчанию на любом языке (они сохраняются в данных при создании профиля)
    const defaultNames = i18n.allTranslations('profiles.defaultAnonymousName').concat(i18n.allTranslations('profiles.legacyMainName'));
    const name = String(user.name || '').trim();
    return user.id === 'default' && defaultNames.includes(name) && !user.login && !user.passwordHash;
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

function buildExternalFeedIdentity(item = {}) {
    const title = normalizeDiscoveryText(item.title || '');
    if (!title)
        return '';

    const author = normalizeAuthorText(item.author || '');
    return `${title}|${author || String(item.url || '').trim().toLowerCase()}`;
}

//Премии, у которых в Викиданных победители отмечены на самих произведениях.
//Русские премии (Большая книга, Русский Букер, НОС) там почти не заполнены.
const wikidataAwards = [
    {id: 'Q255032', label: 'discovery.award.hugo'},
    {id: 'Q266012', label: 'discovery.award.nebula'},
    {id: 'Q898527', label: 'discovery.award.worldFantasy'},
    {id: 'Q2576795', label: 'discovery.award.locus'},
    {id: 'Q708830', label: 'discovery.award.clarke'},
    {id: 'Q160082', label: 'discovery.award.booker'},
    {id: 'Q833633', label: 'discovery.award.pulitzer'},
    {id: 'Q187300', label: 'discovery.award.goncourt'},
];
const wikidataEntityUrl = 'https://www.wikidata.org/wiki/';
//столько книг клиент просит на первой странице вкладки (DiscoveryPage), такие полки готовятся заранее
const externalShelfPageSize = 24;
//столько книг полка отдаёт самое большее (все издания всех премий бывает больше)
const externalShelfMaxLimit = 480;
const externalWarmInterval = 60*60*1000;

//языки читателя для полки премий: пустой список - все языки
function readerLanguages(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(code => String(code || '').trim().toLowerCase())
        .filter(code => /^[a-z]{2,3}$/.test(code)))].sort().slice(0, 10);
}

function findWikidataAward(url = '') {
    return wikidataAwards.find(award => wikidataEntityUrl + award.id === String(url || '').trim()) || null;
}

function buildWikidataAwardsQuery() {
    const values = wikidataAwards.map(award => `wd:${award.id}`).join(' ');
    const label = (subject, name, lang) => `OPTIONAL { ${subject} rdfs:label ?${name} FILTER(LANG(?${name}) = "${lang}") }`;
    return `SELECT ?work (SAMPLE(?ru) AS ?titleRu) (SAMPLE(?en) AS ?titleEn)
        (GROUP_CONCAT(DISTINCT ?authorRuLabel; separator=", ") AS ?authorRu)
        (GROUP_CONCAT(DISTINCT ?authorEnLabel; separator=", ") AS ?authorEn)
        (GROUP_CONCAT(DISTINCT STRAFTER(STR(?award), "/entity/"); separator=" ") AS ?awards)
        (MAX(YEAR(?date)) AS ?year)
    WHERE {
        VALUES ?award { ${values} }
        ?work p:P166 ?statement. ?statement ps:P166 ?award.
        OPTIONAL { ?statement pq:P585 ?date }
        ?work wdt:P50 ?author.
        ${label('?work', 'ru', 'ru')} ${label('?work', 'en', 'en')}
        ${label('?author', 'authorRuLabel', 'ru')} ${label('?author', 'authorEnLabel', 'en')}
    } GROUP BY ?work ORDER BY DESC(?year)`;
}

//ответ SPARQL -> книги для сопоставления: русское название, английское - запасным вариантом
function parseWikidataAwardWinners(data = {}) {
    const value = (binding, name) => String(((binding || {})[name] || {}).value || '').trim();
    const result = [];
    for (const binding of (((data || {}).results || {}).bindings || [])) {
        const titleRu = value(binding, 'titleRu');
        const titleEn = value(binding, 'titleEn');
        const authorRu = value(binding, 'authorRu');
        const authorEn = value(binding, 'authorEn');
        const title = titleRu || titleEn;
        if (!title)
            continue;

        result.push({
            title,
            author: (titleRu ? authorRu || authorEn : authorEn || authorRu),
            //в библиотеке и английские издания часто записаны под русским именем автора («Киз Дэниел»)
            authors: [authorRu, authorEn].filter(Boolean).join(', '),
            url: value(binding, 'work').replace(/^https?:\/\/www\.wikidata\.org\/entity\//, wikidataEntityUrl),
            alternates: (titleRu && titleEn && titleEn !== titleRu
                ? [{title: titleEn, author: authorEn || authorRu, authors: [authorRu, authorEn].filter(Boolean).join(', ')}] : []),
            awards: value(binding, 'awards').split(' ').filter(Boolean),
        });
    }
    return result;
}

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

function decodeHtmlBuffer(data) {
    let text = iconv.decode(data, 'utf8');
    if (text.includes('\uFFFD'))
        text = iconv.decode(data, 'win1251');

        return text;
}

function decodeArchiveText(data) {
    let text = iconv.decode(data, 'utf8');
    if (text.includes('\uFFFD'))
        text = iconv.decode(data, 'win1251');

    return text;
}

function stripHtml(html) {
    return (html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAuthorText(value) {
    return stripHtml(value)
        .toLowerCase()
        .replace(/ё/g, 'е')//i18n-ignore: нормализация
        .replace(/[()[\]{}.,;:!?'"`«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDiscoveryText(value) {
    return stripHtml(value)
        .toLowerCase()
        .replace(/ё/g, 'е')//i18n-ignore: нормализация
        .replace(/&[a-z0-9#]+;/gi, ' ')
        .replace(/[^a-zа-я0-9]+/gi, ' ')//i18n-ignore: разбор данных
        .replace(/\s+/g, ' ')
        .trim();
}

function extractDiscoveryAuthorTokens(author = '') {
    return Array.from(new Set(
        normalizeDiscoveryText(author)
            .split(' ')
            .map(token => token.trim())
            .filter(token => token.length >= 3)
    ));
}

function flibraryAuthorHash(author) {
    return crypto.createHash('md5')
        .update((author || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase().trim(), 'utf8')
        .digest('hex');
}

function getAuthorArchiveEntryHash(entryName = '') {
    const normalized = String(entryName || '').replace(/\\/g, '/');
    const baseName = path.basename(normalized, path.extname(normalized)).toLowerCase();
    return /^[a-f0-9]{32}$/.test(baseName) ? baseName : '';
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

    getDiscoveryConfig(options = {}) {
        const discovery = Object.assign({
            enabled: true,
            shelfLimit: 8,
            externalSource: 'none',
            externalName: '',
            externalTtlMinutes: 1440,
            externalBrowseUrl: '',
        }, this.config.discovery || {}, this.sharedDiscoveryConfig || {}, options || {});

        discovery.enabled = (discovery.enabled !== false);
        discovery.shelfLimit = Math.max(1, Math.min(parseInt(discovery.shelfLimit, 10) || 8, 24));
        discovery.externalSource = String(discovery.externalSource || 'none').trim().toLowerCase();
        if (discovery.externalSource && discovery.externalSource !== 'none')
            discovery.externalSource = 'wikidata-awards';
        discovery.externalName = String(discovery.externalName || '').trim();
        discovery.externalTtlMinutes = Math.max(1440, Math.min(parseInt(discovery.externalTtlMinutes, 10) || 1440, 10080));
        discovery.externalBrowseUrl = (findWikidataAward(discovery.externalBrowseUrl) ? String(discovery.externalBrowseUrl).trim() : '');

        return discovery;
    }

    async getSharedDiscoveryConfig() {
        this.sharedDiscoveryConfig = await this.readingListStore.getSharedDiscoveryConfig();
        return _.cloneDeep(this.sharedDiscoveryConfig);
    }

    async getDiscoveryConfigForRequest(options = {}) {
        await this.getSharedDiscoveryConfig();
        const requestOptions = Object.assign({}, options || {});
        const hasAdminExternalOverrides = (
            Object.prototype.hasOwnProperty.call(requestOptions, 'externalSource')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalName')
            || Object.prototype.hasOwnProperty.call(requestOptions, 'externalTtlMinutes')
        );

        if (!hasAdminExternalOverrides)
            return this.getDiscoveryConfig(requestOptions);

        try {
            await this.requireAdmin(requestOptions.userId, requestOptions.profileAccessToken);
        } catch (e) {
            delete requestOptions.externalSource;
            delete requestOptions.externalName;
            delete requestOptions.externalTtlMinutes;
        }

        return this.getDiscoveryConfig(requestOptions);
    }

    async getDiscoveryDiskCache() {
        if (this.discoveryDiskCache)
            return this.discoveryDiskCache;

        this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        let cache = {};
        try {
            if (await fs.pathExists(this.discoveryDiskCacheFile))
                cache = JSON.parse(await fs.readFile(this.discoveryDiskCacheFile, 'utf8')) || {};
        } catch(e) {
            cache = {};
        }

        this.discoveryDiskCache = cache;
        return cache;
    }

    async saveDiscoveryDiskCache() {
        if (!this.discoveryDiskCacheFile)
            this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        await withFileTransaction(this.discoveryDiskCacheFile, () =>
            require('./FilePersistence').writeFileAtomic(this.discoveryDiskCacheFile, JSON.stringify(this.discoveryDiskCache || {})));
    }

    //Убирает просроченные записи и полки прежних библиотек (хеш INPX - второе поле ключа discovery:...)
    pruneDiscoveryCache(currentKey = '', now = Date.now()) {
        const libraryOf = key => (key.startsWith('discovery:') ? key.split(':')[1] : null);
        const library = libraryOf(currentKey);
        const stale = (key, entry) => !entry || now - entry.time >= (entry.ttl || discoveryCacheMaxTtl)
            || (library !== null && libraryOf(key) !== null && libraryOf(key) !== library);

        for (const [key, entry] of this.discoveryCache) {
            if (stale(key, entry))
                this.discoveryCache.delete(key);
        }
        const diskCache = this.discoveryDiskCache || {};
        for (const key of Object.keys(diskCache)) {
            if (stale(key, diskCache[key]))
                delete diskCache[key];
        }
    }

    async rememberPersistedDiscovery(key, loader, ttl = discoveryCacheTtl, options = {}) {
        const forceRefresh = !!(options && options.forceRefresh);
        const cached = this.discoveryCache.get(key);
        if (!forceRefresh && cached && Date.now() - cached.time < ttl)
            return _.cloneDeep(cached.value);

        const diskCache = await this.getDiscoveryDiskCache();
        const persisted = diskCache[key];
        if (!forceRefresh && persisted && Date.now() - persisted.time < ttl) {
            this.discoveryCache.set(key, {time: persisted.time, ttl: persisted.ttl, value: _.cloneDeep(persisted.value)});
            return _.cloneDeep(persisted.value);
        }

        //параллельный одинаковый запрос ждёт уже идущую загрузку
        if (!this.discoveryPending)
            this.discoveryPending = new Map();
        if (this.discoveryPending.has(key))
            return _.cloneDeep(await this.discoveryPending.get(key));

        const loading = loader();
        this.discoveryPending.set(key, loading);
        try {
            const value = await loading;
            const time = Date.now();
            this.pruneDiscoveryCache(key, time);
            this.discoveryCache.set(key, {time, ttl, value: _.cloneDeep(value)});
            diskCache[key] = {time, ttl, value: _.cloneDeep(value)};
            await this.saveDiscoveryDiskCache();
            return value;
        } catch(e) {
            const fallback = cached || persisted;
            if (fallback) {
                const value = _.cloneDeep(fallback.value);
                if (value && typeof(value) === 'object') {
                    value.discoveryStale = true;
                    value.discoveryRefreshError = e.message;
                }
                return value;
            }
            throw e;
        } finally {
            this.discoveryPending.delete(key);
        }
    }

    externalDiscoverySearchQueries(item = {}, limit = 32) {
        const title = String(item.title || '').trim();
        if (!title)
            return [];

        //книги, удалённые из библиотеки, не ищутся
        const baseQueries = [
            {title: `=${title}`, del: '0', limit},
            {title: `*${title.substring(0, 80)}`, del: '0', limit},
        ];
        const sources = getEnabledLibrarySources(this.config);
        if (sources.length <= 1)
            return baseQueries;

        return sources.flatMap((source) => baseQueries.map(query => Object.assign({}, query, {
            sourceId: source.id,
        })));
    }

    async findExternalDiscoveryCandidates(item = {}, limit = 32) {
        const found = [];
        const seen = new Set();
        for (const query of this.externalDiscoverySearchQueries(item, limit)) {
            const response = await this.bookSearch(query);
            for (const book of (response.found || [])) {
                const key = String(book._uid || book.id || '').trim();
                if (key && seen.has(key))
                    continue;
                if (key)
                    seen.add(key);
                found.push(book);
            }

            await utils.processLoop();
        }

        return found;
    }

    pickDiscoveryBookMatchV2(item, books = []) {
        const title = normalizeDiscoveryText(item.title || '');
        if (!title)
            return null;

        const authorTokens = extractDiscoveryAuthorTokens(item.authors || item.author || '');
        let best = null;
        let bestKind = '';
        let bestScore = -Infinity;
        const copies = [];

        for (const book of books) {
            const bookTitle = normalizeDiscoveryText(book.title || '');
            if (!bookTitle || book.del)
                continue;
            //пометка в скобках в конце («(роман)», «(novel)», «(сборник)») не делает книгу другой
            const sameTitle = (bookTitle === title
                || normalizeDiscoveryText(String(book.title || '').replace(/\s*\([^()]*\)\s*$/, '')) === title);

            let score = -Infinity;
            if (bookTitle === title) {
                score = 1000;
            } else if (bookTitle.startsWith(title) || title.startsWith(bookTitle)) {
                score = 700;
            } else if (bookTitle.includes(title) || title.includes(bookTitle)) {
                score = 450;
            } else {
                continue;
            }

            const bookAuthor = normalizeDiscoveryText(book.author || '');
            let authorScore = 0;
            for (const token of authorTokens) {
                if (bookAuthor.includes(token))
                    authorScore += 90;
            }

            //часть названия совпала, автор другой: это другая книга («The Everlasting» и «The Everlasting Story of Nory»)
            if (authorTokens.length && !authorScore && bookTitle !== title)
                continue;
            if (authorTokens.length && !authorScore)
                score -= 180;

            score += authorScore;
            if (String(book.ext || '').toLowerCase() === 'fb2')
                score += 12;
            score += parseInt(book.librate || '0', 10) || 0;

            const kind = (
                bookTitle === title && authorScore > 0 ? 'exact'
                    : (authorScore > 0 ? 'title-author'
                        : (bookTitle === title ? 'title' : 'title-partial'))
            );

            if (score > bestScore) {
                bestScore = score;
                best = book;
                bestKind = kind;
            }
            //переиздания: то же название и тот же автор; книги с названием, лишь содержащим это, - другие («Падение Гипериона»)
            if (sameTitle && (authorScore > 0 || !authorTokens.length))
                copies.push({book, score});
        }

        return (bestScore >= 450 ? {book: best, kind: bestKind, score: bestScore, copies} : null);
    }

    makeExternalDiscoveryPlaceholder(item = {}, index = 0) {
        const rawId = `${item.title || ''}|${item.author || ''}|${item.url || ''}|${index}`;
        const hash = crypto.createHash('md5').update(rawId, 'utf8').digest('hex');

        return {
            _uid: `external:${hash}`,
            id: `external-${hash.substring(0, 12)}`,
            title: String(item.title || '').trim(),
            author: String(item.author || '').trim(),
            series: '',
            serno: '',
            genre: '',
            ext: 'web',
            size: 0,
            date: '',
            librate: '',
            del: false,
            libid: '',
            file: '',
            discoveryUrl: String(item.url || '').trim(),
            discoveryMissingLocal: true,
        };
    }

    //каждый лауреат сопоставляется с библиотекой один раз для всех премий; книги ищутся по всем названиям
    //(русскому и английскому), и на полку идут все издания: страница оставит те, что на «Моих языках»
    async matchExternalItems(items = []) {
        const result = [];
        const seen = new Set();
        for (const [index, item] of items.entries()) {
            const externalKey = buildExternalFeedIdentity(item);
            if (externalKey && seen.has(externalKey))
                continue;
            if (externalKey)
                seen.add(externalKey);

            const found = new Map();
            for (const variant of [item, ...(item.alternates || [])]) {
                const match = this.pickDiscoveryBookMatchV2(variant, await this.findExternalDiscoveryCandidates(variant, 32));
                if (!match)
                    continue;
                //лучшее совпадение остаётся, даже если название совпало не полностью
                for (const copy of [{book: match.book, score: match.score}, ...match.copies]) {
                    if (!(found.has(copy.book._uid) && found.get(copy.book._uid).score >= copy.score))
                        found.set(copy.book._uid, copy);
                }
            }

            //названия в Викиданных русские и английские: такие издания идут первыми
            const rank = book => {
                const position = ['ru', 'en'].indexOf(String(book.lang || '').trim().toLowerCase());
                return (position < 0 ? 2 : position);
            };
            const books = [...found.values()]
                .sort((a, b) => (rank(a.book) - rank(b.book)) || (b.score - a.score))
                .map(copy => Object.assign({}, copy.book, {discoveryUrl: item.url}));
            result.push({
                awards: item.awards || [],
                books: (books.length ? books : [this.makeExternalDiscoveryPlaceholder(item, index)]),
            });
            await utils.processLoop();
        }
        return {items: result};
    }

    async fetchWikidataAwardWinners(discovery = {}) {
        try {
            const response = await axios.get('https://query.wikidata.org/sparql', {
                params: {query: buildWikidataAwardsQuery()},
                timeout: 60000,
                headers: {
                    //Викиданные требуют User-Agent с контактом
                    'User-Agent': `${this.config.name}/${this.config.version} (https://github.com/vvorth/inpx-shelf)`,
                    'Accept': 'application/sparql-results+json',
                },
            });
            const items = parseWikidataAwardWinners(response.data);
            if (!items.length)
                throw new Error(t('errors.externalReadFailed'));
            return {items};
        } catch (e) {
            const details = String(e && e.message || '').trim();
            const suffix = details ? `: ${details}` : '';
            throw new Error(t('errors.externalUpdateFailed', {name: discovery.externalName || t('discovery.externalSource'), details: suffix}));
        }
    }

    //лауреаты всех премий загружаются одним запросом раз в период обновления витрины
    async getWikidataAwardWinners(discovery = {}, forceRefresh = false) {
        return this.rememberPersistedDiscovery(
            `wikidata-awards:${externalDiscoveryCacheVersion}`,
            () => this.fetchWikidataAwardWinners(discovery),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
    }

    async getWikidataAwardMatches(discovery = {}, forceRefresh = false) {
        const inpxHash = String((await this.dbConfig()).inpxHash || '');
        return this.rememberPersistedDiscovery(
            `wikidata-matches:${inpxHash}:${externalDiscoveryCacheVersion}`,
            async() => this.matchExternalItems((await this.getWikidataAwardWinners(discovery, forceRefresh)).items),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
    }

    async buildExternalDiscoveryShelfV2(limit = 8, discovery = {}, forceRefresh = false) {
        if (discovery.externalSource === 'none')
            return null;

        const award = findWikidataAward(discovery.externalBrowseUrl);
        //издания на других языках отбрасываются до деления на страницы: иначе страница почти пустая
        const languages = readerLanguages(discovery.externalLanguages);
        const readable = book => (!languages.length || !book.lang || languages.includes(String(book.lang).trim().toLowerCase()));
        const {items: matches} = await this.getWikidataAwardMatches(discovery, forceRefresh);
        //сначала книги из библиотеки (новые премии первыми), лауреаты, которых в ней нет, - в конце
        const local = [];
        const missing = [];
        const seenBookUids = new Set();
        let inLibrary = 0;
        for (const {awards, books} of matches) {
            if (award && !awards.includes(award.id))
                continue;
            if (books[0].discoveryMissingLocal) {
                missing.push(books[0]);
                continue;
            }
            const copies = books.filter(readable);
            if (!copies.length)
                continue;
            inLibrary++;
            for (const book of copies) {
                if (!seenBookUids.has(book._uid)) {
                    seenBookUids.add(book._uid);
                    local.push(book);
                }
            }
        }
        const books = local.concat(missing);
        const sourceName = (discovery.externalName || msg('discovery.externalSource'));
        const libraryCounts = {inLibrary, notInLibrary: missing.length};

        return {
            id: 'external-source',
            title: sourceName,
            subtitle: (award
                ? msg('discovery.shelf.externalGenreCounts', {genre: msg(award.label), ...libraryCounts})
                : msg('discovery.shelf.externalCounts', libraryCounts)),
            source: 'external',
            sourceName,
            sourceUrl: (award ? wikidataEntityUrl + award.id : ''),
            updatedAt: Date.now(),
            discoveryStale: false,
            discoveryHasMore: books.length > limit,
            genreOptions: wikidataAwards.map(item => ({label: msg(item.label), value: wikidataEntityUrl + item.id})),
            items: books.slice(0, limit),
            emptyMessage: msg('discovery.shelf.externalEmpty'),
        };
    }

    async rememberExternalDiscoveryShelf(inpxHash = '', discovery = {}, limit = externalShelfPageSize, forceRefresh = false) {
        //полка кешируется целыми страницами клиента: любой размер не даёт своего ключа
        const pageLimit = Math.ceil(limit / externalShelfPageSize) * externalShelfPageSize;
        const shelf = await this.rememberPersistedDiscovery(
            `discovery:${inpxHash}:external:${externalDiscoveryCacheVersion}:${discovery.externalSource}:${discovery.externalName}:${pageLimit}:${discovery.externalBrowseUrl}:${discovery.externalTtlMinutes}:${readerLanguages(discovery.externalLanguages).join(',')}`,
            () => this.buildExternalDiscoveryShelfV2(pageLimit, discovery, forceRefresh),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
        if (shelf && Array.isArray(shelf.items) && shelf.items.length > limit)
            Object.assign(shelf, {items: shelf.items.slice(0, limit), discoveryHasMore: true});
        return shelf;
    }

    //готовит первую страницу всех премий заранее, чтобы выбор премии открывался сразу;
    //готовые и свежие полки берутся из кеша, поэтому повторный вызов ничего не делает
    async warmExternalDiscoveryShelves() {
        if (this.externalDiscoveryWarming)
            return;
        this.externalDiscoveryWarming = true;
        try {
            await this.getSharedDiscoveryConfig();
            const shared = this.getDiscoveryConfig();
            if (!shared.enabled || shared.externalSource === 'none')
                return;

            const inpxHash = String((await this.dbConfig()).inpxHash || '').trim();
            for (const browseUrl of ['', ...wikidataAwards.map(award => wikidataEntityUrl + award.id)])
                await this.rememberExternalDiscoveryShelf(inpxHash, this.getDiscoveryConfig({externalBrowseUrl: browseUrl}));
        } catch (e) {
            log(LM_ERR, `warmExternalDiscoveryShelves: ${e.message}`);
        } finally {
            this.externalDiscoveryWarming = false;
        }
    }

    async getDiscoveryShelvesV2(options = {}) {
        this.checkMyState();

        const discovery = await this.getDiscoveryConfigForRequest(options);
        if (!discovery.enabled)
            return {shelves: []};

        const externalShelfLimit = Math.max(1, Math.min(parseInt(options.externalLimit, 10) || discovery.shelfLimit, externalShelfMaxLimit));
        const personalShelfLimit = Math.max(1, Math.min(parseInt(options.personalLimit, 10) || discovery.shelfLimit, 24));
        const personalSimilarLimit = Math.max(personalShelfLimit, Math.min(parseInt(options.personalSimilarLimit, 10) || Math.max(personalShelfLimit, 16), 96));
        //главная просит только персональные полки, внешняя витрина - только свою
        const section = String(options.section || '');

        const dbConfig = await this.dbConfig();
        const inpxHash = String(dbConfig.inpxHash || '').trim();
        const shelves = [];

        if (section !== 'external') {
            for (const shelf of await this.getPersonalDiscoveryShelvesV2(options.userId, options.profileAccessToken, personalShelfLimit, Object.assign({}, options, {personalSimilarLimit}))) {
                if (shelf)
                    shelves.push(shelf);
            }
        }

        if (section !== 'personal' && discovery.externalSource !== 'none') {
            try {
                //заново загрузить Викиданные и сопоставить книги может только админ, остальным - из кеша
                const forceRefresh = options.forceRefresh === true
                    && await this.requireAdmin(options.userId, options.profileAccessToken).then(() => true, () => false);
                const externalShelf = await this.rememberExternalDiscoveryShelf(inpxHash, discovery, externalShelfLimit, forceRefresh);
                if (externalShelf)
                    shelves.push(externalShelf);
                this.warmExternalDiscoveryShelves();//no await
            } catch (e) {
                shelves.push({
                    id: 'external-error',
                    title: (discovery.externalName || msg('discovery.externalSource')),
                    subtitle: msg('discovery.shelf.externalUnavailable'),
                    source: 'external',
                    sourceName: (discovery.externalName || msg('discovery.externalSource')),
                    items: [],
                    emptyMessage: e.message,
                });
            }
        }

        return {shelves};
    }


    getPersonalReadBookSet(user = null, lists = []) {
        const readBookUids = new Set();
        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});

        for (const [bookUid, progress] of Object.entries(progressMap)) {
            if ((Number(progress && progress.percent || 0) || 0) >= 0.999)
                readBookUids.add(String(bookUid || '').trim());
        }

        for (const list of (Array.isArray(lists) ? lists : [])) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                if (entry.read)
                    readBookUids.add(String(entry.bookUid || '').trim());
            }
        }

        return readBookUids;
    }

    async buildContinueReadingShelfV2(user = null, limit = 8, context = null) {
        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, []));

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: ''}, progress || {}),
            }))
            .filter((item) => item.bookUid && item.progress.hidden !== true && Number(item.progress.percent || 0) < 0.999)
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')));

        const items = [];
        let updatedAt = 0;

        for (const item of rows) {
            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            items.push(Object.assign({}, book, {
                discoveryRead: readBookUids.has(item.bookUid),
            }));

            updatedAt = Math.max(updatedAt, Date.parse(String(item.progress.updatedAt || '')) || 0);
            if (items.length >= limit)
                break;
        }

        return {
            id: 'continue-reading',
            title: msg('discovery.shelf.continueReading'),
            subtitle: msg('discovery.shelf.continueReadingSubtitle'),
            source: 'personal',
            sourceName: msg('discovery.sourceForYou'),
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: msg('discovery.shelf.continueReadingEmpty'),
        };
    }

    async buildFromReadingListsShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id) {
            return {
                id: 'from-your-lists',
                title: msg('discovery.shelf.fromLists'),
                subtitle: msg('discovery.shelf.fromListsUnreadSubtitle'),
                source: 'personal',
                sourceName: msg('discovery.sourceForYou'),
                updatedAt: Date.now(),
                items: [],
                emptyMessage: msg('discovery.shelf.selectProfileFirst'),
            };
        }

        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, lists));
        const candidates = [];
        let updatedAt = 0;

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            const listUpdatedAt = Date.parse(String(list.updatedAt || list.createdAt || '')) || 0;
            updatedAt = Math.max(updatedAt, listUpdatedAt);

            entries.forEach((entry, index) => {
                candidates.push({
                    bookUid: entry.bookUid,
                    read: !!entry.read,
                    updatedAt: String(list.updatedAt || list.createdAt || ''),
                    order: index,
                });
            });
        }

        candidates.sort((a, b) => {
            if (a.read != b.read)
                return (a.read ? 1 : -1);

            const updatedCmp = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
            if (updatedCmp)
                return updatedCmp;

            return a.order - b.order;
        });

        const items = [];
        const seenBookUids = new Set();

        for (const item of candidates) {
            if (!item.bookUid || seenBookUids.has(item.bookUid))
                continue;

            const book = await this.getBookRecordByUid(item.bookUid);
            if (!book)
                continue;

            seenBookUids.add(item.bookUid);
            items.push(Object.assign({}, book, {
                discoveryRead: (item.read || readBookUids.has(item.bookUid)),
            }));

            if (items.length >= limit)
                break;
        }

        return {
            id: 'from-your-lists',
            title: msg('discovery.shelf.fromLists'),
            subtitle: msg('discovery.shelf.fromListsSubtitle'),
            source: 'personal',
            sourceName: msg('discovery.sourceForYou'),
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: msg('discovery.shelf.fromListsEmpty'),
        };
    }

    async buildUnfinishedSeriesShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id) {
            return {
                id: 'unfinished-series',
                title: msg('discovery.shelf.unfinishedSeries'),
                subtitle: msg('discovery.shelf.unfinishedSeriesSubtitle'),
                source: 'personal',
                sourceName: msg('discovery.sourceForYou'),
                updatedAt: Date.now(),
                items: [],
                emptyMessage: msg('discovery.shelf.selectProfileFirst'),
            };
        }

        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? new Set(context.readBookUids) : new Set());
        const seriesState = new Map();
        const booksByUid = await this.getBookRecordsByUids([
            ...Object.keys(progressMap),
            ...lists.flatMap(list => this.readingListStore.normalizeEntries(list.books).filter(entry => entry.read).map(entry => entry.bookUid)),
        ]);

        for (const [bookUid, progress] of Object.entries(progressMap)) {
            const book = booksByUid.get(String(bookUid || '').trim());
            if (!book || !book.series || !book.serno)
                continue;

            const key = String(book.series || '').trim().toLowerCase();
            const current = seriesState.get(key) || {
                series: book.series,
                maxSerno: 0,
                updatedAt: '',
                lastTitle: '',
            };

            if (Number(book.serno || 0) >= current.maxSerno) {
                current.maxSerno = Number(book.serno || 0);
                current.updatedAt = String(progress && progress.updatedAt || current.updatedAt || '');
                current.lastTitle = String(book.title || current.lastTitle || '');
            }

            readBookUids.add(bookUid);
            seriesState.set(key, current);
        }

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            for (const entry of entries) {
                if (!entry.read)
                    continue;

                readBookUids.add(entry.bookUid);
                const book = booksByUid.get(entry.bookUid);
                if (!book || !book.series || !book.serno)
                    continue;

                const key = String(book.series || '').trim().toLowerCase();
                const current = seriesState.get(key) || {
                    series: book.series,
                    maxSerno: 0,
                    updatedAt: '',
                    lastTitle: '',
                };

                if (Number(book.serno || 0) >= current.maxSerno) {
                    current.maxSerno = Number(book.serno || 0);
                    current.updatedAt = String(list.updatedAt || list.createdAt || current.updatedAt || '');
                    current.lastTitle = String(book.title || current.lastTitle || '');
                }

                seriesState.set(key, current);
            }
        }

        const candidates = Array.from(seriesState.values())
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

        const items = [];
        const seenBookUids = new Set();
        let updatedAt = 0;

        for (const state of candidates) {
            const response = await this.getSeriesBookList(state.series);
            const books = Array.isArray(response && response.books) ? response.books : [];
            const nextBook = books
                .filter((book) => book && book.series && Number(book.serno || 0) > Number(state.maxSerno || 0))
                .sort((a, b) => {
                    const sernoCmp = Number(a.serno || 0) - Number(b.serno || 0);
                    if (sernoCmp)
                        return sernoCmp;
                    return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
                })
                .find((book) => book && book._uid && !readBookUids.has(book._uid) && !seenBookUids.has(book._uid));

            if (!nextBook)
                continue;

            seenBookUids.add(nextBook._uid);
            items.push(Object.assign({}, nextBook, {
                discoveryRead: false,
            }));

            updatedAt = Math.max(updatedAt, Date.parse(String(state.updatedAt || '')) || 0);
            if (items.length >= limit)
                break;
        }

        return {
            id: 'unfinished-series',
            title: msg('discovery.shelf.unfinishedSeries'),
            subtitle: msg('discovery.shelf.unfinishedSeriesSubtitle'),
            source: 'personal',
            sourceName: msg('discovery.sourceForYou'),
            updatedAt: updatedAt || Date.now(),
            items,
            emptyMessage: msg('discovery.shelf.unfinishedSeriesEmpty'),
        };
    }

    getPersonalDiscoveryFeatureKeys(value = '', separator = ',') {
        const expression = (separator === 'keywords' ? /[,;|]/ : /,/);
        return Array.from(new Set(
            String(value || '')
                .split(expression)
                .map(item => item.trim().toLowerCase())
                .filter(item => item.length >= (separator === 'keywords' ? 3 : 1))
        ));
    }

    getPersonalDiscoveryProgressWeight(percentValue = 0) {
        const percent = Math.max(0, Math.min(1, Number(percentValue) || 0));
        if (percent < 0.03)
            return 0;
        if (percent < 0.1)
            return 0.25;
        if (percent < 0.5)
            return 1;
        if (percent < 0.95)
            return 2;
        return 3.5;
    }

    async buildPersonalDiscoveryTasteProfile(user = null, context = null) {
        const progressMap = (context && context.progressMap
            ? context.progressMap
            : (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}));
        const lists = (context && Array.isArray(context.lists)
            ? context.lists
            : (user && user.id ? await this.readingListStore.getLists(user.id, {}) : []));
        const discoveryPreferences = (user && user.discoveryPreferences && typeof(user.discoveryPreferences) === 'object'
            ? user.discoveryPreferences
            : {});
        const discoveryEvents = (discoveryPreferences.events && typeof(discoveryPreferences.events) === 'object'
            ? discoveryPreferences.events
            : {});
        const tasteValue = (discoveryPreferences.taste && typeof(discoveryPreferences.taste) === 'object'
            ? discoveryPreferences.taste
            : {});
        const normalizeTasteList = (items, maxItems = 20) => Array.from(new Set(
            (Array.isArray(items) ? items : [])
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
        )).slice(0, maxItems);
        const taste = {
            genres: normalizeTasteList(tasteValue.genres).map(item => item.toLowerCase()),
            authors: normalizeTasteList(tasteValue.authors),
            languages: normalizeTasteList(tasteValue.languages, 10).map(item => item.toLowerCase()),
            explorationRatio: Math.max(0.1, Math.min(0.3, Number(tasteValue.explorationRatio) || 0.15)),
            completedAt: String(tasteValue.completedAt || '').trim(),
            promptDismissedAt: String(tasteValue.promptDismissedAt || '').trim(),
            updatedAt: String(tasteValue.updatedAt || '').trim(),
        };
        const profile = {
            authorWeights: new Map(),
            seriesWeights: new Map(),
            genreWeights: new Map(),
            keywordWeights: new Map(),
            languageWeights: new Map(),
            discoveryEvents,
            taste,
            explicitTasteAuthors: new Set(taste.authors.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)),
            explicitTasteGenres: new Set(taste.genres),
            explicitTasteLanguages: new Set(taste.languages),
            knownBookUids: new Set(),
            signalCount: 0,
            updatedAt: 0,
        };
        const signals = new Map();
        const bookCache = new Map();
        const loadBook = async(bookUid = '') => {
            const normalizedBookUid = String(bookUid || '').trim();
            if (!normalizedBookUid)
                return null;
            if (!bookCache.has(normalizedBookUid))
                bookCache.set(normalizedBookUid, await this.getBookRecordByUid(normalizedBookUid));
            return bookCache.get(normalizedBookUid);
        };
        const addWeight = (map, key, amount) => {
            const normalizedKey = String(key || '').trim().toLowerCase();
            if (!normalizedKey || !Number(amount))
                return;
            map.set(normalizedKey, (map.get(normalizedKey) || 0) + Number(amount));
        };
        const rememberSignal = (bookUid = '', amount = 0, stamp = '') => {
            const normalizedBookUid = String(bookUid || '').trim();
            if (!normalizedBookUid)
                return;
            profile.knownBookUids.add(normalizedBookUid);
            if (!Number(amount))
                return;

            const current = signals.get(normalizedBookUid) || {amount: 0, stamp: ''};
            current.amount = Math.min(4.5, current.amount + Number(amount));
            if (String(stamp || '').localeCompare(String(current.stamp || '')) > 0)
                current.stamp = String(stamp || '');
            signals.set(normalizedBookUid, current);
        };
        const getRecencyMultiplier = (stamp = '') => {
            const time = Date.parse(String(stamp || '')) || 0;
            if (!time)
                return 1;
            const ageDays = Math.max(0, Math.floor((Date.now() - time) / 86400000));
            if (ageDays <= 7)
                return 1.45;
            if (ageDays <= 30)
                return 1.25;
            if (ageDays <= 90)
                return 1.1;
            return 1;
        };
        const applyPositiveBook = (book, signal = {}) => {
            if (!book)
                return;
            const weightedAmount = Number(signal.amount || 0) * getRecencyMultiplier(signal.stamp);
            addWeight(profile.authorWeights, book.author, 2.2 * weightedAmount);
            addWeight(profile.seriesWeights, book.series, 1.2 * weightedAmount);
            this.getPersonalDiscoveryFeatureKeys(book.genre)
                .forEach(genre => addWeight(profile.genreWeights, genre, 1.8 * weightedAmount));
            this.getPersonalDiscoveryFeatureKeys(book.keywords, 'keywords')
                .forEach(keyword => addWeight(profile.keywordWeights, keyword, 1.4 * weightedAmount));
            addWeight(profile.languageWeights, book.lang, 0.25 * weightedAmount);
            profile.updatedAt = Math.max(profile.updatedAt, Date.parse(String(signal.stamp || '')) || 0);
        };
        for (const [bookUid, progress] of Object.entries(progressMap)) {
            const normalizedBookUid = String(bookUid || '').trim();
            profile.knownBookUids.add(normalizedBookUid);
            if (!progress || progress.hidden === true)
                continue;
            rememberSignal(
                normalizedBookUid,
                this.getPersonalDiscoveryProgressWeight(progress.percent),
                progress.updatedAt,
            );
        }

        for (const list of lists) {
            for (const entry of this.readingListStore.normalizeEntries(list.books)) {
                rememberSignal(
                    entry.bookUid,
                    (entry.read ? 2.5 : 0.8),
                    list.updatedAt || list.createdAt,
                );
            }
        }

        for (const [bookUid, item] of Object.entries(discoveryEvents)) {
            if ((Number(item && item.startCount) || 0) > 0)
                profile.knownBookUids.add(String(bookUid || '').trim());
        }

        for (const [bookUid, signal] of signals)
            applyPositiveBook(await loadBook(bookUid), signal);
        profile.signalCount = signals.size;

        taste.authors.forEach(author => addWeight(profile.authorWeights, author, 5));
        taste.genres.forEach(genre => addWeight(profile.genreWeights, genre, 4));
        taste.languages.forEach(language => addWeight(profile.languageWeights, language, 2));
        profile.updatedAt = Math.max(profile.updatedAt, Date.parse(String(taste.updatedAt || taste.completedAt || '')) || 0);

        return profile;
    }

    scorePersonalDiscoveryCandidate(book = {}, profile = {}, rotationSeed = 0) {
        const getWeight = (map, key) => {
            const normalizedKey = String(key || '').trim().toLowerCase();
            if (!normalizedKey)
                return 0;
            return Number(map instanceof Map ? map.get(normalizedKey) : (map || {})[normalizedKey]) || 0;
        };
        const authorKey = String(book.author || '').trim().toLowerCase();
        const seriesKey = String(book.series || '').trim().toLowerCase();
        const genreKeys = this.getPersonalDiscoveryFeatureKeys(book.genre);
        const keywordKeys = this.getPersonalDiscoveryFeatureKeys(book.keywords, 'keywords');
        const languageKey = String(book.lang || '').trim().toLowerCase();
        const bookUid = String(book._uid || book.bookUid || '').trim();
        let contentScore = 0;

        contentScore += getWeight(profile.authorWeights, authorKey) * 32;
        contentScore += getWeight(profile.seriesWeights, seriesKey) * 36;
        genreKeys.forEach(key => contentScore += getWeight(profile.genreWeights, key) * 26);
        keywordKeys.forEach(key => contentScore += getWeight(profile.keywordWeights, key) * 20);
        if (contentScore <= 0)
            return 0;

        let score = contentScore;
        score += Math.min(8, getWeight(profile.languageWeights, languageKey) * 2);

        const discoveryEvent = ((profile.discoveryEvents || {})[bookUid] || {});
        const impressionCount = Math.max(0, Number(discoveryEvent.impressionCount) || 0);
        const openCount = Math.max(0, Number(discoveryEvent.openCount) || 0);
        const lastShownTime = Date.parse(String(discoveryEvent.lastShownAt || ''));
        const shownAgeDays = Number.isFinite(lastShownTime)
            ? Math.max(0, Math.floor((Date.now() - lastShownTime) / 86400000))
            : Number.MAX_SAFE_INTEGER;
        if (impressionCount >= 3 && openCount === 0 && shownAgeDays < 30)
            return 0;

        const ignoredImpressions = Math.max(0, impressionCount - Math.max(1, openCount * 2));
        score -= Math.min(50, ignoredImpressions * 10);
        if (impressionCount > 0 && shownAgeDays < 7)
            score -= 8;
        score += Math.min(12, openCount * 4);
        if (score <= 0)
            return 0;

        score += Math.max(0, Math.min(5, Number(book.librate) || 0)) * 4;
        const bookTime = Date.parse(String(book.date || ''));
        if (Number.isFinite(bookTime)) {
            const ageDays = Math.max(0, Math.floor((Date.now() - bookTime) / 86400000));
            score += Math.max(0, 12 - (Math.min(ageDays, 365) * 12 / 365));
        }

        const numericSeed = Number(rotationSeed) || 0;
        const stableHash = String(book._uid || book.id || '')
            .split('')
            .reduce((sum, char) => ((sum * 33) + char.charCodeAt(0) + numericSeed) % 9973, numericSeed);
        score += (stableHash / 9973) * 8;
        return score;
    }

    scorePersonalDiscoveryExplorationCandidate(book = {}, profile = {}, rotationSeed = 0) {
        const languageKey = String(book.lang || '').trim().toLowerCase();
        const bookUid = String(book._uid || book.bookUid || '').trim();

        const discoveryEvent = ((profile.discoveryEvents || {})[bookUid] || {});
        const impressionCount = Math.max(0, Number(discoveryEvent.impressionCount) || 0);
        const openCount = Math.max(0, Number(discoveryEvent.openCount) || 0);
        const lastShownTime = Date.parse(String(discoveryEvent.lastShownAt || ''));
        const shownAgeDays = Number.isFinite(lastShownTime)
            ? Math.max(0, Math.floor((Date.now() - lastShownTime) / 86400000))
            : Number.MAX_SAFE_INTEGER;
        if (impressionCount >= 3 && openCount === 0 && shownAgeDays < 30)
            return 0;

        let score = 22;
        score += Math.max(0, Math.min(5, Number(book.librate) || 0)) * 5;
        if (profile.explicitTasteLanguages instanceof Set && profile.explicitTasteLanguages.has(languageKey))
            score += 6;
        const bookTime = Date.parse(String(book.date || ''));
        if (Number.isFinite(bookTime)) {
            const ageDays = Math.max(0, Math.floor((Date.now() - bookTime) / 86400000));
            score += Math.max(0, 14 - (Math.min(ageDays, 730) * 14 / 730));
        }
        score -= Math.min(40, Math.max(0, impressionCount - Math.max(1, openCount * 2)) * 10);
        if (impressionCount > 0 && shownAgeDays < 7)
            score -= 8;
        score += Math.min(12, openCount * 4);

        const numericSeed = Number(rotationSeed) || 0;
        const stableHash = String(book._uid || book.id || '')
            .split('')
            .reduce((sum, char) => ((sum * 33) + char.charCodeAt(0) + numericSeed) % 9973, numericSeed);
        score += (stableHash / 9973) * 10;
        return Math.max(0, score);
    }

    //Кандидаты «Похожих» из индекса каталога: лучшие id по оценке, затем записи книг из основной БД.
    //null - БД библиотеки ещё строится.
    async similarCandidatesFromIndex(profile, weights, limit) {
        const catalog = this.catalogSearch;
        if (!catalog || !catalog.ready)
            return null;
        try {
            const known = profile.knownBookUids;
            const result = await catalog.similarCandidates(Object.assign({}, weights, {limit: limit + known.size, now: Date.now()}));
            const pick = async(list, explore) => {
                const scores = new Map(list.map(item => [item.id, item.score]));
                const books = await catalog.loadBooks(list.map(item => item.id));
                return books
                    .filter(book => book && !book.del && book.title && book._uid && !known.has(book._uid))
                    .slice(0, limit)
                    .map(book => Object.assign({}, book, {_similarityScore: scores.get(book.id), _discoveryExplore: explore}));
            };
            return (await pick(result.affinity, false)).concat(await pick(result.explore, true));
        } catch (e) {
            log(LM_WARN, `Similar books from catalog index: ${e.message}`);
            return null;
        }
    }

    async buildSimilarBooksShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id) {
            return {
                id: 'similar-books',
                title: msg('discovery.shelf.similar'),
                subtitle: msg('discovery.shelf.similarSubtitle'),
                source: 'personal',
                sourceName: msg('discovery.sourceForYou'),
                updatedAt: Date.now(),
                items: [],
                emptyMessage: msg('discovery.shelf.selectProfileFirst'),
            };
        }

        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user, lists));
        const profile = await this.buildPersonalDiscoveryTasteProfile(user, Object.assign({}, context || {}, {lists}));
        const preferredAuthors = Object.fromEntries(profile.authorWeights);
        const preferredSeries = Object.fromEntries(profile.seriesWeights);
        const preferredGenres = Object.fromEntries(profile.genreWeights);
        const preferredKeywords = Object.fromEntries(profile.keywordWeights);
        const preferredLanguages = Object.fromEntries(profile.languageWeights);
        const displayLimit = Math.max(1, Math.min(parseInt(limit, 10) || 8, 96));
        const probeLimit = displayLimit + 1;
        if (!Object.keys(preferredAuthors).length && !Object.keys(preferredSeries).length && !Object.keys(preferredGenres).length && !Object.keys(preferredKeywords).length && !Object.keys(preferredLanguages).length) {
            return {
                id: 'similar-books',
                title: msg('discovery.shelf.similar'),
                subtitle: msg('discovery.shelf.similarSubtitle'),
                source: 'personal',
                sourceName: msg('discovery.sourceForYou'),
                updatedAt: Date.now(),
                discoveryTaste: profile.taste,
                discoveryNeedsTasteSetup: !profile.taste.completedAt && !profile.taste.promptDismissedAt,
                items: [],
                emptyMessage: msg('discovery.shelf.similarEmptyNoProfile'),
            };
        }

        const rotationSeed = String(user.id || '')
            .split('')
            .reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) % 9973, Math.floor(Date.now() / 86400000));

        const candidateLimit = Math.max(probeLimit * 16 + 64, 192);
        //оценки считаются по колонкам БД библиотеки в её потоке; пока она строится, полка пуста
        let candidates = await this.similarCandidatesFromIndex(profile, {
            preferredAuthors, preferredSeries, preferredGenres, preferredKeywords, preferredLanguages, rotationSeed,
        }, candidateLimit);
        if (!candidates)
            candidates = [];

        const rawItems = candidates
            .map(book => Object.assign({}, book, {
                _similarityScore: (book._discoveryExplore
                    ? this.scorePersonalDiscoveryExplorationCandidate(book, profile, rotationSeed)
                    : this.scorePersonalDiscoveryCandidate(book, profile, rotationSeed)),
            }))
            .filter(book => book._similarityScore > 0);
        const items = [];
        const authorCounts = new Map();
        const seriesCounts = new Map();
        const genreCounts = new Map();
        const affinityRemaining = rawItems.filter(book => !book._discoveryExplore);
        const explorationRemaining = rawItems.filter(book => book._discoveryExplore);
        const explorationRatio = Math.max(0.1, Math.min(0.3, Number(profile.taste && profile.taste.explorationRatio) || 0.15));
        const desiredExplorationCount = Math.min(explorationRemaining.length, Math.max(1, Math.round(displayLimit * explorationRatio)));
        let explorationCount = 0;

        while ((affinityRemaining.length || explorationRemaining.length) && items.length < probeLimit) {
            const explorationDue = explorationCount < desiredExplorationCount
                && (items.length + 1) >= Math.ceil(((explorationCount + 1) * displayLimit) / desiredExplorationCount);
            let remaining = (explorationDue ? explorationRemaining : affinityRemaining);
            if (!remaining.length)
                remaining = (explorationDue ? affinityRemaining : explorationRemaining);
            let bestIndex = -1;
            let bestAdjustedScore = -Infinity;
            for (let index = 0; index < remaining.length; index++) {
                const candidate = remaining[index];
                const authorKey = String(candidate.author || '').trim().toLowerCase();
                const seriesKey = String(candidate.series || '').trim().toLowerCase();
                if (authorKey && (authorCounts.get(authorKey) || 0) >= 2)
                    continue;
                if (seriesKey && (seriesCounts.get(seriesKey) || 0) >= 1)
                    continue;

                const genrePenalty = this.getPersonalDiscoveryFeatureKeys(candidate.genre)
                    .reduce((sum, key) => sum + (genreCounts.get(key) || 0) * 10, 0);
                const adjustedScore = Number(candidate._similarityScore || 0)
                    - (authorKey ? (authorCounts.get(authorKey) || 0) * 35 : 0)
                    - (seriesKey ? (seriesCounts.get(seriesKey) || 0) * 60 : 0)
                    - genrePenalty;
                if (adjustedScore > bestAdjustedScore) {
                    bestAdjustedScore = adjustedScore;
                    bestIndex = index;
                }
            }
            if (bestIndex < 0)
                break;

            const [book] = remaining.splice(bestIndex, 1);
            const authorKey = String(book.author || '').trim().toLowerCase();
            const seriesKey = String(book.series || '').trim().toLowerCase();
            if (book._discoveryExplore)
                explorationCount++;

            items.push(Object.assign({}, book, {
                discoveryRead: readBookUids.has(String(book._uid || '').trim()),
            }));

            if (authorKey)
                authorCounts.set(authorKey, (authorCounts.get(authorKey) || 0) + 1);
            if (seriesKey)
                seriesCounts.set(seriesKey, (seriesCounts.get(seriesKey) || 0) + 1);
            this.getPersonalDiscoveryFeatureKeys(book.genre)
                .forEach(key => genreCounts.set(key, (genreCounts.get(key) || 0) + 1));
        }

        const hasMore = items.length > displayLimit;
        const visibleItems = items.slice(0, displayLimit);

        return {
            id: 'similar-books',
            title: msg('discovery.shelf.similar'),
            subtitle: msg('discovery.shelf.similarHistorySubtitle'),
            source: 'personal',
            sourceName: msg('discovery.sourceForYou'),
            updatedAt: profile.updatedAt || Date.now(),
            discoveryHasMore: hasMore,
            discoveryTaste: profile.taste,
            discoveryNeedsTasteSetup: !profile.taste.completedAt && !profile.taste.promptDismissedAt,
            discoveryExplorationRatio: explorationRatio,
            items: visibleItems,
            emptyMessage: msg('discovery.shelf.similarEmpty'),
        };
    }

    //Подпись данных, от которых зависят персональные полки. Показы (impression) не входят:
    //они пишутся при каждом открытии главной и сбрасывали бы кеш; их влияние обновится по TTL
    personalDiscoverySignature(user, lists, extra = {}) {
        const preferences = (user && user.discoveryPreferences) || {};
        const events = {};
        for (const [uid, event] of Object.entries(preferences.events || {}))
            events[uid] = [event.openCount || 0, event.startCount || 0];
        return crypto.createHash('md5').update(JSON.stringify([
            extra,
            (lists || []).map(list => [list.id, list.books]),
            user.readerProgress || {},
            preferences.taste || {},
            events,
        ])).digest('hex');
    }

    async getPersonalDiscoveryShelvesV2(userId = '', profileAccessToken = '', limit = 8, options = {}) {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId)
            return [];

        const user = await this.getEffectiveUser(normalizedUserId, profileAccessToken);
        if (!user)
            return [];

        if (user.passwordHash && this.getProfileSessionUser(profileAccessToken) !== user.id)
            return [];

        const lists = await this.readingListStore.getLists(user.id, {});
        const similarEnabled = !!(options && options.personalSimilarEnabled !== false);
        const similarLimit = Math.max(limit, Math.min(parseInt(options && options.personalSimilarLimit, 10) || Math.max(limit, 16), 96));
        const inpxHash = String((await this.dbConfig()).inpxHash || '');
        const signature = this.personalDiscoverySignature(user, lists, {limit, similarEnabled, similarLimit, inpxHash});

        //кеш на пользователя и одно построение за раз: одинаковые запросы ждут уже идущее
        if (!this.personalDiscoveryCache)
            this.personalDiscoveryCache = new Map();
        const cached = this.personalDiscoveryCache.get(user.id);
        if (cached && cached.signature === signature) {
            if (cached.pending)
                return _.cloneDeep(await cached.pending);
            if (!(options && options.forceRefresh === true) && Date.now() - cached.time < personalDiscoveryCacheTtl)
                return _.cloneDeep(cached.value);
        }

        const entry = {signature, time: 0, value: null, pending: null};
        entry.pending = this.buildPersonalDiscoveryShelvesV2(user, lists, limit, similarEnabled, similarLimit);
        this.personalDiscoveryCache.set(user.id, entry);
        try {
            entry.value = await entry.pending;
            entry.time = Date.now();
            return _.cloneDeep(entry.value);
        } catch (e) {
            if (this.personalDiscoveryCache.get(user.id) === entry)
                this.personalDiscoveryCache.delete(user.id);
            throw e;
        } finally {
            entry.pending = null;
        }
    }

    async buildPersonalDiscoveryShelvesV2(user, lists, limit, similarEnabled, similarLimit) {
        const context = {
            lists,
            progressMap: (user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {}),
            readBookUids: this.getPersonalReadBookSet(user, lists),
        };

        const shelves = [
            await this.buildContinueReadingShelfV2(user, limit, context),
            await this.buildFromReadingListsShelfV2(user, limit, context),
            await this.buildUnfinishedSeriesShelfV2(user, limit, context),
        ];

        if (similarEnabled)
            shelves.push(await this.buildSimilarBooksShelfV2(user, similarLimit, context));

        return shelves;
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
        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {});
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

    async getAuthorizedUserOrNull(userId = '', profileAccessToken = '') {
        const user = await this.getEffectiveUser(userId, profileAccessToken);
        if (!user || isAnonymousDefaultUser(user))
            return null;
        if (user.passwordHash && this.getProfileSessionUser(profileAccessToken) !== user.id)
            return null;
        return user;
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
        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: '', hidden: false}, progress || {}),
            }))
            .filter((item) => item.bookUid && isReadingInProgress(item.progress))
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')))
            .slice(0, Math.max(0, limit));

        const result = [];
        for (const item of rows) {
            const book = await this.getBookRecordByUid(item.bookUid);
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

        const progressMap = (user && user.readerProgress && typeof(user.readerProgress) === 'object'
            ? user.readerProgress
            : {});
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

    async getUserProfiles(currentUserId = '') {
        this.checkMyState();

        const {users, currentUser} = await this.readingListStore.getUsers(currentUserId);
        return {
            users: users
                .map((item) => ({
                    id: item.id,
                    name: getUserDisplayName(item),
                    login: item.login || '',
                    requiresLogin: !!item.passwordHash,
                    anonymousProfile: isAnonymousDefaultUser(item),
                    isAdmin: !!item.isAdmin,
                    opdsEnabled: item.opdsEnabled !== false,
                    opdsAuthEnabled: item.opdsAuthEnabled === true,
                    currentReadingCount: Object.values(item.readerProgress || {}).filter(isReadingInProgress).length,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                }))
                .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
            currentUserId: (currentUser ? currentUser.id : ''),
        };
    }

    hashProfilePassword(login, password) {
        return require('./ProfilePassword').hash(password);
    }

    createProfileSession(userId) {
        sessionLifetime.makeRoom(this.profileSessions);
        const token = utils.randomHexString(24);
        this.profileSessions.set(token, {
            userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        return token;
    }

    getProfileSessionUser(token = '') {
        const rec = this.profileSessions.get(String(token || '').trim());
        if (sessionLifetime.expired(rec)) {
            this.profileSessions.delete(String(token || '').trim());
            return '';
        }

        rec.updatedAt = Date.now();
        return rec.userId || '';
    }

    closeProfileSession(token = '') {
        this.profileSessions.delete(String(token || '').trim());
        return {success: true};
    }

    async getEffectiveUser(userId = '', profileAccessToken = '') {
        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (sessionUserId)
            return await this.readingListStore.getUser(sessionUserId);

        return await this.readingListStore.getUser(userId);
    }

    async requireAuthorizedUser(userId = '', profileAccessToken = '') {
        const requestedUser = await this.readingListStore.getUser(userId);
        if (!requestedUser.passwordHash)
            return requestedUser;

        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (!sessionUserId || sessionUserId !== requestedUser.id)
            throw new Error('need_profile_login');

        return requestedUser;
    }

    async requireAdmin(userId = '', profileAccessToken = '') {
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        if (!user.isAdmin)
            throw new Error(t('errors.adminOnlyProfiles'));
        return user;
    }

    async getCurrentUserProfile(userId = '', profileAccessToken = '') {
        this.checkMyState();

        const user = await this.getEffectiveUser(userId, profileAccessToken);
        const anonymousProfile = isAnonymousDefaultUser(user);
        const profileAuthorized = (!anonymousProfile && (!user.passwordHash || this.getProfileSessionUser(profileAccessToken) === user.id));
        const readingSummary = (profileAuthorized ? await this.buildUserReadingSummary(user, 48) : {count: 0, items: []});
        return {
            currentUserId: user.id,
            profileAuthorized,
            currentUserProfile: {
                id: user.id,
                name: getUserDisplayName(user),
                login: user.login || '',
                hasPassword: !!user.passwordHash,
                anonymousProfile,
                isAdmin: !!user.isAdmin,
                emailTo: (profileAuthorized ? user.emailTo || '' : ''),
                telegramChatId: (profileAuthorized ? user.telegramChatId || '' : ''),
                opdsEnabled: user.opdsEnabled !== false,
                opdsAuthEnabled: user.opdsAuthEnabled === true,
                readerPreferences: (profileAuthorized ? this.readingListStore.normalizeReaderPreferences(user.readerPreferences) : null),
                currentReading: readingSummary.items,
                currentReadingCount: readingSummary.count,
                //«Мои языки» хранятся в языках вкуса витрин: один список для каталога и рекомендаций
                libraryLanguages: (profileAuthorized ? this.readingListStore.normalizeDiscoveryPreferences(user.discoveryPreferences).taste.languages : []),
            },
        };
    }

    async loginUserProfile(login = '', password = '') {
        this.checkMyState();
        return withFileTransaction(this.readingListStore.file, async() => {
            const user = await this.readingListStore.findUserByLogin(login);
            if (!user || !user.passwordHash)
                throw new Error(t('errors.invalidLogin'));
            if (!await this.readingListStore.verifyUserPassword(user.id, password))
                throw new Error(t('errors.invalidLogin'));
            return {
                userId: user.id,
                profileAccessToken: this.createProfileSession(user.id),
            };
        });
    }

    async createUserProfile(profile = {}) {
        this.checkMyState();
        return {user: await this.readingListStore.createUser(profile)};
    }

    async updateUserProfile(userId, patch = {}) {
        this.checkMyState();
        return withFileTransaction(this.readingListStore.file, async() => {
            const previous = await this.readingListStore.getUser(userId);
            const user = await this.readingListStore.updateUser(userId, patch);
            if (previous.passwordHash !== user.passwordHash || previous.login !== user.login)
                this.revokeUserSessions(userId);
            return {user};
        });
    }

    async deleteUserProfile(userId) {
        this.checkMyState();
        return withFileTransaction(this.readingListStore.file, async() => {
            const result = await this.readingListStore.deleteUser(userId);
            this.revokeUserSessions(userId);
            if (this.koboService)
                await this.koboService.store.deleteUserDevices(userId);
            return result;
        });
    }

    revokeUserSessions(userId) {
        for (const [token, session] of this.profileSessions) {
            if (session.userId === userId)
                this.profileSessions.delete(token);
        }
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

    async updateSharedDiscoveryConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const discovery = await this.readingListStore.updateSharedDiscoveryConfig(patch || {});
        this.sharedDiscoveryConfig = _.cloneDeep(discovery);
        return {discovery};
    }

    getAdminIntegrationConfig() {
        const hasTelegramToken = !!String(this.config.telegramBotToken || '').trim();
        const hasSmtpPassword = !!String(this.config.smtpPass || '').trim();

        return {
            telegramShareEnabled: !!this.config.telegramShareEnabled,
            telegramBotToken: hasTelegramToken ? '__KEEP__' : '',
            telegramBotTokenSet: hasTelegramToken,
            telegramChatId: String(this.config.telegramChatId || ''),
            telegramCaptionTemplate: String(this.config.telegramCaptionTemplate || '${AUTHOR} - ${TITLE}'),
            emailShareEnabled: !!this.config.emailShareEnabled,
            smtpHost: String(this.config.smtpHost || ''),
            smtpPort: parseInt(this.config.smtpPort, 10) || 587,
            smtpSecure: !!this.config.smtpSecure,
            smtpUser: String(this.config.smtpUser || ''),
            smtpPass: hasSmtpPassword ? '__KEEP__' : '',
            smtpPassSet: hasSmtpPassword,
            emailFrom: String(this.config.emailFrom || ''),
            emailTo: String(this.config.emailTo || ''),
        };
    }

    getAdminOpdsConfig() {
        const opds = this.config.opds || {};
        const hasPassword = !!String(opds.password || '').trim();
        return {
            enabled: opds.enabled !== false,
            root: String(opds.root || '/opds'),
            user: String(opds.user || ''),
            password: hasPassword ? '__KEEP__' : '',
            passwordSet: hasPassword,
            lang: String(opds.lang || ''),
        };
    }

    renderAdminEvent(event = {}) {
        return Object.assign({}, event, {message: i18n.render(event.message)});
    }

    addAdminEvent(level = 'info', category = 'system', message = '', details = {}) {
        if (this.config.adminEventLogEnabled === false)
            return null;

        const maxEvents = Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300));
        const event = {
            id: `${Date.now()}-${utils.randomHexString(6)}`,
            time: new Date().toISOString(),
            level: String(level || 'info'),
            category: String(category || 'system'),
            //текст события - описание {key, params} (переводится при выдаче) или готовая строка (например, из лога)
            message: (message && typeof message === 'object' ? message : String(message || '')),
            details: details || {},
        };

        this.adminEvents.push(event);
        if (this.adminEvents.length > maxEvents)
            this.adminEvents.splice(0, this.adminEvents.length - maxEvents);

        return event;
    }

    async dirSize(dir = '', maxFiles = 20000) {
        const result = {path: dir, exists: false, size: 0, files: 0, truncated: false};
        if (!dir || !await fs.pathExists(dir))
            return result;

        result.exists = true;
        //путь к файлу (например, БД библиотеки) - его размер
        const own = await fs.stat(dir).catch(() => null);
        if (own && own.isFile())
            return Object.assign(result, {size: own.size, files: 1});

        const stack = [dir];
        while (stack.length) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current);
            } catch (e) {
                continue;
            }

            for (const name of list) {
                const filePath = path.join(current, name);
                let stat = null;
                try {
                    stat = await fs.stat(filePath);
                } catch (e) {
                    continue;
                }

                if (stat.isDirectory()) {
                    stack.push(filePath);
                } else {
                    result.files++;
                    result.size += stat.size;
                    if (result.files >= maxFiles) {
                        result.truncated = true;
                        return result;
                    }
                }
            }
        }

        return result;
    }

    async findFilesByExt(dir = '', exts = [], maxFiles = 200) {
        const result = [];
        const normalizedExts = new Set(exts.map(ext => String(ext || '').toLowerCase()));
        if (!dir || !await fs.pathExists(dir))
            return result;

        const stack = [dir];
        while (stack.length && result.length < maxFiles) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current, {withFileTypes: true});
            } catch (e) {
                continue;
            }

            for (const entry of list) {
                const filePath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(filePath);
                    continue;
                }

                if (normalizedExts.has(path.extname(entry.name).toLowerCase()))
                    result.push(filePath);

                if (result.length >= maxFiles)
                    break;
            }
        }

        return result;
    }

    async countArchives(dir = '', maxFiles = 20000) {
        const result = {count: 0, truncated: false};
        if (!dir || !await fs.pathExists(dir))
            return result;

        const stack = [dir];
        while (stack.length) {
            const current = stack.pop();
            let list = [];
            try {
                list = await fs.readdir(current, {withFileTypes: true});
            } catch (e) {
                continue;
            }

            for (const entry of list) {
                const filePath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(filePath);
                    continue;
                }

                if (['.zip', '.7z', '.fb2', '.epub'].includes(path.extname(entry.name).toLowerCase()))
                    result.count++;

                if (result.count >= maxFiles) {
                    result.truncated = true;
                    return result;
                }
            }
        }

        return result;
    }

    async getLibrarySourceDiagnostics(source = {}) {
        const libDir = String(source.libDir || '').trim();
        const inpx = String(source.inpx || source.inpxFile || '').trim();
        const foundInpx = libDir ? await this.findFilesByExt(libDir, ['.inpx'], 20) : [];
        const archiveInfo = libDir ? await this.countArchives(libDir) : {count: 0, truncated: false};
        const exists = async(name) => !!(libDir && await fs.pathExists(path.join(libDir, name)));

        return {
            inpxExists: !!inpx && await fs.pathExists(inpx),
            libDirExists: !!libDir && await fs.pathExists(libDir),
            foundInpx,
            archiveCount: archiveInfo.count,
            archiveCountTruncated: archiveInfo.truncated,
            hasCovers: await exists('covers'),
            hasEtc: await exists('etc'),
            hasImages: await exists('images'),
            hasBin: await exists('bin'),
        };
    }

    async cleanBrokenCoverCacheFiles(dir = '') {
        const result = {dir, removed: 0, checked: 0};
        if (!dir || !await fs.pathExists(dir))
            return result;

        const allowed = new Set(['.png', '.jpg', '.gif']);
        const list = await fs.readdir(dir);
        for (const name of list) {
            const filePath = path.join(dir, name);
            let stat = null;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;
            }

            if (stat.isDirectory())
                continue;

            result.checked++;
            const broken = stat.size <= 0 || !allowed.has(path.extname(name).toLowerCase());
            if (!broken)
                continue;

            await fs.remove(filePath);
            result.removed++;
        }

        return result;
    }

    async buildAdminDashboardMetrics(index = null, dbConfig = null) {
        index = index || await this.getIndexStatus();
        dbConfig = dbConfig || (index.ready ? await this.dbConfig() : {});
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const coverSize = await this.dirSize(coverDir);
        const bookCacheSize = this.effectiveBookCacheSize();
        const coverCacheSize = cleanDirMaxSize(this.config.coverCacheSize);
        const cacheCleanTargetRatio = this.cacheCleanTargetRatio();
        const uptime = process.uptime();
        const cpuUsage = process.cpuUsage();
        const cpuTotalMicros = cpuUsage.user + cpuUsage.system;
        const cpuTotalSeconds = cpuTotalMicros / 1000000;
        const cpuNow = Date.now();
        const previousCpuSnapshot = this.adminCpuSnapshot || null;
        const cpuElapsedSeconds = previousCpuSnapshot ? Math.max(0, (cpuNow - previousCpuSnapshot.at) / 1000) : 0;
        const cpuCurrentPercent = (previousCpuSnapshot && cpuElapsedSeconds > 0)
            ? ((cpuTotalMicros - previousCpuSnapshot.totalMicros) / 1000000 / cpuElapsedSeconds) * 100
            : null;

        this.adminCpuSnapshot = {
            at: cpuNow,
            totalMicros: cpuTotalMicros,
        };

        return {
            generatedAt: new Date().toISOString(),
            uptime,
            memory: process.memoryUsage(),
            cpu: {
                userSeconds: cpuUsage.user / 1000000,
                systemSeconds: cpuUsage.system / 1000000,
                totalSeconds: cpuTotalSeconds,
                currentPercent: cpuCurrentPercent,
                averagePercent: uptime > 0 ? (cpuTotalSeconds / uptime) * 100 : 0,
            },
            runtime: runtimeMetrics.getSnapshot(),
            discovery: await this.readingListStore.getDiscoveryMetrics(),
            index,
            stats: (dbConfig && dbConfig.stats) || (index && index.stats) || {},
            paths: {
                dataDir: this.config.dataDir,
                db: this.catalogSearch.file,
                bookCache: this.config.bookDir,
                coverCache: coverDir,
                tempDir: this.config.tempDir,
            },
            sizes: {
                db: await this.dirSize(this.catalogSearch.file),
                bookCache: await this.dirSize(this.config.bookDir),
                coverCache: coverSize,
                tempDir: await this.dirSize(this.config.tempDir, 5000),
            },
            limits: {
                maxFilesDirSize: this.config.maxFilesDirSize,
                bookCacheSize,
                bookCacheTargetSize: (bookCacheSize === null ? null : cleanDirTargetSize(bookCacheSize, null, cacheCleanTargetRatio)),
                coverCacheSize,
                coverCacheTargetSize: (coverCacheSize === null ? null : cleanDirTargetSize(coverCacheSize, null, cacheCleanTargetRatio)),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio,
            },
        };
    }

    async getAdminDashboardMetrics(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        return await this.buildAdminDashboardMetrics();
    }

    async getAdminDashboard(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const index = await this.getIndexStatus();
        const dbConfig = (index.ready ? await this.dbConfig() : {});
        const metrics = await this.buildAdminDashboardMetrics(index, dbConfig);
        const sources = await Promise.all(getEnabledLibrarySources(this.config).map(async(source) => Object.assign({
            id: source.id || '',
            name: source.name || '',
            enabled: source.enabled !== false,
            inpx: source.inpx || source.inpxFile || '',
            libDir: source.libDir || '',
        }, await this.getLibrarySourceDiagnostics(source))));
        const coverErrors = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse())
            .filter(event => {
                if (event.level !== 'error')
                    return false;

                const text = `${event.category || ''} ${i18n.render(event.message)}`.toLowerCase();
                return text.includes('cover') || text.includes('облож') || /\bimage\s+\S+:/i.test(text);//i18n-ignore: поиск по тексту лога
            })
            .slice(0, 8);
        const state = this.wState.get() || {};

        return Object.assign({}, metrics, {
            sources,
            covers: {
                dir: metrics.paths.coverCache,
                size: metrics.sizes.coverCache.size,
                files: metrics.sizes.coverCache.files,
                limit: metrics.limits.coverCacheSize,
                targetSize: metrics.limits.coverCacheTargetSize,
                latestErrors: coverErrors,
            },
            tasks: [
                {
                    id: 'index',
                    title: t('admin.taskIndexing'),
                    active: state.state === 'db_creating' || state.state === 'db_loading',
                    state: state.state,
                    message: i18n.render(state.jobMessage || state.serverMessage || ''),
                    progress: state.progress || 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => event.category === 'index' && event.level === 'error') || {}).message),
                    cancellable: false,
                },
                {
                    id: 'cache',
                    title: t('admin.taskCacheClean'),
                    active: false,
                    state: 'idle',
                    message: t('admin.taskCacheCleanMessage'),
                    progress: 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => event.category === 'cache' && event.level === 'error') || {}).message),
                    cancellable: false,
                },
                {
                    id: 'delivery',
                    title: t('admin.taskDelivery'),
                    active: false,
                    state: 'events',
                    message: t('admin.taskDeliveryMessage'),
                    progress: 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => ['delivery', 'conversion'].includes(event.category) && event.level === 'error') || {}).message),
                    cancellable: false,
                },
            ],
        });
    }

    async getAdminEvents(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const level = String(options.level || 'all').trim();
        const category = String(options.category || 'all').trim();
        const limit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 80));
        let events = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse());
        if (level !== 'all')
            events = events.filter(event => event.level === level);
        if (category !== 'all')
            events = events.filter(event => event.category === category);

        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300)),
            events: events.slice(0, limit).map(event => this.renderAdminEvent(event)),
        };
    }

    async addAdminTestEvent(userId = '', profileAccessToken = '', level = 'warn') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = String(level || 'warn').toLowerCase() === 'error' ? 'error' : 'warn';
        log(normalized === 'error' ? LM_ERR : LM_WARN, `Admin event log test: ${normalized}`);
        return {success: true};
    }

    async updateAdminEventLog(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const patch = {
            adminEventLogEnabled: options.enabled !== false,
            adminEventLogSize: Math.max(20, Math.min(2000, parseInt(options.maxSize, 10) || 300)),
        };
        await this.saveRuntimeConfigPatch(patch);
        if (this.adminEvents.length > patch.adminEventLogSize)
            this.adminEvents.splice(0, this.adminEvents.length - patch.adminEventLogSize);
        this.addAdminEvent('info', 'settings', msg(patch.adminEventLogEnabled ? 'admin.eventLogEnabled' : 'admin.eventLogDisabled'));
        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: patch.adminEventLogSize,
        };
    }

    normalizeAdminLibrarySources(sources = []) {
        return (Array.isArray(sources) ? sources : [])
            .map((source, index) => {
                const inpx = String(source.inpx || source.inpxFile || '').trim();
                const libDir = String(source.libDir || '').trim();
                const name = String(source.name || '').trim() || path.basename(inpx, path.extname(inpx)) || `Library ${index + 1}`;
                const idBase = String(source.id || name || `source-${index + 1}`)
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]+/gi, '-')
                    .replace(/^-+|-+$/g, '')
                    .substring(0, 40) || `source-${index + 1}`;

                return {
                    id: idBase,
                    name,
                    inpx,
                    inpxFile: inpx,
                    libDir,
                    enabled: source.enabled !== false,
                };
            })
            .filter(source => source.inpx || source.libDir);
    }

    async updateAdminLibrarySources(userId = '', profileAccessToken = '', sources = []) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminLibrarySources(sources);
        if (!normalized.length)
            throw new Error(t('errors.sourcesRequired'));
        if (!normalized.some(source => source.enabled !== false))
            throw new Error(t('errors.sourcesEnabledRequired'));

        this.config.librarySources = normalized;
        await this.saveRuntimeConfigPatch({librarySources: normalized});
        this.addAdminEvent('info', 'sources', msg('admin.sourcesUpdated', {n: normalized.length}));
        return {sources: normalized};
    }

    async diagnoseLibrarySource(userId = '', profileAccessToken = '', source = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        return await this.getLibrarySourceDiagnostics(source);
    }

    effectiveBookCacheSize() {
        const bookCacheSize = cleanDirMaxSize(this.config.bookCacheSize);
        if (bookCacheSize !== null)
            return bookCacheSize;

        return cleanDirMaxSize(this.config.maxFilesDirSize);
    }

    cacheCleanTargetRatio() {
        return cleanDirTargetRatio(this.config.cacheCleanTargetRatio);
    }

    cacheCleanNextScheduledDelay(now = new Date()) {
        try {
            return cleanDirNextScheduledDelay(this.config, now);
        } catch(e) {
            log(LM_ERR, `cacheCleanSchedule: ${e.message}`);
            return cleanDirNextAlignedDelay(this.config, now);
        }
    }

    cacheCleanNextRunAt(now = new Date()) {
        const delay = this.cacheCleanNextScheduledDelay(now);
        if (delay === null)
            return '';

        return new Date(now.getTime() + delay).toISOString();
    }

    cacheDirConfig(kind = 'all') {
        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        const targetRatio = this.cacheCleanTargetRatio();
        const result = [];
        const bookMaxSize = this.effectiveBookCacheSize();
        if ((normalizedKind === 'all' || normalizedKind === 'book') && bookMaxSize !== null && bookMaxSize > 0) {
            result.push({
                id: 'book',
                title: t('settings.admin.bookCache'),
                dir: this.config.bookDir,
                maxSize: bookMaxSize,
                targetRatio,
            });
        }

        const coverMaxSize = cleanDirMaxSize(this.config.coverCacheSize);
        if ((normalizedKind === 'all' || normalizedKind === 'cover') && coverMaxSize !== null && coverMaxSize > 0) {
            result.push({
                id: 'cover',
                title: t('settings.admin.coverCache'),
                dir: this.config.coverDir || `${this.config.publicFilesDir}/cover`,
                maxSize: coverMaxSize,
                targetRatio,
            });
        }

        return result;
    }

    async runCacheClean(reason = 'manual', options = {}) {
        if (this.cacheCleanRunning)
            return {skipped: true, reason: 'already-running'};

        this.cacheCleanRunning = true;
        try {
            const result = [];
            for (const config of this.cacheDirConfig(options.kind || 'all')) {
                try {
                    result.push(await this.cleanDir(Object.assign({}, config, {
                        forceTarget: options.forceTarget === true,
                    })));
                } catch(e) {
                    log(LM_ERR, e.stack || e.message);
                    result.push({
                        id: config.id || '',
                        title: config.title || '',
                        dir: config.dir,
                        error: e.message,
                    });
                }
            }

            if (reason)
                this.addAdminEvent('info', 'cache', msg('admin.cacheCleaned', {reason}), {result});

            return {cleaned: result};
        } finally {
            this.cacheCleanRunning = false;
        }
    }

    scheduleCacheClean(reason = 'deferred', delay = 10*60*1000) {
        const interval = cleanDirInterval(this.config);
        if (!interval || this.cacheCleanTimer)
            return;

        this.cacheCleanTimer = setTimeout(async() => {
            this.cacheCleanTimer = null;
            try {
                await this.runCacheClean(reason);
            } catch(e) {
                log(LM_ERR, e.stack || e.message);
            }
        }, Math.max(60*1000, delay));
    }

    async runAdminCacheCleanKind(userId = '', profileAccessToken = '', kind = 'all') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        if (!['all', 'book', 'cover'].includes(normalizedKind))
            throw new Error(t('errors.unknownCache'));

        return await this.runCacheClean(msg('admin.cleanReasonManual'), {
            kind: normalizedKind,
            forceTarget: true,
        });
    }

    normalizeAdminCachePatch(patch = {}) {
        const normalized = {};
        const mb = 1024*1024;

        const sizeFromMb = (value, fallback) => {
            const mbValue = parseFloat(value);
            if (!Number.isFinite(mbValue))
                return fallback;

            return Math.round(Math.max(1, mbValue) * mb);
        };

        if (utils.hasProp(patch, 'bookCacheSizeMb')) {
            const current = this.effectiveBookCacheSize() || 2048*mb;
            normalized.bookCacheSize = sizeFromMb(patch.bookCacheSizeMb, current);
            normalized.maxFilesDirSize = normalized.bookCacheSize;
        }

        if (utils.hasProp(patch, 'coverCacheSizeMb')) {
            const current = cleanDirMaxSize(this.config.coverCacheSize) || 512*mb;
            normalized.coverCacheSize = sizeFromMb(patch.coverCacheSizeMb, current);
        }

        if (utils.hasProp(patch, 'cacheCleanIntervalMinutes')) {
            const minutes = parseFloat(patch.cacheCleanIntervalMinutes);
            if (Number.isFinite(minutes))
                normalized.cacheCleanInterval = Math.max(0, Math.round(minutes));
        }

        if (utils.hasProp(patch, 'cacheCleanSchedule')) {
            const schedule = String(patch.cacheCleanSchedule || '').trim();
            if (schedule)
                parseCleanDirCron(schedule);

            normalized.cacheCleanSchedule = schedule;
        }

        if (utils.hasProp(patch, 'cacheCleanTargetPercent')) {
            const percent = parseFloat(patch.cacheCleanTargetPercent);
            if (Number.isFinite(percent))
                normalized.cacheCleanTargetRatio = Math.max(0.1, Math.min(1, percent / 100));
        }

        return normalized;
    }

    async updateAdminCacheConfig(userId = '', profileAccessToken = '', patch = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminCachePatch(patch || {});
        if (Object.keys(normalized).length)
            await this.saveRuntimeConfigPatch(normalized);

        this.addAdminEvent('info', 'settings', msg('admin.cacheRotationUpdated'), normalized);
        return {
            cache: {
                bookCacheSize: this.effectiveBookCacheSize(),
                coverCacheSize: cleanDirMaxSize(this.config.coverCacheSize),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio: this.cacheCleanTargetRatio(),
            },
        };
    }

    async cleanBrokenCoverCache(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const result = await this.cleanBrokenCoverCacheFiles(this.config.coverDir || `${this.config.publicFilesDir}/cover`);
        this.addAdminEvent('info', 'cover', msg('admin.brokenCoversCleaned', {n: result.removed}), result);
        return result;
    }

    async rebuildCoverCacheForBook(userId = '', profileAccessToken = '', bookUid = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error(t('errors.bookNotFound'));

        const libid = parseInt(book.libid, 10);

        const sourceId = String(book.sourceId || '').trim();
        const cacheBase = bookAssets.coverCacheKey(book);
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const removed = [];
        for (const ext of ['.png', '.jpg', '.gif']) {
            const filePath = path.join(coverDir, `${cacheBase}${ext}`);
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                removed.push(filePath);
            }
        }

        const coverUrl = `${this.config.rootPathStatic || ''}/cover/by-uid?uid=${encodeURIComponent(bookUid)}`;
        this.addAdminEvent('info', 'cover', msg('admin.coverCacheReset', {title: book.title || bookUid}), {bookUid, libid, sourceId, removed});
        return {
            success: true,
            bookUid,
            libid,
            sourceId,
            removed: removed.length,
            coverUrl,
        };
    }

    async startAdminReindex(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        this.addAdminEvent('warn', 'index', msg('admin.reindexStarted'));
        this.recreateDb();//no await
        return {started: true};
    }

    async saveRuntimeConfigPatch(patch = {}) {
        return withFileTransaction(this.config.configFile, async() => {
            const configManager = new ConfigManager();
            const previous = _.cloneDeep(this.config);
            try {
                Object.assign(this.config, patch);
                configManager.config = this.config;
                await configManager.save();
            } catch (error) {
                for (const key of Object.keys(patch))
                    delete this.config[key];
                Object.assign(this.config, previous);
                configManager.config = this.config;
                throw error;
            }
        });
    }

    normalizeIntegrationPatch(patch = {}) {
        const normalized = {};

        if (utils.hasProp(patch, 'telegramShareEnabled'))
            normalized.telegramShareEnabled = !!patch.telegramShareEnabled;
        if (utils.hasProp(patch, 'telegramBotToken')) {
            const token = String(patch.telegramBotToken || '').trim();
            if (token !== '__KEEP__')
                normalized.telegramBotToken = token;
        }
        if (utils.hasProp(patch, 'telegramChatId'))
            normalized.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utils.hasProp(patch, 'telegramCaptionTemplate'))
            normalized.telegramCaptionTemplate = String(patch.telegramCaptionTemplate || '').trim() || '${AUTHOR} - ${TITLE}';

        if (utils.hasProp(patch, 'emailShareEnabled'))
            normalized.emailShareEnabled = !!patch.emailShareEnabled;
        if (utils.hasProp(patch, 'smtpHost'))
            normalized.smtpHost = String(patch.smtpHost || '').trim();
        if (utils.hasProp(patch, 'smtpPort'))
            normalized.smtpPort = Math.max(1, Math.min(parseInt(patch.smtpPort, 10) || 587, 65535));
        if (utils.hasProp(patch, 'smtpSecure'))
            normalized.smtpSecure = !!patch.smtpSecure;
        if (utils.hasProp(patch, 'smtpUser'))
            normalized.smtpUser = String(patch.smtpUser || '').trim();
        if (utils.hasProp(patch, 'smtpPass')) {
            const pass = String(patch.smtpPass || '');
            if (pass !== '__KEEP__')
                normalized.smtpPass = pass;
        }
        if (utils.hasProp(patch, 'emailFrom'))
            normalized.emailFrom = String(patch.emailFrom || '').trim();
        if (utils.hasProp(patch, 'emailTo'))
            normalized.emailTo = String(patch.emailTo || '').trim();

        return normalized;
    }

    normalizeAdminOpdsPatch(patch = {}) {
        const current = this.config.opds || {};
        const normalized = Object.assign({}, current);

        if (utils.hasProp(patch, 'enabled'))
            normalized.enabled = (patch.enabled !== false);
        if (utils.hasProp(patch, 'root')) {
            let root = String(patch.root || '/opds').trim() || '/opds';
            if (!root.startsWith('/'))
                root = `/${root}`;
            normalized.root = root.replace(/\/+$/g, '') || '/opds';
        }
        if (utils.hasProp(patch, 'user'))
            normalized.user = String(patch.user || '').trim();
        if (utils.hasProp(patch, 'lang')) {
            const lang = String(patch.lang || '').trim().toLowerCase();
            normalized.lang = (['ru', 'en'].includes(lang) ? lang : '');
        }
        if (utils.hasProp(patch, 'password')) {
            const password = String(patch.password || '');
            if (password !== '__KEEP__')
                normalized.password = password;
        }

        if (normalized.password && !normalized.user)
            throw new Error(t('errors.opdsLoginRequired'));

        return normalized;
    }

    async updateAdminIntegrationConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeIntegrationPatch(patch || {});
        await this.saveRuntimeConfigPatch(normalized);
        this.addAdminEvent('info', 'settings', msg('admin.deliverySettingsUpdated'));

        return {integrations: this.getAdminIntegrationConfig()};
    }

    async updateAdminOpdsConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const opds = this.normalizeAdminOpdsPatch(patch || {});
        await this.saveRuntimeConfigPatch({opds});
        this.addAdminEvent('info', 'settings', msg('admin.opdsSettingsUpdated'));

        return {opds: this.getAdminOpdsConfig()};
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

        const item = await this.readingListStore.setBookRead(userId, listId, bookUid, read);
        await this.readingListStore.setBooksRead(userId, [bookUid], read, {listIds: [listId]});
        return {
            list: this.readingListStore.listStats(item),
            bookUid,
            read: !!read,
        };
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

    async extractBook(libFolder, libFile, sourceLibDir = '') {
        const outFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;

        libFolder = libFolder.replace(/\\/g, '/').replace(/\/\//g, '/');
        const libDir = sourceLibDir || this.config.libDir;

        const file = libFile;
        const resolveFolder = async() => {
            const folder = `${libDir}/${libFolder}`;

            return await this.resolveLibraryArchivePath(folder, libDir);
        };

        const folder = await resolveFolder();
        
        const fullPath = `${folder}/${file}`;

        if (!file || await fs.pathExists(fullPath)) {// файл есть на диске
            
            await fs.copy(fullPath, outFile);
            return outFile;
        } else {// файл в zip-архиве
            if (!await fs.pathExists(folder))
                throw new Error(`archive not found: ${folder}`);

            const zipReader = new ZipReader();
            await zipReader.open(folder, false);

            try {
                const extract = async(entryFilePath) => {
                    try {
                        await fs.remove(outFile);
                        await zipReader.extractToFile(entryFilePath, outFile);
                    } catch(e) {
                        await fs.remove(outFile);
                    }
                };

                await extract(file);

                if (!await fs.pathExists(outFile)) {//не удалось найти в архиве, попробуем имя файла в кодировке cp866
                    await extract(iconv.encode(file, 'cp866').toString());
                }

                if (!await fs.pathExists(outFile))
                    throw new Error(`file not found in archive: ${file}`);

                return outFile;
            } finally {
                await zipReader.close();
            }
        }
    }

    async resolveLibraryArchivePath(folder = '', libDir = '') {
        const candidates = [folder];
        const ext = path.extname(folder).toLowerCase();
        if (ext === '.zip')
            candidates.push(`${folder.substring(0, folder.length - 4)}.7z`);
        else if (ext === '.7z')
            candidates.push(`${folder.substring(0, folder.length - 3)}.zip`);

        for (const candidate of candidates) {
            const resolved = await this.resolveExistingPath(candidate);
            if (resolved)
                return resolved;
        }

        const baseName = path.basename(folder);
        const relativeFolder = String(folder || '').startsWith(`${libDir}/`)
            ? String(folder || '').substring(String(libDir || '').length + 1)
            : baseName;
        const directRoots = [
            libDir,
            `${libDir}/fb2`,
            `${libDir}/books`,
            `${libDir}/archives`,
        ].filter(Boolean);

        for (const root of directRoots) {
            for (const name of Array.from(new Set([relativeFolder, baseName]))) {
                const resolved = await this.resolveArchiveNameInDir(root, name);
                if (resolved)
                    return resolved;
            }
        }

        const scanned = new Set(directRoots.map(item => path.resolve(item)));
        try {
            if (libDir && await fs.pathExists(libDir)) {
                const entries = await fs.readdir(libDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;

                    const dir = path.join(libDir, entry.name);
                    const key = path.resolve(dir);
                    if (scanned.has(key))
                        continue;

                    scanned.add(key);
                    const resolved = await this.resolveArchiveNameInDir(dir, baseName);
                    if (resolved)
                        return resolved;
                }
            }
        } catch(e) {
            // keep the original missing archive error
        }

        return folder;
    }

    async resolveArchiveNameInDir(dir = '', name = '') {
        const candidate = path.join(dir, name);
        const candidates = [candidate];
        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.zip')
            candidates.push(`${candidate.substring(0, candidate.length - 4)}.7z`);
        else if (ext === '.7z')
            candidates.push(`${candidate.substring(0, candidate.length - 3)}.zip`);

        for (const item of candidates) {
            const resolved = await this.resolveExistingPath(item);
            if (resolved)
                return resolved;
        }

        return '';
    }

    async resolveExistingPath(filePath = '') {
        if (!filePath)
            return '';
        if (await fs.pathExists(filePath))
            return filePath;

        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath).toLowerCase();
        if (!dir || !baseName || !await fs.pathExists(dir))
            return '';

        try {
            const entries = await fs.readdir(dir);
            const match = entries.find(item => item.toLowerCase() === baseName);
            return match ? path.join(dir, match) : '';
        } catch(e) {
            return '';
        }
    }

    async resolveLibraryAssetDir(subDir = '', sourceLibDir = '') {
        const normalizedSubDir = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        const candidates = [
            `${libDir}/${normalizedSubDir}`,
            `${path.dirname(libDir)}/${normalizedSubDir}`,
        ];

        for (const dir of Array.from(new Set(candidates))) {
            if (await fs.pathExists(dir))
                return dir;
        }

        return candidates[0];
    }

    async resolveLibraryAssetDirs(subDir = '', sourceLibDir = '') {
        const normalizedSubDir = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        const candidates = [
            `${libDir}/${normalizedSubDir}`,
            `${path.dirname(libDir)}/${normalizedSubDir}`,
        ].filter(item => item && !item.startsWith('./'));

        const result = [];
        const seen = new Set();
        for (const dir of candidates) {
            const key = path.resolve(dir).toLowerCase();
            if (seen.has(key))
                continue;

            seen.add(key);
            if (await fs.pathExists(dir))
                result.push(dir);
        }

        return result;
    }

    libraryToolDirs(sourceLibDir = '') {
        const libDir = String(sourceLibDir || this.config.libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        return Array.from(new Set([
            `${libDir}/bin`,
            `${path.dirname(libDir)}/bin`,
        ]));
    }

    async ensureFblibraryArchives(subDir, sourceLibDir = '') {
        if (!this.fblibraryArchives)
            this.fblibraryArchives = {};

        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;

        //пустой список тоже запоминается до переиндексации: иначе каждая обложка заново читает каталоги
        if (!this.fblibraryArchives[cacheKey]) {
            const result = [];
            const dir = await this.resolveLibraryAssetDir(subDir, libDir);

            if (await fs.pathExists(dir)) {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const match = file.match(/(\d{4,})-(\d{4,})\.(zip|7z)$/i);
                    if (!match)
                        continue;

                    result.push({
                        file: `${dir}/${file}`,
                        from: parseInt(match[1], 10),
                        to: parseInt(match[2], 10),
                    });
                }
            }

            result.sort((a, b) => a.from - b.from);
            this.fblibraryArchives[cacheKey] = result;
        }
    }

    async getFblibraryArchives(subDir, libid, sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;
        await this.ensureFblibraryArchives(subDir, libDir);

        return this.fblibraryArchives[cacheKey]
            .filter(item => libid >= item.from && libid <= item.to)
            .sort((a, b) => {
                const aspan = a.to - a.from;
                const bspan = b.to - b.from;
                if (aspan !== bspan)
                    return aspan - bspan;

                return a.from - b.from;
            });
    }

    async getFblibraryImages(libid, sourceLibDir = '', libFolder = '') {
        const archives = libFolder ? await this.getBookAssetArchives('images', libFolder, sourceLibDir)
            : await this.getFblibraryArchives('images', libid, sourceLibDir);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const prefix = `${libid}/`;
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(prefix))
                    .map(entry => entry.name)
                    .sort((a, b) => {
                        const ai = parseInt(a.substring(prefix.length), 10);
                        const bi = parseInt(b.substring(prefix.length), 10);
                        return ai - bi;
                    });

                const result = [];
                for (const entryName of entryNames) {
                    const id = entryName.substring(prefix.length);
                    if (!id)
                        continue;

                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        result.push(Object.assign({id}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(sourceLibDir), this.config.converterPaths)));
                    } catch(e) {
                        log(LM_ERR, `image ${entryName}: ${e.message}`);
                    }
                }

                if (result.length)
                    return result;
            } finally {
                await zipReader.close();
            }
        }

        return [];
    }

    async getFblibraryCover(libid, sourceLibDir = '', libFolder = '') {
        const archives = libFolder ? await this.getBookAssetArchives('covers', libFolder, sourceLibDir)
            : await this.getFblibraryArchives('covers', libid, sourceLibDir);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            try {
                const data = await zipReader.extractToBuf(String(libid));
                return Object.assign({id: '0'}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(sourceLibDir), this.config.converterPaths));
            } catch(e) {
                if (externalTools.isMissingToolError(e))
                    throw e;
                // try next matching archive
            } finally {
                await zipReader.close();
            }
        }

        return null;
    }

    async getBookAssetArchives(subDir, libFolder, sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const bookArchive = await this.resolveLibraryArchivePath(`${libDir}/${libFolder}`, libDir);
        const baseName = path.basename(bookArchive, path.extname(bookArchive));
        const dirs = Array.from(new Set([
            path.join(path.dirname(bookArchive), subDir),
            ...await this.resolveLibraryAssetDirs(subDir, libDir),
        ]));
        const exact = [];
        for (const dir of dirs) {
            if (!await fs.pathExists(dir))
                continue;
            for (const name of await fs.readdir(dir)) {
                if (['.zip', '.7z'].includes(path.extname(name).toLowerCase())
                    && path.basename(name, path.extname(name)).toLowerCase() === baseName.toLowerCase())
                    exact.push({file: path.join(dir, name)});
            }
        }
        return exact
            .filter((archive, index, all) => all.findIndex(item => item.file === archive.file) === index);
    }

    async getBookCover(book) {
        const fileId = path.basename(String(book.file || ''), path.extname(String(book.file || '')));
        const cover = book.folder ? await this.getFblibraryCover(fileId, book.sourceLibDir, book.folder) : null;
        if (cover || String(book.ext).toLowerCase() !== 'fb2')
            return cover;

        // Embedded covers must come from this book, never another archive
        // that happens to contain the same numeric filename.
        const file = await this.extractBook(book.folder, `${book.file}.${book.ext}`, book.sourceLibDir);
        try {
            const {cover: embedded} = await this.fb2Helper.getDescAndCover(file);
            return embedded ? await imageUtils.normalizeForFb2(embedded, this.config.tempDir,
                this.libraryToolDirs(book.sourceLibDir), this.config.converterPaths) : null;
        } finally {
            await fs.remove(file);
        }
    }

    async getEpubImage(libid, num, fileName, libFolder, sourceLibDir = '', archiveCache = new Map(), readerCache = null) {
        const subDir = num === -1 ? 'covers' : 'images';
        if (!archiveCache.has(subDir))
            archiveCache.set(subDir, await this.getBookAssetArchives(subDir, libFolder, sourceLibDir));
        for (const archive of archiveCache.get(subDir)) {
            const cachedReader = readerCache && readerCache.get(archive.file);
            const reader = cachedReader || new ZipReader(this.config);
            let data;
            try {
                if (!cachedReader) {
                    await reader.open(archive.file, false);
                    if (readerCache)
                        readerCache.set(archive.file, reader);
                }
                data = await reader.extractToBuf(num === -1 ? String(libid) : `${libid}/${num}`);
            } catch (error) {
                if (externalTools.isMissingToolError(error))
                    throw error;
                log(LM_WARN, `EPUB image ${archive.file}: ${error.message}`);
            } finally {
                if (!readerCache || !readerCache.has(archive.file))
                    await reader.close();
            }
            if (data && data.length)
                return await imageUtils.normalizeForEpub(data, fileName, this.config.tempDir,
                    this.libraryToolDirs(sourceLibDir), this.config.converterPaths);
        }
        return null;
    }

    //Индекс справок и портретов авторов строится один раз на поколение ресурсов библиотеки:
    //параллельные запросы ждут одно построение, после ошибки следующий запрос строит заново
    ensureAuthorInfoArchives() {
        if (!this.authorInfoIndex) {
            const index = this.buildAuthorInfoIndex();
            this.authorInfoIndex = index;
            index.catch(() => {
                if (this.authorInfoIndex === index)
                    this.authorInfoIndex = null;
            });
        }
        return this.authorInfoIndex;
    }

    async buildAuthorInfoIndex() {
        const authorInfoArchives = [];
        const authorPictureArchives = [];
        const authorToArchive = new Map();

        const sources = getEnabledLibrarySources(this.config);
        const scannedAuthorDirs = new Set();

        for (const source of sources) {
            const authorDirs = [
                ...await this.resolveLibraryAssetDirs('etc/authors', source.libDir),
                ...await this.resolveLibraryAssetDirs('authors', source.libDir),
            ];
            for (const authorsDir of authorDirs) {
                const dirKey = path.resolve(authorsDir).toLowerCase();
                if (scannedAuthorDirs.has(dirKey))
                    continue;

                scannedAuthorDirs.add(dirKey);

                const files = await fs.readdir(authorsDir);
                for (const file of files) {
                    if (!/^\d+\.(7z|zip)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    authorInfoArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${authorsDir}/${file}`,
                    });
                }

                const picturesDir = `${authorsDir}/pictures`;
                if (!await fs.pathExists(picturesDir))
                    continue;

                const pictureFiles = await fs.readdir(picturesDir);
                for (const file of pictureFiles) {
                    if (!/^\d+\.(zip|7z)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    authorPictureArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${picturesDir}/${file}`,
                    });
                }
            }
        }

        const bySourceAndId = (a, b) => {
            const sourceCompare = String(a.sourceId || '').localeCompare(String(b.sourceId || ''));
            if (sourceCompare)
                return sourceCompare;

            return parseInt(a.id, 10) - parseInt(b.id, 10);
        };

        authorInfoArchives.sort(bySourceAndId);
        authorPictureArchives.sort(bySourceAndId);

        for (const archive of authorInfoArchives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                for (const entry of Object.values(zipReader.entries)) {
                    const name = (entry.name || '').replace(/\\/g, '/');
                    if (!name || entry.isDirectory)
                        continue;

                    const hash = getAuthorArchiveEntryHash(name);
                    if (!hash)
                        continue;

                    if (!authorToArchive.has(hash))
                        authorToArchive.set(hash, []);

                    authorToArchive.get(hash).push({
                        archive,
                        entryName: name,
                    });
                }
            } finally {
                await zipReader.close();
            }
        }

        return {authorInfoArchives, authorPictureArchives, authorToArchive};
    }

    async getAuthorPictureByKey(authorKey, archiveId = '', sourceId = '') {
        const {authorPictureArchives} = await this.ensureAuthorInfoArchives();

        const archives = [];
        if (archiveId) {
            const exactArchive = authorPictureArchives.find(item => item.id === String(archiveId) && (!sourceId || item.sourceId === sourceId));
            if (exactArchive)
                archives.push(exactArchive);
        }

        archives.push(...authorPictureArchives.filter(item => {
            if (archives.includes(item))
                return false;

            return sourceId && item.sourceId === sourceId;
        }));
        archives.push(...authorPictureArchives.filter(item => !archives.includes(item)));

        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(`${authorKey}/`))
                    .map(entry => entry.name)
                    .sort();

                for (const entryName of entryNames) {
                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        const image = await imageUtils.normalizeForFb2(data, this.config.tempDir, this.libraryToolDirs(archive.sourceLibDir), this.config.converterPaths);
                        return `data:${image.contentType};base64,${image.data.toString('base64')}`;
                    } catch(e) {
                        log(LM_WARN, `author picture ${entryName}: ${e.message}`);
                    }
                }
            } finally {
                await zipReader.close();
            }
        }

        return '';
    }

    async findAuthorInfo(author) {
        const {authorToArchive} = await this.ensureAuthorInfoArchives();

        const hashed = flibraryAuthorHash(author);
        const matches = authorToArchive.get(hashed) || [];
        if (!hashed || !matches.length)
            return null;

        for (const match of matches) {
            const archive = match.archive;
            const entryName = match.entryName || hashed;
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            let html = '';
            try {
                html = decodeHtmlBuffer(await zipReader.extractToBuf(entryName));
            } catch(e) {
                log(LM_WARN, `author info ${archive.file}:${entryName}: ${e.message}`);
                continue;
            } finally {
                await zipReader.close();
            }

            return {
                key: hashed,
                html,
                text: stripHtml(html),
                photo: await this.getAuthorPictureByKey(hashed, archive.id, archive.sourceId),
            };
        }

        return null;
    }

    async getAuthorInfo(authorId, author) {
        //авторы ищутся по имени: id авторов прежней БД больше не используются
        const authorName = author || '';

        const normalized = normalizeAuthorText(authorName);
        if (!normalized)
            return {authorInfo: null};

        const cacheKey = flibraryAuthorHash(authorName);
        if (this.authorInfoCache.has(cacheKey))
            return {authorInfo: this.authorInfoCache.get(cacheKey)};

        const authorInfo = await this.findAuthorInfo(authorName);
        this.authorInfoCache.set(cacheKey, authorInfo);
        return {authorInfo};
    }

    async injectFblibraryImages(bookFile, libid, sourceLibDir = '', libFolder = '') {
        const images = await this.getFblibraryImages(libid, sourceLibDir, libFolder);
        const cover = await this.getFblibraryCover(libid, sourceLibDir, libFolder);
        if (!images.length && !cover)
            return false;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        let text = data.toString();

        if (!/<FictionBook[\s>]/i.test(text) || !/<\/FictionBook>\s*$/i.test(text))
            return false;

        const existingBinaryIds = new Set();
        for (const match of text.matchAll(/<binary\b[^>]*\bid=(['"])(.*?)\1/gi))
            existingBinaryIds.add(match[2]);

        let coverHrefId = '';
        const coverHrefMatch = text.match(/<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?([^"']+)["'][^>]*\/?>[\s\S]*?<\/coverpage>/i);
        if (coverHrefMatch)
            coverHrefId = String(coverHrefMatch[1] || '').trim();

        const binaries = [];
        const effectiveCover = (cover && coverHrefId && !existingBinaryIds.has(coverHrefId))
            ? Object.assign({}, cover, {id: coverHrefId})
            : cover;
        const assets = (effectiveCover && !images.some(image => image.id === effectiveCover.id) ? [effectiveCover, ...images] : images);
        for (const image of assets) {
            if (existingBinaryIds.has(image.id))
                continue;

            const base64 = image.data.toString('base64');
            binaries.push(`<binary id="${image.id}" content-type="${image.contentType}">${base64}</binary>`);
        }

        let coverLinked = false;
        if (effectiveCover) {
            coverLinked = /<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?[^"']+["'][^>]*\/?>[\s\S]*?<\/coverpage>/i.test(text);
            if (!coverLinked) {
                const titleInfoRe = /<title-info\b[^>]*>/i;
                const titleInfoMatch = text.match(titleInfoRe);
                if (titleInfoMatch) {
                    const hrefAttr = 'xlink:href';
                    const coverpage = `\n<coverpage><image ${hrefAttr}="#${effectiveCover.id}"/></coverpage>`;
                    const insertAt = titleInfoMatch.index + titleInfoMatch[0].length;
                    text = `${text.slice(0, insertAt)}${coverpage}${text.slice(insertAt)}`;
                    coverLinked = true;
                }
            }
        }

        if (!binaries.length && !coverLinked)
            return false;

        text = text.replace(/<\/FictionBook>\s*$/i, `\n${binaries.join('\n')}\n</FictionBook>`);
        await fs.writeFile(bookFile, text);

        return (binaries.length > 0 || coverLinked);
    }

    async shouldInjectFblibraryImages(bookFile, libFolder = '') {
        if (path.extname(String(libFolder || '')).toLowerCase() === '.7z')
            return true;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        const text = data.toString();

        return !/<binary\b/i.test(text);
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
        const getNodeText = (node) => {
            const parts = [];
            node.eachDeepSelf((item) => {
                if (item.type === parser.TEXT || item.type === parser.CDATA)
                    parts.push(item.value);
            });

            return parts.join(' ').replace(/\s+/g, ' ').trim();
        };

        const walk = (sections, level = 0) => {
            for (const section of sections) {
                const titleNode = section.$$('\/title/');
                let title = '';
                if (titleNode && titleNode.count)
                    title = getNodeText(titleNode);

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

    async getReviewArchiveState(sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const dirs = [
            ...await this.resolveLibraryAssetDirs('reviews', libDir),
            ...await this.resolveLibraryAssetDirs('etc/reviews', libDir),
        ];
        const state = await libraryReviews.snapshot(dirs);
        // Include the source even when no review directories exist.
        state.signature = utils.getBufHash(`${path.resolve(libDir)}:${state.signature}`, 'sha256', 'hex');
        if (!this.reviewArchiveStates)
            this.reviewArchiveStates = new Map();
        const cached = this.reviewArchiveStates.get(libDir);
        if (cached && cached.signature === state.signature)
            return cached;
        this.reviewArchiveStates.set(libDir, state);
        return state;
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

    async ensureReviewIndex(sourceLibDir = '', state = null) {
        state = state || await this.getReviewArchiveState(sourceLibDir);
        if (!state.indexPromise)
            state.indexPromise = this.createReviewIndex(state.archives);
        return state.indexPromise;
    }

    async createReviewIndex(archives) {
        const reviewToArchives = new Map();

        for (const archive of archives) {
            if (archive.id.toLowerCase() === 'additional')
                continue;
            const zipReader = new ZipReader(this.config);
            try {
                await zipReader.open(archive.file);
                for (const item of Object.values(zipReader.entries || {})) {
                    const entryName = String(item.name || '').replace(/\\/g, '/');
                    if (!entryName || item.isDirectory)
                        continue;

                    const key = libraryReviews.normalizeEntryKey(entryName);
                    if (!key) continue;
                    const list = reviewToArchives.get(key) || [];
                    list.push({archive: archive.file, entryName});
                    reviewToArchives.set(key, list);
                }
            } catch(e) {
                log(LM_WARN, `review archive ${archive.file}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return reviewToArchives;
    }

    async getBookReviews(book, state = null) {
        const entryKey = libraryReviews.entryKey(book.folder, `${book.file}.${book.ext}`);
        const reviewIndex = await this.ensureReviewIndex(book.sourceLibDir, state);
        const matches = reviewIndex.get(entryKey) || [];
        const reviews = [];
        const seen = new Set();

        for (const match of matches) {
            const zipReader = new ZipReader(this.config);
            try {
                await zipReader.open(match.archive, false);
                const raw = await zipReader.extractToBuf(match.entryName);
                const parsed = JSON.parse(decodeArchiveText(raw));
                if (!Array.isArray(parsed))
                    continue;

                for (const item of parsed) {
                    if (!item || typeof(item) !== 'object')
                        continue;

                    const review = {
                        name: String(item.name || '').trim(),
                        time: String(item.time || '').trim(),
                        text: String(item.text || '').replace(/<br\s*\/?>/gi, '\n').trim(),
                    };
                    const key = JSON.stringify(review);
                    if (!seen.has(key)) {
                        seen.add(key);
                        reviews.push(review);
                    }
                }
            } catch(e) {
                log(LM_WARN, `review entry ${match.archive}:${match.entryName}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return reviews;
    }

    async getBookLibraryRating(book, state = null) {
        state = state || await this.getReviewArchiveState(book.sourceLibDir);
        if (!state.ratingsPromise)
            state.ratingsPromise = this.readLibraryRatings(state.archives);
        const ratings = await state.ratingsPromise;
        return ratings.get(libraryReviews.entryKey(book.folder, `${book.file}.${book.ext}`)) || null;
    }

    async readLibraryRatings(archives) {
        const ratings = new Map();
        for (const archive of archives.filter(item => item.id.toLowerCase() === 'additional')) {
            const reader = new ZipReader(this.config);
            try {
                await reader.open(archive.file, false);
                const rows = JSON.parse(decodeArchiveText(await reader.extractToBuf('books.json')));
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    if (!row || typeof row.folder !== 'string' || typeof row.file !== 'string'
                        || !Number.isFinite(row.sum) || !Number.isSafeInteger(row.count)
                        || row.count <= 0 || row.sum <= 0 || row.sum > row.count * 5)
                        continue;
                    const key = libraryReviews.entryKey(row.folder, row.file);
                    if (!ratings.has(key))
                        ratings.set(key, {value: row.sum / row.count, count: row.count});
                }
            } catch (error) {
                log(LM_WARN, `library ratings ${archive.file}: ${error.message}`);
            } finally {
                await reader.close();
            }
        }
        return ratings;
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

    async cleanDir(config) {
        const {dir} = config;
        const maxSize = cleanDirMaxSize(config.maxSize);
        const targetRatio = cleanDirTargetRatio(config.targetRatio);
        const targetSize = (maxSize === null ? null : cleanDirTargetSize(maxSize, config.targetSize, targetRatio));
        const result = {
            id: config.id || '',
            title: config.title || '',
            dir,
            maxSize,
            targetSize,
            targetRatio,
            forceTarget: config.forceTarget === true,
            exists: false,
            found: 0,
            removed: 0,
            size: 0,
            after: 0,
            overLimit: false,
        };
        if (!dir || maxSize === null)
            return result;

        if (!await fs.pathExists(dir))
            return result;

        result.exists = true;
        const list = await fs.readdir(dir);

        let size = 0;
        let files = [];
        //формируем список
        for (const filename of list) {
            const filePath = `${dir}/${filename}`;
            let stat = null;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;//файл удалён во время обхода или битая ссылка
            }
            if (!stat.isDirectory()) {
                size += stat.size;
                files.push({name: filePath, stat});
            }
        }

        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        const initialSize = size;
        result.found = files.length;
        result.size = initialSize;
        result.overLimit = initialSize > maxSize;
        let i = 0;
        //удаляем
        while ((result.overLimit || result.forceTarget) && i < files.length && size > targetSize) {
            const file = files[i];
            const oldFile = file.name;
            try {
                await fs.remove(oldFile);
            } catch (e) {
                log(LM_ERR, `clean dir ${dir}, remove ${oldFile}: ${e.message}`);
            }
            size -= file.stat.size;
            i++;
        }

        if (i) {
            log(LM_WARN, `clean dir ${dir}, maxSize=${maxSize}, targetSize=${targetSize}, found ${files.length} files, total size=${initialSize}, after=${size}`);
            log(LM_WARN, `removed ${i} files`);
        }

        result.removed = i;
        result.after = size;
        return result;
    }

    async periodicCleanDir() {
        try {
            for (const config of this.cacheDirConfig())
                await fs.ensureDir(config.dir);
        } catch (e) {
            log(LM_FATAL, e.message);
            asyncExit.exit(1);
            return;
        }

        while (1) {// eslint-disable-line no-constant-condition
            try {
                const delay = this.cacheCleanNextScheduledDelay();
                if (delay === null) {
                    await utils.sleep(60*1000);
                } else if (delay <= 1000) {
                    await this.runCacheClean(msg('admin.cleanReasonScheduled'));

                    await utils.sleep(60*1000);
                } else {
                    await utils.sleep(Math.min(delay, 60*1000));//интервал проверки не чаще 1 минуты
                }
            } catch (e) {
                //сбой одной очистки не должен останавливать сервер
                log(LM_ERR, `periodicCleanDir: ${e.stack || e.message}`);
                await utils.sleep(60*1000);
            }
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

// Jobs kept in their own files; their methods run on the worker like the ones above.
Object.assign(WebWorker.prototype, require('./AdminBackup'), require('./BookDelivery'));

module.exports = WebWorker;


