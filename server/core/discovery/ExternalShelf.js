const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const _ = require('lodash');
const axios = require('axios');

const log = new (require('../AppLogger'))().log;//singleton
const utils = require('../utils');
const {withFileTransaction, writeFileAtomic} = require('../FilePersistence');
const {getEnabledLibrarySources} = require('../LibrarySources');
const {stripHtml, normalizeAuthorText} = require('../HtmlText');
const {t, msg} = require('../i18n');

const discoveryCacheTtl = 15*60*1000;//15 minutes

//наибольший срок обновления внешней витрины (externalTtlMinutes); записи без своего срока живут столько
const discoveryCacheMaxTtl = 10080*60*1000;

const externalDiscoveryCacheVersion = 'v9';

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

// Витрина: настройки, общий кеш полок и внешняя полка лауреатов премий из Викиданных.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
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
    },

    async getSharedDiscoveryConfig() {
        this.sharedDiscoveryConfig = await this.readingListStore.getSharedDiscoveryConfig();
        return _.cloneDeep(this.sharedDiscoveryConfig);
    },

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
    },

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
    },

    async saveDiscoveryDiskCache() {
        if (!this.discoveryDiskCacheFile)
            this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        await withFileTransaction(this.discoveryDiskCacheFile, () =>
            writeFileAtomic(this.discoveryDiskCacheFile, JSON.stringify(this.discoveryDiskCache || {})));
    },

    //Убирает просроченные записи и записи прежних библиотек (хеш INPX - второе поле ключей discovery: и wikidata-matches:)
    pruneDiscoveryCache(currentKey = '', now = Date.now()) {
        const libraryOf = key => (/^(discovery|wikidata-matches):/.test(key) ? key.split(':')[1] : null);
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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

    //лауреаты всех премий загружаются одним запросом раз в период обновления витрины
    async getWikidataAwardWinners(discovery = {}, forceRefresh = false) {
        return this.rememberPersistedDiscovery(
            `wikidata-awards:${externalDiscoveryCacheVersion}`,
            () => this.fetchWikidataAwardWinners(discovery),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
    },

    async getWikidataAwardMatches(discovery = {}, forceRefresh = false) {
        const inpxHash = String((await this.dbConfig()).inpxHash || '');
        return this.rememberPersistedDiscovery(
            `wikidata-matches:${inpxHash}:${externalDiscoveryCacheVersion}`,
            async() => this.matchExternalItems((await this.getWikidataAwardWinners(discovery, forceRefresh)).items),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
    },

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
    },

    //forceRefresh пересобирает полку, refetch - ещё и заново загружает лауреатов и сопоставляет их с библиотекой
    async rememberExternalDiscoveryShelf(inpxHash = '', discovery = {}, limit = externalShelfPageSize, forceRefresh = false, refetch = forceRefresh) {
        //полка кешируется целыми страницами клиента: любой размер не даёт своего ключа
        const pageLimit = Math.ceil(limit / externalShelfPageSize) * externalShelfPageSize;
        const shelf = await this.rememberPersistedDiscovery(
            `discovery:${inpxHash}:external:${externalDiscoveryCacheVersion}:${discovery.externalSource}:${discovery.externalName}:${pageLimit}:${discovery.externalBrowseUrl}:${discovery.externalTtlMinutes}:${readerLanguages(discovery.externalLanguages).join(',')}`,
            () => this.buildExternalDiscoveryShelfV2(pageLimit, discovery, refetch),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
        if (shelf && Array.isArray(shelf.items) && shelf.items.length > limit)
            Object.assign(shelf, {items: shelf.items.slice(0, limit), discoveryHasMore: true});
        return shelf;
    },

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
    },

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
                //заново загрузить Викиданные и сопоставить книги может только админ, остальным полка собирается из кеша
                const forceRefresh = options.forceRefresh === true;
                const refetch = forceRefresh
                    && await this.requireAdmin(options.userId, options.profileAccessToken).then(() => true, () => false);
                const externalShelf = await this.rememberExternalDiscoveryShelf(inpxHash, discovery, externalShelfLimit, forceRefresh, refetch);
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
    },
};
