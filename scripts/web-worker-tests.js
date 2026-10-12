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
            'wikidata-matches:old-hash:v9': {time: Date.now(), ttl: day, value: {}},
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
    worker.rememberExternalDiscoveryShelf = async(inpxHash, discovery, limit, forceRefresh, refetch) => {
        forced.push([forceRefresh, refetch]);
        return {id: 'external-source', items: []};
    };

    await worker.getDiscoveryShelvesV2({section: 'external', forceRefresh: true, userId: 'reader'});
    await worker.getDiscoveryShelvesV2({section: 'external', forceRefresh: true, userId: 'admin'});
    await worker.getDiscoveryShelvesV2({section: 'external', userId: 'admin'});
    assert.deepStrictEqual(forced, [[true, false], [true, true], [false, false]]);
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

//индекс справок об авторах: одно построение на параллельные запросы, без недостроенного индекса после ошибки
async function testAuthorInfoIndexBuildsOnce() {
    const worker = bareWorker();
    worker.resetLibraryAssetCaches();
    let builds = 0;
    let fail = true;
    worker.buildAuthorInfoIndex = async() => {
        builds++;
        await new Promise(resolve => setTimeout(resolve, 10));
        if (fail)
            throw new Error('broken archive');
        return {authorInfoArchives: [], authorPictureArchives: [], authorToArchive: new Map()};
    };

    const results = await Promise.allSettled([worker.ensureAuthorInfoArchives(), worker.ensureAuthorInfoArchives()]);
    assert.deepStrictEqual(results.map(item => item.status), ['rejected', 'rejected']);
    assert.strictEqual(builds, 1);

    fail = false;
    const [first, second] = await Promise.all([worker.ensureAuthorInfoArchives(), worker.ensureAuthorInfoArchives()]);
    assert.strictEqual(builds, 2);
    assert.strictEqual(first, second);
    await worker.ensureAuthorInfoArchives();
    assert.strictEqual(builds, 2);

    worker.resetLibraryAssetCaches();
    await worker.ensureAuthorInfoArchives();
    assert.strictEqual(builds, 3);
}

//файл, извлечённый из архива, не остаётся во временном каталоге, если в кеше нет только описания книги
async function testRestoreBookRemovesExtractedFileWhenDescriptionIsMissing() {
    await temporary(async(dir) => {
        const config = {tempDir: path.join(dir, 'tmp'), bookDir: path.join(dir, 'book'), bookPathStatic: '/book'};
        await fs.ensureDir(config.tempDir);
        await fs.ensureDir(config.bookDir);
        const worker = bareWorker({config, scheduleCacheClean: () => {}, stateStore: {putBookFile: () => {}}});
        worker.extractBook = async() => {
            const file = path.join(config.tempDir, 'extracted');
            await fs.writeFile(file, 'book text');
            return file;
        };
        const hash = require('crypto').createHash('sha256').update('book text').digest('hex');
        await fs.writeFile(path.join(config.bookDir, hash), 'gzipped earlier');

        assert.strictEqual(await worker.restoreBook('uid', 'folder.zip', '1.txt', 'book.txt', dir), `/book/${hash}`);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
        assert.strictEqual((await fs.readJson(path.join(config.bookDir, `${hash}.d.json`))).size, 9);
    });
}

//очистка кеша пропускает файлы, которые нельзя прочитать (удалены во время обхода, битые ссылки)
async function testCleanDirSkipsVanishedFiles() {
    await temporary(async(dir) => {
        await fs.writeFile(path.join(dir, 'old'), Buffer.alloc(600));
        await fs.utimes(path.join(dir, 'old'), 1, 1);
        await fs.writeFile(path.join(dir, 'new'), Buffer.alloc(600));
        await fs.symlink(path.join(dir, 'missing'), path.join(dir, 'broken'));

        const result = await bareWorker().cleanDir({dir, maxSize: 1000, targetSize: 700});
        assert.strictEqual(result.found, 2);
        assert.strictEqual(result.removed, 1);
        assert.deepStrictEqual((await fs.readdir(dir)).sort(), ['broken', 'new']);
    });
}

//если config.json не записался, прежний список библиотек остаётся в памяти
async function testLibrarySourcesRollBackWhenConfigSaveFails() {
    await temporary(async(dir) => {
        const ConfigManager = require('../server/config');
        const save = ConfigManager.prototype.save;
        const property = Object.getOwnPropertyDescriptor(ConfigManager.prototype, 'config');
        const previous = [{id: 'main', name: 'Main', inpx: '/lib/main.inpx', inpxFile: '/lib/main.inpx', libDir: '/lib', enabled: true}];
        const worker = bareWorker({config: {configFile: path.join(dir, 'config.json'), librarySources: previous}});
        worker.requireAdmin = async() => {};
        worker.addAdminEvent = () => {};
        //менеджер конфигурации - общий объект: на время теста он ничего не принимает и не пишет
        Object.defineProperty(ConfigManager.prototype, 'config', {configurable: true, set() {}});
        ConfigManager.prototype.save = async() => {
            throw new Error('disk full');
        };
        try {
            await assert.rejects(worker.updateAdminLibrarySources('admin', '', [{name: 'Other', inpx: '/other/other.inpx', libDir: '/other'}]), /disk full/);
        } finally {
            ConfigManager.prototype.save = save;
            Object.defineProperty(ConfigManager.prototype, 'config', property);
        }
        assert.deepStrictEqual(worker.config.librarySources, previous);
    });
}

