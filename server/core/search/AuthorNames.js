//Английские имена авторов из Wikidata: «Азимов Айзек» -> «Isaac Asimov».
//Таблица скачивается администратором один раз (несколько МБ) и хранится в <dataDir>/author-names.json.
//Сопоставление с именами библиотеки - по набору слов имени без учёта порядка.
const {normalize} = require('./textNorm');
const WikidataTable = require('./WikidataTable');

const pageSize = 20000;

//писатель, романист, поэт, детский писатель, фантаст, автор рассказов, драматург, эссеист, автор, переводчик, сценарист
const occupations = ['Q36180', 'Q6625963', 'Q49757', 'Q4853732', 'Q18844224', 'Q15949613', 'Q214917', 'Q11774202', 'Q482980', 'Q333634', 'Q28389'];

//без ORDER BY порядок строк между страницами не определён: имена терялись бы и повторялись
function occupationQuery(occupation, offset) {
    return `SELECT ?item ?ru ?en WHERE {
  ?item wdt:P106 wd:${occupation} .
  ?item rdfs:label ?ru . FILTER(LANG(?ru) = "ru")
  ?item rdfs:label ?en . FILTER(LANG(?en) = "en")
} ORDER BY ?item LIMIT ${pageSize} OFFSET ${offset}`;
}

//ь и ъ пишут не везде: «Конан Дойль Артур» в библиотеке, «Артур Конан Дойл» в Wikidata
const words = name => normalize(name).replace(/[ьъ]/g, '').split(' ').filter(Boolean);//i18n-ignore: данные поиска

//Ключ имени: слова в алфавитном порядке, чтобы «Айзек Азимов» и «Азимов Айзек» совпали
function nameKey(name = '') {
    return words(name).sort().join(' ');
}

//Ключи имени из библиотеки «Фамилия Имя Отчество»: полное имя и без отчества
function libraryKeys(name = '') {
    const own = words(name);
    const keys = [own.slice().sort().join(' ')];
    if (own.length > 2)
        keys.push(own.slice(0, 2).sort().join(' '));
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

//Содержимое author-names.json: после скачивания, из бэкапа или импорта - только пары строк [русское имя, английское]
function normalizeData(raw = {}) {
    const entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .filter(row => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string')
        .map(row => [row[0], row[1]]);
    return {source: String(raw.source || 'wikidata'), updatedAt: String(raw.updatedAt || ''), entries};
}

class AuthorNames extends WikidataTable {
    constructor(config, fetchJson = null) {
        super(config, {
            file: 'author-names.json',
            purpose: 'author name aliases',
            pageSize,
            queries: occupations.map(occupation => offset => occupationQuery(occupation, offset)),
            addRow(rows, binding) {
                const item = WikidataTable.value(binding, 'item');
                const ru = WikidataTable.value(binding, 'ru');
                const en = WikidataTable.value(binding, 'en');
                if (item && ru && en)
                    rows.set(item, [ru, en]);
            },
            entries: rows => [...rows.values()],
            normalizeData,
        }, fetchJson);
    }
}

module.exports = AuthorNames;
module.exports.buildLookup = buildLookup;
module.exports.englishName = englishName;
module.exports.nameKey = nameKey;
module.exports.normalizeData = normalizeData;
