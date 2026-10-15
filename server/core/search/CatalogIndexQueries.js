//Запросы OPDS к индексу каталога: поиск книг по полям и навигация по алфавиту. Методы подмешиваются в CatalogIndex.
//Имена сравниваются в нормализованном виде (name_norm / title_norm): регистр, ё/е и пунктуация не важны.
//Условия по книге (жанр, язык, удалённые) проверяются по колонкам в памяти через SQL-функцию catalog_ok:
//так не нужны ни индекс по жанрам, ни соединения с book_genre.
const {normalize} = require('./textNorm');
const {checkSearchRegExp} = require('../utils');

const maxLimit = 1000;
const maxChar = '￿';
const regExps = new Map();

//запросы синхронны, поэтому текущая маска и отметки лежат в модуле
let currentMask = null;
let currentMarks = null;

//нормализация префикса без обрезки пробела в конце: «иван » - это уже следующая буква навигации
function normalizePrefix(text = '') {
    return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^ /, '');//i18n-ignore: данные поиска
}

function regExpFor(pattern) {
    let re = regExps.get(pattern);
    if (!re) {
        re = checkSearchRegExp(pattern);
        if (regExps.size > 200)
            regExps.clear();
        regExps.set(pattern, re);
    }
    return re;
}

function requireDb(index) {
    if (!index.db)
        throw new Error('catalog_index_not_ready');
    if (!index.db.catalogFunctions) {
        index.db.function('catalog_re', {deterministic: true}, (pattern, value) => (regExpFor(pattern).test(String(value || '')) ? 1 : 0));
        index.db.function('catalog_ok', {deterministic: true}, id => currentMask[id]);
        index.db.function('catalog_mark', id => {
            currentMarks[id] = 1;
            return 1;
        });
        index.db.catalogFunctions = true;
    }
    if (!index.columns)
        index.loadColumns();
}

const fields = {
    author: {norm: 'a.name_norm', raw: 'a.name'},
    series: {norm: 's.name_norm', raw: 's.name'},
    title: {norm: 'b.title_norm', raw: 'b.title'},
};

//Условие по значению с маркером: нет - префикс, = точно, * содержит, # содержит и не начинается с буквы ru/en, ~ RegExp
function valueCondition(field, value, params) {
    const {norm, raw} = fields[field];
    const mode = ('=*#~'.includes(value[0]) ? value[0] : '');
    const text = (mode ? value.substring(1) : value);

    if (mode === '~') {
        regExpFor(text);
        params.push(text);
        return `catalog_re(?, ${raw})`;
    }
    if (mode === '=') {
        params.push(normalize(text));
        return `${norm} = ?`;
    }
    const p = normalizePrefix(text);
    //значение из одной пунктуации («???» после неудачной перекодировки) в нормализованных именах ничему не соответствует
    if (text && !p)
        return '0';
    if (mode === '*' || mode === '#') {
        params.push(p);
        return `(${norm} != '' AND instr(${norm}, ?) > 0${mode === '#' ? ` AND ${norm} NOT GLOB '[а-яa-z]*'` : ''})`;//i18n-ignore: данные поиска
    }
    if (!p)
        return '';
    params.push(p, p + maxChar);
    return `(${norm} >= ? AND ${norm} < ?)`;
}

const hasValue = value => (value !== undefined && value !== null && value !== '');
const hasBookFilter = query => !!(query.genre || query.lang || hasValue(query.del));

//Кэш запросов живёт, пока не перечитаны колонки и не было правки метаданных (updateBook сбрасывает его)
function queryCache(index) {
    if (!index.queryMasks || index.queryMasks.columns !== index.columns)
        index.queryMasks = {columns: index.columns, masks: new Map(), groups: new Map(), totals: new Map()};
    return index.queryMasks;
}

