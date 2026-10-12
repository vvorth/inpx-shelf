const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

async function withTempDir(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-catalog-test-'));
    try {
        await task(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function testPreparedBookSizeAppearsInCatalogAcrossRestart() {
    await withTempDir(async(dir) => {
        const StateStore = require('../server/core/StateStore');
        const bytes = Buffer.from('Original restored EPUB fixture. '.repeat(4096));
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const book = {_uid: 'epub-size', file: '504942', folder: 'usr-500000-504999.zip', ext: 'epub', size: 42};
        //Every StateStore holds state.sqlite open in WAL mode: on Windows the directory
        //cannot be removed until all of them are closed.
        const stores = [];
        const openStore = () => {
            const store = new StateStore({dataDir: dir});
            stores.push(store);
            return store;
        };
        try {
            const store = openStore();
            // RC6 cache rows did not yet store the restored size.
            store.putBookFile({id: book._uid, hash, size: 0, assetVersion: ''});
            const bookDir = path.join(dir, 'book');
            const descriptor = path.join(bookDir, `${hash}.d.json`);
            await fs.outputJson(descriptor, {size: bytes.length, assetVersion: 'fblibrary-assets-v5'});
            const make = () => {
                const worker = Object.create(require('../server/core/WebWorker').prototype);
                worker.config = {bookDir};
                worker.stateStore = openStore();
                worker.readingListStore = {getMetadataOverrides: async() => ({})};
                worker.resetLibraryAssetCaches();
                return worker;
            };
            const result = async worker => worker.applyMetadataOverridesToSearchResult({
                found: [{books: [{...book}]}], books: [{...book}],
            });
            for (const worker of [make(), make()]) {
                const response = await result(worker);
                for (const row of [response.books[0], response.found[0].books[0]]) {
                    assert.strictEqual(row.size, bytes.length);
                    assert.strictEqual(row.inpxSize, 42);
                }
            }
            assert.strictEqual(book.size, 42, 'The INPX-derived record must stay intact');
            await fs.writeJson(descriptor, {size: 1, assetVersion: 'fblibrary-assets-v4'});
            assert.strictEqual((await result(make())).books[0].size, 42, 'Obsolete book caches must not supply sizes');
            await fs.writeFile(descriptor, 'broken json');
            assert.strictEqual((await result(make())).books[0].size, 42);
            await fs.remove(descriptor);
            store.putBookFile({id: book._uid, hash, size: bytes.length, assetVersion: 'fblibrary-assets-v5'});
            assert.strictEqual((await result(make())).books[0].size, bytes.length, 'The measured size survives removal of the file cache');
        } finally {
            for (const store of stores)
                store.close();
        }
    });
}

// JS regular expressions cannot be interrupted: patterns that backtrack per title are refused.
async function testRegExpSearchRefusesBacktrackingPatterns() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const index = new CatalogIndex();
        const file = path.join(dir, 'library.sqlite');
        index.beginBuild(file);
        index.insertBooks([{id: 1, _uid: 'hope', author: 'Huh Christopher', title: 'Keeping My Hope',
            series: '', serno: 0, size: 42, librate: 0, del: 0, sourceId: 'main', insno: 0, folder: 'a.zip', file: '1',
            libid: '1', ext: 'epub', lang: 'en'}]);
        index.finishBuild({});
        index.open(file);
        try {
            assert.deepStrictEqual(index.findBooks({title: '~^keeping.*hope$'}).ids, [1]);
            for (const title of ['~.*.*hope', '~(.*.*)*q', '~(a|a)+q', '~(k)\\1'])
                assert.throws(() => index.findBooks({title}), /слишком сложное/, title);
            assert.throws(() => index.findBooks({author: 'huh', title: '~.{0,99}.{0,99}q'}), /слишком сложное/);
            // optional characters before a fixed run backtrack exponentially (1 s per title at 20)
            assert.throws(() => index.findBooks({title: `~^${'.?'.repeat(20)}.{20}\\x00`}), /слишком сложное/);
            assert.deepStrictEqual(index.findBooks({title: '~^(?:keeping) my hopes?$'}).ids, [1], 'One "?" and a group prefix stay allowed');
            assert.deepStrictEqual(index.findBooks({title: '~^keeping.*?hope$'}).ids, [1], 'A lazy quantifier counts once');
        } finally {
            index.close();
        }
    });
}

