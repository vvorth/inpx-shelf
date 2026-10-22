const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

//настоящий _uid (base64 от SHA-256): импорт принимает только такие
const realUid = name => require('crypto').createHash('sha256').update(name).digest('base64');

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

//кеш витрины: без записей прежних форматов, версий, месяцев и библиотек, не больше 16 записей;
//просроченная запись своего месяца остаётся (её отдают, пока идёт обновление)
async function testDiscoveryCacheIsPruned() {
    await temporary(async(dataDir) => {
        const day = 24*60*60*1000;
        const worker = bareWorker({config: {dataDir}, discoveryCache: new Map()});
        worker.fetchWikidataAwardWinners = async() => ({items: []});
        await worker.getWikidataAwardWinners({externalTtlMinutes: 1440});
        const [awardsKey] = worker.discoveryCache.keys();
        const [, version, month] = awardsKey.split(':');
        const matchesKey = hash => `wikidata-matches:${hash}:${version}:${month}`;
        const obsolete = [`discovery:new-hash:external:${version}:${month}:wikidata-awards::480:::1440:ru`, matchesKey('old-hash'),
            `wikidata-awards:v5:${month}`, `wikidata-matches:new-hash:${version}:2000-01`];
        for (const key of obsolete)
            worker.discoveryDiskCache[key] = {time: Date.now(), ttl: day, value: {}};
        worker.discoveryDiskCache[awardsKey].time -= 3*day;
        worker.discoveryCache.get(awardsKey).time -= 3*day;

        await worker.rememberPersistedDiscovery(matchesKey('new-hash'), async() => ({items: []}), day);
        const text = await fs.readFile(path.join(dataDir, 'discovery-cache.json'), 'utf8');
        assert.ok(!text.includes('\n'));
        assert.deepStrictEqual(Object.keys(JSON.parse(text)).sort(), [awardsKey, matchesKey('new-hash')].sort());

        for (let i = 0; i < 40; i++)
            await worker.rememberPersistedDiscovery(`wikidata-awards:extra-${i}:${version}:${month}`, async() => ({i}), day);
        const keys = Object.keys(await fs.readJson(path.join(dataDir, 'discovery-cache.json')));
        assert.strictEqual(keys.length, 16);
        assert.ok(keys.includes(`wikidata-awards:extra-39:${version}:${month}`));
        assert.ok(!keys.includes(`wikidata-awards:extra-0:${version}:${month}`));
        assert.ok(worker.discoveryCache.size <= 16);
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
    worker.buildExternalDiscoveryShelfV2 = async(limit, discovery, refetch) => {
        forced.push(refetch);
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
        const savePatch = ConfigManager.savePatch;
        const previous = [{id: 'main', name: 'Main', inpx: '/lib/main.inpx', inpxFile: '/lib/main.inpx', libDir: '/lib', enabled: true}];
        const worker = bareWorker({config: {configFile: path.join(dir, 'config.json'), librarySources: previous}});
        worker.requireAdmin = async() => {};
        worker.addAdminEvent = () => {};
        ConfigManager.savePatch = async() => {
            throw new Error('disk full');
        };
        try {
            await assert.rejects(worker.updateAdminLibrarySources('admin', '', [{name: 'Other', inpx: '/other/other.inpx', libDir: '/other'}]), /disk full/);
        } finally {
            ConfigManager.savePatch = savePatch;
        }
        assert.deepStrictEqual(worker.config.librarySources, previous);
    });
}

//«прочитано» - отметка профиля, не списка: книга в двух списках прочитана в обоих сразу, файл пишется один раз
async function testReadMarkIsTheProfiles() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
        await store.load();
        const a = await store.createList('', 'A');
        const b = await store.createList('', 'B');
        await store.addBooks('', a.id, ['book-1']);
        await store.addBooks('', b.id, ['book-1', 'book-2']);
        const worker = bareWorker({checkMyState: () => {}, readingListStore: store});
        worker.getListedBookRecords = async(uids) => new Map(uids.map(uid => [uid, {_uid: uid, author: 'Автор'}]));
        const readCounts = async() => (await worker.getReadingLists('', 'book-1')).lists.map(list => [list.name, list.readCount]);

        let saves = 0;
        const save = store.save.bind(store);
        store.save = async(...args) => {
            saves++;
            return save(...args);
        };
        await worker.markReaderBooksRead('', ['book-1'], true);
        assert.strictEqual(saves, 1);
        assert.deepStrictEqual(await readCounts(), [['A', 1], ['B', 1]]);

        //снятая в одном списке отметка снята и в другом: раньше список B оставался «прочитано»
        await worker.markReaderBooksRead('', ['book-1'], false);
        assert.deepStrictEqual(await readCounts(), [['A', 0], ['B', 0]]);
        assert.deepStrictEqual((await store.getList('', b.id)).books, [{bookUid: 'book-1'}, {bookUid: 'book-2'}], 'lists keep no read mark');
    });
}

