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

module.exports = [testSpellingVariantsShareAuthorAndSeries, testRegExpSearchRefusesBacktrackingPatterns, testPreparedBookSizeAppearsInCatalogAcrossRestart];
