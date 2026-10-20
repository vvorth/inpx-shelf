//Таблица из Wikidata, которую администратор скачивает в <dataDir>/<file>: английские имена авторов, названия произведений.
//Скачивание постранично по SPARQL-запросам, с повтором при 429/5xx; файл заменяется только целиком скачанным.
const fs = require('fs-extra');

const {t} = require('../i18n');
const {withFileTransaction, writeFileAtomic} = require('../FilePersistence');

const endpoint = 'https://query.wikidata.org/sparql';

//ошибка с ключом перевода: фоновая задача хранит описание, текст получается в браузере на языке интерфейса
function keyError(key, params) {
    return Object.assign(new Error(t(key, params)), {i18nKey: key, i18nParams: params});
}

class WikidataTable {
    //options: file - имя файла в dataDir; purpose - для User-Agent; pageSize (0 - запрос без страниц);
    //queries - функции (offset) => SPARQL, каждая листается до неполной страницы;
    //addRow(rows: Map, binding) - собирает строку ответа; entries(rows) - записи файла; normalizeData(raw) - содержимое файла
    constructor(config, options, fetchJson = null) {
        this.config = config;
        this.options = options;
        this.file = `${config.dataDir}/${options.file}`;
        this.fetchJson = fetchJson || this.defaultFetchJson.bind(this);
        this.job = null;
        this.retryDelayMs = 5000;
        this.state = {running: false, progress: 0, error: '', message: ''};
    }

    async defaultFetchJson(query) {
        const axios = require('axios');
        const version = this.config.version || '';
        const response = await axios.get(endpoint, {
            params: {query, format: 'json'},
            headers: {
                'Accept': 'application/sparql-results+json',
                //правила Wikidata Query Service требуют понятный User-Agent
                'User-Agent': `inpx-shelf/${version} (https://github.com/vvorth/inpx-shelf; ${this.options.purpose})`,
            },
            timeout: 120 * 1000,
            responseType: 'json',
        });
        return response.data;
    }

    //сведения о таблице кешируются: get-config спрашивает их при каждом открытии приложения
    async info() {
        if (!this.infoCache) {
            try {
                const data = await fs.readJson(this.file);
                this.infoCache = {ready: true, updatedAt: String(data.updatedAt || ''), count: (data.entries || []).length};
            } catch (e) {
                this.infoCache = {ready: false, updatedAt: '', count: 0};
            }
        }
        return Object.assign({}, this.infoCache);
    }

    //файл заменён (скачан, импортирован, восстановлен из бэкапа): сведения и производные данные читаются заново
    changed() {
        this.infoCache = null;
    }

    async readEntries() {
        try {
            const data = await fs.readJson(this.file);
            return {entries: Array.isArray(data.entries) ? data.entries : [], updatedAt: String(data.updatedAt || '')};
        } catch (e) {
            return {entries: [], updatedAt: ''};
        }
    }

    status() {
        return Object.assign({}, this.state);
    }

    //Запуск скачивания в фоне; onDone вызывается после записи файла
    start(onDone) {
        if (this.state.running)
            return this.status();

        this.state = {running: true, progress: 0, error: '', message: ''};
        this.job = this.download()
            .then(async(count) => {
                this.state = {running: false, progress: 1, error: '', message: `${count}`};
                if (onDone)
                    await onDone();
            })
            .catch((e) => {
                this.state = {running: false, progress: 0, error: (e.i18nKey ? {key: e.i18nKey, params: e.i18nParams} : e.message), message: ''};
            });
        return this.status();
    }

    async download() {
        const {queries, pageSize, addRow} = this.options;
        const rows = new Map();
        for (let i = 0; i < queries.length; i++) {
            for (let offset = 0; ; offset += pageSize) {
                const data = await this.fetchWithRetry(queries[i](offset));
                const bindings = (data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : []);
                for (const binding of bindings)
                    addRow(rows, binding);
                if (!pageSize || bindings.length < pageSize)
                    break;
            }
            this.state.progress = (i + 1) / queries.length;
        }

        const entries = this.options.entries(rows);
        if (!entries.length)
            throw keyError('errors.wikidataNoNames');

        const data = this.options.normalizeData({source: 'wikidata', updatedAt: new Date().toISOString(), entries});
        // Тот же замок, что у восстановления из бэкапа: долгая загрузка не затрёт только что восстановленный файл.
        await withFileTransaction(this.file, () => writeFileAtomic(this.file, JSON.stringify(data)));
        this.changed();
        return entries.length;
    }

    async fetchWithRetry(query) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await this.fetchJson(query);
            } catch (e) {
                lastError = e;
                //429 и 5xx бывают при нагрузке на сервис: ждём и пробуем снова
                await new Promise(resolve => setTimeout(resolve, (attempt + 1) * this.retryDelayMs));
            }
        }
        throw keyError('errors.wikidataUnavailable', {message: (lastError ? lastError.message : '')});
    }
}

//значение поля ответа SPARQL
WikidataTable.value = (binding, name) => String((binding[name] && binding[name].value) || '');

module.exports = WikidataTable;