//отметка «прочитано» в списке пишет reading-lists.json один раз
async function testReadingListBookReadSavesOnce() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
        await store.load();
        const list = await store.createList('', 'Queue');
        await store.setBookMembership('', list.id, 'book-1', true);
        const worker = bareWorker({checkMyState: () => {}, readingListStore: store});
        worker.getBookRecordByUid = async(uid) => ({_uid: uid});

        let saves = 0;
        const save = store.save.bind(store);
        store.save = async(...args) => {
            saves++;
            return save(...args);
        };
        const result = await worker.setReadingListBookRead('', list.id, 'book-1', true);
        assert.strictEqual(saves, 1);
        assert.strictEqual(result.read, true);
        assert.strictEqual(result.list.readCount, 1);
        const {user} = await store.resolveUser('');
        assert.strictEqual(user.readerProgress['book-1'].percent, 1);
        assert.strictEqual(store.normalizeEntries((await store.getList('', list.id)).books)[0].read, true);

        await assert.rejects(worker.setReadingListBookRead('', list.id, 'book-2', true), error => error.message === require('../server/core/i18n').t('errors.bookNotInList'));
        assert.strictEqual(saves, 1);
    });
}

//архивы обложек книги и справки об авторах кешируются до сброса кешей библиотеки; справок не больше 1000
async function testLibraryAssetCaches() {
    await temporary(async(libDir) => {
        await fs.outputFile(path.join(libDir, 'a.zip'), '');
        await fs.outputFile(path.join(libDir, 'covers', 'a.zip'), '');
        const worker = bareWorker({config: {libDir}});
        worker.resetLibraryAssetCaches();

        assert.strictEqual((await worker.getBookAssetArchives('covers', 'a.zip')).length, 1);
        await fs.remove(path.join(libDir, 'covers'));
        assert.strictEqual((await worker.getBookAssetArchives('covers', 'a.zip')).length, 1);
        worker.resetLibraryAssetCaches();
        assert.strictEqual((await worker.getBookAssetArchives('covers', 'a.zip')).length, 0);

        worker.findAuthorInfo = async() => null;
        for (let i = 0; i < 1001; i++)
            await worker.getAuthorInfo(null, `Author ${i}`);
        assert.strictEqual(worker.authorInfoCache.size, 1000);
    });
}

//вход в профиль проверяет пароль вне блокировки хранилища и не создаёт сессию, если пароль сменили во время проверки
async function testProfileLoginChecksPasswordOutsideTheStoreLock() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const profilePassword = require('../server/core/ProfilePassword');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const user = await store.createUser({name: 'Carol', login: 'carol', passwordHash: await profilePassword.hash('carol-pass')});
        const worker = bareWorker({checkMyState: () => {}, readingListStore: store, profileSessions: new Map()});

        let done = false;
        const login = worker.loginUserProfile('carol', 'carol-pass').then(result => (done = true, result));
        await store.getUser(user.id);
        assert.strictEqual(done, false, 'store calls do not wait for scrypt');
        assert.strictEqual((await login).userId, user.id);

        const passwordHash = await profilePassword.hash('new-pass');
        const raced = worker.loginUserProfile('carol', 'carol-pass');
        await new Promise(resolve => setImmediate(resolve));
        await worker.updateUserProfile(user.id, {passwordHash});
        await assert.rejects(raced, error => error.message === require('../server/core/i18n').t('errors.invalidLogin'));
        assert.strictEqual(worker.profileSessions.size, 0);
        assert.strictEqual((await worker.loginUserProfile('carol', 'new-pass')).userId, user.id);
    });
}

module.exports = [
    testDiscoveryCacheIsPruned,
    testExternalForceRefreshIsAdminOnly,
    testLibraryRebuildsDoNotOverlap,
    testAuthorInfoIndexBuildsOnce,
    testRestoreBookRemovesExtractedFileWhenDescriptionIsMissing,
    testCleanDirSkipsVanishedFiles,
    testLibrarySourcesRollBackWhenConfigSaveFails,
    testReadingListBookReadSavesOnce,
    testLibraryAssetCaches,
    testProfileLoginChecksPasswordOutsideTheStoreLock,
];
