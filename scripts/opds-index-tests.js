//Тесты запросов OPDS к индексу каталога: node scripts/opds-index-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CatalogIndex = require('../server/core/search/CatalogIndex');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opds-index-'));
const index = new CatalogIndex();
try {
    const book = (id, title, author, extra = {}) => Object.assign({
        id, _uid: `u${id}`, title, author, series: '', serno: 0, genre: 'prose_classic', lang: 'ru', ext: 'fb2',
        size: 1000, date: '2020-01-01', librate: 4, del: 0, sourceId: 'main', keywords: '',
    }, extra);

    const file = path.join(dir, 'catalog.sqlite');
    assert.throws(() => index.findBooks({}), /catalog_index_not_ready/);
    index.beginBuild(file);
    index.insertBooks([
        book(1, 'Мастер и Маргарита', 'Булгаков Михаил', {series: 'Классика'}),
        book(2, 'Собачье сердце', 'Булгаков Михаил'),
        book(3, 'Трудно быть богом', 'Стругацкий Аркадий,Стругацкий Борис', {series: 'Мир Полудня', serno: 3, genre: 'sf_social,sf'}),
        book(4, 'Ёлка у Ивановых', 'Введенский Александр', {genre: 'dramaturgy'}),
        book(5, 'A Wizard of Earthsea', 'Le Guin Ursula', {lang: 'en', ext: 'epub', genre: 'sf_fantasy'}),
        book(6, 'Мастер и Маргарита!', 'Булгаков Михаил'),
        book(7, 'Удалённая книга', 'Булгаков Михаил', {del: 1}),
        book(8, '«Елка» для всех', 'Иванов Иван', {genre: 'dramaturgy'}),
        book(9, '1984', 'Orwell George', {lang: 'en', genre: 'sf_social'}),
        book(10, 'Мир без конца', 'Иванов Иван', {del: 1, genre: 'dramaturgy'}),
    ]);
    index.finishBuild({inpxHash: 'h'});
    index.open(file);

    const sorted = query => index.findBooks(query).ids.sort((a, b) => a - b);

    //findBooks: маркеры
    assert.deepStrictEqual(sorted({author: 'булг'}), [1, 2, 6, 7]);
    assert.deepStrictEqual(sorted({author: 'БУЛГ', del: '0'}), [1, 2, 6]);
    assert.deepStrictEqual(sorted({author: '=булгаков михаил'}), [1, 2, 6, 7]);
    assert.deepStrictEqual(sorted({author: '=булг'}), []);
    assert.deepStrictEqual(sorted({author: '*аков'}), [1, 2, 6, 7]);
    assert.deepStrictEqual(sorted({author: '*guin'}), [5]);
    assert.deepStrictEqual(sorted({author: '#guin'}), [], '# excludes names starting with a latin letter');
    assert.deepStrictEqual(sorted({author: '~^le\\s'}), [5]);
    assert.throws(() => index.findBooks({author: '~(a+)+'}), /сложное/);
    assert.deepStrictEqual(sorted({title: 'елка'}), [4, 8], 'leading punctuation is ignored');
    assert.deepStrictEqual(sorted({title: 'ёлка'}), [4, 8], 'ё matches е');
    assert.deepStrictEqual(sorted({title: '=мастер и маргарита'}), [1, 6], 'punctuation is ignored in exact match');
    assert.deepStrictEqual(sorted({title: '*маргар'}), [1, 6]);
    assert.deepStrictEqual(sorted({title: '#198'}), [9], '# allows names starting with a digit');
    assert.deepStrictEqual(sorted({title: '#мир'}), [], '# excludes names starting with a cyrillic letter');
    assert.deepStrictEqual(sorted({title: '~^собачье сердце$'}), [2]);
    assert.throws(() => index.findBooks({title: '~сердце$'}), /двух обычных символов/, 'a pattern without a literal start would test every title');
    assert.deepStrictEqual(sorted({series: 'мир'}), [3]);
    assert.deepStrictEqual(sorted({series: '=классика'}), [1]);
    assert.deepStrictEqual(sorted({title: '???'}), [], 'punctuation-only value matches nothing');
    assert.deepStrictEqual(sorted({author: '*???'}), []);
    //несколько авторов у книги: подходит любой
    assert.deepStrictEqual(sorted({author: 'стругацкий б'}), [3]);
    assert.deepStrictEqual(sorted({author: '=стругацкий борис'}), [3]);
    assert.deepStrictEqual(sorted({author: '=стругацкий аркадий'}), [3]);
    //сочетания и фильтры
    assert.deepStrictEqual(sorted({author: 'булг', title: 'мастер'}), [1, 6]);
    assert.deepStrictEqual(sorted({genre: 'sf'}), [3]);
    assert.deepStrictEqual(sorted({genre: 'sf,sf_fantasy'}), [3, 5]);
    assert.deepStrictEqual(sorted({genre: 'dramaturgy', del: '0'}), [4, 8]);
    assert.deepStrictEqual(sorted({genre: 'dramaturgy'}), [4, 8, 10]);
    assert.deepStrictEqual(sorted({lang: 'en'}), [5, 9]);
    assert.deepStrictEqual(sorted({lang: 'en,ru', genre: 'sf_social'}), [3, 9]);
    //порядок: автор, серия (книги без серии в конце), номер, название; страницы
    assert.deepStrictEqual(index.findBooks({author: 'булг', del: '0'}).ids, [1, 6, 2], 'one author: books with a series first');
    const all = index.findBooks({del: '0'});
    assert.strictEqual(all.totalFound, 8);
    const page = index.findBooks({del: '0', limit: 3, offset: 2});
    assert.deepStrictEqual(page.ids, all.ids.slice(2, 5));
    assert.strictEqual(page.totalFound, 8);

    //opdsGroups
    const groups = (from, query) => index.opdsGroups(from, query).found.map(g => [g.value, g.count, g.bookCount]);
    assert.deepStrictEqual(groups('author', {depth: 1, del: '0'}), [['l', 1, 1], ['o', 1, 1], ['б', 1, 3], ['в', 1, 1], ['и', 1, 1], ['с', 2, 2]]);
    assert.deepStrictEqual(groups('author', {depth: 2, author: 'с', del: '0'}), [['ст', 2, 2]]);
    assert.deepStrictEqual(groups('author', {depth: 1, genre: 'sf', del: '0'}), [['с', 2, 2]]);
    assert.deepStrictEqual(groups('author', {depth: 1, genre: 'dramaturgy', del: '0'}), [['в', 1, 1], ['и', 1, 1]]);
    assert.deepStrictEqual(groups('author', {depth: 1, genre: 'nope', del: '0'}), []);
    assert.deepStrictEqual(groups('series', {depth: 2, del: '0'}), [['кл', 1, 1], ['ми', 1, 1]]);
    assert.deepStrictEqual(groups('series', {depth: 1, genre: 'sf', del: '0'}), [['м', 1, 1]]);
    const titleGroups = index.opdsGroups('title', {depth: 1, del: '0'});
    assert.deepStrictEqual(titleGroups.found.map(g => [g.value, g.count, g.bookCount]),
        [['1', 1, 1], ['a', 1, 1], ['е', 2, 2], ['м', 1, 2], ['с', 1, 1], ['т', 1, 1]]);
    assert.strictEqual(titleGroups.totalFound, 7);
    assert.deepStrictEqual(groups('title', {depth: 2, title: 'ма', del: '0'}), [['ма', 1, 2]]);
    assert.deepStrictEqual(groups('title', {depth: 1, title: 'е', genre: 'dramaturgy', del: '0'}), [['е', 2, 2]]);
    assert.deepStrictEqual(groups('title', {depth: 6, title: '1', del: '0'}), [['1984', 1, 1]], 'title shorter than depth is its own group');
    assert.deepStrictEqual(groups('title', {depth: 2, title: 'a', del: '0'}), [['a ', 1, 1]], 'a trailing space is kept for the next level');
    assert.deepStrictEqual(groups('title', {depth: 3, title: 'a ', del: '0'}), [['a w', 1, 1]]);
    assert.deepStrictEqual(groups('title', {depth: 1, title: '*маргар', del: '0'}), [['м', 1, 2]], 'marker queries group too');
    assert.deepStrictEqual(groups('title', {depth: 1}).map(g => g[0]), ['1', 'a', 'е', 'м', 'с', 'т', 'у'], 'without del filter deleted books count');
    assert.strictEqual(index.opdsGroups('title', {depth: 1, del: '0'}), titleGroups, 'repeated query comes from the cache');
    assert.throws(() => index.opdsGroups('genre', {}), /Unknown/);

    //opdsNames
    const authors = index.opdsNames('author', {author: 'ст', del: '0'});
    assert.deepStrictEqual(authors.found.map(r => [r.author, r.bookCount]), [['Стругацкий Аркадий', 1], ['Стругацкий Борис', 1]]);
    assert.strictEqual(authors.totalFound, 2);
    const names = index.opdsNames('author', {del: '0', limit: 2, offset: 1});
    assert.strictEqual(names.found.length, 2);
    assert.strictEqual(names.totalFound, 7);
    assert.deepStrictEqual(index.opdsNames('author', {author: 'иванов', del: '0', genre: 'dramaturgy'}).found.map(r => r.bookCount), [1]);
    assert.deepStrictEqual(index.opdsNames('author', {author: '=иванов иван', del: '0'}).found.map(r => r.author), ['Иванов Иван']);
    assert.deepStrictEqual(index.opdsNames('series', {series: '*мир', del: '0'}).found.map(r => [r.series, r.bookCount]), [['Мир Полудня', 1]]);
    const titles = index.opdsNames('title', {title: 'мастер', del: '0'});
    assert.strictEqual(titles.totalFound, 1, 'titles differing in punctuation are one name');
    assert.strictEqual(titles.found[0].bookCount, 2);
    assert.strictEqual(titles.found[0].id, 1);
    assert.deepStrictEqual(index.opdsNames('title', {title: '=мастер и маргарита', del: '0', genre: 'sf'}).found, []);
    assert.strictEqual(index.opdsNames('title', {del: '0'}).totalFound, 7);

    //поиск в одной библиотеке
    assert.deepStrictEqual(sorted({title: '*мастер', sourceId: 'main'}), [1, 6]);
    assert.deepStrictEqual(sorted({title: '*мастер', sourceId: 'other'}), []);

    //итог названий считается раз для всех страниц; правка метаданных его сбрасывает
    const prepare = index.db.prepare.bind(index.db);
    let counts = 0;
    index.db.prepare = (sql) => {
        if (sql.startsWith('SELECT COUNT(*) AS n FROM (SELECT MIN(b.id)'))
            counts++;
        return prepare(sql);
    };
    const titlePage = offset => index.opdsNames('title', {del: '0', limit: 2, offset});
    assert.deepStrictEqual([titlePage(2).totalFound, titlePage(4).totalFound], [7, 7]);
    assert.strictEqual(counts, 0, 'the total of the query above is reused');
    index.updateBook(file, {_uid: 'u2', title: 'Мастер и Маргарита', author: 'Булгаков Михаил'});
    assert.strictEqual(titlePage(0).totalFound, 6);
    assert.strictEqual(counts, 1);

    console.log('ok opds-index-tests');
} catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
} finally {
    //открытый файл БД не даёт удалить каталог в Windows
    index.close();
    fs.rmSync(dir, {recursive: true, force: true});
}
