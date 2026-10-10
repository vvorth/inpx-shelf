//Английские имена авторов из Wikidata: «Азимов Айзек» -> «Isaac Asimov».
//Таблица скачивается администратором один раз (несколько МБ) и хранится в <dataDir>/author-names.json.
//Сопоставление с именами библиотеки - по набору слов имени без учёта порядка.
const fs = require('fs-extra');

const {normalize} = require('./textNorm');

const endpoint = 'https://query.wikidata.org/sparql';
const pageSize = 20000;

//писатель, романист, поэт, детский писатель, фантаст, автор рассказов, драматург, эссеист, автор, переводчик, сценарист
const occupations = ['Q36180', 'Q6625963', 'Q49757', 'Q4853732', 'Q18844224', 'Q15949613', 'Q214917', 'Q11774202', 'Q482980', 'Q333634', 'Q28389'];

function occupationQuery(occupation, offset) {
    return `SELECT ?item ?ru ?en WHERE {
  ?item wdt:P106 wd:${occupation} .
  ?item rdfs:label ?ru . FILTER(LANG(?ru) = "ru")
  ?item rdfs:label ?en . FILTER(LANG(?en) = "en")
} LIMIT ${pageSize} OFFSET ${offset}`;
}

//Ключ имени: слова в алфавитном порядке, чтобы «Айзек Азимов» и «Азимов Айзек» совпали
function nameKey(name = '') {
    return normalize(name).split(' ').filter(Boolean).sort().join(' ');
}

//Ключи имени из библиотеки «Фамилия Имя Отчество»: полное имя и без отчества
function libraryKeys(name = '') {
    const words = normalize(name).split(' ').filter(Boolean);
    const keys = [words.slice().sort().join(' ')];
    if (words.length > 2)
        keys.push(words.slice(0, 2).sort().join(' '));
    return keys.filter(key => key.includes(' '));
}

//Таблица ключ -> английское имя; ключи с разными английскими именами (тёзки) отбрасываются
function buildLookup(entries = []) {
    const map = new Map();
    const ambiguous = new Set();
    for (const [ru, en] of entries) {
        const key = nameKey(ru);
        const english = String(en || '').trim();
        if (!key.includes(' ') || !/[a-z]/i.test(english))
            continue;
        const previous = map.get(key);
        if (previous === undefined)
            map.set(key, english);
        else if (normalize(previous) !== normalize(english))
            ambiguous.add(key);
    }
    for (const key of ambiguous)
        map.delete(key);
    return map;
}

//Английское имя автора библиотеки или ''. Совпадение с самим именем (латиница в библиотеке) не нужно.
function englishName(lookup, name = '') {
    for (const key of libraryKeys(name)) {
        const english = lookup.get(key);
        if (english && nameKey(english) !== nameKey(name))
            return english;
    }
    return '';
}

class AuthorNames {
    constructor(config, fetchJson = null) {
        this.config = config;
        this.file = `${config.dataDir}/author-names.json`;
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
                'User-Agent': `inpx-web/${version} (https://github.com/AceAsket/inpx-web; author name aliases)`,
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

    //Запуск скачивания в фоне; onDone вызывается после записи файла (перестройка индекса)
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
                this.state = {running: false, progress: 0, error: e.message, message: ''};
            });
        return this.status();
    }

    async download() {
        const byItem = new Map();
        for (let i = 0; i < occupations.length; i++) {
            for (let offset = 0; ; offset += pageSize) {
                const data = await this.fetchWithRetry(occupationQuery(occupations[i], offset));
                const rows = (data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : []);
                for (const row of rows) {
                    const item = row.item && row.item.value;
                    const ru = row.ru && row.ru.value;
                    const en = row.en && row.en.value;
                    if (item && ru && en)
                        byItem.set(item, [ru, en]);
                }
                if (rows.length < pageSize)
                    break;
            }
            this.state.progress = (i + 1) / occupations.length;
        }

        if (!byItem.size)
            throw new Error('Wikidata не вернула ни одного имени');

        const tmpFile = `${this.file}.tmp`;
        await fs.writeJson(tmpFile, {source: 'wikidata', updatedAt: new Date().toISOString(), entries: [...byItem.values()]});
        await fs.move(tmpFile, this.file, {overwrite: true});
        this.infoCache = null;
        return byItem.size;
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
        throw new Error(`Wikidata недоступна: ${lastError ? lastError.message : ''}`);
    }
}

module.exports = AuthorNames;
module.exports.buildLookup = buildLookup;
module.exports.englishName = englishName;
module.exports.nameKey = nameKey;
