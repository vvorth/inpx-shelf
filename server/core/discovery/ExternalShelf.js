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

//столько записей самое большее держит кеш витрины (в памяти и в discovery-cache.json): обычно их две на библиотеку
const discoveryCacheMaxEntries = 16;

//смена версии сбрасывает сохранённый кеш (pruneDiscoveryCache): в нём целые записи книг
const externalDiscoveryCacheVersion = 'v11';

//значение кеша общее для всех запросов: пометка ставится на копии верхнего уровня
function markDiscoveryStale(value, error = '') {
    if (!value || typeof(value) !== 'object')
        return value;
    return Object.assign({}, value, {discoveryStale: true}, (error ? {discoveryRefreshError: error} : {}));
}

//Клиент подставляет discoveryUrl в href: из ответа Викиданных и из кеша на диске пропускаются только http(s)-адреса
function httpUrlOrEmpty(value) {
    try {
        const url = new URL(String(value || '').trim());
        return (url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '');
    } catch (e) {
        return '';
    }
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

//не премия: заметные произведения писателей, родившихся в текущем месяце; меняется раз в месяц
const bornThisMonth = {id: 'born-this-month', label: 'discovery.award.bornThisMonth'};
const shelfOptions = [...wikidataAwards, bornThisMonth];

//на полку писателей месяца идут книги не моложе этого: витрина старых книг
const bornThisMonthMinAge = 20;

const wikidataEntityUrl = 'https://www.wikidata.org/wiki/';

//столько книг полка отдаёт самое большее (все издания всех премий бывает больше)
const externalShelfMaxLimit = 480;

//языки читателя для полки премий: пустой список - все языки
function readerLanguages(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(code => String(code || '').trim().toLowerCase())
        .filter(code => /^[a-z]{2,3}$/.test(code)))].sort().slice(0, 10);
}

function optionValue(option) {
    return (option === bornThisMonth ? option.id : wikidataEntityUrl + option.id);
}

function findWikidataAward(url = '') {
    return shelfOptions.find(option => optionValue(option) === String(url || '').trim()) || null;
}

//месяц полки писателей месяца: от него зависят запрос и ключи кеша
function currentMonth(now = new Date()) {
    return now.toISOString().slice(0, 7);
}

const sparqlLabel = (subject, name, lang) => `OPTIONAL { ${subject} rdfs:label ?${name} FILTER(LANG(?${name}) = "${lang}") }`;

//названия, авторы и языки оригинала (ISO 639-1) произведения
const sparqlWorkColumns = `?work (SAMPLE(?ru) AS ?titleRu) (SAMPLE(?en) AS ?titleEn)
        (GROUP_CONCAT(DISTINCT ?authorRuLabel; separator=", ") AS ?authorRu)
        (GROUP_CONCAT(DISTINCT ?authorEnLabel; separator=", ") AS ?authorEn)
        (GROUP_CONCAT(DISTINCT ?langCode; separator=" ") AS ?langs)`;
const sparqlWorkDetails = `OPTIONAL { ?work wdt:P407/wdt:P218 ?langCode }
        ${sparqlLabel('?work', 'ru', 'ru')} ${sparqlLabel('?work', 'en', 'en')}
        ${sparqlLabel('?author', 'authorRuLabel', 'ru')} ${sparqlLabel('?author', 'authorEnLabel', 'en')}`;

function buildWikidataAwardsQuery() {
    const values = wikidataAwards.map(award => `wd:${award.id}`).join(' ');
    return `SELECT ${sparqlWorkColumns}
        (GROUP_CONCAT(DISTINCT STRAFTER(STR(?award), "/entity/"); separator=" ") AS ?awards)
        (MAX(YEAR(?date)) AS ?year)
    WHERE {
        VALUES ?award { ${values} }
        ?work p:P166 ?statement. ?statement ps:P166 ?award.
        OPTIONAL { ?statement pq:P585 ?date }
        ?work wdt:P50 ?author.
        ${sparqlWorkDetails}
    } GROUP BY ?work ORDER BY DESC(?year)`;
}

