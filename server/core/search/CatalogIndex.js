//БД библиотеки на SQLite (node:sqlite): записи книг, авторы, серии, жанры, полнотекстовый поиск FTS5.
//Строится из INPX (см. CatalogSearch); работает синхронно, поэтому запускается в отдельном потоке
//(см. CatalogIndexThread). Записи книг хранят исходные поля INPX, поиск и сортировка - с правками метаданных.
const {DatabaseSync} = require('node:sqlite');

const {normalize, tokens, switchLayout, editDistance, allowedTypos, trigrams} = require('./textNorm');
const {workKey} = require('./workKey');
const {buildLookup, englishName} = require('./AuthorNames');

const schemaVersion = '11';
const maxLimit = 200;
//длинный запрос из сотен слов превращается в огромное выражение FTS и перебор опечаток: режем
const maxQueryLength = 200;
const maxQueryTokens = 12;
//Сортировка по релевантности считает bm25 по всем совпадениям запроса (~3,5 мс на тысячу с сортировкой), и короткий
//префикс («ка» - сотни тысяч книг) занял бы поток на секунду. Больше maxRanked совпадений - порядок «по оценке»:
//bm25 такие совпадения почти не различает; итог и счётчики фильтров остаются точными
const maxRanked = 20000;
const queryTokens = value => tokens(String(value || '').substring(0, maxQueryLength)).slice(0, maxQueryTokens);
const facetFields = ['lang', 'ext', 'genre', 'source', 'librate'];
const powerFields = new Map([
    ['author', 'author'], ['автор', 'author'],//i18n-ignore: данные поиска
    ['title', 'title'], ['название', 'title'],//i18n-ignore: данные поиска
    ['series', 'series'], ['серия', 'series'],//i18n-ignore: данные поиска
    ['genre', 'genre'], ['жанр', 'genre'],//i18n-ignore: данные поиска
    ['lang', 'lang'], ['язык', 'lang'],//i18n-ignore: данные поиска
    ['ext', 'ext'], ['format', 'ext'], ['формат', 'ext'],//i18n-ignore: данные поиска
    ['source', 'source'], ['rating', 'librate'],
]);

const schema = `
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sort_order(name TEXT PRIMARY KEY, ids BLOB NOT NULL);
    CREATE TABLE source(key TEXT PRIMARY KEY, name TEXT NOT NULL, lib_dir TEXT NOT NULL);
    CREATE TABLE column_data(name TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE book(
        id INTEGER PRIMARY KEY, uid TEXT NOT NULL,
        title TEXT NOT NULL, author TEXT NOT NULL, series TEXT NOT NULL, serno INTEGER, genre TEXT NOT NULL, keywords TEXT NOT NULL,
        lang TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER, date TEXT NOT NULL, librate INTEGER, del INTEGER,
        file TEXT NOT NULL, folder TEXT NOT NULL, libid TEXT NOT NULL, insno INTEGER, source TEXT NOT NULL,
        title_norm TEXT, author_norm TEXT, series_norm TEXT, work_key TEXT, work INTEGER
    );
    CREATE TABLE book_genre(book_id INTEGER NOT NULL, genre TEXT NOT NULL);
    CREATE TABLE author(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE TABLE book_author(book_id INTEGER NOT NULL, author_id INTEGER NOT NULL);
    CREATE TABLE author_alias(author_id INTEGER NOT NULL, alias TEXT NOT NULL);
    CREATE TABLE series(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE TABLE term(id INTEGER PRIMARY KEY, term TEXT NOT NULL, docs INTEGER NOT NULL);
    CREATE TABLE name(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref INTEGER NOT NULL, name_norm TEXT NOT NULL, books INTEGER NOT NULL);
    CREATE TABLE source_books(source TEXT NOT NULL, kind TEXT NOT NULL, ref INTEGER NOT NULL, books INTEGER NOT NULL, PRIMARY KEY(source, kind, ref)) WITHOUT ROWID;
    CREATE VIRTUAL TABLE book_fts USING fts5(
        title, author, series, keywords,
        content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
`;

//фильтры и сортировка работают по колонкам в памяти; индексы нужны только точным совпадениям и именам
const postBuildSchema = `
    CREATE UNIQUE INDEX book_uid ON book(uid);
    CREATE INDEX book_source_libid ON book(source, libid);
    CREATE INDEX book_title_norm ON book(title_norm);
    CREATE INDEX book_series_norm ON book(series_norm);
    CREATE INDEX book_work ON book(work) WHERE work IS NOT NULL;
    CREATE INDEX name_kind_norm ON name(kind, name_norm);
    CREATE INDEX book_author_author ON book_author(author_id, book_id);
    CREATE INDEX author_norm ON author(name_norm);
    CREATE INDEX author_alias_author ON author_alias(author_id);
    CREATE VIRTUAL TABLE term_tri USING fts5(term, content='term', content_rowid='id', tokenize='trigram');
    CREATE VIRTUAL TABLE name_tri USING fts5(name_norm, content='name', content_rowid='id', tokenize='trigram');
`;

const columnTypes = {
    lang: Uint16Array, ext: Uint16Array, source: Uint16Array, librate: Uint8Array, flags: Uint8Array, date: Uint32Array,
    work: Uint32Array, genreStart: Uint32Array, genreList: Uint16Array,
};
const columnArrays = Object.keys(columnTypes);

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

