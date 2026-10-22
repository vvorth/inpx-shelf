//БД библиотеки на SQLite: импорт из INPX, записи книг, поиск, подсказки.
//Пока БД строится впервые, ready = false и сервер занят; при пересборке прежняя БД отвечает до замены.
const path = require('path');
const fs = require('fs-extra');

const log = new (require('../AppLogger'))().log;//singleton
const utils = require('../utils');
const AuthorNames = require('./AuthorNames');
const WorkTitles = require('./WorkTitles');
const {getIndexedLibrarySources, getAllLibrarySources} = require('../LibrarySources');


class CatalogSearch {
    constructor(config, worker) {
        this.config = config;
        this.worker = worker;
        this.file = `${config.dataDir}/library.sqlite`;
        this.enabled = true;
        this.thread = null;
        this.ready = false;
        this.building = false;
        this.progress = 0;
        this.meta = {};
        this.buildPromise = null;
        this.nextBuild = null;
        this.buildSeq = 0;
        this.staleTmpRemoved = false;
        this.generation = 0;
        this.inpxHash = '';
        this.editedDuringBuild = null;
        this.authorNames = new AuthorNames(config);
        this.workTitles = new WorkTitles(config);
        //книги выключенных библиотек в индексе скрыты: статистика без них и ключи библиотек, что есть в индексе
        this.visibility = {stats: null, books: 0, indexed: []};
    }

    status() {
        return {enabled: this.enabled, ready: this.ready, building: this.building, progress: this.progress, books: Number(this.visibility.books || this.meta.books || 0)};
    }

    hiddenSourceIds() {
        return getAllLibrarySources(this.config).filter(source => source.enabled === false).map(source => source.id);
    }

    //Название библиотеки берётся из текущих настроек: его правка не требует пересборки
    sourceInfo() {
        return getAllLibrarySources(this.config).map(source => ({id: source.id, name: source.name}));
    }

    //Открыть БД в потоке запросов со скрытыми выключенными библиотеками
    async openIndex(thread) {
        const meta = await thread.call('open', this.file, this.hiddenSourceIds(), this.sourceInfo());
        this.visibility = await thread.call('sourceVisibility');
        return meta;
    }

    //Включение или выключение библиотеки без пересборки: true, если все включённые библиотеки уже есть в индексе
    async applySourceVisibility() {
        if (!this.ready)
            return false;
        this.visibility = await this.getThread().call('setHiddenSources', this.hiddenSourceIds(), this.sourceInfo());
        return this.hasEnabledSourcesIndexed();
    }

    hasEnabledSourcesIndexed() {
        const indexed = new Set(this.visibility.indexed || []);
        return getAllLibrarySources(this.config).every(source => source.enabled === false || indexed.has(source.id));
    }

    //Хеш содержимого индекса для кэшей выдачи: меняется и при выключении библиотеки
    libraryKey() {
        const hidden = this.hiddenSourceIds().filter(id => (this.visibility.indexed || []).includes(id)).sort();
        const hash = this.meta.inpxHash || '';
        return (hidden.length && hash ? `${hash}-${utils.getBufHash(hidden.join('|'), 'sha256', 'hex').substring(0, 12)}` : hash);
    }

    getThread() {
        if (!this.thread || !this.thread.worker) {
            //поток мог упасть (ошибка, нехватка памяти): новый открывает ту же БД раньше любого запроса
            const restart = !!this.thread && this.ready;
            const CatalogIndexThread = require('./CatalogIndexThread');
            this.thread = new CatalogIndexThread();
            if (restart) {
                log(LM_WARN, 'Library DB thread stopped, restarting');
                this.openIndex(this.thread).catch(e => log(LM_ERR, `Library DB reopen: ${e.message}`));
                this.thread.call('warmUp').catch(() => {});
            }
        }
        return this.thread;
    }