// Author and series pages look names up by name_norm: spellings that differ only in case or ё/е are one entry.
async function testSpellingVariantsShareAuthorAndSeries() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const index = new CatalogIndex();
        const file = path.join(dir, 'library.sqlite');
        const book = (id, author, series) => ({id, _uid: `u${id}`, author, title: `Книга ${id}`, series, serno: id, size: 1, librate: 0, del: 0,
            sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang: 'ru'});
        index.beginBuild(file);
        index.insertBooks([book(1, 'Семёнов Юлиан', 'Петровка'), book(2, 'Семенов Юлиан', 'петровка'), book(3, 'семенов юлиан', '')]);
        index.finishBuild({});
        index.open(file);
        try {
            assert.deepStrictEqual(index.authorBooks('Семенов Юлиан'), {author: 'Семёнов Юлиан', ids: [1, 2, 3]});
            assert.deepStrictEqual(index.listNames({kind: 'author'}).items, [{name: 'Семёнов Юлиан', books: 3}]);
            assert.deepStrictEqual(index.listNames({kind: 'series'}).items, [{name: 'Петровка', books: 2}]);
        } finally {
            index.close();
        }
    });
}

// A metadata edit moves the book between authors: their book counts follow.
async function testMetadataEditKeepsAuthorCounts() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const index = new CatalogIndex();
        const file = path.join(dir, 'library.sqlite');
        const book = (id, author) => ({id, _uid: `u${id}`, author, title: `Книга ${id}`, series: '', serno: 0, size: 1, librate: 0, del: 0,
            sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang: 'ru'});
        index.beginBuild(file);
        index.insertBooks([book(1, 'Автор Первый'), book(2, 'Автор Первый'), book(3, 'Автор Второй')]);
        index.finishBuild({});
        index.updateBook(file, {id: 1, title: 'Книга 1', author: 'Автор Второй', series: ''});
        index.updateBook(file, {id: 3, title: 'Книга 3', author: 'Автор Третий,Автор Третий', series: ''});
        index.open(file);
        try {
            assert.deepStrictEqual(index.listNames({kind: 'author'}).items,
                [{name: 'Автор Второй', books: 1}, {name: 'Автор Первый', books: 1}, {name: 'Автор Третий', books: 1}]);
            assert.deepStrictEqual(index.authorBooks('Автор Третий').ids, [3]);
            assert.deepStrictEqual(index.matchNames('автор второй').authors, [{name: 'Автор Второй', books: 1}]);
        } finally {
            index.close();
        }
    });
}

// An edit keeps English author names searchable, registers a new series and refreshes cached OPDS groups.
async function testMetadataEditKeepsAliasesSeriesAndOpdsGroups() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const index = new CatalogIndex();
        const file = path.join(dir, 'library.sqlite');
        const book = (id, title, series) => ({id, _uid: `u${id}`, author: 'Азимов Айзек', title, series, serno: 1, size: 1, librate: 0, del: 0,
            sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang: 'ru'});
        index.beginBuild(file, [['Азимов Айзек', 'Isaac Asimov']]);
        index.insertBooks([book(1, 'Академия', 'Основание'), book(2, 'Конец вечности', '')]);
        index.finishBuild({});
        index.open(file);
        try {
            const titles = () => index.opdsGroups('title', {depth: 1, del: '0'}).found.map(group => group.value);
            assert.deepStrictEqual(titles(), ['а', 'к']);
            index.updateBook(file, {id: 1, title: 'Будущее', author: 'Азимов Айзек', series: 'Новая серия'});
            assert.deepStrictEqual(titles(), ['б', 'к']);
            assert.deepStrictEqual(index.search({q: 'asimov будущее'}).ids, [1]);
            assert.deepStrictEqual(index.listNames({kind: 'series'}).items, [{name: 'Новая серия', books: 1}]);
            assert.deepStrictEqual(index.seriesBooks('Новая серия'), [1]);
            assert.deepStrictEqual(index.matchNames('новая').series, [{name: 'Новая серия', books: 1}]);
        } finally {
            index.close();
        }
    });
}