//Типизированный массив из BLOB: копия, чтобы не зависеть от выравнивания буфера
function typedFromBlob(Type, bytes) {
    return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function dateDaysAgo(days) {
    const date = new Date(Date.now() - days * 24 * 3600 * 1000);
    return date.toISOString().substring(0, 10);
}

class CatalogIndex {
    constructor() {
        this.db = null;
        this.build = null;
        this.hidden = new Set();
        this.hiddenBooks = {author: new Map(), series: new Map()};
        this.visibility = {stats: null, books: 0, indexed: []};
        this.maxRanked = maxRanked;
        this.hits = null;
    }

    //---------- открытие ----------
    //hidden - ключи выключенных библиотек: их книги остаются в БД, но не видны (см. setHiddenSources)
    //info - [{id, name, libDir}] из текущих настроек: название и папка библиотеки в записях книг
    open(file, hidden = [], info = []) {
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
        this.sources = new Map(db.prepare('SELECT key, name, lib_dir FROM source').all().map(row => [row.key, row]));
        db.function('catalog_visible', id => (this.columns.flags[id] & 1));
        db.function('catalog_hit', (id) => {
            this.hits.push(id);
            return 1;
        });
        db.function('catalog_books', (kind, ref, books) => Math.max(0, books - ((kind === 'series' ? this.hiddenBooks.series : this.hiddenBooks.author).get(ref) || 0)));
        this.setHiddenSources(hidden, info);
        return this.meta();
    }

    //---------- выключенные библиотеки ----------
    //Книги выключенных библиотек скрываются без пересборки: в колонках в памяти снимается признак «книга есть»
    //(flags & 1, его проверяют поиск, OPDS и витрины), счётчики книг авторов и серий уменьшаются при чтении.
    setHiddenSources(keys = [], info = []) {
        this.liveSources = new Map((info || []).map(source => [String(source.id || ''), source]));
        this.hidden = new Set((keys || []).map(String).filter(key => this.sources && this.sources.has(key)));
        this.hiddenBooks = {author: new Map(), series: new Map()};
        this.queryMasks = null;
        if (!this.db)
            return this.visibility;

        if (this.columns)
            this.applyHidden(this.columns);
        const indexed = [...this.sources.keys()];
        let books = this.db.prepare('SELECT COUNT(*) AS n FROM book').get().n;
        if (!this.hidden.size) {
            this.visibility = {stats: null, books, indexed};
            return this.visibility;
        }

        const hiddenJson = JSON.stringify([...this.hidden]);
        for (const row of this.db.prepare('SELECT kind, ref, books FROM source_books WHERE source IN (SELECT value FROM json_each(?))').iterate(hiddenJson)) {
            const map = this.hiddenBooks[row.kind];
            map.set(row.ref, (map.get(row.ref) || 0) + row.books);
        }
        books -= this.db.prepare('SELECT COUNT(*) AS n FROM book WHERE source IN (SELECT value FROM json_each(?))').get(hiddenJson).n;
        this.visibility = {stats: this.visibleStats(), books, indexed};
        return this.visibility;
    }

    sourceVisibility() {
        return this.visibility;
    }

    applyHidden(c) {
        if (!c.storedFlags)
            c.storedFlags = c.flags.slice();
        const codes = new Set([...this.hidden].map(key => c.codes.source.get(key)).filter(code => code !== undefined));
        for (let id = 0; id <= c.maxId; id++)
            c.flags[id] = (codes.has(c.source[id]) ? c.storedFlags[id] & ~1 : c.storedFlags[id]);
    }

    //Счётчик книг имени с учётом выключенных библиотек: kind - author, series или name (таблица name: kind и ref)
    booksSql(kind, table) {
        if (!this.hidden.size)
            return `${table}.books`;
        return (kind === 'name'
            ? `catalog_books(${table}.kind, ${table}.ref, ${table}.books)`
            : `catalog_books('${kind}', ${table}.id, ${table}.books)`);
    }

    //Статистика библиотеки (как в finishBuild) без книг выключенных библиотек: суммы по библиотекам из sourceStats,
    //книги, языки и жанры - по колонкам, авторы и серии - по счётчикам с вычетом выключенных
    visibleStats() {
        if (!this.columns)
            this.loadColumns();
        const c = this.columns;
        const meta = this.meta();
        const parse = (value) => {
            try {
                return JSON.parse(value || '{}');
            } catch (e) {
                return {};
            }
        };
        const sourceStats = parse(meta.sourceStats);
        const sum = field => [...this.sources.keys()].filter(key => !this.hidden.has(key))
            .reduce((total, key) => total + Number((sourceStats[key] || {})[field] || 0), 0);

        let bookCount = 0;
        let bookDelCount = 0;
        const langs = new Uint8Array(c.dicts.lang.length);
        const genres = new Uint8Array(c.dicts.genre.length);
        for (let id = 1; id <= c.maxId; id++) {
            const flags = c.flags[id];
            if (!(flags & 1))
                continue;
            if (flags & 2)
                bookDelCount++;
            else
                bookCount++;
            langs[c.lang[id]] = 1;
            for (let i = c.genreStart[id]; i < c.genreStart[id + 1]; i++)
                genres[c.genreList[i]] = 1;
        }
        const count = list => list.reduce((total, value) => total + value, 0);
        const named = table => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${this.booksSql(table, table)} > 0`).get().n;
        const authorCount = named('author');
        const filesCount = sum('filesCount');
        const filesDelCount = sum('filesDelCount');
        return {
            filesCount, filesCountAll: filesCount + filesDelCount, filesDelCount,
            recsLoaded: Number(parse(meta.stats).recsLoaded) || 0,
            authorCount,
            authorCountAll: authorCount + sum('authorGroups'),
            bookCount, bookCountAll: bookCount + bookDelCount, bookDelCount,
            noAuthorBookCount: sum('noAuthorBookCount'),
            titleCount: sum('titleCount'),
            seriesCount: named('series'),
            genreCount: count(genres),
            langCount: count(langs),
        };
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
    //aliasEntries - пары [русское имя, английское имя] из Wikidata (см. AuthorNames)
    //sources - [{id, name, libDir}] библиотек, и выключенных
    beginBuild(file, aliasEntries = [], sources = []) {
        if (this.build)
            this.build.db.close();

        const db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;');
        db.exec(schema);
        db.exec('BEGIN');
        const insertSource = db.prepare('INSERT INTO source(key, name, lib_dir) VALUES (?, ?, ?)');
        for (const source of sources)
            insertSource.run(String(source.id || ''), String(source.name || ''), String(source.libDir || ''));
        this.build = {
            db,
            authors: new Map(),
            aliasLookup: buildLookup(aliasEntries),
            aliases: new Map(),
            series: new Map(),
            uids: new Set(),
            lastId: 0,
            count: 0,
            insertBook: db.prepare(`INSERT INTO book(id, uid, title, author, series, serno, genre, keywords, lang, ext, size, date, librate, del,
                file, folder, libid, insno, source, title_norm, author_norm, series_norm, work_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            insertGenre: db.prepare('INSERT INTO book_genre(book_id, genre) VALUES (?, ?)'),
            insertBookAuthor: db.prepare('INSERT INTO book_author(book_id, author_id) VALUES (?, ?)'),
            insertFts: db.prepare('INSERT INTO book_fts(rowid, title, author, series, keywords) VALUES (?, ?, ?, ?, ?)'),
        };
    }

    //id назначаются по порядку вызовов; повтор _uid (та же книга в другой библиотеке) пропускается
    insertBooks(rows = []) {
        const b = this.build;
        if (!b)
            throw new Error('catalog index: build not started');

        for (const row of rows) {
            if (b.uids.has(row._uid))
                continue;
            b.uids.add(row._uid);
            const id = ++b.lastId;
            if (!row._uid)
                continue;

            //shown - значения с правкой метаданных: по ним ищутся, сортируются и группируются книги
            const shown = Object.assign({}, row, row.shown || {});
            const title = String(shown.title || '');
            const author = String(shown.author || '');
            const series = String(shown.series || '');
            b.insertBook.run(
                id, String(row._uid), String(row.title || ''), String(row.author || ''), String(row.series || ''), Number(row.serno) || 0,
                String(row.genre || ''), String(row.keywords || ''), String(row.lang || '').trim().toLowerCase(), String(row.ext || ''),
                Number(row.size) || 0, String(row.date || ''), Number(row.librate) || 0, row.del ? 1 : 0,
                String(row.file || ''), String(row.folder || ''), String(row.libid || ''), Number(row.insno) || 0, String(row.sourceId || ''),
                normalize(title), normalize(author), normalize(series), workKey(shown),
            );

            for (const genre of String(row.genre || '').split(',').map(value => value.trim()).filter(Boolean))
                b.insertGenre.run(id, genre);

            const authorAliases = [];
            for (const name of splitAuthors(author)) {
                if (!b.aliases.has(name))
                    b.aliases.set(name, englishName(b.aliasLookup, name));
                if (b.aliases.get(name))
                    authorAliases.push(b.aliases.get(name));
                //«Семёнов» и «семенов» - один автор (имя - первое написание): страницы ищут по name_norm
                const key = normalize(name) || name;
                let rec = b.authors.get(key);
                if (!rec) {
                    rec = {id: b.authors.size + 1, name, books: 0, sources: {}};
                    b.authors.set(key, rec);
                }
                if (!row.del) {
                    rec.books++;
                    rec.sources[row.sourceId || ''] = (rec.sources[row.sourceId || ''] || 0) + 1;
                }
                b.insertBookAuthor.run(id, rec.id);
            }

            if (series) {
                const key = normalize(series) || series;
                const rec = b.series.get(key) || {id: b.series.size + 1, name: series, books: 0, sources: {}};
                if (!row.del) {
                    rec.books++;
                    rec.sources[row.sourceId || ''] = (rec.sources[row.sourceId || ''] || 0) + 1;
                }
                b.series.set(key, rec);
            }

            //английские имена авторов ищутся наравне с именами из библиотеки
            b.insertFts.run(id, normalize(title), normalize([author, ...authorAliases].join(' ')), normalize(series), normalize(row.keywords));
            b.count++;
        }

        return b.count;
    }

    //Разбор INPX в начатую сборку (LibraryImport.importLibrary); onProgress задаёт поток (CatalogIndexChild)
    importLibrary(options) {
        return require('./LibraryImport').importLibrary(this, options, this.onProgress);
    }

    finishBuild(meta = {}) {
        const b = this.build;
        if (!b)
            throw new Error('catalog index: build not started');

        const db = b.db;
        let aliasCount = 0;
        try {
            const insertAuthor = db.prepare('INSERT INTO author(id, name, name_norm, books) VALUES (?, ?, ?, ?)');
            const insertSeries = db.prepare('INSERT INTO series(id, name, name_norm, books) VALUES (?, ?, ?, ?)');
            const insertName = db.prepare('INSERT INTO name(kind, ref, name_norm, books) VALUES (?, ?, ?, ?)');
            const insertAlias = db.prepare('INSERT INTO author_alias(author_id, alias) VALUES (?, ?)');
            //книги имён по библиотекам: выключенная библиотека вычитается из счётчиков без прохода по книгам
            const perSource = (db.prepare('SELECT COUNT(*) AS n FROM source').get().n > 1);
            const insertSourceBooks = db.prepare('INSERT INTO source_books(source, kind, ref, books) VALUES (?, ?, ?, ?)');
            const addSourceBooks = (kind, rec) => {
                if (perSource) {
                    for (const [source, books] of Object.entries(rec.sources))
                        insertSourceBooks.run(source, kind, rec.id, books);
                }
            };
            for (const rec of b.authors.values()) {
                const {id, name, books} = rec;
                addSourceBooks('author', rec);
                insertAuthor.run(id, name, normalize(name), books);
                insertName.run('author', id, normalize(name), books);
                const alias = b.aliases.get(name);
                if (alias) {
                    aliasCount++;
                    insertAlias.run(id, alias);
                    insertName.run('alias', id, normalize(alias), books);
                }
            }
            for (const rec of b.series.values()) {
                const {id, name, books} = rec;
                addSourceBooks('series', rec);
                insertSeries.run(id, name, normalize(name), books);
                insertName.run('series', id, normalize(name), books);
            }

            //словарь слов для исправления опечаток
            db.exec(`CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, 'book_fts', 'row')`);
            db.exec(`INSERT INTO term(term, docs) SELECT term, doc FROM temp.vocab WHERE length(term) >= 4 AND term GLOB '*[^0-9]*'`);

            //издания одного произведения получают общую метку - меньший id; у книги без других изданий метки нет
            db.exec(`CREATE TEMP TABLE work_group(key TEXT PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID`);
            db.exec(`INSERT INTO work_group SELECT work_key, MIN(id) FROM book WHERE work_key IS NOT NULL GROUP BY work_key HAVING COUNT(*) > 1`);
            db.exec(`UPDATE book SET work = (SELECT id FROM work_group WHERE key = book.work_key) WHERE work_key IN (SELECT key FROM work_group)`);
            db.exec('DROP TABLE work_group');

            //порядки сортировки считаются один раз и хранятся готовыми списками id
            const insertOrder = db.prepare('INSERT INTO sort_order(name, ids) VALUES (?, ?)');
            //id читаются потоком в типизированный массив: без 700 тыс. объектов строк на каждый порядок
            const bookTotal = db.prepare('SELECT COUNT(*) AS n FROM book').get().n;
            for (const [name, sql] of Object.entries(sortOrderSql)) {
                const ids = new Uint32Array(bookTotal);
                let n = 0;
                for (const row of db.prepare(sql).iterate())
                    ids[n++] = row.id;
                insertOrder.run(name, Buffer.from(ids.buffer, 0, n * 4));
            }

            //ключ произведения и имя автора нужны только для расчётов выше
            db.exec('UPDATE book SET work_key = NULL, author_norm = NULL');

            //статистика библиотеки (раньше считалась при создании основной БД)
            const one = sql => db.prepare(sql).get().n;
            const bookCount = one('SELECT COUNT(*) AS n FROM book WHERE del = 0');
            const bookDelCount = one('SELECT COUNT(*) AS n FROM book WHERE del <> 0');
            const authorCount = b.authors.size;
            //файл удалён, если удалены все его записи
            const files = db.prepare(`SELECT SUM(alive > 0) AS live, SUM(alive = 0) AS dead
                FROM (SELECT SUM(del = 0) AS alive FROM book GROUP BY folder, file, ext)`).get();
            const filesCount = files.live || 0;
            const filesDelCount = files.dead || 0;
            const stats = {
                filesCount, filesCountAll: filesCount + filesDelCount, filesDelCount,
                recsLoaded: Number(meta.recsLoaded) || b.count,
                authorCount,
                authorCountAll: authorCount + one(`SELECT COUNT(DISTINCT lower(author)) AS n FROM book WHERE author LIKE '%,%'`),
                bookCount, bookCountAll: bookCount + bookDelCount, bookDelCount,
                noAuthorBookCount: one(`SELECT COUNT(*) AS n FROM book WHERE del = 0 AND author = ''`),
                titleCount: one('SELECT COUNT(DISTINCT lower(title)) AS n FROM book'),
                seriesCount: b.series.size,
                genreCount: one('SELECT COUNT(DISTINCT genre) AS n FROM book_genre'),
                langCount: one('SELECT COUNT(DISTINCT lang) AS n FROM book'),
            };
            delete meta.recsLoaded;
            //слагаемые статистики по библиотекам - для статистики без выключенных (см. visibleStats)
            const sourceStats = {};
            if (perSource) {
                const add = (sql, fields) => {
                    for (const row of db.prepare(sql).all()) {
                        const target = sourceStats[row.source] || (sourceStats[row.source] = {});
                        for (const field of fields)
                            target[field] = row[field] || 0;
                    }
                };
                add(`SELECT source, SUM(del = 0) AS bookCount, SUM(del <> 0) AS bookDelCount, SUM(del = 0 AND author = '') AS noAuthorBookCount,
                    COUNT(DISTINCT lower(title)) AS titleCount FROM book GROUP BY source`, ['bookCount', 'bookDelCount', 'noAuthorBookCount', 'titleCount']);
                add(`SELECT source, SUM(alive > 0) AS filesCount, SUM(alive = 0) AS filesDelCount
                    FROM (SELECT source, SUM(del = 0) AS alive FROM book GROUP BY source, folder, file, ext) GROUP BY source`, ['filesCount', 'filesDelCount']);
                add(`SELECT source, COUNT(DISTINCT lower(author)) AS authorGroups FROM book WHERE author LIKE '%,%' GROUP BY source`, ['authorGroups']);
            }

            //колонки фильтров сохраняются готовыми: открытие индекса не перебирает книги
            const columns = this.computeColumns(db);
            const insertColumn = db.prepare('INSERT INTO column_data(name, data) VALUES (?, ?)');
            for (const name of columnArrays)
                insertColumn.run(name, Buffer.from(columns[name].buffer, columns[name].byteOffset, columns[name].byteLength));
            insertColumn.run('dicts', Buffer.from(JSON.stringify(columns.dicts)));

            db.exec(postBuildSchema);
            db.exec(`INSERT INTO term_tri(term_tri) VALUES ('rebuild')`);
            db.exec(`INSERT INTO name_tri(name_tri) VALUES ('rebuild')`);

            const insertMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
            const fullMeta = Object.assign({}, meta, {
                schemaVersion, books: String(b.count), aliases: String(aliasCount), builtAt: new Date().toISOString(), stats: JSON.stringify(stats),
                sourceStats: JSON.stringify(sourceStats),
            });
            for (const [key, value] of Object.entries(fullMeta))
                insertMeta.run(key, String(value));

            db.exec('COMMIT');
            db.exec(`INSERT INTO book_fts(book_fts) VALUES ('optimize')`);
            db.exec('ANALYZE');
            //VACUUM уменьшает файл примерно на четверть, но с temp_store = MEMORY держит в памяти копию всей БД
            //(400 тыс. книг: +170 МБ к пику RSS); с временным файлом - около +40 МБ и на треть секунды дольше
            db.exec('PRAGMA temp_store = FILE');
            db.exec('VACUUM');
        } finally {
            db.close();
            this.build = null;
        }

        return {books: b.count, authors: b.authors.size, series: b.series.size, aliases: aliasCount};
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
        const text = String(q || '').substring(0, maxQueryLength).replace(/(^|\s)(-?)([\p{L}]+):(=?)("([^"]*)"|\S+)/gu, (match, lead, minus, field, eq, raw, quoted) => {
            const key = powerFields.get(field.toLowerCase());
            if (!key)
                return match;

            const value = (quoted !== undefined ? quoted : raw);
            if (['author', 'title', 'series'].includes(key)) {
                if (eq)
                    result.exact.push({field: key, value: normalize(value)});
                else
                    result.columns.push({field: key, tokens: queryTokens(value)});
            } else {
                const target = (minus ? result.excludes : result.filters);
                const values = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
                target[key] = (target[key] || []).concat(values);
            }
            return lead;
        });

        result.free = queryTokens(text);
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

    //id всех совпадений FTS: собираются функцией SQL, без объекта строки на каждое совпадение
    matchIds(expression) {
        this.hits = [];
        try {
            this.db.prepare('SELECT COUNT(catalog_hit(rowid)) AS n FROM book_fts WHERE book_fts MATCH ?').get(expression);
            return this.hits;
        } finally {
            this.hits = null;
        }
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
        const stored = new Map(db.prepare('SELECT name, data FROM column_data').all().map(row => [row.name, row.data]));
        let c;
        if (stored.has('dicts')) {
            const dicts = JSON.parse(Buffer.from(stored.get('dicts')).toString());
            const codes = {};
            for (const [field, values] of Object.entries(dicts))
                codes[field] = new Map(values.map((value, index) => [value, index]));
            c = {dicts, codes};
            for (const name of columnArrays)
                c[name] = typedFromBlob(columnTypes[name], stored.get(name));
            c.maxId = c.flags.length - 1;
        } else {
            c = this.computeColumns(db);
        }

        c.order = {};
        for (const row of db.prepare('SELECT name, ids FROM sort_order').all())
            c.order[row.name] = typedFromBlob(Uint32Array, row.ids);
        c.pass = new Uint8Array(c.maxId + 1);
        c.editions = new Uint32Array(c.maxId + 1);
        this.applyHidden(c);
        this.columns = c;
    }

    //Колонки по таблицам книг: при построении (и для индексов без сохранённых колонок)
    computeColumns(db) {
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
            librate: new Uint8Array(size), flags: new Uint8Array(size), date: new Uint32Array(size), work: new Uint32Array(size),
        };
        for (const row of db.prepare('SELECT id, lang, ext, source, librate, del, work, date FROM book').iterate()) {
            const id = row.id;
            c.lang[id] = code('lang', row.lang || '');
            c.ext[id] = code('ext', String(row.ext || '').toLowerCase());
            c.source[id] = code('source', row.source || '');
            c.librate[id] = Math.max(0, Math.min(255, row.librate || 0));
            c.flags[id] = 1 | (row.del ? 2 : 0);
            c.work[id] = row.work || 0;
            c.date[id] = parseInt(String(row.date || '').replace(/\D/g, '').substring(0, 8), 10) || 0;
        }

        //жанры: для книги id её жанры лежат в genreList[genreStart[id] .. genreStart[id + 1])
        //два прохода потоком вместо загрузки всех строк book_genre объектами
        const genreCount = new Uint32Array(size + 1);
        let genreTotal = 0;
        for (const row of db.prepare('SELECT book_id FROM book_genre').iterate()) {
            genreCount[row.book_id + 1]++;
            genreTotal++;
        }
        for (let i = 1; i <= size; i++)
            genreCount[i] += genreCount[i - 1];
        c.genreStart = genreCount;
        c.genreList = new Uint16Array(genreTotal);
        const fill = new Uint32Array(size);
        for (const row of db.prepare('SELECT book_id, genre FROM book_genre').iterate())
            c.genreList[genreCount[row.book_id] + fill[row.book_id]++] = code('genre', row.genre);
        return c;
    }

    //Условия запроса как проверки по колонкам. Фасетные поля проверяются отдельно,
    //чтобы счётчик каждого фильтра считался без его собственного условия.
    compileFilter(filters, excludes, options) {
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

    //колонки загружаются сразу после открытия, а не первым поиском или первой витриной
    warmUp() {
        if (this.db && !this.columns)
            this.loadColumns();
        return true;
    }

    //---------- «Похоже на то, что вы читали» ----------
    //Оценка всех книг по весам вкуса из колонок в памяти. Возвращает лучшие id отдельно для книг
    //с совпадениями (affinity) и для «нового для разнообразия» (explore). Формула та же, что была
    //у прохода по основной БД: автор ×32, серия ×36, жанр ×26, тема ×20, язык, отказы, оценка, свежесть.
    similarCandidates(request = {}) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        if (!this.columns)
            this.loadColumns();
        const c = this.columns;
        const limit = Math.max(1, Math.min(Number(request.limit) || 192, 2000));
        const rotationSeed = Number(request.rotationSeed) || 0;
        const now = Number(request.now) || Date.now();

        //книги авторов и серий из вкуса - по индексам SQLite; у книги нескольких авторов берётся больший вес
        const findAuthor = this.db.prepare('SELECT id FROM author WHERE name_norm = ?');
        const authorBooks = this.db.prepare('SELECT book_id AS id FROM book_author WHERE author_id = ?');
        const seriesBooks = this.db.prepare('SELECT id FROM book WHERE series_norm = ?');
        const addMax = (map, id, weight) => map.set(id, Math.max(map.get(id) || 0, weight));
        const authorWeights = (weights = {}) => {
            const map = new Map();
            for (const [key, weight] of Object.entries(weights || {}).slice(0, 200)) {
                for (const name of splitAuthors(key)) {
                    const author = findAuthor.get(normalize(name));
                    if (author) {
                        for (const row of authorBooks.iterate(author.id))
                            addMax(map, row.id, Number(weight) || 0);
                    }
                }
            }
            return map;
        };
        const seriesWeights = (weights = {}) => {
            const map = new Map();
            for (const [key, weight] of Object.entries(weights || {}).slice(0, 200)) {
                const name = normalize(key);
                if (name) {
                    for (const row of seriesBooks.iterate(name))
                        addMax(map, row.id, Number(weight) || 0);
                }
            }
            return map;
        };
        const dictWeights = (field, weights = {}) => {
            const result = new Float64Array(c.dicts[field].length);
            const lower = new Map(Object.entries(weights || {}).map(([key, weight]) => [String(key).toLowerCase(), Number(weight) || 0]));
            c.dicts[field].forEach((value, code) => {
                result[code] = lower.get(String(value).toLowerCase()) || 0;
            });
            return result;
        };
        const keywordScores = (weights = {}, factor = 1) => {
            const scores = new Map();
            const query = this.db.prepare('SELECT rowid AS id FROM book_fts WHERE book_fts MATCH ?');
            for (const [key, weight] of Object.entries(weights || {}).slice(0, 40)) {
                const phrase = normalize(key);
                if (!phrase)
                    continue;
                for (const row of query.iterate(`keywords : "${phrase.replace(/"/g, '')}"`))
                    scores.set(row.id, (scores.get(row.id) || 0) + (Number(weight) || 0) * factor);
            }
            return scores;
        };

        const preferredAuthors = authorWeights(request.preferredAuthors);
        const preferredSeries = seriesWeights(request.preferredSeries);
        const preferredGenres = dictWeights('genre', request.preferredGenres);
        const preferredLanguages = dictWeights('lang', request.preferredLanguages);
        const keywordPlus = keywordScores(request.preferredKeywords, 20);

        const yearMs = 365 * 86400000;
        const byScore = (a, b) => (b.score - a.score) || (a.id - b.id);
        const keepTop = (list) => {
            if (list.length >= limit * 2) {
                list.sort(byScore);
                list.length = limit;
            }
        };
        const affinity = [];
        const explore = [];
        for (let id = 1; id <= c.maxId; id++) {
            const flags = c.flags[id];
            if (!(flags & 1) || (flags & 2))
                continue;

            let score = (preferredAuthors.get(id) || 0) * 32
                + (preferredSeries.get(id) || 0) * 36
                + (keywordPlus.get(id) || 0);
            for (let i = c.genreStart[id]; i < c.genreStart[id + 1]; i++)
                score += preferredGenres[c.genreList[i]] * 26;

            const isExplore = !score;
            if (isExplore)
                score = 22;
            score += Math.min(8, preferredLanguages[c.lang[id]] * 2);

            score += Math.min(5, c.librate[id]) * 4;
            const date = c.date[id];
            if (date) {
                const time = Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100);
                const age = Math.max(0, Math.min(yearMs, now - time));
                score += 12 - age * 12 / yearMs;
            }
            //поворот выдачи раз в сутки: стабильный в течение дня
            score += (((Math.imul(id, 2654435761) >>> 0) + rotationSeed) % 9973) / 9973 * 8;

            const target = (isExplore ? explore : affinity);
            target.push({id, score});
            keepTop(target);
        }

        const finish = list => list.sort(byScore).slice(0, limit);
        return {affinity: finish(affinity), explore: finish(explore)};
    }

    //---------- поиск ----------
    search(request = {}) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
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
        const sort = String(request.sort || (hasText ? 'relevance' : 'date'));
        //итог и счётчики фильтров считаются по всем совпадениям; оценка bm25 нужна только сортировке по релевантности
        //и только если совпадений не больше maxRanked, иначе они идут «по оценке» (rating)
        const hitIds = (hasText ? this.matchIds(text.expression) : null);
        let scored = null;
        if (hasText && sort === 'relevance' && hitIds.length <= this.maxRanked)
            scored = this.db.prepare(`SELECT rowid AS id, bm25(book_fts, 10.0, 6.0, 4.0, 1.0) AS score FROM book_fts WHERE book_fts MATCH ?`).all(text.expression);

        const exactIds = (parsed.exact.length ? this.exactIdSet(parsed.exact) : null);
        const filter = this.compileFilter(filters, parsed.excludes, {showDeleted: !!request.showDeleted, exactIds});

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
        //group: издания одного произведения - одна позиция выдачи; editions[метка] - сколько изданий прошло фильтры
        const group = !!request.group;
        const editions = c.editions;
        if (group)
            editions.fill(0);
        let total = 0;

        const visit = (id) => {
            if (!filter.base(id))
                return;
            const mask = filter.mask(id);
            if (mask === full) {
                pass[id] = 1;
                const work = (group ? c.work[id] : 0);
                if (!work || !editions[work]++)
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

        if (hitIds) {
            for (const id of hitIds)
                visit(id);
        } else {
            for (let id = 1; id <= c.maxId; id++)
                visit(id);
        }

        //страница результата; произведение представляет первое в порядке выдачи издание
        const ids = [];
        const pageEditions = {};
        let skipped = 0;
        const take = (id) => {
            const work = (group ? c.work[id] : 0);
            const count = (work ? editions[work] : 1);
            if (!count)
                return;
            if (work)
                editions[work] = 0;//остальные издания этого произведения пропускаются
            if (skipped < offset) {
                skipped++;
                return;
            }
            ids.push(id);
            if (count > 1)
                pageEditions[id] = count;
        };
        if (scored) {
            const ranked = scored.filter(hit => pass[hit.id]);
            ranked.sort((a, b) => a.score - b.score || c.librate[b.id] - c.librate[a.id] || a.id - b.id);
            for (let i = 0; i < ranked.length && ids.length < limit; i++)
                take(ranked[i].id);
        } else {
            const order = c.order[sort === 'relevance' ? 'rating' : sort] || c.order.date;
            for (let i = 0; i < order.length && ids.length < limit; i++) {
                if (pass[order[i]])
                    take(order[i]);
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
            editions: pageEditions,
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
        //авторы ищутся и по именам из библиотеки, и по английским именам
        for (const [field, kinds] of [['authors', ['author', 'alias']], ['series', ['series']]]) {
            const kindIn = kinds.map(() => '?').join(',');
            let rows;
            if (long.length) {
                const where = short.map(() => ' AND n.name_norm LIKE ?').join('');
                rows = this.db.prepare(`SELECT n.ref AS id, ${this.booksSql('name', 'n')} AS books FROM name_tri JOIN name n ON n.id = name_tri.rowid
                    WHERE name_tri MATCH ? AND n.kind IN (${kindIn})${where} ORDER BY books DESC LIMIT ?`)
                    .all(long.map(word => `"${word}"`).join(' AND '), ...kinds, ...short.map(word => `%${word}%`), limit * 2);
            } else {
                rows = this.db.prepare(`SELECT ref AS id, ${this.booksSql('name', 'name')} AS books FROM name
                    WHERE kind IN (${kindIn}) AND name_norm >= ? AND name_norm < ? ORDER BY books DESC LIMIT ?`)
                    .all(...kinds, words[0], `${words[0]}￿`, limit * 2);
            }

            const ids = [...new Set(rows.map(row => row.id))].slice(0, limit);
            if (field === 'authors') {
                const select = this.db.prepare(`SELECT name, ${this.booksSql('author', 'author')} AS books FROM author WHERE id = ?`);
                const aliasOf = this.db.prepare('SELECT alias FROM author_alias WHERE author_id = ?');
                result.authors = ids
                    .map(id => Object.assign({}, select.get(id), {alias: (aliasOf.get(id) || {}).alias || ''}))
                    .filter(row => row.name && row.books > 0)
                    .map(row => (row.alias ? {name: row.name, books: row.books, alias: row.alias} : {name: row.name, books: row.books}));
            } else {
                const select = this.db.prepare(`SELECT name, ${this.booksSql('series', 'series')} AS books FROM series WHERE id = ?`);
                result.series = ids
                    .map(id => select.get(id))
                    .filter(row => row && row.books > 0)
                    .map(row => ({name: row.name, books: row.books}));
            }
        }
        return result;
    }

    //Авторы или серии для вкладок поиска: без запроса - по алфавиту, с запросом - по совпадению имени
    listNames(request = {}) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');

        const isAuthor = (request.kind !== 'series');
        const table = (isAuthor ? 'author' : 'series');
        const limit = Math.max(1, Math.min(200, parseInt(request.limit, 10) || 50));
        const offset = Math.max(0, parseInt(request.offset, 10) || 0);
        const words = queryTokens(request.q);
        const aliasOf = this.db.prepare('SELECT alias FROM author_alias WHERE author_id = ?');
        const describe = (row) => {
            const alias = (isAuthor ? (aliasOf.get(row.id) || {}).alias : '');
            return (alias ? {name: row.name, books: row.books, alias} : {name: row.name, books: row.books});
        };

        const books = this.booksSql(table, table);
        if (!words.length) {
            const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${books} > 0`).get().n;
            const rows = this.db.prepare(`SELECT id, name, ${books} AS books FROM ${table} WHERE ${books} > 0 ORDER BY name_norm LIMIT ? OFFSET ?`).all(limit, offset);
            return {items: rows.map(describe), total};
        }

        //все слова запроса должны встретиться в имени (у авторов - и в английском имени)
        const kinds = (isAuthor ? ['author', 'alias'] : ['series']);
        const kindIn = kinds.map(() => '?').join(',');
        const long = words.filter(word => word.length >= 3);
        const short = words.filter(word => word.length < 3);
        let ids;
        if (long.length) {
            const where = short.map(() => ' AND n.name_norm LIKE ?').join('');
            ids = this.db.prepare(`SELECT n.ref AS id, MAX(${this.booksSql('name', 'n')}) AS books FROM name_tri JOIN name n ON n.id = name_tri.rowid
                WHERE name_tri MATCH ? AND n.kind IN (${kindIn})${where} GROUP BY n.ref ORDER BY books DESC LIMIT 5000`)
                .all(long.map(word => `"${word}"`).join(' AND '), ...kinds, ...short.map(word => `%${word}%`));
        } else {
            ids = this.db.prepare(`SELECT ref AS id, MAX(${this.booksSql('name', 'name')}) AS books FROM name
                WHERE kind IN (${kindIn}) AND name_norm LIKE ? GROUP BY ref ORDER BY books DESC LIMIT 5000`)
                .all(...kinds, `%${words[0]}%`);
        }
        const select = this.db.prepare(`SELECT id, name, ${books} AS books FROM ${table} WHERE id = ?`);
        const rows = ids.slice(offset, offset + limit).map(row => select.get(row.id)).filter(row => row && row.books > 0);
        return {items: rows.map(describe), total: ids.length};
    }

    authorAliases(name = '') {
        if (!this.db)
            return [];
        return this.db.prepare('SELECT aa.alias AS alias FROM author a JOIN author_alias aa ON aa.author_id = a.id WHERE a.name_norm = ?')
            .all(normalize(name)).map(row => row.alias);
    }

    //Английские имена авторов для набора полей «автор» книг: {поле: ['Isaac Asimov', ...]}
    authorAliasesOf(values = []) {
        const result = {};
        for (const value of values)
            result[value] = splitAuthors(value).flatMap(name => this.authorAliases(name));
        return result;
    }

    //Подсказки при наборе: авторы, серии и книги
    suggest(request = {}) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');

        const parsed = this.parseQuery(request.q);
        const text = this.resolveText(parsed);
        const query = text.corrected || parsed.free.join(' ');
        const names = (query ? this.matchNames(query, 4) : {authors: [], series: []});

        let books = [];
        if (text.expression) {
            if (!this.columns)
                this.loadColumns();
            //одно издание на произведение
            const seen = new Set();
            const firstEdition = work => !work || (!seen.has(work) && seen.add(work));
            const count = this.db.prepare('SELECT COUNT(*) AS n FROM book_fts WHERE book_fts MATCH ?').get(text.expression).n;
            if (count <= this.maxRanked) {
                books = this.db.prepare(`SELECT b.id AS id, b.work AS work
                    FROM book_fts f JOIN book b ON b.id = f.rowid
                    WHERE book_fts MATCH ? AND b.del = 0 AND catalog_visible(b.id)
                    ORDER BY bm25(book_fts, 10.0, 6.0, 4.0, 1.0) LIMIT 30`).all(text.expression)
                    .filter(row => firstEdition(row.work))
                    .slice(0, 6)
                    .map(row => ({id: row.id}));
            } else {
                //слишком много совпадений для bm25 (см. maxRanked): лучшие по оценке
                const c = this.columns;
                c.pass.fill(0);
                for (const id of this.matchIds(text.expression))
                    c.pass[id] = 1;
                for (let i = 0; i < c.order.rating.length && books.length < 6; i++) {
                    const id = c.order.rating[i];
                    if (c.pass[id] && (c.flags[id] & 1) && !(c.flags[id] & 2) && firstEdition(c.work[id]))
                        books.push({id});
                }
            }
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
            const old = db.prepare('SELECT del, series_norm, source FROM book WHERE id = ?').get(id) || {};
            const sourceBooks = db.prepare(`INSERT INTO source_books(source, kind, ref, books) VALUES (?, ?, ?, MAX(0, ?))
                ON CONFLICT(source, kind, ref) DO UPDATE SET books = MAX(0, books + excluded.books)`);
            const multiSource = (db.prepare('SELECT COUNT(*) AS n FROM source').get().n > 1);
            //исходные поля записи не меняются: правка накладывается при выдаче, здесь - поиск и связи с авторами
            db.prepare('UPDATE book SET title_norm = ?, series_norm = ? WHERE id = ?').run(normalize(title), normalize(series), id);
            //счётчики книг авторов и серий (списки, поиск имён) считают только неудалённые книги
            const counted = old.del ? 0 : 1;
            const before = new Set(db.prepare('SELECT author_id FROM book_author WHERE book_id = ?').all(id).map(r => r.author_id));
            db.prepare('DELETE FROM book_author WHERE book_id = ?').run(id);
            const findAuthor = db.prepare('SELECT id FROM author WHERE name_norm = ?');
            const aliasOf = db.prepare('SELECT alias FROM author_alias WHERE author_id = ?');
            const authorAliases = [];
            const after = new Set();
            for (const name of splitAuthors(author)) {
                let found = findAuthor.get(normalize(name));
                if (!found) {
                    const authorId = Number(db.prepare('INSERT INTO author(name, name_norm, books) VALUES (?, ?, 0)').run(name, normalize(name)).lastInsertRowid);
                    const nameId = db.prepare(`INSERT INTO name(kind, ref, name_norm, books) VALUES ('author', ?, ?, 0)`).run(authorId, normalize(name)).lastInsertRowid;
                    db.prepare('INSERT INTO name_tri(rowid, name_norm) VALUES (?, ?)').run(nameId, normalize(name));
                    found = {id: authorId};
                }
                authorAliases.push(...aliasOf.all(found.id).map(r => r.alias));
                if (after.has(found.id))
                    continue;
                after.add(found.id);
                db.prepare('INSERT INTO book_author(book_id, author_id) VALUES (?, ?)').run(id, found.id);
            }
            const addBooks = (authorId, delta) => {
                db.prepare('UPDATE author SET books = MAX(0, books + ?) WHERE id = ?').run(delta, authorId);
                db.prepare(`UPDATE name SET books = MAX(0, books + ?) WHERE kind IN ('author', 'alias') AND ref = ?`).run(delta, authorId);
                if (multiSource && delta)
                    sourceBooks.run(String(old.source || ''), 'author', authorId, delta);
            };
            for (const authorId of before) {
                if (!after.has(authorId))
                    addBooks(authorId, -counted);
            }
            for (const authorId of after) {
                if (!before.has(authorId))
                    addBooks(authorId, counted);
            }

            const seriesNorm = normalize(series);
            if (seriesNorm !== (old.series_norm || '')) {
                const findSeries = db.prepare('SELECT id FROM series WHERE name_norm = ?');
                const addSeriesBooks = (seriesId, delta) => {
                    db.prepare('UPDATE series SET books = MAX(0, books + ?) WHERE id = ?').run(delta, seriesId);
                    db.prepare(`UPDATE name SET books = MAX(0, books + ?) WHERE kind = 'series' AND ref = ?`).run(delta, seriesId);
                    if (multiSource && delta)
                        sourceBooks.run(String(old.source || ''), 'series', seriesId, delta);
                };
                const before = (old.series_norm ? findSeries.get(old.series_norm) : null);
                if (before)
                    addSeriesBooks(before.id, -counted);
                if (seriesNorm) {
                    let found = findSeries.get(seriesNorm);
                    if (!found) {
                        const seriesId = Number(db.prepare('INSERT INTO series(name, name_norm, books) VALUES (?, ?, 0)').run(series, seriesNorm).lastInsertRowid);
                        const nameId = db.prepare(`INSERT INTO name(kind, ref, name_norm, books) VALUES ('series', ?, ?, 0)`).run(seriesId, seriesNorm).lastInsertRowid;
                        db.prepare('INSERT INTO name_tri(rowid, name_norm) VALUES (?, ?)').run(nameId, seriesNorm);
                        found = {id: seriesId};
                    }
                    addSeriesBooks(found.id, counted);
                }
            }

            //английские имена авторов ищутся наравне с именами из библиотеки, как при построении
            db.prepare('DELETE FROM book_fts WHERE rowid = ?').run(id);
            db.prepare('INSERT INTO book_fts(rowid, title, author, series, keywords) VALUES (?, ?, ?, ?, ?)')
                .run(id, normalize(title), normalize([author, ...authorAliases].join(' ')), seriesNorm, normalize(row.keywords));
            db.exec('COMMIT');
        } finally {
            db.close();
        }
        //названия и серии изменились: кэш групп и масок OPDS строится заново
        this.queryMasks = null;
        //язык и оценка правкой не меняются: колонки в памяти остаются верными
        //shortcut: книга остаётся в прежней группе изданий до следующей сборки БД; пересчитывать группу здесь, если правки станут частыми
    }

    //---------- записи книг ----------
    //Поля записи как у разбора INPX, плюс сведения об источнике
    //книги выключенных библиотек пропускаются; includeHidden - вернуть и их с пометкой hiddenSource (списки показывают их бледными)
    bookRows(sql, params = [], includeHidden = false) {
        return this.db.prepare(`SELECT id, uid, title, author, series, serno, genre, keywords, lang, ext, size, date, librate, del,
            file, folder, libid, insno, source FROM book WHERE ${sql}`).all(...params).filter(row => includeHidden || !this.hidden.has(row.source)).map((row) => {
            const source = this.sources.get(row.source) || {};
            const live = (this.liveSources && this.liveSources.get(row.source)) || {};
            return {
                id: row.id, _uid: row.uid, author: row.author, genre: row.genre, title: row.title, series: row.series, serno: row.serno,
                file: row.file, size: row.size, libid: row.libid, del: row.del, ext: row.ext, date: row.date, lang: row.lang,
                librate: row.librate, keywords: row.keywords, folder: row.folder, insno: row.insno,
                sourceId: row.source, sourceName: live.name || source.name || '', sourceLibDir: live.libDir || source.lib_dir || '',
                ...(this.hidden.has(row.source) ? {hiddenSource: true} : {}),
            };
        });
    }

    //Записи по id в порядке запроса
    getBooks(ids = []) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        const byId = new Map(this.bookRows('id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids.map(Number))]).map(row => [row.id, row]));
        return ids.map(id => byId.get(Number(id))).filter(Boolean);
    }

    //Ответ запроса с записями его книг в books: id и записи берутся из одной БД, даже если между двумя вызовами потока её заменили.
    //id книг - в ids, в самом ответе-массиве или в строках books, found (названия OPDS), affinity и explore (похожие книги)
    withBooks(action, ...args) {
        const result = this[action](...args);
        if (Array.isArray(result))
            return {books: this.getBooks(result)};
        const ids = result.ids || ['books', 'found', 'affinity', 'explore'].flatMap(key => (result[key] || []).map(row => row.id));
        //ответ может лежать в кэше запросов: меняется копия
        const answer = Object.assign({}, result, {books: this.getBooks(ids)});
        delete answer.ids;
        return answer;
    }

    getBooksByUids(uids = [], includeHidden = false) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        return this.bookRows('uid IN (SELECT value FROM json_each(?))', [JSON.stringify(uids.map(String))], includeHidden);
    }

    //Не удалённые записи по нормализованному названию: {title_norm: [записи]}
    getBooksByTitles(titles = []) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        const result = {};
        const rows = this.db.prepare('SELECT id, title_norm FROM book WHERE title_norm IN (SELECT value FROM json_each(?)) AND del = 0')
            .all(JSON.stringify(titles.map(String)));
        const byId = new Map(this.getBooks(rows.map(row => row.id)).map(row => [row.id, row]));
        for (const row of rows) {
            if (!byId.has(row.id))
                continue;
            if (!result[row.title_norm])
                result[row.title_norm] = [];
            result[row.title_norm].push(byId.get(row.id));
        }
        return result;
    }

    //Книги автора по имени (с учётом правок метаданных): {author: имя из библиотеки, ids}
    authorBooks(name = '') {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        const author = this.db.prepare('SELECT id, name FROM author WHERE name_norm = ?').get(normalize(name));
        if (!author)
            return {author: '', ids: []};
        const ids = this.db.prepare('SELECT book_id AS id FROM book_author WHERE author_id = ? ORDER BY book_id').all(author.id).map(row => row.id);
        return {author: author.name, ids};
    }

    seriesBooks(name = '') {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        const value = normalize(name);
        return (value ? this.db.prepare('SELECT id FROM book WHERE series_norm = ? ORDER BY id').all(value).map(row => row.id) : []);
    }

    //Книги нескольких серий одним запросом: series - id книг каждой серии по порядку names, ids - все эти id
    seriesBooksOf(names = []) {
        const series = names.map(name => this.seriesBooks(name));
        return {series, ids: [...new Set(series.flat())]};
    }

    //Значения фильтров, встречающиеся в библиотеке
    facetValues() {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        if (!this.columns)
            this.loadColumns();
        const c = this.columns;
        const {lang, ext, genre} = c.dicts;
        if (!this.hidden.size)
            return {lang: lang.filter(Boolean), ext: ext.filter(Boolean), genre: genre.filter(Boolean)};

        //только значения, у которых есть книги включённых библиотек
        const used = {lang: new Uint8Array(lang.length), ext: new Uint8Array(ext.length), genre: new Uint8Array(genre.length)};
        for (let id = 1; id <= c.maxId; id++) {
            if (!(c.flags[id] & 1))
                continue;
            used.lang[c.lang[id]] = 1;
            used.ext[c.ext[id]] = 1;
            for (let i = c.genreStart[id]; i < c.genreStart[id + 1]; i++)
                used.genre[c.genreList[i]] = 1;
        }
        const pick = (field, values) => values.filter((value, code) => value && used[field][code]);
        return {lang: pick('lang', lang), ext: pick('ext', ext), genre: pick('genre', genre)};
    }

    //Записи по ключам «источник:libid» (так выводятся id книг Kobo): {ключ: [записи]}
    getBooksByStableKeys(keys = []) {
        if (!this.db)
            throw new Error('catalog_index_not_ready');
        const result = {};
        const select = `source = ? AND libid = ?`;
        for (const key of keys) {
            const at = String(key).indexOf(':');
            if (at < 0)
                continue;
            const rows = this.bookRows(select, [key.substring(0, at), key.substring(at + 1)]);
            if (rows.length)
                result[key] = rows;
        }
        return result;
    }
}

Object.assign(CatalogIndex.prototype, require('./CatalogIndexQueries'));
module.exports = CatalogIndex;
