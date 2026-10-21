const crypto = require('crypto');
const _ = require('lodash');

const log = new (require('../AppLogger'))().log;//singleton
const {msg} = require('../i18n');
const {READ_PERCENT, isReadingInProgress, readerProgressOf} = require('../ReaderProgress');

const personalDiscoveryCacheTtl = 10*60*1000;

//Показы и открытия книги на витрине. suppressed: показана трижды за месяц и ни разу не открыта
function discoveryEngagement(book = {}, profile = {}) {
    const discoveryEvent = ((profile.discoveryEvents || {})[String(book._uid || book.bookUid || '').trim()] || {});
    const impressionCount = Math.max(0, Number(discoveryEvent.impressionCount) || 0);
    const openCount = Math.max(0, Number(discoveryEvent.openCount) || 0);
    const lastShownTime = Date.parse(String(discoveryEvent.lastShownAt || ''));
    const shownAgeDays = Number.isFinite(lastShownTime)
        ? Math.max(0, Math.floor((Date.now() - lastShownTime) / 86400000))
        : Number.MAX_SAFE_INTEGER;

    return {
        suppressed: impressionCount >= 3 && openCount === 0 && shownAgeDays < 30,
        //штраф за пропущенные показы (не больше maxPenalty) и недавний показ, прибавка за открытия
        apply(score, maxPenalty) {
            score -= Math.min(maxPenalty, Math.max(0, impressionCount - Math.max(1, openCount * 2)) * 10);
            if (impressionCount > 0 && shownAgeDays < 7)
                score -= 8;
            return score + Math.min(12, openCount * 4);
        },
    };
}

//Добавка 0..1 по _uid книги, постоянная при одном зерне: разводит равные оценки
function discoveryRotation(book = {}, rotationSeed = 0) {
    const numericSeed = Number(rotationSeed) || 0;
    const stableHash = String(book._uid || book.id || '')
        .split('')
        .reduce((sum, char) => ((sum * 33) + char.charCodeAt(0) + numericSeed) % 9973, numericSeed);
    return stableHash / 9973;
}

//Персональная полка без книг: гостю (сначала выбрать профиль) или когда подобрать нечего
function emptyPersonalShelf(id, title, subtitle, emptyMessage = msg('discovery.shelf.selectProfileFirst')) {
    return {id, title, subtitle, source: 'personal', sourceName: msg('discovery.sourceForYou'), updatedAt: Date.now(), items: [], emptyMessage};
}