    //Открыть готовую БД библиотеки или построить её из INPX. Единственный вход в сборку: сборки идут по одной,
    //запросы во время сборки сливаются в одну следующую (с последним хешем; force, если его просил хоть один).
    //keepReady: прежняя БД отвечает, пока строится новая; force: строить, даже если хеш INPX не изменился
    ensure(inpxHash, options = {}) {
        this.inpxHash = inpxHash;
        let next = this.nextBuild;
        if (!next) {
            next = this.nextBuild = {force: false, keepReady: true};
            next.promise = this.buildPromise = (this.buildPromise || Promise.resolve()).then(() => {
                this.nextBuild = null;
                return this.runBuild(next);
            });
        }
        next.inpxHash = inpxHash;
        next.generation = this.generation;
        next.force = next.force || !!options.force;
        next.keepReady = next.keepReady && !!options.keepReady;
        return next.promise;
    }

    async runBuild({inpxHash, force, keepReady, generation}) {
        //запрос, поставленный до закрытия БД, не строит её заново
        if (generation !== this.generation)
            return false;
        if (!keepReady)
            this.ready = false;
        try {
            //сборки идут по одной, поэтому временные файлы до первой из них - остатки прерванных запусков
            if (!this.staleTmpRemoved) {
                this.staleTmpRemoved = true;
                await this.removeStaleTmpFiles();
            }
            return await this.ensureInner(inpxHash, generation, force);
        } catch (e) {
            log(LM_ERR, `Library DB: ${e.message}`);
            return false;
        }
    }

    async ensureInner(inpxHash, generation, force) {
        const thread = this.getThread();
        if (!force && await fs.pathExists(this.file)) {
            try {
                const meta = await this.openIndex(thread);
                const names = await this.authorNames.readEntries();
                if (meta.inpxHash === inpxHash && String(meta.aliasesStamp || '') === names.updatedAt) {
                    this.meta = meta;
                    this.ready = (generation === this.generation);
                    log(`Library DB ready: ${meta.books} books`);
                    thread.call('warmUp').catch(() => {});
                    return true;
                }
                log(meta.inpxHash === inpxHash ? 'Library DB: author names changed, rebuilding' : 'Library DB: library changed, rebuilding');
            } catch (e) {
                log(LM_WARN, `Library DB: ${e.message}, rebuilding`);
            }
        }

        return await this.rebuild(inpxHash, generation);
    }

    //Импорт всех библиотек из INPX во временный файл; готовый файл заменяет прежний.
    //Разбор INPX, отбор, пропуск повторов _uid и порядок id - в потоке сборки (LibraryImport.importLibrary).
    async rebuild(inpxHash, generation) {
        //строит отдельный поток: поток запросов продолжает отвечать по прежней БД до замены файла
        const CatalogIndexThread = require('./CatalogIndexThread');
        const thread = new CatalogIndexThread();
        //у каждой сборки свой файл: никакая сборка не удалит и не подменит чужой
        const tmpFile = `${this.file}.${process.pid}-${++this.buildSeq}.tmp`;

        this.building = true;
        this.progress = 0;
        //правки метаданных во время сборки могут не попасть в новую БД: их _uid повторяются после замены
        const edited = new Set();
        this.editedDuringBuild = edited;
        const started = Date.now();
        log('Library DB build start');
        try {
            const config = this.config;
            //выключенные библиотеки тоже в индексе, но после включённых: повтор книги (_uid) остаётся за включённой
            const indexed = await getIndexedLibrarySources(config);
            const sources = [...indexed.filter(source => source.enabled !== false), ...indexed.filter(source => source.enabled === false)];
            const overrides = await this.worker.readingListStore.getMetadataOverrides();
            const names = await this.authorNames.readEntries();

            const sourceRows = sources.map(source => ({id: source.id, name: source.name, libDir: source.libDir}));
            await thread.call('beginBuild', tmpFile, names.entries, sourceRows);
            //разбор, отбор и правки метаданных - в потоке сборки; закрытие БД останавливает поток: он занят разбором
            let cancelled = false;
            thread.onProgress = (progress) => {
                this.progress = progress;
                if (generation !== this.generation && !cancelled) {
                    cancelled = true;
                    thread.terminate().catch(() => {});
                }
            };
            let imported;
            try {
                imported = await thread.call('importLibrary', {
                    sources: sources.map(source => ({id: source.id, name: source.name, inpx: source.inpxFile || source.inpx, libDir: source.libDir})),
                    filterConfig: {inpxFilterFile: config.inpxFilterFile, allowUnsafeFilter: config.allowUnsafeFilter},
                    overrides,
                });
            } catch (e) {
                throw (cancelled ? new Error('build cancelled: library reloaded') : e);
            }

            const counts = await thread.call('finishBuild', {
                inpxHash, aliasesStamp: names.updatedAt, aliases: 0, recsLoaded: imported.recsLoaded, inpxInfo: imported.inpxInfo,
            });
            //в Linux и macOS открытая прежняя БД остаётся читаемой после замены файла: запросы не прерываются;
            //Windows не даёт заменить открытый файл: прежняя БД закрывается и, если замена не удалась, открывается снова
            const reader = this.getThread();
            const closeOld = (process.platform === 'win32');
            if (closeOld)
                await reader.call('close');
            try {
                await fs.move(tmpFile, this.file, {overwrite: true});
            } catch (e) {
                if (closeOld && this.ready)
                    await this.openIndex(reader).catch(() => (this.ready = false));
                throw e;
            }
            try {
                this.meta = await this.openIndex(reader);
            } catch (e) {
                //прежнего файла уже нет, а новый не открылся
                this.ready = false;
                throw e;
            }
            this.progress = 1;
            this.ready = (generation === this.generation);
            if (edited.size) {
                try {
                    const current = await this.worker.readingListStore.getMetadataOverrides();
                    for (const book of await reader.call('getBooksByUids', [...edited]))
                        await this.updateBook(this.worker.applyMetadataOverrideToBook(book, current));
                } catch (e) {
                    log(LM_WARN, `Library DB update: ${e.message}`);
                }
            }
            log(`Library DB built in ${((Date.now() - started) / 1000).toFixed(1)}s: ${counts.books} books, ${counts.authors} authors, ${counts.series} series, ${counts.aliases} English author names`);
            reader.call('warmUp').catch(() => {});
            return true;
        } catch (e) {
            await thread.call('abortBuild').catch(() => {});
            await fs.remove(tmpFile).catch(() => {});
            throw e;
        } finally {
            await thread.terminate().catch(() => {});
            this.building = false;
            if (this.editedDuringBuild === edited)
                this.editedDuringBuild = null;
            //разбор INPX оставляет много мусора: освобождаем память сразу, как прежнее создание БД
            utils.freeMemory();
        }
    }

