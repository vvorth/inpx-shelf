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

module.exports = [
    testDiscoveryCacheIsPruned,
];