//Маска книг, подходящих под genre, lang и del: Uint8Array по id книги; маски запоминаются до смены колонок
function bookMask(index, query) {
    const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    const genres = list(query.genre);
    const langs = list(query.lang).map(item => (item === '?' ? '' : item.toLowerCase()));
    const del = (hasValue(query.del) ? (parseInt(query.del, 10) ? 1 : 0) : -1);
    const key = JSON.stringify([genres, langs, del]);

    const cache = queryCache(index).masks;
    if (cache.has(key))
        return cache.get(key);

    const c = index.columns;
    const codes = (field, values) => new Set(values.map(value => c.codes[field].get(value) ?? c.codes[field].get(value.toLowerCase())).filter(code => code !== undefined));
    const genreCodes = codes('genre', genres);
    const langCodes = codes('lang', langs);
    const mask = new Uint8Array(c.maxId + 1);
    if ((!genres.length || genreCodes.size) && (!langs.length || langCodes.size)) {
        for (let id = 1; id <= c.maxId; id++) {
            const flags = c.flags[id];
            if (!(flags & 1) || (del >= 0 && !!(flags & 2) !== !!del) || (langs.length && !langCodes.has(c.lang[id])))
                continue;
            if (genres.length) {
                let found = false;
                for (let i = c.genreStart[id]; i < c.genreStart[id + 1] && !found; i++)
                    found = genreCodes.has(c.genreList[i]);
                if (!found)
                    continue;
            }
            mask[id] = 1;
        }
    }

    if (cache.size >= 8)
        cache.clear();
    cache.set(key, mask);
    return mask;
}

//Условие «у имени есть подходящие книги» для таблиц author/series (alias a / s): без жанра и языка хватает готового счётчика.
//С выключенными библиотеками маска нужна и без фильтров: имя только из их книг не показывается
function availability(index, from, query) {
    if (!hasBookFilter(query) && !index.hidden.size)
        return [];
    if (!query.genre && !query.lang && String(query.del) === '0')
        return [`${index.booksSql(from, from === 'author' ? 'a' : 's')} > 0`];

    currentMask = bookMask(index, query);
    return [from === 'author'
        ? 'EXISTS (SELECT 1 FROM book_author ba WHERE ba.author_id = a.id AND catalog_ok(ba.book_id))'
        : 'EXISTS (SELECT 1 FROM book b WHERE b.series_norm = s.name_norm AND catalog_ok(b.id))'];
}

//Условия по книгам b для query: author, series, title, genre, lang, del
function bookWhere(index, query, params) {
    const where = [];
    if (query.author) {
        const sub = [];
        const cond = valueCondition('author', String(query.author), sub);
        if (cond) {
            params.push(...sub);
            where.push(`b.id IN (SELECT ba.book_id FROM book_author ba JOIN author a ON a.id = ba.author_id WHERE ${cond})`);
        }
    }
    if (query.series) {
        const sub = [];
        const cond = valueCondition('series', String(query.series), sub);
        if (cond) {
            params.push(...sub);
            where.push(`b.series_norm IN (SELECT s.name_norm FROM series s WHERE ${cond})`);
        }
    }
    if (query.title) {
        const cond = valueCondition('title', String(query.title), params);
        if (cond)
            where.push(cond);
    }
    //поиск по одной библиотеке (сопоставление внешней витрины по источникам)
    if (query.sourceId) {
        params.push(String(query.sourceId));
        where.push('b.source = ?');
    }
    if (hasBookFilter(query) || index.hidden.size) {
        currentMask = bookMask(index, query);
        where.push('catalog_ok(b.id)');
    }
    return where;
}

const whereSql = where => (where.length ? ` WHERE ${where.join(' AND ')}` : '');

