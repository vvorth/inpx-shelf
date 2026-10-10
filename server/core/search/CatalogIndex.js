//Поисковый индекс каталога на SQLite (node:sqlite) с полнотекстовым поиском FTS5.
//Строится из таблицы book основной БД; работает синхронно, поэтому запускается в отдельном потоке
//(см. CatalogIndexThread). Отвечает идентификаторами книг, сами записи берутся из основной БД.
const {DatabaseSync} = require('node:sqlite');

const {normalize, tokens, switchLayout, editDistance, allowedTypos, trigrams} = require('./textNorm');
const {copyKey} = require('./copyKey');

const schemaVersion = '4';
const maxLimit = 200;
const facetFields = ['lang', 'ext', 'genre', 'source', 'librate'];
const powerFields = new Map([
    ['author', 'author'], ['автор', 'author'],
    ['title', 'title'], ['название', 'title'],
    ['series', 'series'], ['серия', 'series'],
    ['genre', 'genre'], ['жанр', 'genre'],
    ['lang', 'lang'], ['язык', 'lang'],
    ['ext', 'ext'], ['format', 'ext'], ['формат', 'ext'],
    ['source', 'source'], ['rating', 'librate'],
]);

const schema = `
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sort_order(name TEXT PRIMARY KEY, ids BLOB NOT NULL);
    CREATE TABLE book(
        id INTEGER PRIMARY KEY, uid TEXT NOT NULL, title_norm TEXT, author_norm TEXT, series_norm TEXT, serno INTEGER, lang TEXT, ext TEXT, size INTEGER, date TEXT,
        librate INTEGER, del INTEGER, source TEXT, copy_key TEXT, is_copy INTEGER DEFAULT 0, is_copy_src INTEGER DEFAULT 0
    );
    CREATE TABLE book_genre(book_id INTEGER NOT NULL, genre TEXT NOT NULL);
    CREATE TABLE author(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE TABLE book_author(book_id INTEGER NOT NULL, author_id INTEGER NOT NULL);
    CREATE TABLE series(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE TABLE term(id INTEGER PRIMARY KEY, term TEXT NOT NULL, docs INTEGER NOT NULL);
    CREATE TABLE name(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref INTEGER NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE VIRTUAL TABLE book_fts USING fts5(
        title, author, series, keywords,
        content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
`;

//фильтры и сортировка работают по колонкам в памяти; индексы нужны только точным совпадениям и именам
const postBuildSchema = `
    CREATE INDEX book_title_norm ON book(title_norm);
    CREATE INDEX book_series_norm ON book(series_norm);
    CREATE INDEX name_kind_norm ON name(kind, name_norm);
    CREATE INDEX book_author_author ON book_author(author_id, book_id);
    CREATE INDEX author_norm ON author(name_norm);
    CREATE VIRTUAL TABLE term_tri USING fts5(term, content='term', content_rowid='id', tokenize='trigram');
    CREATE VIRTUAL TABLE name_tri USING fts5(name_norm, content='name', content_rowid='id', tokenize='trigram');
`;

const sortOrderSql = {
    date: 'SELECT id FROM book ORDER BY date DESC, id DESC',
    title: 'SELECT id FROM book ORDER BY title_norm, id',
    author: 'SELECT id FROM book ORDER BY author_norm, series_norm, serno, title_norm, id',
    rating: 'SELECT id FROM book ORDER BY librate DESC, date DESC, id DESC',
};

function splitAuthors(value = '') {
    return String(value || '').split(',').map(name => name.trim()).filter(Boolean);
}

function ftsPhrase(token, prefix = true) {
    return `"${token.replace(/"/g, '')}"${prefix && token.length >= 2 ? '*' : ''}`;
}

function dateDaysAgo(days) {
    const date = new Date(Date.now() - days * 24 * 3600 * 1000);
    return date.toISOString().substring(0, 10);
}

class CatalogIndex {
    constructor() {
        this.db = null;
        this.build = null;
    }

    //---------- открытие ----------
    open(file) {
        this.close();
        const db = new DatabaseSync(file, {readOnly: true});
        try {
            const version = db.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get();
            if (!version || version.value !== schemaVersion)
                throw new Error('catalog index: schema version mismatch');
        } catch (e) {
            db.close();
            throw e;
        }
        this.db = db;
        return this.meta();
    }