//старый файл и старый экспорт: отметка «прочитано» из записи списка становится прогрессом владельца, место в книге остаётся
async function testListReadMarksMoveToProgress() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
        const reader = Object.assign(store.makeDefaultUser(), {id: 'reader', name: 'Reader', readerProgress: {
            'book-2': {percent: 0.4, sectionId: 's', updatedAt: '2026-01-01T00:00:00.000Z'},
        }});
        await fs.outputJson(store.file, {version: 5, users: [reader], lists: [{id: 'l1', userId: 'reader', name: 'Old',
            updatedAt: '2026-02-01T00:00:00.000Z', books: [{bookUid: 'book-1', read: true}, {bookUid: 'book-2', read: true}, {bookUid: 'book-3', read: false}]}]});

        const progress = async() => (await store.resolveUser('reader')).user.readerProgress;
        let rows = await progress();
        assert.deepStrictEqual([rows['book-1'].read, rows['book-1'].percent], [true, 0], 'a book never opened is read at its start');
        assert.strictEqual(rows['book-1'].updatedAt, '2026-02-01T00:00:00.000Z', 'marked when the list last changed');
        assert.deepStrictEqual([rows['book-2'].read, rows['book-2'].percent, rows['book-2'].sectionId], [true, 0.4, 's'], 'the place stays');
        assert.strictEqual(rows['book-3'], undefined);

        //после записи файла отметки остаются только в прогрессе
        await store.updateList('reader', 'l1', {name: 'Renamed'});
        const saved = await fs.readJson(store.file);
        assert.deepStrictEqual(saved.lists[0].books, [{bookUid: 'book-1'}, {bookUid: 'book-2'}, {bookUid: 'book-3'}]);
        rows = await progress();
        assert.strictEqual(rows['book-1'].read, true);

        await store.importData('reader', {lists: [{name: 'Exported', books: [{bookUid: realUid('book-4'), read: true}, {bookUid: realUid('book-5')}]}]});
        rows = await progress();
        assert.strictEqual(rows[realUid('book-4')].read, true);
        assert.strictEqual(rows[realUid('book-5')], undefined);
    });
}

//«Забыть» книгу: из профиля уходит всё о ней, другие книги и чужие списки не трогаются
async function testForgetBooksClearsProfile() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
        await store.load();
        const list = await store.createList('', 'Queue');
        await store.addBooks('', list.id, ['gone', 'kept']);
        await store.setBooksRead('', ['gone'], true);
        await store.updateReaderProgress('', 'gone', {percent: 0.3, hidden: true});
        await store.updateReaderProgress('', 'kept', {percent: 0.5});
        await store.addReaderBookmark('', 'gone', {title: 'b'});
        await store.recordDiscoveryEvents('', [{bookUid: 'gone', type: 'open'}, {bookUid: 'kept', type: 'open'}]);
        await store.putKosyncProgress('', 'a'.repeat(32), {percentage: 0.3, timestamp: 1, bookUid: 'gone'});
        await store.putKosyncProgress('', 'b'.repeat(32), {percentage: 0.5, timestamp: 1, bookUid: 'kept'});

        assert.deepStrictEqual(await store.forgetBooks('', ['gone']), {count: 1});
        const {user} = await store.resolveUser('');
        assert.deepStrictEqual(Object.keys(user.readerProgress), ['kept']);
        assert.strictEqual(user.readerBookmarks.gone, undefined);
        assert.deepStrictEqual(Object.keys(user.discoveryPreferences.events), ['kept']);
        assert.deepStrictEqual(Object.values(user.kosyncProgress).map(row => row.bookUid), ['kept']);
        assert.deepStrictEqual(store.normalizeEntries((await store.getList('', list.id)).books).map(entry => entry.bookUid), ['kept']);
        await assert.rejects(store.forgetBooks('', []));
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