    //Временные файлы сборок, прерванных остановкой сервера
    async removeStaleTmpFiles() {
        const dir = path.dirname(this.file);
        const prefix = `${path.basename(this.file)}.`;
        for (const name of await fs.readdir(dir).catch(() => [])) {
            if (name.startsWith(prefix) && name.endsWith('.tmp'))
                await fs.remove(path.join(dir, name)).catch(() => {});
        }
    }

    //Сведения о библиотеке из БД: хеш INPX, коллекция, статистика
    libraryConfig() {
        const parse = (value) => {
            try {
                return JSON.parse(value || '{}');
            } catch (e) {
                return {};
            }
        };
        //inpxHash - хеш, с которым строилась БД (по нему видно, что INPX изменился); libraryKey - ещё и с выключенными библиотеками
        return {
            inpxHash: this.libraryKey(), buildHash: this.meta.inpxHash || '',
            inpxInfo: parse(this.meta.inpxInfo), stats: this.visibility.stats || parse(this.meta.stats),
        };
    }

    //Таблицы Wikidata, которые скачивает администратор: английские имена авторов, названия произведений
    wikidataTable(name = '') {
        const table = {'author-names': this.authorNames, 'work-titles': this.workTitles}[name || 'author-names'];
        if (!table)
            throw new Error(`Unknown table: ${name}`);
        return table;
    }

    //Скачивание (администратор); имена авторов входят в индекс - по окончании он перестраивается
    startWikidataDownload(name = '') {
        const table = this.wikidataTable(name);
        return table.start(async() => {
            //во время сборки - в очередь: следующая сборка сверит имена с готовой БД
            if (table === this.authorNames && this.inpxHash)
                await this.ensure(this.inpxHash, {keepReady: true});
        });
    }

    async wikidataStatus(name = '') {
        const table = this.wikidataTable(name);
        const info = await table.info();
        if (table !== this.authorNames)
            return Object.assign(info, {job: table.status(), indexBuilding: false});
        return Object.assign(info, {
            job: table.status(),
            matched: Number(this.meta.aliases || 0),
            //dbLoad - запрошенная загрузка или пересборка, ещё до хэширования INPX: после импорта имён карточка сразу видит пересборку
            indexBuilding: this.building || !!(this.worker && this.worker.dbLoad),
        });
    }

