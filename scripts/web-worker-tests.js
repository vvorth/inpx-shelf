const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-web-worker-'));
    try {
        return await task(dir);
    } finally {
        await fs.remove(dir);
    }
}

function bareWorker(fields = {}) {
    const WebWorker = require('../server/core/WebWorker');
    return Object.assign(Object.create(WebWorker.prototype), fields);
}

//кеш внешней витрины: один ключ на страницу клиента, без полок прежней библиотеки и просроченных записей
async function testDiscoveryCacheIsPruned() {
    await temporary(async(dataDir) => {
        const day = 24*60*60*1000;
        const worker = bareWorker({config: {dataDir}, discoveryCache: new Map()});
        worker.discoveryDiskCache = {
            'discovery:old-hash:external:v6:x': {time: Date.now(), ttl: day, value: {}},
            'wikidata-awards:v5': {time: Date.now() - 2*day, ttl: day, value: {}},
            'discovery:new-hash:legacy': {time: Date.now() - 8*day, value: {}},
        };
        const builds = [];
        worker.buildExternalDiscoveryShelfV2 = async(limit) => {
            builds.push(limit);
            return {items: Array.from({length: limit}, (item, index) => ({_uid: String(index)})), discoveryHasMore: false};
        };
        const discovery = {externalSource: 'wikidata-awards', externalName: '', externalBrowseUrl: '', externalTtlMinutes: 1440};

        const first = await worker.rememberExternalDiscoveryShelf('new-hash', discovery, 30);
        const second = await worker.rememberExternalDiscoveryShelf('new-hash', discovery, 40);
        assert.deepStrictEqual(builds, [48]);
        assert.strictEqual(first.items.length, 30);
        assert.strictEqual(second.items.length, 40);
        assert.strictEqual(second.discoveryHasMore, true);

        const text = await fs.readFile(path.join(dataDir, 'discovery-cache.json'), 'utf8');
        assert.ok(!text.includes('\n'));
        const keys = Object.keys(JSON.parse(text));
        assert.strictEqual(keys.length, 1);
        assert.match(keys[0], /^discovery:new-hash:external:.*:48:/);
        assert.deepStrictEqual(Array.from(worker.discoveryCache.keys()), keys);
    });
}

//полную перезагрузку внешней витрины запускает только админ
async function testExternalForceRefreshIsAdminOnly() {
    const worker = bareWorker({checkMyState: () => {}, dbConfig: async() => ({inpxHash: 'h'})});
    worker.getDiscoveryConfigForRequest = async() => ({enabled: true, shelfLimit: 8, externalSource: 'wikidata-awards', externalTtlMinutes: 1440});
    worker.warmExternalDiscoveryShelves = async() => {};
    worker.requireAdmin = async(userId) => {
        if (userId !== 'admin')
            throw new Error('admin only');
    };
    const forced = [];
    worker.rememberExternalDiscoveryShelf = async(inpxHash, discovery, limit, forceRefresh) => {
        forced.push(forceRefresh);
        return {id: 'external-source', items: []};
    };

    await worker.getDiscoveryShelvesV2({section: 'external', forceRefresh: true, userId: 'reader'});
    await worker.getDiscoveryShelvesV2({section: 'external', forceRefresh: true, userId: 'admin'});
    await worker.getDiscoveryShelvesV2({section: 'external', userId: 'admin'});
    assert.deepStrictEqual(forced, [false, true, false]);
}

//пересборки БД библиотеки не идут параллельно: во время сборки в очереди не больше одной следующей
async function testLibraryRebuildsDoNotOverlap() {
    const worker = bareWorker({config: {}, setMyState: () => {}, resetLibraryAssetCaches: () => {}});
    worker.inpxHashCreator = {getInpxFileHash: async() => 'file', getHash: async() => 'hash'};
    let running = 0;
    const builds = [];
    worker.catalogSearch = {
        ready: true,
        ensure: async(hash, options) => {
            running++;
            assert.strictEqual(running, 1, 'rebuilds overlap');
            builds.push(options.force);
            await new Promise(resolve => setTimeout(resolve, 20));
            running--;
            return true;
        },
    };

    await Promise.all([worker.loadOrCreateDb(), worker.recreateDb(), worker.loadOrCreateDb(), worker.recreateDb()]);
    assert.deepStrictEqual(builds, [false, true]);
    assert.strictEqual(worker.dbLoad, null);
}

module.exports = [
    testDiscoveryCacheIsPruned,
    testExternalForceRefreshIsAdminOnly,
    testLibraryRebuildsDoNotOverlap,
];