//романисты, поэты и драматурги, родившиеся в этом месяце (точная дата), и их заметные произведения;
//известность автора - число статей о нём в Википедиях
function buildWikidataBornThisMonthQuery(now = new Date()) {
    return `SELECT ${sparqlWorkColumns} (MAX(?sitelinks) AS ?rank)
    WHERE {
        {
            SELECT ?work ?author ?sitelinks WHERE {
                VALUES ?occupation { wd:Q6625963 wd:Q49757 wd:Q214917 }
                ?author wdt:P106 ?occupation; wdt:P800 ?work; wikibase:sitelinks ?sitelinks.
                FILTER(?sitelinks >= 30)
                ?work wdt:P50 ?author.
                ?author p:P569 ?birth. ?birth a wikibase:BestRank; psv:P569 ?birthValue.
                ?birthValue wikibase:timeValue ?born; wikibase:timePrecision ?precision.
                FILTER(?precision >= 11 && MONTH(?born) = ${now.getUTCMonth() + 1})
                FILTER NOT EXISTS { ?work wdt:P577 ?published FILTER(YEAR(?published) > ${now.getUTCFullYear() - bornThisMonthMinAge}) }
            } LIMIT 600
        }
        ${sparqlWorkDetails}
    } GROUP BY ?work ORDER BY DESC(?rank)`;
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
            langs: value(binding, 'langs').split(' ').filter(Boolean),
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
        //записи прежних версий и форматов не держатся в памяти до первой записи файла
        this.pruneDiscoveryCache();
        return cache;
    },

    async saveDiscoveryDiskCache() {
        if (!this.discoveryDiskCacheFile)
            this.discoveryDiskCacheFile = path.join(this.config.dataDir, 'discovery-cache.json');
        await withFileTransaction(this.discoveryDiskCacheFile, () =>
            writeFileAtomic(this.discoveryDiskCacheFile, JSON.stringify(this.discoveryDiskCache || {})));
    },

    //Убирает записи прежних версий и других месяцев, записи прежних библиотек (хеш INPX - второе поле ключей wikidata-matches:)
    //и самые давние сверх discoveryCacheMaxEntries. Просроченная запись своего месяца остаётся: её отдают, пока идёт обновление
    pruneDiscoveryCache(currentKey = '', now = Date.now()) {
        const month = currentMonth(new Date(now));
        const libraryOf = key => (key.startsWith('wikidata-matches:') ? key.split(':')[1] : null);
        const library = libraryOf(currentKey);
        const stale = (key, entry) => !entry || !/^wikidata-(awards|matches):/.test(key)
            || !key.split(':').includes(externalDiscoveryCacheVersion) || key.split(':').pop() !== month
            || (library !== null && libraryOf(key) !== null && libraryOf(key) !== library);

        //в Map недавно прочитанные - в конце, в файле - недавно записанные
        for (const [key, entry] of this.discoveryCache) {
            if (stale(key, entry) || this.discoveryCache.size > discoveryCacheMaxEntries)
                this.discoveryCache.delete(key);
        }
        const diskCache = this.discoveryDiskCache || {};
        let extra = Object.keys(diskCache).filter(key => !stale(key, diskCache[key])).length - discoveryCacheMaxEntries;
        for (const key of Object.keys(diskCache)) {
            if (stale(key, diskCache[key]) || extra-- > 0)
                delete diskCache[key];
        }
    },

    //Общий кеш витрины в памяти и в discovery-cache.json. Значение одно на ключ и отдаётся без копии: читатели его не меняют.
    //Просроченное значение со staleWhileRevalidate отдаётся сразу и обновляется в фоне; ждёт только запрос без значения
    //(и forceRefresh). Ошибка обновления оставляет прежнее значение с пометкой discoveryStale, повтор - не раньше discoveryCacheTtl
    async rememberPersistedDiscovery(key, loader, ttl = discoveryCacheTtl, options = {}) {
        const forceRefresh = !!(options && options.forceRefresh);
        let entry = this.discoveryCache.get(key);
        if (!entry) {
            const persisted = (await this.getDiscoveryDiskCache())[key];
            entry = this.discoveryCache.get(key) || (persisted && {time: persisted.time, ttl: persisted.ttl, value: persisted.value});
        }
        if (entry) {
            this.discoveryCache.delete(key);
            this.discoveryCache.set(key, entry);
        }

        const now = Date.now();
        if (!forceRefresh && entry && now - entry.time < ttl)
            return entry.value;
        if (!forceRefresh && entry && options.staleWhileRevalidate) {
            if (!(entry.retryAt > now)) {
                this.refreshPersistedDiscovery(key, loader, ttl)
                    .catch(e => log(LM_WARN, `discovery refresh ${key}: ${e.message}`));
            }
            return (entry.retryAt ? markDiscoveryStale(entry.value) : entry.value);
        }

        try {
            return await this.refreshPersistedDiscovery(key, loader, ttl);
        } catch(e) {
            if (entry)
                return markDiscoveryStale(entry.value, e.message);
            throw e;
        }
    },

    //одна загрузка на ключ: параллельные запросы и фоновое обновление ждут её
    refreshPersistedDiscovery(key, loader, ttl) {
        if (!this.discoveryPending)
            this.discoveryPending = new Map();
        if (this.discoveryPending.has(key))
            return this.discoveryPending.get(key);

        const loading = (async() => {
            try {
                //загрузчик начинается после записи в discoveryPending
                const value = await Promise.resolve().then(loader);
                const time = Date.now();
                const diskCache = await this.getDiscoveryDiskCache();
                this.discoveryCache.delete(key);
                this.discoveryCache.set(key, {time, ttl, value});
                delete diskCache[key];
                diskCache[key] = {time, ttl, value};
                this.pruneDiscoveryCache(key, time);
                await this.saveDiscoveryDiskCache();
                return value;
            } catch(e) {
                const entry = this.discoveryCache.get(key);
                if (entry)
                    entry.retryAt = Date.now() + discoveryCacheTtl;
                throw e;
            } finally {
                this.discoveryPending.delete(key);
            }
        })();
        this.discoveryPending.set(key, loading);
        return loading;
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

            let score;
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
            discoveryUrl: httpUrlOrEmpty(item.url),
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

            //первым идёт оригинал, затем русский и английский перевод (названия в Викиданных русские и английские)
            const preferred = [...(item.langs || []), 'ru', 'en'];
            const rank = book => {
                const position = preferred.indexOf(String(book.lang || '').trim().toLowerCase());
                return (position < 0 ? preferred.length : position);
            };
            const books = [...found.values()]
                .sort((a, b) => (rank(a.book) - rank(b.book)) || (b.score - a.score))
                .map(copy => Object.assign({}, copy.book, {discoveryUrl: httpUrlOrEmpty(item.url)}));
            result.push({
                awards: item.awards || [],
                books: (books.length ? books : [this.makeExternalDiscoveryPlaceholder(item, index)]),
            });
            await utils.processLoop();
        }
        return {items: result};
    },

    async queryWikidata(query) {
        const response = await axios.get('https://query.wikidata.org/sparql', {
            params: {query},
            timeout: 60000,
            headers: {
                //Викиданные требуют User-Agent с контактом
                'User-Agent': `${this.config.name}/${this.config.version} (https://github.com/vvorth/inpx-shelf)`,
                'Accept': 'application/sparql-results+json',
            },
        });
        return parseWikidataAwardWinners(response.data);
    },

    async fetchWikidataAwardWinners(discovery = {}) {
        try {
            const items = await this.queryWikidata(buildWikidataAwardsQuery());
            if (!items.length)
                throw new Error(t('errors.externalReadFailed'));

            //писатели месяца не обязательны: без них полки премий работают
            let born = [];
            try {
                born = await this.queryWikidata(buildWikidataBornThisMonthQuery());
            } catch (e) {
                log(LM_WARN, `Wikidata born-this-month: ${e.message}`);
            }
            //произведение и лауреат, и книга писателя месяца: одна запись с обеими отметками
            const byUrl = new Map(items.map(item => [item.url, item]));
            for (const item of born) {
                if (byUrl.has(item.url))
                    byUrl.get(item.url).awards.push(bornThisMonth.id);
                else
                    items.push(Object.assign(item, {awards: [bornThisMonth.id]}));
            }
            return {items};
        } catch (e) {
            const details = String(e && e.message || '').trim();
            const suffix = details ? `: ${details}` : '';
            throw new Error(t('errors.externalUpdateFailed', {name: discovery.externalName || t('discovery.externalSource'), details: suffix}), {cause: e});
        }
    },

    //лауреаты всех премий загружаются одним запросом раз в период обновления витрины
    async getWikidataAwardWinners(discovery = {}, forceRefresh = false) {
        return this.rememberPersistedDiscovery(
            `wikidata-awards:${externalDiscoveryCacheVersion}:${currentMonth()}`,
            () => this.fetchWikidataAwardWinners(discovery),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh},
        );
    },

    //одно сопоставление на библиотеку и месяц: из него собираются полки всех премий, языков и страниц;
    //просроченное отдаётся сразу, а заново лауреаты загружаются и сопоставляются в фоне
    async getWikidataAwardMatches(discovery = {}, forceRefresh = false) {
        const inpxHash = String((await this.dbConfig()).inpxHash || '');
        return this.rememberPersistedDiscovery(
            `wikidata-matches:${inpxHash}:${externalDiscoveryCacheVersion}:${currentMonth()}`,
            async() => this.matchExternalItems((await this.getWikidataAwardWinners(discovery, forceRefresh)).items),
            discovery.externalTtlMinutes * 60 * 1000,
            {forceRefresh, staleWhileRevalidate: true},
        );
    },

    async buildExternalDiscoveryShelfV2(limit = 8, discovery = {}, forceRefresh = false) {
        if (discovery.externalSource === 'none')
            return null;

        const award = findWikidataAward(discovery.externalBrowseUrl);
        //издания на других языках отбрасываются до деления на страницы: иначе страница почти пустая
        const languages = readerLanguages(discovery.externalLanguages);
        const readable = book => (!languages.length || !book.lang || languages.includes(String(book.lang).trim().toLowerCase()));
        const found = await this.getWikidataAwardMatches(discovery, forceRefresh);
        const matches = found.items;
        //сначала книги из библиотеки (новые премии первыми), лауреаты, которых в ней нет, - в конце
        const local = [];
        const missing = [];
        const seenBookUids = new Set();
        let inLibrary = 0;
        for (const {awards, books} of matches) {
            //«Все премии» - только лауреаты
            if (award ? !awards.includes(award.id) : !awards.some(id => id !== bornThisMonth.id))
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
            sourceUrl: (award && award !== bornThisMonth ? wikidataEntityUrl + award.id : ''),
            updatedAt: Date.now(),
            discoveryStale: !!found.discoveryStale,
            ...(found.discoveryRefreshError ? {discoveryRefreshError: found.discoveryRefreshError} : {}),
            discoveryHasMore: books.length > limit,
            genreOptions: shelfOptions.map(item => ({label: msg(item.label), value: optionValue(item)})),
            //записи книг - из общего кеша: наружу идёт копия; адрес проверяется заново, кеш на диске мог быть записан и не этим кодом
            items: _.cloneDeep(books.slice(0, limit)).map(book => Object.assign(book, {discoveryUrl: httpUrlOrEmpty(book.discoveryUrl)})),
            emptyMessage: msg('discovery.shelf.externalEmpty'),
        };
    },

    //сопоставление лауреатов с библиотекой готовится заранее, полки всех премий собираются из него сразу
    async warmExternalDiscoveryShelves() {
        if (this.externalDiscoveryWarming)
            return;
        this.externalDiscoveryWarming = true;
        try {
            await this.getSharedDiscoveryConfig();
            const shared = this.getDiscoveryConfig();
            if (!shared.enabled || shared.externalSource === 'none')
                return;

            await this.getWikidataAwardMatches(shared);
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
                const refetch = options.forceRefresh === true
                    && await this.requireAdmin(options.userId, options.profileAccessToken).then(() => true, () => false);
                const externalShelf = await this.buildExternalDiscoveryShelfV2(externalShelfLimit, discovery, refetch);
                if (externalShelf)
                    shelves.push(externalShelf);
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