    async listNames(request = {}) {
        this.checkReady();
        return await this.getThread().call('listNames', request);
    }

    async authorAliases(name = '') {
        if (!this.ready)
            return [];
        return await this.getThread().call('authorAliases', name);
    }

    async authorAliasesOf(values = []) {
        if (!this.ready)
            return {};
        return await this.getThread().call('authorAliasesOf', values);
    }

    checkReady() {
        if (!this.ready)
            throw new Error('catalog_index_not_ready');
    }

    async search(request = {}) {
        const result = await this.callWithBooks('search', request);
        for (const book of result.books) {
            if (result.editions[book.id])
                book.editions = result.editions[book.id];
        }
        delete result.editions;
        return result;
    }

    //Кандидаты для полки «Похоже на то, что вы читали»: id и оценки из индекса, записи этих книг в books
    async similarCandidates(request = {}) {
        return await this.callWithBooks('similarCandidates', request);
    }

    async suggest(request = {}) {
        const result = await this.callWithBooks('suggest', request);
        result.books = result.books.map(book => ({_uid: book._uid, title: book.title, author: book.author, ext: book.ext, lang: book.lang}));
        return result;
    }

    //Поиск книг по полям (findBooks): {books: записи с правками, totalFound}
    async findBooks(query = {}) {
        return await this.callWithBooks('findBooks', query);
    }

    //Запрос к потоку, ответ которого ссылается на книги по id: записи (с правками метаданных) приходят тем же вызовом в books,
    //иначе замена БД между двумя вызовами сопоставила бы id другим книгам
    async callWithBooks(action, ...args) {
        this.checkReady();
        const result = await this.getThread().call('withBooks', action, ...args);
        await this.worker.applyMetadataOverridesToSearchResult({books: result.books});
        return result;
    }

    //Записи по _uid (без правок метаданных: их накладывает вызывающий)
    //includeHidden - и книги выключенных библиотек (с пометкой hiddenSource)
    async getBooksByUids(uids = [], includeHidden = false) {
        this.checkReady();
        return (uids.length ? await this.getThread().call('getBooksByUids', uids, includeHidden) : []);
    }

    //Книги автора и серии с правками метаданных
    async authorBooks(name = '') {
        return await this.callWithBooks('authorBooks', name);
    }

    async seriesBooks(name = '') {
        return (await this.callWithBooks('seriesBooks', name)).books;
    }

    //Книги нескольких серий (с правками метаданных) одним вызовом потока: [[записи серии], ...] по порядку names
    async seriesBooksOf(names = []) {
        if (!names.length)
            return [];
        const {series, books} = await this.callWithBooks('seriesBooksOf', names);
        const byId = new Map(books.map(book => [book.id, book]));
        return series.map(ids => ids.map(id => byId.get(id)).filter(Boolean));
    }

    async facetValues() {
        this.checkReady();
        return await this.getThread().call('facetValues');
    }

    async getBooksByStableKeys(keys = []) {
        this.checkReady();
        return (keys.length ? await this.getThread().call('getBooksByStableKeys', keys) : {});
    }

    async getBooksByTitles(titles = []) {
        this.checkReady();
        return (titles.length ? await this.getThread().call('getBooksByTitles', titles) : {});
    }

    async updateBook(row) {
        if (row && row._uid && this.editedDuringBuild)
            this.editedDuringBuild.add(row._uid);
        if (!this.ready || !row || !row._uid)
            return;
        try {
            await this.getThread().call('updateBook', this.file, {
                _uid: row._uid, title: row.title, author: row.author, series: row.series, serno: row.serno,
                lang: row.lang, librate: row.librate, keywords: row.keywords,
            });
        } catch (e) {
            log(LM_WARN, `Library DB update: ${e.message}`);
        }
    }

    async close() {
        this.generation++;
        this.ready = false;
        if (this.thread) {
            await this.thread.call('close').catch(() => {});
            await this.thread.terminate();
            this.thread = null;
        }
    }

    async call(action, ...args) {
        this.checkReady();
        return await this.getThread().call(action, ...args);
    }
}

module.exports = CatalogSearch;