//статистика чтения: прочитанные из прогресса, авторы и жанры прочитанного, кеш до изменения
async function testReadingStats() {
    const store = Object.create(require('../server/core/ReadingListStore').prototype);
    store.getLists = async() => [{id: 'l1', books: [{bookUid: 'marked'}, {bookUid: 'reading'}]}];
    let lookups = 0;
    const books = {
        done: {_uid: 'done', author: 'Лем Станислав', genre: 'sf,sf_social'},
        marked: {_uid: 'marked', author: 'Лем Станислав, Стругацкий Аркадий', genre: 'sf'},
    };
    const worker = bareWorker({checkMyState: () => {}, readingListStore: store, dbConfig: async() => ({inpxHash: 'h'})});
    worker.getBookRecordsByUids = async(uids) => {
        lookups++;
        return new Map(uids.filter(uid => books[uid]).map(uid => [uid, books[uid]]));
    };
    const user = {id: 'reader', readerProgress: {
        done: {percent: 1, updatedAt: '2026-03-05T10:00:00.000Z', read: true},
        marked: {percent: 0.1, updatedAt: '2026-03-07T10:00:00.000Z', read: true},
        reading: {percent: 0.4, updatedAt: '2026-04-01T10:00:00.000Z', read: false},
        unmarked: {percent: 1, updatedAt: '2026-04-01T10:00:00.000Z', read: false},
        hidden: {percent: 0.2, hidden: true},
    }};

    const stats = await worker.getReadingStats(user);
    assert.deepStrictEqual(stats, {
        finished: 2,
        inProgress: 2,
        finishedAt: ['2026-03-05T10:00:00.000Z', '2026-03-07T10:00:00.000Z'],
        authors: [{name: 'Лем Станислав', count: 2}, {name: 'Стругацкий Аркадий', count: 1}],
        genres: [{name: 'sf', count: 2}, {name: 'sf_social', count: 1}],
    });
    await worker.getReadingStats(user);
    assert.strictEqual(lookups, 1, 'unchanged data comes from the cache');
    user.readerProgress.reading = {percent: 0.4, updatedAt: '2026-04-02T10:00:00.000Z', read: true};
    assert.strictEqual((await worker.getReadingStats(user)).inProgress, 1, 'a book marked read is not in progress, whatever its percent');
    assert.strictEqual(lookups, 2);
}

//вход в профиль проверяет пароль вне блокировки хранилища и не создаёт сессию, если пароль сменили во время проверки
async function testProfileLoginChecksPasswordOutsideTheStoreLock() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const profilePassword = require('../server/core/ProfilePassword');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const user = await store.createUser({name: 'Carol', login: 'carol', passwordHash: await profilePassword.hash('carol-pass')});
        const worker = bareWorker({checkMyState: () => {}, readingListStore: store});

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
        assert.strictEqual((await worker.loginUserProfile('carol', 'new-pass')).userId, user.id);
    });
}

//правки метаданных читаются без блокировки хранилища из кэша, который сбрасывает любая запись файла (и восстановление бэкапа)
async function testMetadataOverridesCacheFollowsWrites() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const {withFileTransaction, writeFileAtomic} = require('../server/core/FilePersistence');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        //первое чтение создаёт файл хранилища (запись): кэш появляется со следующего
        await store.getMetadataOverrides();
        const first = await store.getMetadataOverrides();
        assert.deepStrictEqual(first, {});
        assert.strictEqual(await store.getMetadataOverrides(), first, 'unchanged file reuses the overrides');
        assert.ok(Object.isFrozen(first));

        let release = null;
        const held = withFileTransaction(store.file, () => new Promise(resolve => (release = resolve)));
        const read = await Promise.race([store.getMetadataOverrides(), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]);
        release();
        await held;
        assert.strictEqual(read, first, 'the read does not wait for the store lock');

        await store.updateMetadataOverride('book-1', {title: 'Edited'});
        assert.strictEqual((await store.getMetadataOverrides())['book-1'].title, 'Edited');

        const data = JSON.parse(await fs.readFile(store.file, 'utf8'));
        data.metadataOverrides['book-1'].title = 'Restored';
        await writeFileAtomic(store.file, JSON.stringify(data));
        assert.strictEqual((await store.getMetadataOverrides())['book-1'].title, 'Restored');
    });
}

