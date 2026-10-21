//Названия произведений на разных языках из Wikidata: «Гиперион» - «Hyperion» (Дэн Симмонс).
//Таблица скачивается администратором в <dataDir>/work-titles.json. По ней «Другие издания» и «Возможные замены»
//находят ту же книгу под названием на другом языке: название совпало с одним из названий произведения, а первый
//автор книги - с одним из его авторов.
const {normalize} = require('./textNorm');
const WikidataTable = require('./WikidataTable');

//Произведения со статьёй в Википедии: такой запрос отвечает целиком за 10-20 с. Все литературные произведения
//с русским и английским названием - больше минуты (предел Wikidata - 60 с), а постранично с ORDER BY каждая страница
//считается заново (~35 с), без ORDER BY страницы повторяют друг друга. Литературные произведения английской Википедии
//тоже не укладываются в минуту.
//[Википедия, тип]: литературное произведение (романы, повести, рассказы - вид указан отдельно), письменное произведение
const sources = [['ru', 'Q7725634'], ['ru', 'Q47461344'], ['en', 'Q47461344']];

//P1476 - название на языке оригинала
function sourceQuery([wiki, type]) {
    return `SELECT ?item ?ru ?en ?title ?aru ?aen WHERE {
  ?article schema:about ?item ; schema:isPartOf <https://${wiki}.wikipedia.org/> .
  ?item wdt:P31 wd:${type} ; wdt:P50 ?a .
  ?item rdfs:label ?ru . FILTER(LANG(?ru) = "ru")
  ?item rdfs:label ?en . FILTER(LANG(?en) = "en")
  OPTIONAL { ?item wdt:P1476 ?title }
  OPTIONAL { ?a rdfs:label ?aru . FILTER(LANG(?aru) = "ru") }
  OPTIONAL { ?a rdfs:label ?aen . FILTER(LANG(?aen) = "en") }
}`;
}

const strings = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(String) : []);

//Содержимое work-titles.json: записи [названия[], авторы[]]; запись без двух названий или без автора не нужна
function normalizeData(raw = {}) {
    const entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .filter(row => Array.isArray(row))
        .map(row => [strings(row[0]), strings(row[1])])
        .filter(([titles, authors]) => new Set(titles.map(normalize)).size > 1 && authors.length);
    return {source: String(raw.source || 'wikidata'), updatedAt: String(raw.updatedAt || ''), entries};
}

//ь и ъ пишут не везде: «Дойль» и «Дойл»
const words = name => [...new Set(normalize(name).replace(/[ьъ]/g, '').split(' ').filter(Boolean))];//i18n-ignore: данные поиска

//Первый автор книги библиотеки («Симмонс Дэн» или «Simmons Dan»; авторы через запятую) - тот же, что в другой записи
//(«Дэн Симмонс»): первые два слова в любом порядке, отчество и второе имя не обязательны
function sameAuthor(libraryAuthor = '', otherAuthor = '') {
    const wanted = words(String(libraryAuthor).split(',')[0]).slice(0, 2);
    const known = new Set(words(otherAuthor));
    return wanted.length > 1 && wanted.every(word => known.has(word));
}

//Первый автор книги библиотеки - автор произведения из Wikidata. Строже sameAuthor: первые два слова «Конан Дойль Артур» -
//обе фамилия, и они есть у «Адриан Конан Дойль». Поэтому слова одного имени все есть в другом; инициал - начало слова
function sameWorkAuthor(libraryAuthor = '', workAuthor = '') {
    const own = words(String(libraryAuthor).split(',')[0]);
    const known = words(workAuthor);
    const inside = (some, all) => some.every(word => all.includes(word) || (word.length === 1 && all.some(other => other.startsWith(word))));
    return sameAuthor(libraryAuthor, workAuthor) && (inside(own, known) || inside(known, own));
}

class WorkTitles extends WikidataTable {
    constructor(config, fetchJson = null) {
        super(config, {
            file: 'work-titles.json',
            purpose: 'work titles in other languages',
            pageSize: 0,
            queries: sources.map(source => () => sourceQuery(source)),
            addRow(rows, binding) {
                const item = WikidataTable.value(binding, 'item');
                if (!item)
                    return;
                const row = rows.get(item) || rows.set(item, {titles: new Set(), authors: new Set()}).get(item);
                for (const name of ['ru', 'en', 'title'])
                    if (WikidataTable.value(binding, name))
                        row.titles.add(WikidataTable.value(binding, name));
                for (const name of ['aru', 'aen'])
                    if (WikidataTable.value(binding, name))
                        row.authors.add(WikidataTable.value(binding, name));
            },
            entries: rows => normalizeData({entries: [...rows.values()].map(row => [[...row.titles], [...row.authors]])}).entries,
            normalizeData,
        }, fetchJson);
        this.lookup = null;
    }

    changed() {
        super.changed();
        this.lookup = null;
    }

    //нормализованное название -> записи; строится при первом запросе после скачивания или импорта
    async byTitle() {
        if (!this.lookup) {
            this.lookup = (async() => {
                const map = new Map();
                for (const [titles, authors] of (await this.readEntries()).entries) {
                    const work = {titles: [...new Set(titles.map(normalize))], authors};
                    for (const title of work.titles)
                        (map.get(title) || map.set(title, []).get(title)).push(work);
                }
                return map;
            })();
        }
        return await this.lookup;
    }

    //Названия той же книги на других языках: {titles: нормализованные названия, authors: имена авторов произведений}
    async sameWork(title = '', author = '') {
        const works = ((await this.byTitle()).get(normalize(title)) || [])
            .filter(work => work.authors.some(name => sameWorkAuthor(author, name)));
        return {
            titles: [...new Set(works.flatMap(work => work.titles))],
            authors: [...new Set(works.flatMap(work => work.authors))],
        };
    }
}

module.exports = WorkTitles;
module.exports.normalizeData = normalizeData;
module.exports.sameAuthor = sameAuthor;
module.exports.sameWorkAuthor = sameWorkAuthor;
