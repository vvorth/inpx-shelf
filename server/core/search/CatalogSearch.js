//БД библиотеки на SQLite: импорт из INPX, записи книг, поиск, подсказки.
//Пока БД строится впервые, ready = false и сервер занят; при пересборке прежняя БД отвечает до замены.
const fs = require('fs-extra');

const log = new (require('../AppLogger'))().log;//singleton
const utils = require('../utils');
const AuthorNames = require('./AuthorNames');
const InpxParser = require('../InpxParser');
const {getEnabledLibrarySources} = require('../LibrarySources');
const {loadInpxFilter, makeRecordFilter, makeInpxInfo} = require('./LibraryImport');


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
        this.generation = 0;
        this.inpxHash = '';
        this.editedDuringBuild = null;
        this.authorNames = new AuthorNames(config);
    }

    status() {
        return {enabled: this.enabled, ready: this.ready, building: this.building, progress: this.progress, books: Number(this.meta.books || 0)};
    }

    getThread() {
        if (!this.thread || !this.thread.worker) {
            //поток мог упасть (ошибка, нехватка памяти): новый открывает ту же БД раньше любого запроса
            const restart = !!this.thread && this.ready;
            const CatalogIndexThread = require('./CatalogIndexThread');
            this.thread = new CatalogIndexThread();
            if (restart) {
                log(LM_WARN, 'Library DB thread stopped, restarting');
                this.thread.call('open', this.file).catch(e => log(LM_ERR, `Library DB reopen: ${e.message}`));
                this.thread.call('warmUp').catch(() => {});
            }
        }
        return this.thread;
    }

    //Открыть готовую БД библиотеки или построить её из INPX.
    //keepReady: прежняя БД отвечает, пока строится новая; force: строить, даже если хеш INPX не изменился
    ensure(inpxHash, options = {}) {
        const generation = ++this.generation;
        this.inpxHash = inpxHash;
        if (!options.keepReady)
            this.ready = false;
        this.buildPromise = this.ensureInner(inpxHash, generation, !!options.force)
            .catch((e) => {
                log(LM_ERR, `Library DB: ${e.message}`);
                return false;
            });
        return this.buildPromise;
    }

    async ensureInner(inpxHash, generation, force) {
        const thread = this.getThread();
        if (!force && await fs.pathExists(this.file)) {
            try {
                const meta = await thread.call('open', this.file);
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

    //Импорт всех включённых библиотек из INPX во временный файл; готовый файл заменяет прежний.
    //Отбор здесь, пропуск повторов _uid и порядок id - в потоке сборки (insertBooks), как у прежнего создания основной БД.
    async rebuild(inpxHash, generation) {
        //строит отдельный поток: поток запросов продолжает отвечать по прежней БД до замены файла
        const CatalogIndexThread = require('./CatalogIndexThread');
        const thread = new CatalogIndexThread();
        const tmpFile = `${this.file}.tmp`;
        await fs.remove(tmpFile);

        this.building = true;
        this.progress = 0;
        //правки метаданных во время сборки могут не попасть в новую БД: их _uid повторяются после замены
        const edited = new Set();
        this.editedDuringBuild = edited;
        const started = Date.now();
        log('Library DB build start');
        try {
            const config = this.config;
            const sources = getEnabledLibrarySources(config);
            const inpxFilter = await loadInpxFilter(config);
            const filter = makeRecordFilter(config, inpxFilter);
            const overrides = await this.worker.readingListStore.getMetadataOverrides();
            const names = await this.authorNames.readEntries();

            const sourceRows = sources.map(source => ({id: source.id, name: source.name, libDir: source.libDir}));
            await thread.call('beginBuild', tmpFile, names.entries, sourceRows);
            const parserInfos = [];
            let recsLoaded = 0;
            for (const [index, source] of sources.entries()) {
                let totalFiles = 0;
                const onFile = async(state) => {
                    if (state.totalFiles)
                        totalFiles = state.totalFiles;
                    if (totalFiles)
                        this.progress = Math.min(0.9, (index + (state.current || 0) / totalFiles) / sources.length * 0.9);
                };
                const onChunk = async(chunk) => {
                    if (generation !== this.generation)
                        throw new Error('build cancelled: library reloaded');
                    const rows = [];
                    for (const rec of chunk) {
                        rec.sourceId = source.id;
                        if (!filter(rec))
                            continue;
                        if (overrides[rec._uid]) {
                            const shown = this.worker.applyMetadataOverrideToBook(Object.assign({}, rec), overrides);
                            rec.shown = {title: shown.title, author: shown.author, series: shown.series, serno: shown.serno};
                        }
                        rows.push(rec);
                    }
                    recsLoaded += chunk.length;
                    await thread.call('insertBooks', rows);
                };

                const parser = new InpxParser();
                await parser.parse(source.inpxFile || source.inpx, onFile, onChunk);
                parserInfos.push({id: source.id, name: source.name, inpx: source.inpxFile || source.inpx, libDir: source.libDir, info: parser.info});
            }

            const counts = await thread.call('finishBuild', {
                inpxHash, aliasesStamp: names.updatedAt, aliases: 0, recsLoaded,
                inpxInfo: JSON.stringify(makeInpxInfo(parserInfos, inpxFilter)),
            });
            //в Linux и macOS открытая прежняя БД остаётся читаемой после замены файла: запросы не прерываются;
            //Windows не даёт заменить открытый файл
            const reader = this.getThread();
            if (process.platform === 'win32')
                await reader.call('close');
            await fs.move(tmpFile, this.file, {overwrite: true});
            this.meta = await reader.call('open', this.file);
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

    //Сведения о библиотеке из БД: хеш INPX, коллекция, статистика
    libraryConfig() {
        const parse = (value) => {
            try {
                return JSON.parse(value || '{}');
            } catch (e) {
                return {};
            }
        };
        return {inpxHash: this.meta.inpxHash || '', inpxInfo: parse(this.meta.inpxInfo), stats: parse(this.meta.stats)};
    }

    //Скачивание английских имён авторов (администратор); по окончании индекс перестраивается
    startAuthorNamesDownload() {
        return this.authorNames.start(async() => {
            if (this.ready)
                await this.ensure(this.inpxHash, {keepReady: true});
        });
    }

    async authorNamesStatus() {
        const info = await this.authorNames.info();
        return Object.assign(info, {
            job: this.authorNames.status(),
            matched: Number(this.meta.aliases || 0),
            indexBuilding: this.building,
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
        this.checkReady();
        const result = await this.getThread().call('search', request);
        const books = await this.loadBooks(result.ids);
        for (const book of books) {
            if (result.editions[book.id])
                book.editions = result.editions[book.id];
        }
        delete result.ids;
        delete result.editions;
        return Object.assign(result, {books});
    }

    //Другие издания того же произведения, с правками метаданных
    async editions(uid = '') {
        this.checkReady();
        return await this.loadBooks(await this.getThread().call('editionIds', uid));
    }

    //Кандидаты для полки «Похоже на то, что вы читали»: id и оценки из индекса
    async similarCandidates(request = {}) {
        this.checkReady();
        return await this.getThread().call('similarCandidates', request);
    }

    async suggest(request = {}) {
        this.checkReady();
        const result = await this.getThread().call('suggest', request);
        const uids = await this.loadBooks(result.books.map(book => book.id));
        result.books = uids.map(book => ({_uid: book._uid, title: book.title, author: book.author, ext: book.ext, lang: book.lang}));
        return result;
    }

    //Записи книг в порядке выдачи, с правками метаданных
    async loadBooks(ids = []) {
        if (!ids.length)
            return [];
        const books = await this.getThread().call('getBooks', ids);
        await this.worker.applyMetadataOverridesToSearchResult({books});
        return books;
    }

    //Записи по _uid (без правок метаданных: их накладывает вызывающий)
    async getBooksByUids(uids = []) {
        this.checkReady();
        return (uids.length ? await this.getThread().call('getBooksByUids', uids) : []);
    }

    //Книги автора и серии с правками метаданных
    async authorBooks(name = '') {
        this.checkReady();
        const result = await this.getThread().call('authorBooks', name);
        return {author: result.author, books: await this.loadBooks(result.ids)};
    }

    async seriesBooks(name = '') {
        this.checkReady();
        return await this.loadBooks(await this.getThread().call('seriesBooks', name));
    }

    async facetValues() {
        this.checkReady();
        return await this.getThread().call('facetValues');
    }

    async getBooksByStableKeys(keys = []) {
        this.checkReady();
        return (keys.length ? await this.getThread().call('getBooksByStableKeys', keys) : {});
    }

    async updateBook(row) {
        if (row && row._uid && this.editedDuringBuild)
            this.editedDuringBuild.add(row._uid);
        if (!this.ready || !row || !row.id)
            return;
        try {
            await this.getThread().call('updateBook', this.file, {
                id: row.id, title: row.title, author: row.author, series: row.series, serno: row.serno,
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