//две быстрые правки одной книги попадают в индекс по порядку, последней - самая новая
async function testBookMetadataEditsReachIndexInOrder() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const worker = bareWorker({checkMyState: () => {}, requireAdmin: async() => {}, readingListStore: store});
        worker.getBookRecordByUid = async uid => ({_uid: uid, id: 1, title: 'Original', author: 'Author', series: ''});
        const applied = [];
        let second = null;
        worker.catalogSearch = {
            updateBook: async(book) => {
                //вторая правка приходит, пока первая ещё обновляет индекс
                if (!second) {
                    second = worker.updateBookMetadata('admin', '', 'book-1', {title: 'Second'});
                    await new Promise(resolve => setTimeout(resolve, 30));
                }
                applied.push(book.title);
            },
        };
        await worker.updateBookMetadata('admin', '', 'book-1', {title: 'First'});
        await second;
        assert.deepStrictEqual(applied, ['First', 'Second']);
        assert.strictEqual(worker.bookIndexUpdates.size, 0);
    });
}

//контроллер передаёт раздел и размеры персональных полок: иначе «ещё» у похожих книг ничего не меняет
async function testDiscoveryRequestKeepsSectionAndPersonalLimits() {
    const Controller = require('../server/controllers/ApiController');
    let options = null;
    const controller = Object.assign(Object.create(Controller.prototype), {
        webWorker: {getDiscoveryShelvesV2: async(value) => { options = value; return {shelves: []}; }},
    });
    const result = await controller.getDiscoveryShelves({section: 'personal', personalLimit: 12, personalSimilarLimit: 24}, {});
    assert.deepStrictEqual(result, {shelves: []});
    assert.strictEqual(options.section, 'personal');
    assert.strictEqual(options.personalLimit, 12);
    assert.strictEqual(options.personalSimilarLimit, 24);
}

