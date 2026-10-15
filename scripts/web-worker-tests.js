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

//«Забыть» книгу: из профиля уходит всё о ней, другие книги и чужие списки не трогаются
async function testForgetBooksClearsProfile() {
    await temporary(async(dataDir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
        await store.load();
        const list = await store.createList('', 'Queue');
        await store.addBooks('', list.id, ['gone', 'kept']);
        await store.setBookRead('', list.id, 'gone', true);
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

//статистика чтения: прочитанные из прогресса и списков, даты только у прогресса, авторы и жанры прочитанного, кеш до изменения
async function testReadingStats() {
    const store = Object.create(require('../server/core/ReadingListStore').prototype);
    let lists = [{id: 'l1', books: [{bookUid: 'marked', read: true}, {bookUid: 'reading', read: false}]}];
    store.getLists = async() => lists;
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
        done: {percent: 1, updatedAt: '2026-03-05T10:00:00.000Z'},
        reading: {percent: 0.4, updatedAt: '2026-04-01T10:00:00.000Z'},
        hidden: {percent: 0.2, hidden: true},
    }};

    const stats = await worker.getReadingStats(user);
    assert.deepStrictEqual(stats, {
        finished: 2,
        inProgress: 1,
        finishedAt: ['2026-03-05T10:00:00.000Z'],
        authors: [{name: 'Лем Станислав', count: 2}, {name: 'Стругацкий Аркадий', count: 1}],
        genres: [{name: 'sf', count: 2}, {name: 'sf_social', count: 1}],
    });
    await worker.getReadingStats(user);
    assert.strictEqual(lookups, 1, 'unchanged data comes from the cache');
    lists = [{id: 'l1', books: [{bookUid: 'marked', read: true}, {bookUid: 'reading', read: true}]}];
    assert.strictEqual((await worker.getReadingStats(user)).inProgress, 0, 'a book marked read in a list is not in progress');
    assert.strictEqual(lookups, 2);
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

//контроллер передаёт раздел и размеры персональных полок: иначе «ещё» у похожих книг ничего не меняет
async function testDiscoveryRequestKeepsSectionAndPersonalLimits() {
    const Controller = require('../server/controllers/WebSocketController');
    let options = null;
    const controller = Object.assign(Object.create(Controller.prototype), {
        webWorker: {getDiscoveryShelvesV2: async(value) => { options = value; return {shelves: []}; }},
        send() {},
    });
    await controller.getDiscoveryShelves({section: 'personal', personalLimit: 12, personalSimilarLimit: 24}, {});
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
            await worker.setReadingListBookRead('', list.id, 'old-gone', true);

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
        const older = library('older.sqlite', [book(1, 'old-revision', 'Корепанов Алексей', 'Горькие яблоки', {libid: '500'}),
            book(2, 'old-line', 'Петров Пётр', 'Тот же libid')]);
        const newer = library('newer.sqlite', [book(1, 'new-revision', 'Корепанов Алексей', 'Горькие яблоки', {libid: '900'}),
            book(2, 'new-line', 'Петров Пётр', 'Тот же libid', {size: 2})]);
        try {
            const oldDir = path.join(dataDir, 'old');
            const newDir = path.join(dataDir, 'new');
            await fs.ensureDir(oldDir);
            await fs.ensureDir(newDir);
            const oldStore = new ReadingListStore({dataDir: oldDir, adminLogin: 'admin', adminPassword: 'admin'});
            const list = await oldStore.createList('', 'Queue');
            await oldStore.addBooks('', list.id, ['old-revision', 'old-line']);
            const source = bareWorker({readingListStore: oldStore, catalogSearch: catalog(older), checkMyState: () => true, config: {}});
            const backup = JSON.parse(JSON.stringify(await source.exportReadingLists('')));
            assert.deepStrictEqual(Object.keys(backup.books).sort(), ['old-line', 'old-revision']);
            assert.strictEqual(backup.books['old-revision'].author, 'Корепанов Алексей');

            const newStore = new ReadingListStore({dataDir: newDir, adminLogin: 'admin', adminPassword: 'admin'});
            const target = bareWorker({readingListStore: newStore, catalogSearch: catalog(newer), checkMyState: () => true, config: {}});
            await target.importReadingLists('', backup);
            const imported = (await newStore.getLists('')).find(item => item.name === 'Queue');
            const {books} = await target.getReadingList('', imported.id);
            //та же библиотека и libid - переходит сама; другая ревизия с новым libid - видна по названию и автору
            assert.deepStrictEqual(books.map(item => [item._uid, item.title, item.author, item.series, item.unavailable || '']).sort(), [
                ['new-line', 'Тот же libid', 'Петров Пётр', 'Цикл', ''],
                ['old-revision', 'Горькие яблоки', 'Корепанов Алексей', 'Цикл', 'missing'],
            ]);
            const page = await target.getBook('old-revision');
            assert.deepStrictEqual(page.replacements.map(item => item._uid), ['new-revision']);
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
    testReadingListBookReadSavesOnce,
    testForgetBooksClearsProfile,
    testListedBooksKeepUntilReaderReplacesThem,
    testProfileBackupCarriesBookDetails,
    testOtherEditionsAcrossLanguages,
    testListedBooksFollowUpdatedInpxLine,
    testReadingStats,
    testLibraryAssetCaches,
    testProfileLoginChecksPasswordOutsideTheStoreLock,
];