    meta() {
        if (!this.db)
            return {};
        const result = {};
        for (const row of this.db.prepare('SELECT key, value FROM meta').all())
            result[row.key] = row.value;
        return result;
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.columns = null;
    }

    //---------- построение ----------
    beginBuild(file) {
        if (this.build)
            this.build.db.close();

        const db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;');
        db.exec(schema);
        db.exec('BEGIN');
        this.build = {
            db,
            authors: new Map(),
            series: new Map(),
            count: 0,
            insertBook: db.prepare(`INSERT INTO book(id, uid, title_norm, author_norm, series_norm, serno, lang, ext, size, date, librate, del, source, copy_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            insertGenre: db.prepare('INSERT INTO book_genre(book_id, genre) VALUES (?, ?)'),
            insertBookAuthor: db.prepare('INSERT INTO book_author(book_id, author_id) VALUES (?, ?)'),
            insertFts: db.prepare('INSERT INTO book_fts(rowid, title, author, series, keywords) VALUES (?, ?, ?, ?, ?)'),
        };
    }

    insertBooks(rows = []) {
        const b = this.build;
        if (!b)
            throw new Error('catalog index: build not started');

        for (const row of rows) {
            const id = Number(row.id);
            if (!id || !row._uid)
                continue;

            const title = String(row.title || '');
            const author = String(row.author || '');
            const series = String(row.series || '');
            b.insertBook.run(
                id, String(row._uid), normalize(title), normalize(author), normalize(series),
                Number(row.serno) || 0, String(row.lang || ''), String(row.ext || '').toLowerCase(), Number(row.size) || 0,
                String(row.date || ''), Number(row.librate) || 0, row.del ? 1 : 0, String(row.sourceId || ''), copyKey(row),
            );

            for (const genre of String(row.genre || '').split(',').map(value => value.trim()).filter(Boolean))
                b.insertGenre.run(id, genre);

            for (const name of splitAuthors(author)) {
                let rec = b.authors.get(name);
                if (!rec) {
                    rec = {id: b.authors.size + 1, books: 0};
                    b.authors.set(name, rec);
                }
                if (!row.del)
                    rec.books++;
                b.insertBookAuthor.run(id, rec.id);
            }

            if (series) {
                const rec = b.series.get(series) || {id: b.series.size + 1, books: 0};
                if (!row.del)
                    rec.books++;
                b.series.set(series, rec);
            }

            b.insertFts.run(id, normalize(title), normalize(author), normalize(series), normalize(row.keywords));
            b.count++;
        }

        return b.count;
    }

    finishBuild(meta = {}) {
        const b = this.build;
        if (!b)
            throw new Error('catalog index: build not started');

        const db = b.db;
        try {
            const insertAuthor = db.prepare('INSERT INTO author(id, name, name_norm, books) VALUES (?, ?, ?, ?)');
            const insertSeries = db.prepare('INSERT INTO series(id, name, name_norm, books) VALUES (?, ?, ?, ?)');
            const insertName = db.prepare('INSERT INTO name(kind, ref, name_norm, books) VALUES (?, ?, ?, ?)');
            for (const [name, rec] of b.authors) {
                insertAuthor.run(rec.id, name, normalize(name), rec.books);
                insertName.run('author', rec.id, normalize(name), rec.books);
            }
            for (const [name, rec] of b.series) {
                insertSeries.run(rec.id, name, normalize(name), rec.books);
                insertName.run('series', rec.id, normalize(name), rec.books);
            }

            //словарь слов для исправления опечаток
            db.exec(`CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, 'book_fts', 'row')`);
            db.exec(`INSERT INTO term(term, docs) SELECT term, doc FROM temp.vocab WHERE length(term) >= 4 AND term GLOB '*[^0-9]*'`);

            //первая копия книги остаётся, остальные помечаются: по всей библиотеке и внутри источника
            db.exec(`UPDATE book SET is_copy = 1 WHERE id NOT IN (SELECT MIN(id) FROM book GROUP BY copy_key)`);
            db.exec(`UPDATE book SET is_copy_src = 1 WHERE id NOT IN (SELECT MIN(id) FROM book GROUP BY source, copy_key)`);

            //порядки сортировки считаются один раз и хранятся готовыми списками id
            const insertOrder = db.prepare('INSERT INTO sort_order(name, ids) VALUES (?, ?)');
            for (const [name, sql] of Object.entries(sortOrderSql)) {
                const ids = Uint32Array.from(db.prepare(sql).all(), row => row.id);
                insertOrder.run(name, Buffer.from(ids.buffer));
            }

            //ключ копий и имя автора нужны только для расчётов выше
            db.exec('UPDATE book SET copy_key = NULL, author_norm = NULL');

            db.exec(postBuildSchema);
            db.exec(`INSERT INTO term_tri(term_tri) VALUES ('rebuild')`);
            db.exec(`INSERT INTO name_tri(name_tri) VALUES ('rebuild')`);

            const insertMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
            const fullMeta = Object.assign({}, meta, {schemaVersion, books: String(b.count), builtAt: new Date().toISOString()});
            for (const [key, value] of Object.entries(fullMeta))
                insertMeta.run(key, String(value));

            db.exec('COMMIT');
            db.exec(`INSERT INTO book_fts(book_fts) VALUES ('optimize')`);
            db.exec('ANALYZE');
            db.exec('VACUUM');
        } finally {
            db.close();
            this.build = null;
        }

        return {books: b.count, authors: b.authors.size, series: b.series.size};
    }

    abortBuild() {
        if (this.build) {
            try {
                this.build.db.close();
            } catch (e) {
                //ignore
            }
            this.build = null;
        }
    }

    //---------- разбор запроса ----------
    parseQuery(q = '') {
        const result = {free: [], columns: [], filters: {}, excludes: {}, exact: []};
        const text = String(q || '').replace(/(^|\s)(-?)([\p{L}]+):(=?)("([^"]*)"|\S+)/gu, (match, lead, minus, field, eq, raw, quoted) => {
            const key = powerFields.get(field.toLowerCase());
            if (!key)
                return match;

            const value = (quoted !== undefined ? quoted : raw);
            if (['author', 'title', 'series'].includes(key)) {
                if (eq)
                    result.exact.push({field: key, value: normalize(value)});
                else
                    result.columns.push({field: key, tokens: tokens(value)});
            } else {
                const target = (minus ? result.excludes : result.filters);
                const values = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
                target[key] = (target[key] || []).concat(values);
            }
            return lead;
        });

        result.free = tokens(text);
        return result;
    }

    ftsExpression(parsed, freeTokens = parsed.free) {
        const parts = freeTokens.map(token => ftsPhrase(token));
        for (const column of parsed.columns) {
            for (const token of column.tokens)
                parts.push(`${column.field} : ${ftsPhrase(token)}`);
        }
        for (const exact of parsed.exact) {
            if (exact.value)
                parts.push(`${exact.field} : "${exact.value.replace(/"/g, '')}"`);
        }
        return parts.join(' AND ');
    }

    //---------- исправление опечаток ----------
    correctWord(word) {
        const max = allowedTypos(word);
        if (!max)
            return null;
        const grams = trigrams(word);
        if (!grams.length)
            return null;

        const rows = this.db.prepare(`SELECT t.term, t.docs FROM term_tri JOIN term t ON t.id = term_tri.rowid
            WHERE term_tri MATCH ? ORDER BY rank LIMIT 300`).all(grams.map(gram => `"${gram}"`).join(' OR '));

        let best = null;
        for (const row of rows) {
            //слово может быть началом более длинного: сравниваем и с началом термина
            const distance = Math.min(editDistance(word, row.term, max), editDistance(word, row.term.substring(0, word.length), max));
            if (distance > max || row.term === word)
                continue;
            if (!best || distance < best.distance || (distance === best.distance && row.docs > best.docs))
                best = {term: row.term, distance, docs: row.docs};
        }
        return best ? best.term : null;
    }

    hasHits(expression) {
        if (!expression)
            return false;
        return !!this.db.prepare('SELECT rowid FROM book_fts WHERE book_fts MATCH ? LIMIT 1').get(expression);
    }

    //Подбирает запрос, по которому что-то найдётся: как есть, в другой раскладке, с исправленными опечатками
    resolveText(parsed) {
        const expression = this.ftsExpression(parsed);
        if (!expression || this.hasHits(expression))
            return {expression, corrected: ''};

        if (parsed.free.length) {
            const switched = tokens(switchLayout(parsed.free.join(' ')));
            const switchedExpression = this.ftsExpression(parsed, switched);
            if (switched.join(' ') !== parsed.free.join(' ') && this.hasHits(switchedExpression))
                return {expression: switchedExpression, corrected: switched.join(' '), layout: true};

            const fixed = parsed.free.map(word => (this.hasHits(ftsPhrase(word)) ? word : (this.correctWord(word) || word)));
            const fixedExpression = this.ftsExpression(parsed, fixed);
            if (fixed.join(' ') !== parsed.free.join(' ') && this.hasHits(fixedExpression))
                return {expression: fixedExpression, corrected: fixed.join(' ')};
        }

        return {expression, corrected: ''};
    }

    //---------- колонки в памяти: фильтры, счётчики фильтров и сортировка без проходов по SQLite ----------
    loadColumns() {
        const db = this.db;
        const maxId = (db.prepare('SELECT MAX(id) AS m FROM book').get().m || 0);
        const size = maxId + 1;
        const dicts = {lang: [], ext: [], source: [], genre: []};
        const codes = {lang: new Map(), ext: new Map(), source: new Map(), genre: new Map()};
        const code = (field, value) => {
            let result = codes[field].get(value);
            if (result === undefined) {
                result = dicts[field].length;
                dicts[field].push(value);
                codes[field].set(value, result);
            }
            return result;
        };

        const c = {
            maxId, dicts, codes,
            lang: new Uint16Array(size), ext: new Uint16Array(size), source: new Uint16Array(size),
            librate: new Uint8Array(size), flags: new Uint8Array(size), date: new Uint32Array(size),
        };
        for (const row of db.prepare('SELECT id, lang, ext, source, librate, del, is_copy, is_copy_src, date FROM book').iterate()) {
            const id = row.id;
            c.lang[id] = code('lang', row.lang || '');
            c.ext[id] = code('ext', row.ext || '');
            c.source[id] = code('source', row.source || '');
            c.librate[id] = Math.max(0, Math.min(255, row.librate || 0));
            c.flags[id] = 1 | (row.del ? 2 : 0) | (row.is_copy ? 4 : 0) | (row.is_copy_src ? 8 : 0);
            c.date[id] = parseInt(String(row.date || '').replace(/\D/g, '').substring(0, 8), 10) || 0;
        }

        //жанры: для книги id её жанры лежат в genreList[genreStart[id] .. genreStart[id + 1])
        const genreCount = new Uint32Array(size + 1);
        const genreRows = db.prepare('SELECT book_id, genre FROM book_genre').all();
        for (const row of genreRows)
            genreCount[row.book_id + 1]++;
        for (let i = 1; i <= size; i++)
            genreCount[i] += genreCount[i - 1];
        c.genreStart = genreCount;
        c.genreList = new Uint16Array(genreRows.length);
        const fill = new Uint32Array(size);
        for (const row of genreRows)
            c.genreList[genreCount[row.book_id] + fill[row.book_id]++] = code('genre', row.genre);

        c.order = {};
        for (const row of db.prepare('SELECT name, ids FROM sort_order').all()) {
            const bytes = row.ids;
            c.order[row.name] = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
        c.pass = new Uint8Array(size);
        this.columns = c;
    }

    //Условия запроса как проверки по колонкам. Фасетные поля проверяются отдельно,
    //чтобы счётчик каждого фильтра считался без его собственного условия.
    compileFilter(filters, excludes, options, hitSet) {
        const c = this.columns;
        const toSet = (field, values) => {
            const set = new Set();
            for (const value of values || []) {
                const id = c.codes[field].get(String(value).toLowerCase()) ?? c.codes[field].get(String(value));
                if (id !== undefined)
                    set.add(id);
            }
            return set;
        };

        const facet = {};
        for (const field of ['lang', 'ext', 'source', 'genre']) {
            if (filters[field] && filters[field].length)
                facet[field] = toSet(field, filters[field]);
        }
        if (filters.librate && filters.librate.length)
            facet.librate = new Set(filters.librate.map(value => Number(value) || 0));

        let dateFrom = 0;
        let dateTo = 0;
        const added = String(filters.added || '');
        const days = {'7d': 7, '30d': 30, '365d': 365}[added];
        if (days) {
            dateFrom = parseInt(dateDaysAgo(days).replace(/\D/g, ''), 10);
        } else if (added.includes('..')) {
            const [from, to] = added.split('..').map(value => parseInt(String(value || '').replace(/\D/g, ''), 10) || 0);
            dateFrom = from;
            dateTo = to;
        }
        if (dateFrom || dateTo)
            facet.added = true;

        const exclude = {
            lang: toSet('lang', excludes.lang),
            ext: toSet('ext', excludes.ext),
            genre: toSet('genre', excludes.genre),
        };

        let copyFlag = 0;
        if (options.hideCopies)
            copyFlag = (filters.source && filters.source.length === 1 ? 8 : 4);
        const hideDeleted = !options.showDeleted;
        const exactIds = (options.exactIds || null);

        const hasGenre = (id, set) => {
            for (let i = c.genreStart[id]; i < c.genreStart[id + 1]; i++) {
                if (set.has(c.genreList[i]))
                    return true;
            }
            return false;
        };

        const fields = ['lang', 'ext', 'source', 'genre', 'librate', 'added'];
        const bits = {};
        fields.forEach((field, index) => (bits[field] = 1 << index));
        const full = (1 << fields.length) - 1;

        //базовые условия (не фасеты)
        const base = (id) => {
            const flags = c.flags[id];
            if (!(flags & 1))
                return false;
            if (hideDeleted && (flags & 2))
                return false;
            if (copyFlag && (flags & copyFlag))
                return false;
            if (hitSet && !hitSet[id])
                return false;
            if (exactIds && !exactIds.has(id))
                return false;
            if (exclude.lang.size && exclude.lang.has(c.lang[id]))
                return false;
            if (exclude.ext.size && exclude.ext.has(c.ext[id]))
                return false;
            if (exclude.genre.size && hasGenre(id, exclude.genre))
                return false;
            return true;
        };

        //маска пройденных фасетных условий
        const mask = (id) => {
            let result = full;
            if (facet.lang && !facet.lang.has(c.lang[id]))
                result &= ~bits.lang;
            if (facet.ext && !facet.ext.has(c.ext[id]))
                result &= ~bits.ext;
            if (facet.source && !facet.source.has(c.source[id]))
                result &= ~bits.source;
            if (facet.genre && !hasGenre(id, facet.genre))
                result &= ~bits.genre;
            if (facet.librate && !facet.librate.has(c.librate[id]))
                result &= ~bits.librate;
            if (facet.added && ((dateFrom && c.date[id] < dateFrom) || (dateTo && c.date[id] > dateTo)))
                result &= ~bits.added;
            return result;
        };

        return {base, mask, bits, full};
    }

    exactIdSet(exact = []) {
        let result = null;
        for (const item of exact) {
            let rows;
            if (item.field === 'title')
                rows = this.db.prepare('SELECT id FROM book WHERE title_norm = ?').all(item.value);
            else if (item.field === 'series')
                rows = this.db.prepare('SELECT id FROM book WHERE series_norm = ?').all(item.value);
            else
                rows = this.db.prepare('SELECT ba.book_id AS id FROM author a JOIN book_author ba ON ba.author_id = a.id WHERE a.name_norm = ?').all(item.value);
            const ids = new Set(rows.map(row => row.id));
            result = (result ? new Set([...result].filter(id => ids.has(id))) : ids);
        }
        return result;
    }

    //---------- поиск ----------
    search(request = {}) {
        if (!this.db)
            throw new Error('catalog index is not ready');
        if (!this.columns)
            this.loadColumns();

        const c = this.columns;
        const parsed = this.parseQuery(request.q);
        const filters = {added: String(((request.filters || {}).added) || '')};
        for (const field of facetFields) {
            const value = (request.filters || {})[field];
            filters[field] = [].concat(Array.isArray(value) ? value : (value ? [value] : []), parsed.filters[field] || []).map(String).filter(Boolean);
        }
        const limit = Math.max(1, Math.min(maxLimit, parseInt(request.limit, 10) || 50));
        const offset = Math.max(0, parseInt(request.offset, 10) || 0);

        //текстовая часть: совпадения FTS с оценкой
        const text = this.resolveText(Object.assign({}, parsed, {exact: []}));
        const hasText = !!text.expression;
        let hits = null;
        let hitSet = null;
        if (hasText) {
            hits = this.db.prepare(`SELECT rowid AS id, bm25(book_fts, 10.0, 6.0, 4.0, 1.0) AS score FROM book_fts WHERE book_fts MATCH ?`).all(text.expression);
            hitSet = new Uint8Array(c.maxId + 1);
            for (const hit of hits)
                hitSet[hit.id] = 1;
        }

        const exactIds = (parsed.exact.length ? this.exactIdSet(parsed.exact) : null);
        const filter = this.compileFilter(filters, parsed.excludes, {showDeleted: !!request.showDeleted, hideCopies: !!request.hideCopies, exactIds}, null);

        //один проход: итог, отметки прошедших книг и счётчики фасетов
        const counts = {};
        for (const field of ['lang', 'ext', 'source', 'genre'])
            counts[field] = new Uint32Array(c.dicts[field].length);
        counts.librate = new Uint32Array(256);
        const addedFrom = [7, 30, 365].map(days => parseInt(dateDaysAgo(days).replace(/\D/g, ''), 10));
        const addedCounts = [0, 0, 0];
        const wantFacets = (request.facets !== false);
        const {bits, full} = filter;
        const pass = c.pass;
        pass.fill(0);
        let total = 0;

        const visit = (id) => {
            if (!filter.base(id))
                return;
            const mask = filter.mask(id);
            if (mask === full) {
                pass[id] = 1;
                total++;
            }
            if (!wantFacets)
                return;
            if ((mask | bits.lang) === full)
                counts.lang[c.lang[id]]++;
            if ((mask | bits.ext) === full)
                counts.ext[c.ext[id]]++;
            if ((mask | bits.source) === full)
                counts.source[c.source[id]]++;
            if ((mask | bits.librate) === full)
                counts.librate[c.librate[id]]++;
            if ((mask | bits.genre) === full) {
                for (let i = c.genreStart[id]; i < c.genreStart[id + 1]; i++)
                    counts.genre[c.genreList[i]]++;
            }
            if ((mask | bits.added) === full) {
                const date = c.date[id];
                for (let i = 0; i < 3; i++) {
                    if (date >= addedFrom[i])
                        addedCounts[i]++;
                }
            }
        };

        if (hits) {
            for (const hit of hits)
                visit(hit.id);
        } else {
            for (let id = 1; id <= c.maxId; id++)
                visit(id);
        }

        //страница результата
        const sort = String(request.sort || (hasText ? 'relevance' : 'date'));
        const ids = [];
        if (sort === 'relevance' && hits) {
            const ranked = hits.filter(hit => pass[hit.id]);
            ranked.sort((a, b) => a.score - b.score || c.librate[b.id] - c.librate[a.id] || a.id - b.id);
            for (const hit of ranked.slice(offset, offset + limit))
                ids.push(hit.id);
        } else {
            const order = c.order[sort] || c.order.date;
            let skipped = 0;
            for (let i = 0; i < order.length && ids.length < limit; i++) {
                const id = order[i];
                if (!pass[id])
                    continue;
                if (skipped < offset)
                    skipped++;
                else
                    ids.push(id);
            }
        }

        const facets = {};
        if (wantFacets) {
            const list = (field, values) => [...values.entries()]
                .filter(([, n]) => n > 0)
                .map(([index, n]) => [field === 'librate' ? String(index) : c.dicts[field][index], n])
                .filter(([value]) => value !== '')
                .sort((a, b) => b[1] - a[1])
                .slice(0, 40);
            for (const field of facetFields)
                facets[field] = list(field, counts[field]);
            facets.added = [['7d', addedCounts[0]], ['30d', addedCounts[1]], ['365d', addedCounts[2]]];
        }

        const entityQuery = (text.corrected || parsed.free.join(' '));
        const entities = (offset === 0 && entityQuery ? this.matchNames(entityQuery, 5) : {authors: [], series: []});

        return {
            ids,
            total,
            facets,
            authors: entities.authors,
            series: entities.series,
            corrected: text.corrected || '',
            layout: !!text.layout,
        };
    }

    //Авторы и серии по словам запроса: все слова должны встретиться в имени (подстрока)
    matchNames(query, limit = 5) {
        const words = tokens(query);
        const result = {authors: [], series: []};
        if (!words.length)
            return result;

        const long = words.filter(word => word.length >= 3);
        const short = words.filter(word => word.length < 3);
        for (const kind of ['author', 'series']) {
            let rows;
            if (long.length) {
                const where = short.map(() => ' AND n.name_norm LIKE ?').join('');
                rows = this.db.prepare(`SELECT n.ref AS id, n.books AS books FROM name_tri JOIN name n ON n.id = name_tri.rowid
                    WHERE name_tri MATCH ? AND n.kind = ?${where} ORDER BY n.books DESC LIMIT ?`)
                    .all(long.map(word => `"${word}"`).join(' AND '), kind, ...short.map(word => `%${word}%`), limit);
            } else {
                rows = this.db.prepare(`SELECT ref AS id, books FROM name WHERE kind = ? AND name_norm >= ? AND name_norm < ? ORDER BY books DESC LIMIT ?`)
                    .all(kind, words[0], `${words[0]}￿`, limit);
            }

            const table = (kind === 'author' ? 'author' : 'series');
            const select = this.db.prepare(`SELECT name, books FROM ${table} WHERE id = ?`);
            result[kind === 'author' ? 'authors' : 'series'] = rows
                .map(row => select.get(row.id))
                .filter(row => row && row.books > 0)
                .map(row => ({name: row.name, books: row.books}));
        }
        return result;
    }

    //Подсказки при наборе: авторы, серии и книги
    suggest(request = {}) {
        if (!this.db)
            throw new Error('catalog index is not ready');

        const parsed = this.parseQuery(request.q);
        const text = this.resolveText(parsed);
        const query = text.corrected || parsed.free.join(' ');
        const names = (query ? this.matchNames(query, 4) : {authors: [], series: []});

        let books = [];
        if (text.expression) {
            books = this.db.prepare(`SELECT b.id AS id
                FROM book_fts f JOIN book b ON b.id = f.rowid
                WHERE book_fts MATCH ? AND b.del = 0 AND b.is_copy = 0
                ORDER BY bm25(book_fts, 10.0, 6.0, 4.0, 1.0) LIMIT 6`).all(text.expression);
        }

        return {authors: names.authors, series: names.series, books, corrected: text.corrected || '', layout: !!text.layout};
    }

    //Правка метаданных одной книги без полной пересборки
    updateBook(file, row) {
        const db = new DatabaseSync(file);
        try {
            const id = Number(row.id);
            const title = String(row.title || '');
            const author = String(row.author || '');
            const series = String(row.series || '');
            db.exec('BEGIN');
            db.prepare(`UPDATE book SET title_norm = ?, series_norm = ?, serno = ?, lang = ?, librate = ?
                WHERE id = ?`).run(normalize(title), normalize(series), Number(row.serno) || 0,
                String(row.lang || ''), Number(row.librate) || 0, id);
            db.prepare('DELETE FROM book_fts WHERE rowid = ?').run(id);
            db.prepare('INSERT INTO book_fts(rowid, title, author, series, keywords) VALUES (?, ?, ?, ?, ?)')
                .run(id, normalize(title), normalize(author), normalize(series), normalize(row.keywords));
            db.exec('COMMIT');
        } finally {
            db.close();
        }
        //колонки и порядки сортировки перечитаются при следующем поиске
        this.columns = null;
    }
}

module.exports = CatalogIndex;