//книга, пропавшая из библиотеки, остаётся в списке бледной; замены не подставляются сами, читатель выбирает из возможных
async function testListedBooksKeepUntilReaderReplacesThem() {
    await temporary(async(dataDir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const ReadingListStore = require('../server/core/ReadingListStore');
        const book = (id, uid, author, title, extra = {}) => Object.assign({id, _uid: uid, author, title, series: '', serno: 0, size: 1,
            librate: 0, del: 0, sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang: 'ru',
            date: '2010-01-01'}, extra);
        const library = (name, books, sources = [], hidden = []) => {
            const index = new CatalogIndex();
            const file = path.join(dataDir, name);
            index.beginBuild(file, [], sources);
            index.insertBooks(books);
            index.finishBuild({});
            index.open(file, hidden);
            return index;
        };
        const first = library('first.sqlite', [
            book(1, 'old-apples', 'Корепанов Алексей Яковлевич', 'Горькие яблоки'),
            book(2, 'old-copy', 'Иванов Иван', 'Рассказы', {libid: '20', date: '2001-01-01'}),
            book(3, 'old-gone', 'Петров Пётр', 'Только здесь'),
        ]);
        const other = {sourceId: 'second'};
        const second = library('second.sqlite', [
            book(1, 'new-other', 'Уэй Маргарет', 'Горькие яблоки', other),
            book(2, 'new-apples', 'Корепанов Алексей', 'Горькие яблоки!', {...other, libid: '777', size: 2}),
            book(3, 'new-copy-a', 'Иванов Иван', 'Рассказы', {...other, libid: '31', date: '2001-01-01'}),
            book(4, 'new-copy-b', 'Иванов Иван', 'Рассказы', {...other, libid: '30', date: '2001-01-01'}),
            book(5, 'new-copy-c', 'Иванов Иван', 'Рассказы', {...other, libid: '29', date: '2005-01-01'}),
            book(6, 'off-copy', 'Иванов Иван', 'Рассказы', {sourceId: 'off'}),
        ], [{id: 'second', name: 'Second', libDir: dataDir}, {id: 'off', name: 'Off', libDir: dataDir}], ['off']);
        const catalog = (index) => ({ready: true,
            getBooksByUids: async(uids, includeHidden) => index.getBooksByUids(uids, includeHidden),
            getBooksByTitles: async(titles) => index.getBooksByTitles(titles),
            getBooksByStableKeys: async(keys) => index.getBooksByStableKeys(keys),
            authorAliasesOf: async() => ({})});
        try {
            const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
            const list = await store.createList('', 'Queue');
            await store.addBooks('', list.id, ['old-apples', 'old-copy', 'old-gone', 'off-copy']);
            await store.updateReaderProgress('', 'old-apples', {percent: 0.5, sectionId: 's'});
            const worker = bareWorker({readingListStore: store, catalogSearch: catalog(first), checkMyState: () => true,
                config: {}});

            await worker.syncListedBooks();
            assert.deepStrictEqual(Object.keys((await store.getBookNoteState()).notes).sort(), ['old-apples', 'old-copy', 'old-gone']);

            //другая библиотека: списки и прогресс не меняются сами
            worker.catalogSearch = catalog(second);
            await worker.syncListedBooks();
            const listed = async() => store.normalizeEntries((await store.getList('', list.id)).books).map(entry => entry.bookUid);
            assert.deepStrictEqual(await listed(), ['old-apples', 'old-copy', 'old-gone', 'off-copy']);
            assert.deepStrictEqual(Object.keys((await store.getBookNoteState()).notes).sort(), ['off-copy', 'old-apples', 'old-copy', 'old-gone'],
                'a book of a disabled library keeps its note');

            //недоступные книги видны в списке: пропавшие - по заметке, из выключенной библиотеки - своей записью
            const {books} = await worker.getReadingList('', list.id);
            assert.deepStrictEqual(books.map(item => [item._uid, item.title, item.unavailable]), [
                ['old-apples', 'Горькие яблоки', 'missing'], ['old-copy', 'Рассказы', 'missing'],
                ['old-gone', 'Только здесь', 'missing'], ['off-copy', 'Рассказы', 'disabled'],
            ]);

            //«Читаю сейчас» - в том же виде, что и список: недоступная книга с прогрессом остаётся, бледной
            await store.updateReaderProgress('', 'old-copy', {percent: 1, sectionId: 's'});
            const reading = await worker.getReadingNow((await store.resolveUser('')).user);
            assert.deepStrictEqual(reading.books.map(item => [item._uid, item.unavailable, item._readerPercent]), [['old-apples', 'missing', 0.5]],
                'finished books are not in progress');
            await worker.markReaderBooksRead('', ['old-gone'], true);
            await worker.markReaderBooksRead('', ['old-gone'], false);

            //возможные замены: все совпадения по названию и первому автору, лучшие первыми, без отбора
            const replacements = async uid => (await worker.getBook(uid)).replacements.map(item => item._uid);
            assert.deepStrictEqual(await replacements('old-apples'), ['new-apples']);
            assert.deepStrictEqual(await replacements('old-copy'), ['new-copy-b', 'new-copy-a', 'new-copy-c']);
            assert.deepStrictEqual(await replacements('off-copy'), ['new-copy-c', 'new-copy-b', 'new-copy-a']);
            assert.deepStrictEqual(await replacements('old-gone'), []);
            assert.deepStrictEqual((await worker.getBook('new-apples')).replacements, undefined, 'available book has editions, not replacements');

            //убрать и вернуть недоступную книгу можно
            await worker.updateReadingListBook('', list.id, 'old-gone', false);
            await worker.updateReadingListBook('', list.id, 'old-gone', true);

            //замена, выбранная читателем: место в списке, прогресс; заметка старой книги остаётся у других профилей
            const result = await worker.replaceListedBook('', 'old-apples', 'new-apples');
            assert.strictEqual(result.bookUid, 'new-apples');
            assert.deepStrictEqual(await listed(), ['new-apples', 'old-copy', 'off-copy', 'old-gone']);
            const {user} = await store.resolveUser('');
            assert.strictEqual(user.readerProgress['new-apples'].percent, 0.5);
            assert.ok(!user.readerProgress['old-apples']);
            await assert.rejects(worker.replaceListedBook('', 'old-copy', 'off-copy'), /not found|не найдена/i, 'replacement must be available');

            //повторная сверка ничего не меняет и не пишет файл
            await worker.syncListedBooks();
            let saves = 0;
            const save = store.save.bind(store);
            store.save = async(...args) => {
                saves++;
                return save(...args);
            };
            await worker.syncListedBooks();
            assert.strictEqual(saves, 0);
        } finally {
            first.close();
            second.close();
        }
    });
}