//Группы названий с префиксом prefix. Переход от группы к группе идёт по индексу: сортировать
//все названия библиотеки ради группировки по первым буквам слишком долго.
function titleGroups(index, prefix, depth, query) {
    const where = bookWhere(index, Object.assign({}, query, {author: '', series: '', title: ''}), []);
    where.push('b.title_norm >= ? AND b.title_norm < ?');
    const next = index.db.prepare('SELECT substr(title_norm, 1, ?) AS value FROM book WHERE title_norm >= ? AND title_norm < ? ORDER BY title_norm LIMIT 1');
    const stats = index.db.prepare(`SELECT COUNT(DISTINCT b.title_norm) AS count, COUNT(*) AS bookCount, MIN(b.id) AS id FROM book b WHERE ${where.join(' AND ')}`);

    const found = [];
    let from = prefix;
    for (let row = next.get(depth, from, prefix + maxChar); row; row = next.get(depth, from, prefix + maxChar)) {
        //название короче глубины - группа из него одного, иначе все названия с этим началом
        const to = row.value + (Array.from(row.value).length < depth ? '\u0000' : maxChar);
        const stat = stats.get(row.value, to);
        from = to;
        if (stat.count)
            found.push({id: stat.id, name: undefined, value: row.value, count: stat.count, bookCount: stat.bookCount});
    }
    found.sort((a, b) => a.value.localeCompare(b.value));
    return {found, totalFound: found.reduce((sum, row) => sum + row.count, 0)};
}

//В порядке OPDS у одного автора книги без серии идут после серий, а сортировка индекса ставит их первыми:
//переставляем внутри страницы (авторов у книг страницы немного, поэтому по book_author через IN)
function seriesLast(index, ids) {
    if (ids.length < 2)
        return ids;
    const marks = ids.map(() => '?').join(',');
    const hasSeries = new Map(index.db.prepare(`SELECT id, series_norm != '' AS s FROM book WHERE id IN (${marks})`).all(...ids).map(row => [row.id, row.s]));
    if (new Set(hasSeries.values()).size < 2)
        return ids;

    const signature = new Map(index.db.prepare(`SELECT book_id AS id, group_concat(author_id) AS g FROM (
        SELECT book_id, author_id FROM book_author WHERE book_id IN (${marks}) ORDER BY author_id) GROUP BY book_id`).all(...ids).map(row => [row.id, row.g]));
    const first = new Map();
    ids.forEach((id, i) => first.has(signature.get(id)) || first.set(signature.get(id), i));
    const position = new Map(ids.map((id, i) => [id, i]));
    return ids.slice().sort((a, b) => (first.get(signature.get(a)) - first.get(signature.get(b)))
        || (hasSeries.get(b) - hasSeries.get(a)) || (position.get(a) - position.get(b)));
}