// Персональные полки витрины: «Читаю сейчас», из списков, следующие книги серий и «Похожие»; статистика чтения.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
    getPersonalReadBookSet(user = null) {
        const readBookUids = new Set();
        for (const [bookUid, progress] of Object.entries(readerProgressOf(user))) {
            if ((Number(progress && progress.percent || 0) || 0) >= READ_PERCENT)
                readBookUids.add(String(bookUid || '').trim());
        }
        return readBookUids;
    },

    async buildContinueReadingShelfV2(user = null, limit = 8, context = null) {
        const progressMap = (context && context.progressMap
            ? context.progressMap
            : readerProgressOf(user));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user));

        const rows = Object.entries(progressMap)
            .map(([bookUid, progress]) => ({
                bookUid: String(bookUid || '').trim(),
                progress: Object.assign({percent: 0, sectionId: '', updatedAt: ''}, progress || {}),
            }))
            .filter((item) => item.bookUid && isReadingInProgress(item.progress))
            .sort((a, b) => String(b.progress.updatedAt || '').localeCompare(String(a.progress.updatedAt || '')));

        const items = [];
        let updatedAt = 0;
        const booksByUid = await this.getBookRecordsByUids(rows.map(item => item.bookUid));

        for (const item of rows) {
            const book = booksByUid.get(item.bookUid);
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
    },

    async buildFromReadingListsShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id)
            return emptyPersonalShelf('from-your-lists', msg('discovery.shelf.fromLists'), msg('discovery.shelf.fromListsUnreadSubtitle'));

        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user));
        const candidates = [];
        let updatedAt = 0;

        for (const list of lists) {
            const entries = this.readingListStore.normalizeEntries(list.books);
            const listUpdatedAt = Date.parse(String(list.updatedAt || list.createdAt || '')) || 0;
            updatedAt = Math.max(updatedAt, listUpdatedAt);

            entries.forEach((entry, index) => {
                candidates.push({
                    bookUid: entry.bookUid,
                    read: readBookUids.has(entry.bookUid),
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
        const booksByUid = await this.getBookRecordsByUids(candidates.map(item => item.bookUid));

        for (const item of candidates) {
            if (!item.bookUid || seenBookUids.has(item.bookUid))
                continue;

            const book = booksByUid.get(item.bookUid);
            if (!book)
                continue;

            seenBookUids.add(item.bookUid);
            items.push(Object.assign({}, book, {
                discoveryRead: item.read,
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
    },

    async buildUnfinishedSeriesShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id)
            return emptyPersonalShelf('unfinished-series', msg('discovery.shelf.unfinishedSeries'), msg('discovery.shelf.unfinishedSeriesSubtitle'));

        const progressMap = (context && context.progressMap
            ? context.progressMap
            : readerProgressOf(user));
        const readBookUids = (context && context.readBookUids ? new Set(context.readBookUids) : new Set());
        const seriesState = new Map();
        const booksByUid = await this.getBookRecordsByUids(Object.keys(progressMap));

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

        const candidates = Array.from(seriesState.values())
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

        const items = [];
        const seenBookUids = new Set();
        let updatedAt = 0;

        const seriesBooks = await this.catalogSearch.seriesBooksOf(candidates.map(state => state.series));
        for (const [index, state] of candidates.entries()) {
            //удалённая из библиотеки книга не может быть следующей в серии
            const nextBook = seriesBooks[index]
                .filter((book) => book && !book.del && book.series && Number(book.serno || 0) > Number(state.maxSerno || 0))
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
    },

    getPersonalDiscoveryFeatureKeys(value = '', separator = ',') {
        const expression = (separator === 'keywords' ? /[,;|]/ : /,/);
        return Array.from(new Set(
            String(value || '')
                .split(expression)
                .map(item => item.trim().toLowerCase())
                .filter(item => item.length >= (separator === 'keywords' ? 3 : 1))
        ));
    },

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
    },

    async buildPersonalDiscoveryTasteProfile(user = null, context = null) {
        const progressMap = (context && context.progressMap
            ? context.progressMap
            : readerProgressOf(user));
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
                    (this.readingListStore.isBookRead(user, entry.bookUid) ? 2.5 : 0.8),
                    list.updatedAt || list.createdAt,
                );
            }
        }

        for (const [bookUid, item] of Object.entries(discoveryEvents)) {
            if ((Number(item && item.startCount) || 0) > 0)
                profile.knownBookUids.add(String(bookUid || '').trim());
        }

        const booksByUid = await this.getBookRecordsByUids(Array.from(signals.keys()));
        for (const [bookUid, signal] of signals)
            applyPositiveBook(booksByUid.get(bookUid), signal);
        profile.signalCount = signals.size;

        taste.authors.forEach(author => addWeight(profile.authorWeights, author, 5));
        taste.genres.forEach(genre => addWeight(profile.genreWeights, genre, 4));
        taste.languages.forEach(language => addWeight(profile.languageWeights, language, 2));
        profile.updatedAt = Math.max(profile.updatedAt, Date.parse(String(taste.updatedAt || taste.completedAt || '')) || 0);

        return profile;
    },

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
        let contentScore = 0;

        contentScore += getWeight(profile.authorWeights, authorKey) * 32;
        contentScore += getWeight(profile.seriesWeights, seriesKey) * 36;
        genreKeys.forEach(key => contentScore += getWeight(profile.genreWeights, key) * 26);
        keywordKeys.forEach(key => contentScore += getWeight(profile.keywordWeights, key) * 20);
        if (contentScore <= 0)
            return 0;

        let score = contentScore;
        score += Math.min(8, getWeight(profile.languageWeights, languageKey) * 2);

        const engagement = discoveryEngagement(book, profile);
        if (engagement.suppressed)
            return 0;

        score = engagement.apply(score, 50);
        if (score <= 0)
            return 0;

        score += Math.max(0, Math.min(5, Number(book.librate) || 0)) * 4;
        const bookTime = Date.parse(String(book.date || ''));
        if (Number.isFinite(bookTime)) {
            const ageDays = Math.max(0, Math.floor((Date.now() - bookTime) / 86400000));
            score += Math.max(0, 12 - (Math.min(ageDays, 365) * 12 / 365));
        }

        score += discoveryRotation(book, rotationSeed) * 8;
        return score;
    },

    scorePersonalDiscoveryExplorationCandidate(book = {}, profile = {}, rotationSeed = 0) {
        const languageKey = String(book.lang || '').trim().toLowerCase();
        const engagement = discoveryEngagement(book, profile);
        if (engagement.suppressed)
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
        score = engagement.apply(score, 40);

        score += discoveryRotation(book, rotationSeed) * 10;
        return Math.max(0, score);
    },

    //Кандидаты «Похожих» из индекса каталога: лучшие id по оценке и записи этих книг.
    //null - БД библиотеки ещё строится.
    async similarCandidatesFromIndex(profile, weights, limit) {
        const catalog = this.catalogSearch;
        if (!catalog || !catalog.ready)
            return null;
        try {
            const known = profile.knownBookUids;
            const result = await catalog.similarCandidates(Object.assign({}, weights, {limit: limit + known.size, now: Date.now()}));
            const byId = new Map(result.books.map(book => [book.id, book]));
            const pick = (list, explore) => {
                const scores = new Map(list.map(item => [item.id, item.score]));
                return list.map(item => byId.get(item.id))
                    .filter(book => book && !book.del && book.title && book._uid && !known.has(book._uid))
                    .slice(0, limit)
                    .map(book => Object.assign({}, book, {_similarityScore: scores.get(book.id), _discoveryExplore: explore}));
            };
            return pick(result.affinity, false).concat(pick(result.explore, true));
        } catch (e) {
            log(LM_WARN, `Similar books from catalog index: ${e.message}`);
            return null;
        }
    },

    async buildSimilarBooksShelfV2(user = null, limit = 8, context = null) {
        if (!user || !user.id)
            return emptyPersonalShelf('similar-books', msg('discovery.shelf.similar'), msg('discovery.shelf.similarSubtitle'));

        const lists = (context && Array.isArray(context.lists) ? context.lists : await this.readingListStore.getLists(user.id, {}));
        const readBookUids = (context && context.readBookUids ? context.readBookUids : this.getPersonalReadBookSet(user));
        const profile = await this.buildPersonalDiscoveryTasteProfile(user, Object.assign({}, context || {}, {lists}));
        const preferredAuthors = Object.fromEntries(profile.authorWeights);
        const preferredSeries = Object.fromEntries(profile.seriesWeights);
        const preferredGenres = Object.fromEntries(profile.genreWeights);
        const preferredKeywords = Object.fromEntries(profile.keywordWeights);
        const preferredLanguages = Object.fromEntries(profile.languageWeights);
        const displayLimit = Math.max(1, Math.min(parseInt(limit, 10) || 8, 96));
        const probeLimit = displayLimit + 1;
        if (!Object.keys(preferredAuthors).length && !Object.keys(preferredSeries).length && !Object.keys(preferredGenres).length && !Object.keys(preferredKeywords).length && !Object.keys(preferredLanguages).length) {
            return Object.assign(emptyPersonalShelf('similar-books', msg('discovery.shelf.similar'), msg('discovery.shelf.similarSubtitle'),
                msg('discovery.shelf.similarEmptyNoProfile')), {
                discoveryTaste: profile.taste,
                discoveryNeedsTasteSetup: !profile.taste.completedAt && !profile.taste.promptDismissedAt,
            });
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
    },

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
    },

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
    },

    async buildPersonalDiscoveryShelvesV2(user, lists, limit, similarEnabled, similarLimit) {
        const context = {
            lists,
            progressMap: readerProgressOf(user),
            readBookUids: this.getPersonalReadBookSet(user),
        };

        const shelves = [
            await this.buildContinueReadingShelfV2(user, limit, context),
            await this.buildFromReadingListsShelfV2(user, limit, context),
            await this.buildUnfinishedSeriesShelfV2(user, limit, context),
        ];

        if (similarEnabled)
            shelves.push(await this.buildSimilarBooksShelfV2(user, similarLimit, context));

        return shelves;
    },

    //Статистика чтения профиля, кеш на пользователя до изменения списков, прогресса или библиотеки
    async getReadingStats(user) {
        this.checkMyState();
        const lists = await this.readingListStore.getLists(user.id, {});
        const inpxHash = String((await this.dbConfig()).inpxHash || '');
        const signature = this.personalDiscoverySignature(user, lists, {stats: true, inpxHash});

        if (!this.readingStatsCache)
            this.readingStatsCache = new Map();
        const cached = this.readingStatsCache.get(user.id);
        if (cached && cached.signature === signature)
            return _.cloneDeep(await cached.value);

        const entry = {signature, value: this.buildReadingStats(user)};
        this.readingStatsCache.set(user.id, entry);
        try {
            return _.cloneDeep(await entry.value);
        } catch (e) {
            if (this.readingStatsCache.get(user.id) === entry)
                this.readingStatsCache.delete(user.id);
            throw e;
        }
    },

    //Прочитанные - как на витрине: прогресс до конца (отметка «прочитано» тоже ставит прогресс 100% с датой).
    //Дата окончания - updatedAt прогресса. Месяцы и годы считает браузер по датам, в своём часовом поясе.
    async buildReadingStats(user) {
        const progressMap = readerProgressOf(user);
        const readBookUids = this.getPersonalReadBookSet(user);
        readBookUids.delete('');

        const finishedAt = [];
        for (const bookUid of readBookUids) {
            const progress = progressMap[bookUid];
            const time = (progress && Number(progress.percent) >= READ_PERCENT ? Date.parse(String(progress.updatedAt || '')) : NaN);
            if (Number.isFinite(time))
                finishedAt.push(new Date(time).toISOString());
        }

        const inProgress = Object.entries(progressMap)
            .filter(([bookUid, progress]) => isReadingInProgress(progress) && !readBookUids.has(bookUid.trim()))
            .length;

        const authors = new Map();
        const genres = new Map();
        const add = (map, values) => {
            for (const value of new Set(String(values || '').split(',').map(item => item.trim()).filter(Boolean)))
                map.set(value, (map.get(value) || 0) + 1);
        };
        for (const book of (await this.getBookRecordsByUids([...readBookUids])).values()) {
            add(authors, book.author);
            add(genres, book.genre);
        }
        const top = map => [...map]
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'ru'))
            .slice(0, 10)
            .map(([name, count]) => ({name, count}));

        return {
            finished: readBookUids.size,
            inProgress,
            finishedAt: finishedAt.sort(),
            authors: top(authors),
            genres: top(genres),
        };
    },
};