//обновление INPX переписало строку книги: та же библиотека и libid, одна запись - ссылки всех профилей переходят сами
async function testListedBooksFollowUpdatedInpxLine() {
    await temporary(async(dataDir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const ReadingListStore = require('../server/core/ReadingListStore');
        const book = (id, uid, libid, extra = {}) => Object.assign({id, _uid: uid, author: 'Стругацкий Аркадий', title: `Книга ${libid}`, series: '',
            serno: 0, size: 1, librate: 0, del: 0, sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid, ext: 'fb2', lang: 'ru',
            date: '2010-01-01'}, extra);
        const library = (name, books) => {
            const index = new CatalogIndex();
            const file = path.join(dataDir, name);
            index.beginBuild(file);
            index.insertBooks(books);
            index.finishBuild({});
            index.open(file);
            return index;
        };
        const before = library('before.sqlite', [book(1, 'v1', '10'), book(2, 'dup-v1', '12'), book(3, 'legacy-v1', '13')]);
        const after = library('after.sqlite', [
            book(1, 'v2', '10', {librate: 5}),
            book(2, 'dup-fb2', '12'), book(3, 'dup-epub', '12', {ext: 'epub'}),
            book(4, 'legacy-v2', '13'),
        ]);
        const catalog = index => ({ready: true,
            getBooksByUids: async(uids, includeHidden) => index.getBooksByUids(uids, includeHidden),
            getBooksByStableKeys: async(keys) => index.getBooksByStableKeys(keys)});
        try {
            const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
            const list = await store.createList('', 'Queue');
            await store.addBooks('', list.id, ['v1', 'dup-v1', 'legacy-v1']);
            await store.updateReaderProgress('', 'v1', {percent: 0.4, sectionId: 's'});
            const deviceMoves = [];
            const worker = bareWorker({readingListStore: store, catalogSearch: catalog(before),
                koboService: {rekeyDeviceRows: async(mapping) => deviceMoves.push(mapping)}});
            await worker.syncListedBooks();
            //заметка прежних версий - без библиотеки: по ней книга сама не переходит
            await store.saveBookNotes({});
            const data = await store.load();
            delete data.bookNotes['legacy-v1'].sourceId;
            await store.save(data);

            worker.catalogSearch = catalog(after);
            await worker.syncListedBooks();
            const books = store.normalizeEntries((await store.getList('', list.id)).books).map(entry => entry.bookUid);
            assert.deepStrictEqual(books, ['v2', 'dup-v1', 'legacy-v1'], 'ambiguous copies and notes without a library stay as they are');
            const {user} = await store.resolveUser('');
            assert.strictEqual(user.readerProgress.v2.percent, 0.4);
            assert.deepStrictEqual(deviceMoves, [{v1: 'v2'}], 'Kobo device rows follow the book');
            assert.strictEqual((await store.getBookNoteState()).notes.v2.sourceId, 'main');
        } finally {
            before.close();
            after.close();
        }
    });
}