module.exports = {
    //Поиск книг: {ids, totalFound}; порядок как в «Автор, серия, номер, название»
    findBooks(query = {}) {
        requireDb(this);

        const params = [];
        const where = bookWhere(this, query, params);
        currentMarks = new Uint8Array(this.columns.maxId + 1);
        const total = this.db.prepare(`SELECT COUNT(catalog_mark(b.id)) AS n FROM book b${whereSql(where)}`).get(...params).n;
        const marks = currentMarks;
        currentMarks = null;

        const limit = Math.max(1, Math.min(maxLimit, parseInt(query.limit, 10) || 100));
        const offset = Math.max(0, parseInt(query.offset, 10) || 0);
        const ids = [];
        const order = this.columns.order.author;
        for (let i = 0, skipped = 0; i < order.length && ids.length < limit; i++) {
            if (!marks[order[i]])
                continue;
            if (skipped < offset)
                skipped++;
            else
                ids.push(order[i]);
        }
        return {ids: seriesLast(this, ids), totalFound: total};
    },

    //Группы имён по первым depth символам: [{id, name, value, count, bookCount}] по возрастанию value.
    //Для названий id - id одной из книг группы, name не заполняется (название берётся из записи книги)
    opdsGroups(from, query = {}) {
        if (!fields[from])
            throw new Error(`Unknown value for param 'from'`);
        requireDb(this);

        const depth = Math.max(1, parseInt(query.depth, 10) || 1);
        const cache = queryCache(this).groups;
        const key = JSON.stringify([from, depth, query[from] || '', query.genre || '', query.lang || '', query.del]);
        if (cache.has(key))
            return cache.get(key);
        const result = this.opdsGroupsUncached(from, query, depth);
        if (cache.size >= 200)
            cache.clear();
        cache.set(key, result);
        return result;
    },

    opdsGroupsUncached(from, query, depth) {
        const params = [depth];
        let sql;
        if (from === 'title') {
            const title = String(query.title || '');
            if (!title || !'=*#~'.includes(title[0]))
                return titleGroups(this, normalizePrefix(title), depth, query);
            const where = bookWhere(this, Object.assign({}, query, {author: '', series: ''}), params);
            sql = `SELECT substr(t, 1, ?) AS value, COUNT(*) AS count, SUM(n) AS bookCount, MIN(i) AS id FROM (
                    SELECT b.title_norm AS t, COUNT(*) AS n, MIN(b.id) AS i FROM book b${whereSql(where)} GROUP BY b.title_norm
                ) GROUP BY value`;
        } else {
            const alias = (from === 'author' ? 'a' : 's');
            const where = [];
            const cond = (query[from] ? valueCondition(from, String(query[from]), params) : '');
            if (cond)
                where.push(cond);
            where.push(...availability(this, from, query));
            sql = `SELECT substr(${alias}.name_norm, 1, ?) AS value, COUNT(*) AS count, SUM(${this.booksSql(from, alias)}) AS bookCount, MIN(${alias}.id) AS id, MIN(${alias}.name) AS name
                FROM ${from} ${alias}${whereSql(where)} GROUP BY value`;
        }

        const found = this.db.prepare(sql).all(...params).map(row => ({
            id: row.id, name: row.name, value: row.value, count: row.count, bookCount: row.bookCount,
        }));
        found.sort((a, b) => a.value.localeCompare(b.value));
        return {found, totalFound: found.reduce((sum, row) => sum + row.count, 0)};
    },

    //Имена, подходящие под запрос, по алфавиту: {found: [{id, author|series, bookCount}], totalFound}.
    //Для названий id - id книги с этим названием, само название берётся из записи книги
    opdsNames(from, query = {}) {
        if (!fields[from])
            throw new Error(`Unknown value for param 'from'`);
        requireDb(this);

        const limit = Math.max(1, Math.min(maxLimit, parseInt(query.limit, 10) || 100));
        const offset = Math.max(0, parseInt(query.offset, 10) || 0);
        const params = [];
        let select;
        let order;
        if (from === 'title') {
            const where = bookWhere(this, Object.assign({}, query, {author: '', series: ''}), params);
            select = `SELECT MIN(b.id) AS id, COUNT(*) AS bookCount FROM book b${whereSql(where)} GROUP BY b.title_norm`;
            order = 'ORDER BY b.title_norm';
        } else {
            const alias = (from === 'author' ? 'a' : 's');
            const where = [];
            const cond = (query[from] ? valueCondition(from, String(query[from]), params) : '');
            if (cond)
                where.push(cond);
            where.push(...availability(this, from, query));
            select = `SELECT ${alias}.id AS id, ${alias}.name AS ${from}, ${this.booksSql(from, alias)} AS bookCount FROM ${from} ${alias}${whereSql(where)}`;
            order = `ORDER BY ${alias}.name_norm, ${alias}.id`;
        }

        const found = this.db.prepare(`${select} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
        //итог одинаков для всех страниц, а у названий это второй GROUP BY по книгам: запоминается, как группы
        const totals = queryCache(this).totals;
        const key = JSON.stringify([select, params]);
        if (!totals.has(key)) {
            if (totals.size >= 200)
                totals.clear();
            totals.set(key, this.db.prepare(`SELECT COUNT(*) AS n FROM (${select})`).get(...params).n);
        }
        return {found: found.map(row => Object.assign({}, row)), totalFound: totals.get(key)};
    },
};