// The build thread skips repeated _uids and numbers books in order; an edit made during a rebuild
// survives the file swap; a crashed library thread is restarted on the next request.
async function testCatalogSearchRebuildEditsAndThreadRestart() {
    await withTempDir(async(dir) => {
        const InpxParser = require('../server/core/InpxParser');
        const CatalogSearch = require('../server/core/search/CatalogSearch');
        const book = (n, uid) => ({_uid: uid, title: `Book ${n}`, author: 'Author A', series: '', serno: 0, genre: 'sf', lang: 'en', ext: 'fb2',
            size: 1, date: '2026-01-01', librate: 0, del: 0, folder: 'a.zip', file: String(n), libid: String(n), insno: 0, keywords: ''});
        let duringBuild = async() => {};
        const parse = InpxParser.prototype.parse;
        InpxParser.prototype.parse = async function(_file, _onFile, onChunk) {
            this.info = {};
            await onChunk([book(1, 'a'), book(2, 'b'), book(2, 'b')]);
            await duringBuild();
            await onChunk([book(2, 'b'), book(3, 'c')]);
        };
        const overrides = {};
        const worker = {readingListStore: {getMetadataOverrides: async() => overrides},
            applyMetadataOverrideToBook: (row, all) => Object.assign(row, all[row._uid] || {})};
        const search = new CatalogSearch({dataDir: dir, inpxFile: path.join(dir, 'x.inpx')}, worker);
        search.authorNames = {readEntries: async() => ({entries: [], updatedAt: ''})};
        const ids = async uids => (await search.getBooksByUids(uids)).map(row => [row._uid, row.id]);
        try {
            assert.strictEqual(await search.ensure('h1'), true);
            assert.deepStrictEqual(await ids(['a', 'b', 'c']), [['a', 1], ['b', 2], ['c', 3]]);

            duringBuild = async() => {
                const [row] = await search.getBooksByUids(['a']);
                overrides.a = {title: 'Edited Title'};
                await search.updateBook(worker.applyMetadataOverrideToBook(row, overrides));
            };
            assert.strictEqual(await search.ensure('h2', {keepReady: true}), true);
            assert.deepStrictEqual((await search.call('search', {q: 'edited'})).ids, [1]);

            await search.thread.worker.terminate();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual((await search.call('search', {q: 'edited'})).ids, [1]);
        } finally {
            InpxParser.prototype.parse = parse;
            await search.close();
        }
    });
}

// Search and suggest queries are capped in length and word count before they reach FTS.
function testSearchQueryIsCapped() {
    const CatalogIndex = require('../server/core/search/CatalogIndex');
    const parsed = new CatalogIndex().parseQuery(`${Array.from({length: 300}, (_, i) => `w${i}`).join(' ')} author:${'x'.repeat(50)}`);
    assert.strictEqual(parsed.free.length, 12);
    assert.deepStrictEqual(parsed.columns, [], 'A power field past the length cap is dropped');
    assert.strictEqual(new CatalogIndex().parseQuery(`author:"${'слово '.repeat(20)}"`).columns[0].tokens.length, 12);
}

module.exports = [testSearchQueryIsCapped, testCatalogSearchRebuildEditsAndThreadRestart, testMetadataEditKeepsAliasesSeriesAndOpdsGroups, testMetadataEditKeepsAuthorCounts,
    testSpellingVariantsShareAuthorAndSeries, testRegExpSearchRefusesBacktrackingPatterns, testPreparedBookSizeAppearsInCatalogAcrossRestart];