//бэкап профиля несёт названия и авторов книг: на сервере с новым INPX пропавшие книги видны и находятся замены
async function testProfileBackupCarriesBookDetails() {
    const [oldRevision, oldLine, newRevision, newLine] = ['old-revision', 'old-line', 'new-revision', 'new-line'].map(realUid);
    await temporary(async(dataDir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const ReadingListStore = require('../server/core/ReadingListStore');
        const book = (id, uid, author, title, extra = {}) => Object.assign({id, _uid: uid, author, title, series: 'Цикл', serno: 1, size: 1,
            librate: 0, del: 0, sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang: 'ru',
            date: '2010-01-01'}, extra);
        const library = (name, books) => {
            const index = new CatalogIndex();
            const file = path.join(dataDir, name);
            index.beginBuild(file, [], []);
            index.insertBooks(books);
            index.finishBuild({});
            index.open(file, []);
            return index;
        };
        const catalog = (index) => ({ready: true,
            getBooksByUids: async(uids, includeHidden) => index.getBooksByUids(uids, includeHidden),
            getBooksByTitles: async(titles) => index.getBooksByTitles(titles),
            getBooksByStableKeys: async(keys) => index.getBooksByStableKeys(keys),
            authorAliasesOf: async() => ({})});
        const older = library('older.sqlite', [book(1, oldRevision, 'Корепанов Алексей', 'Горькие яблоки', {libid: '500'}),
            book(2, oldLine, 'Петров Пётр', 'Тот же libid')]);
        const newer = library('newer.sqlite', [book(1, newRevision, 'Корепанов Алексей', 'Горькие яблоки', {libid: '900'}),
            book(2, newLine, 'Петров Пётр', 'Тот же libid', {size: 2})]);
        try {
            const oldDir = path.join(dataDir, 'old');
            const newDir = path.join(dataDir, 'new');
            await fs.ensureDir(oldDir);
            await fs.ensureDir(newDir);
            const oldStore = new ReadingListStore({dataDir: oldDir, adminLogin: 'admin', adminPassword: 'admin'});
            const list = await oldStore.createList('', 'Queue');
            await oldStore.addBooks('', list.id, [oldRevision, oldLine]);
            const source = bareWorker({readingListStore: oldStore, catalogSearch: catalog(older), checkMyState: () => true, config: {}});
            const backup = JSON.parse(JSON.stringify(await source.exportReadingLists('')));
            assert.deepStrictEqual(Object.keys(backup.books).sort(), [oldLine, oldRevision].sort());
            assert.strictEqual(backup.books[oldRevision].author, 'Корепанов Алексей');

            const newStore = new ReadingListStore({dataDir: newDir, adminLogin: 'admin', adminPassword: 'admin'});
            const target = bareWorker({readingListStore: newStore, catalogSearch: catalog(newer), checkMyState: () => true, config: {}});
            await target.importReadingLists('', backup);
            const imported = (await newStore.getLists('')).find(item => item.name === 'Queue');
            const {books} = await target.getReadingList('', imported.id);
            //та же библиотека и libid - переходит сама; другая ревизия с новым libid - видна по названию и автору
            assert.deepStrictEqual(books.map(item => [item._uid, item.title, item.author, item.series, item.unavailable || '']).sort(), [
                [newLine, 'Тот же libid', 'Петров Пётр', 'Цикл', ''],
                [oldRevision, 'Горькие яблоки', 'Корепанов Алексей', 'Цикл', 'missing'],
            ].sort());
            const page = await target.getBook(oldRevision);
            assert.deepStrictEqual(page.replacements.map(item => item._uid), [newRevision]);
        } finally {
            older.close();
            newer.close();
        }
    });
}

