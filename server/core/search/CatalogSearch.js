//Поиск по каталогу через индекс SQLite: построение индекса из основной БД, поиск, подсказки.
//Пока индекс строится или недоступен (нет node:sqlite), ready = false и клиент использует старый поиск.
const fs = require('fs-extra');

const log = new (require('../AppLogger'))().log;//singleton
const AuthorNames = require('./AuthorNames');

const chunkSize = 5000;

function sqliteAvailable() {
    try {
        require('node:sqlite');
        return true;
    } catch (e) {
        return false;
    }
}

class CatalogSearch {
    constructor(config, worker) {
        this.config = config;
        this.worker = worker;
        this.file = `${config.dataDir}/catalog-index.sqlite`;
        this.enabled = (config.catalogSearch !== false) && sqliteAvailable();
        this.thread = null;
        this.ready = false;
        this.building = false;
        this.progress = 0;
        this.meta = {};
        this.buildPromise = null;
        this.generation = 0;
        this.inpxHash = '';
        this.authorNames = new AuthorNames(config);
    }

    status() {
        return {enabled: this.enabled, ready: this.ready, building: this.building, progress: this.progress, books: Number(this.meta.books || 0)};
    }

    getThread() {
        if (!this.thread) {
            const CatalogIndexThread = require('./CatalogIndexThread');
            this.thread = new CatalogIndexThread();
        }
        return this.thread;
    }

    //Открыть готовый индекс или перестроить его для текущей БД. Без await: строится в фоне.
    //keepReady: та же библиотека, меняются только имена авторов - старый индекс отвечает, пока строится новый
    ensure(db, inpxHash, options = {}) {
        if (!this.enabled)
            return Promise.resolve(false);

        const generation = ++this.generation;
        this.inpxHash = inpxHash;
        if (!options.keepReady)
            this.ready = false;
        this.buildPromise = this.ensureInner(db, inpxHash, generation)
            .catch((e) => {
                log(LM_ERR, `Catalog index: ${e.message}`);
                return false;
            });
        return this.buildPromise;
    }

    async ensureInner(db, inpxHash, generation) {
        const thread = this.getThread();
        if (await fs.pathExists(this.file)) {
            try {
                const meta = await thread.call('open', this.file);
                const names = await this.authorNames.readEntries();
                if (meta.inpxHash === inpxHash && String(meta.aliasesStamp || '') === names.updatedAt) {
                    this.meta = meta;
                    this.ready = (generation === this.generation);
                    log(`Catalog index ready: ${meta.books} books`);
                    return true;
                }
                log(meta.inpxHash === inpxHash ? 'Catalog index: author names changed, rebuilding' : 'Catalog index: library changed, rebuilding');
            } catch (e) {
                log(LM_WARN, `Catalog index: ${e.message}, rebuilding`);
            }
        }

        return await this.rebuild(db, inpxHash, generation);
    }

    async rebuild(db, inpxHash, generation) {
        const thread = this.getThread();
        const tmpFile = `${this.file}.tmp`;
        await fs.remove(tmpFile);

        this.building = true;
        this.progress = 0;
        const started = Date.now();
        log('Catalog index build start');
        try {
            const dbConfig = await this.worker.dbConfig();
            const total = Number((dbConfig.stats || {}).bookCountAll) || 0;
            const overrides = await this.worker.readingListStore.getMetadataOverrides();
            const names = await this.authorNames.readEntries();

            await thread.call('beginBuild', tmpFile, names.entries);
            for (let from = 1; from <= total; from += chunkSize) {
                if (generation !== this.generation || db !== this.worker.db)
                    throw new Error('build cancelled: database reloaded');

                const ids = [];
                for (let id = from; id < from + chunkSize && id <= total; id++)
                    ids.push(id);
                const rows = await db.select({table: 'book', where: `@@id(${db.esc(ids)})`});
                for (const row of rows)
                    this.worker.applyMetadataOverrideToBook(row, overrides);
                await thread.call('insertBooks', rows.map(row => ({
                    id: row.id, _uid: row._uid, title: row.title, author: row.author, series: row.series, serno: row.serno,
                    genre: row.genre, lang: row.lang, ext: row.ext, size: row.size, date: row.date, librate: row.librate,
                    del: row.del, sourceId: row.sourceId, keywords: row.keywords,
                })));
                this.progress = Math.min(0.95, (from + chunkSize) / Math.max(1, total) * 0.95);
            }

            const counts = await thread.call('finishBuild', {inpxHash, aliasesStamp: names.updatedAt, aliases: 0});
            await thread.call('close');
            await fs.move(tmpFile, this.file, {overwrite: true});
            this.meta = await thread.call('open', this.file);
            this.progress = 1;
            this.ready = (generation === this.generation);
            log(`Catalog index built in ${((Date.now() - started) / 1000).toFixed(1)}s: ${counts.books} books, ${counts.authors} authors, ${counts.series} series, ${counts.aliases} English author names`);
            return true;
        } catch (e) {
            await thread.call('abortBuild').catch(() => {});
            await fs.remove(tmpFile).catch(() => {});
            throw e;
        } finally {
            this.building = false;
        }
    }

    //Скачивание английских имён авторов (администратор); по окончании индекс перестраивается
    startAuthorNamesDownload() {
        return this.authorNames.start(async() => {
            if (this.worker.db && this.enabled)
                await this.ensure(this.worker.db, this.inpxHash, {keepReady: this.ready});
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

    checkReady() {
        if (!this.ready)
            throw new Error('catalog_index_not_ready');
    }

    async search(request = {}) {
        this.checkReady();
        const result = await this.getThread().call('search', request);
        const books = await this.loadBooks(result.ids);
        delete result.ids;
        return Object.assign(result, {books});
    }

    async suggest(request = {}) {
        this.checkReady();
        const result = await this.getThread().call('suggest', request);
        const uids = await this.loadBooks(result.books.map(book => book.id));
        result.books = uids.map(book => ({_uid: book._uid, title: book.title, author: book.author, ext: book.ext, lang: book.lang}));
        return result;
    }

    //Записи книг из основной БД в порядке выдачи индекса, с правками метаданных
    async loadBooks(ids = []) {
        if (!ids.length)
            return [];
        const db = this.worker.db;
        const rows = await db.select({table: 'book', where: `@@id(${db.esc(ids)})`});
        const byId = new Map(rows.map(row => [row.id, row]));
        const books = ids.map(id => byId.get(id)).filter(Boolean);
        await this.worker.applyMetadataOverridesToSearchResult({books});
        return books;
    }

    async updateBook(row) {
        if (!this.ready || !row || !row.id)
            return;
        try {
            await this.getThread().call('updateBook', this.file, {
                id: row.id, title: row.title, author: row.author, series: row.series, serno: row.serno,
                lang: row.lang, librate: row.librate, keywords: row.keywords,
            });
        } catch (e) {
            log(LM_WARN, `Catalog index update: ${e.message}`);
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
}

module.exports = CatalogSearch;
