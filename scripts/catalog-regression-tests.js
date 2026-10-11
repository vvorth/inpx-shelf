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
        // RC6 cache rows did not yet store the restored size.
        const store = new StateStore({dataDir: dir});
        store.putBookFile({id: book._uid, hash, size: 0, assetVersion: ''});
        const bookDir = path.join(dir, 'book');
        const descriptor = path.join(bookDir, `${hash}.d.json`);
        await fs.outputJson(descriptor, {size: bytes.length, assetVersion: 'fblibrary-assets-v5'});
        const make = () => {
            const worker = Object.create(require('../server/core/WebWorker').prototype);
            worker.config = {bookDir};
            worker.stateStore = new StateStore({dataDir: dir});
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
        store.close();
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
        } finally {
            index.close();
        }
    });
}

module.exports = [testRegExpSearchRefusesBacktrackingPatterns, testPreparedBookSizeAppearsInCatalogAcrossRestart];