//«Другие издания» находят книгу под названием на другом языке: Wikidata связывает «Гиперион» и «Hyperion» Симмонса
async function testOtherEditionsAcrossLanguages() {
    await temporary(async(dataDir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const WorkTitles = require('../server/core/search/WorkTitles');
        const book = (id, author, title, lang) => ({id, _uid: `b${id}`, author, title, series: '', serno: 0, size: 1, librate: 0, del: 0,
            sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang, date: '2010-01-01'});
        const index = new CatalogIndex();
        const file = path.join(dataDir, 'catalog.sqlite');
        index.beginBuild(file, [], []);
        index.insertBooks([
            book(1, 'Симмонс Дэн', 'Гиперион', 'ru'),
            book(2, 'Симмонс Дэн', 'Hyperion', 'en'),
            book(3, 'Simmons Dan', 'Hyperion', 'en'),
            book(4, 'Гёльдерлин Иоганн Христиан Фридрих', 'Гиперион', 'ru'),
            book(5, 'Симмонс Дэн', 'Гиперион', 'uk'),
            book(6, 'Симмонс Дэн', 'Падение Гипериона', 'ru'),
            book(11, 'Дойль Артур Конан', 'Sherlock Holmes. The Complete Stories', 'en'),
            book(12, 'Дойль Артур', 'Sherlock Holmes. The Complete Stories', 'en'),
            book(13, 'Дойль Игнатий', 'Sherlock Holmes. The Complete Stories', 'en'),
            book(14, 'Толстой Лев Николаевич', 'Детство', 'ru'),
            book(15, 'Толстой Алексей', 'Детство', 'ru'),
            book(21, 'Doyle Arthur Conan', 'The Hound of the Baskervilles', 'en'),
        ]);
        index.finishBuild({});
        index.open(file, []);
        try {
            const workTitles = new WorkTitles({dataDir});
            await fs.writeJson(workTitles.file, WorkTitles.normalizeData({entries: [
                [['Гиперион', 'Hyperion'], ['Дэн Симмонс', 'Dan Simmons']],
                [['Падение Гипериона', 'The Fall of Hyperion'], ['Дэн Симмонс', 'Dan Simmons']],
                [['Гиперион', 'Hyperion'], ['Фридрих Гёльдерлин', 'Friedrich Hölderlin']],
                [['Одно название'], ['Кто-то']],
                [['Собака Баскервилей', 'The Hound of the Baskervilles'], ['Артур Конан Дойл', 'Arthur Conan Doyle']],
            ]}));
            const worker = bareWorker({catalogSearch: {workTitles, getBooksByTitles: async(titles) => index.getBooksByTitles(titles)},
                applyMetadataOverridesToSearchResult: async() => {}});
            const uids = async(item) => (await worker.findMatchingBooks(item)).map(found => found._uid);
            //та же книга на том же названии - первой, затем переводы; другой автор и другая книга того же цикла - нет
            assert.deepStrictEqual(await uids(book(1, 'Симмонс Дэн', 'Гиперион', 'ru')), ['b5', 'b2', 'b3']);
            assert.deepStrictEqual(await uids(book(3, 'Simmons Dan', 'Hyperion', 'en')), ['b2', 'b1', 'b5'],
                'an English record under the Latin name finds the Russian ones');
            assert.deepStrictEqual(await uids(book(4, 'Гёльдерлин Иоганн Христиан Фридрих', 'Гиперион', 'ru')), [],
                'Hölderlin has no other edition in the library');
            //имя автора в другой библиотеке записано в другом порядке, отчество - не везде
            assert.deepStrictEqual(await uids(book(10, 'Конан Дойль Артур', 'Sherlock Holmes. The Complete Stories', 'en')), ['b11', 'b12'],
                'Doyle under another word order');
            assert.deepStrictEqual(await uids(book(16, 'Толстой Лев', 'Детство', 'ru')), ['b14'], 'a patronymic in one library only');
            //в Wikidata «Дойл», в библиотеке «Дойль»
            assert.deepStrictEqual(await uids(book(20, 'Конан Дойль Артур', 'Собака Баскервилей', 'ru')), ['b21'], 'Doyle without the soft sign');
            const {sameWorkAuthor} = WorkTitles;
            assert.ok(!sameWorkAuthor('Конан Дойль Артур', 'Адриан Конан Дойль'), 'the father is not the son');
            assert.ok(!sameWorkAuthor('Ершов Пётр Сергеевич', 'Ершов, Пётр Павлович'), 'another patronymic');
            assert.ok(!sameWorkAuthor('Джонатан Джонатан', 'Джонатан Франзен'), 'one name twice is one word');
            assert.ok(sameWorkAuthor('Le Guin Ursula', 'Ursula K. Le Guin'));
            assert.ok(sameWorkAuthor('Толстой Лев Николаевич', 'Лев Толстой'));
            assert.ok(sameWorkAuthor('Tolkien J. R. R.', 'J. R. R. Tolkien'));
            assert.ok(sameWorkAuthor('Иванов Валентин Д.', 'Иванов, Валентин Дмитриевич'), 'an initial');
            //без таблицы - как раньше: только то же название
            await fs.remove(workTitles.file);
            workTitles.changed();
            assert.deepStrictEqual(await uids(book(1, 'Симмонс Дэн', 'Гиперион', 'ru')), ['b5']);
            assert.strictEqual(WorkTitles.normalizeData({entries: [[['Одно название'], ['Кто-то']], 'bad', [['A', 'B'], []]]}).entries.length, 0,
                'a work needs two different titles and an author');
        } finally {
            index.close();
        }
    });
}

module.exports = [
    testDiscoveryRequestKeepsSectionAndPersonalLimits,
    testDiscoveryCacheIsPruned,
    testExternalForceRefreshIsAdminOnly,
    testLibraryRebuildsDoNotOverlap,
    testAuthorInfoIndexBuildsOnce,
    testRestoreBookRemovesExtractedFileWhenDescriptionIsMissing,
    testCleanDirSkipsVanishedFiles,
    testLibrarySourcesRollBackWhenConfigSaveFails,
    testReadMarkIsTheProfiles,
    testListReadMarksMoveToProgress,
    testForgetBooksClearsProfile,
    testListedBooksKeepUntilReaderReplacesThem,
    testProfileBackupCarriesBookDetails,
    testOtherEditionsAcrossLanguages,
    testListedBooksFollowUpdatedInpxLine,
    testReadingStats,
    testLibraryAssetCaches,
    testProfileLoginChecksPasswordOutsideTheStoreLock,
    testMetadataOverridesCacheFollowsWrites,
    testBookMetadataEditsReachIndexInOrder,
];
