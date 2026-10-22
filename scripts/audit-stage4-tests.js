const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const passwords = require('../server/core/ProfilePassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const transaction = require('../server/core/BackupTransaction');
const http = require('http');
const requestLimits = require('../server/core/RequestLimits');
const Security = require('../server/core/Security');
const {ApiTestClient, apiController, apiApp, listen, rawPost} = require('./api-test-client');

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-stage4-'));
    try {
        await task(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function archive(entries) {
    const zip = new (require('yazl').ZipFile)();
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        zip.outputStream.on('data', chunk => chunks.push(chunk));
        zip.outputStream.on('end', resolve);
        zip.outputStream.on('error', reject);
    });
    for (const [name, value] of Object.entries(entries))
        zip.addBuffer(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), name);
    zip.end();
    await done;
    return {buffer: Buffer.concat(chunks)};
}

async function testScryptMigrationAndOpds() {
    const first = await passwords.hash('пароль');
    const second = await passwords.hash('пароль');
    assert.notStrictEqual(first, second);
    assert.strictEqual(await passwords.verify(first, 'different-login', 'пароль'), true);
    assert.strictEqual(await passwords.verify(first, 'different-login', 'wrong'), false);
    assert.strictEqual(await passwords.verify('scrypt:v999:9999999999999999:bad', '', ''), false);
    await assert.rejects(passwords.hash('x'.repeat(4097)), /длинный/);
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir});
        const user = await store.createUser({name: 'Legacy OPDS', login: 'legacy', opdsEnabled: true,
            passwordHash: passwords.legacy('legacy', 'secret')});
        assert.strictEqual(await store.verifyUserPassword(user.id, 'wrong'), false);
        assert.strictEqual((await store.getUser(user.id)).passwordHash, user.passwordHash);
        assert.strictEqual(await store.verifyUserPassword(user.id, 'secret'), true);
        const migrated = await store.getUser(user.id);
        assert.match(migrated.passwordHash, /^scrypt:v1:/);
        await store.updateUser(user.id, {login: 'renamed'});
        const restarted = new ReadingListStore({dataDir});
        assert.strictEqual(await restarted.verifyUserPassword(user.id, 'secret'), true);
        assert.strictEqual((await restarted.getUser(user.id)).passwordHash, migrated.passwordHash);
        assert.match((await restarted.getUser('admin')).passwordHash, /^scrypt:v1:/);
    });
}

// A JSON body is an object of at most apiMessageLimitMb; a malformed one is answered and the next request works.
async function testApiBodyBoundsAndRecovery() {
    await temporary(async(dir) => {
        const config = {apiMessageLimitMb: 1, importLimitMb: 1, backupUploadLimitMb: 1, tempDir: path.join(dir, 'tmp'), rootPathStatic: ''};
        const security = new Security(config);
        security.secret = 'test-secret';
        const controller = apiController({config, security, profileAccess: null, webWorker: {}, workerState: {getState: () => ({})},
            updateReaderPreferences: async() => ({ok: true})});
        const {base, close} = await listen(apiApp({config, security, controller, health: false}));
        const api = ApiTestClient.forSession(base, security);
        const post = body => api.request('PATCH', 'api/me/reader-preferences', {body,
            headers: {'content-type': 'application/json', 'x-csrf-token': api.csrfToken}});
        try {
            for (const malformed of ['null', '[]', 'false', '"text"', '{'])
                assert.strictEqual((await post(malformed)).status, 400, JSON.stringify(malformed));
            const pad = size => JSON.stringify({preferences: {pad: 'x'.repeat(size - '{"preferences":{"pad":""}}'.length)}});
            assert.deepStrictEqual((await post(pad(1024*1024))).body, {ok: true}, 'At the limit');
            const large = await post(pad(1024*1024 + 1));
            assert.strictEqual(large.status, 413);
            assert.ok(large.body.error);
            assert.strictEqual((await post(pad(7*1024*1024))).status, 413);
            //тело сверх лимита дочитывается и отбрасывается: соединение не рвётся посреди отправки, клиент получает 413
            const sent = await rawPost(base, '/api/me/discovery-events', {'Content-Type': 'application/json', 'X-Inpx-Api': '1',
                'X-CSRF-Token': api.csrfToken, Cookie: api.cookie}, 7*1024*1024);
            assert.deepStrictEqual([sent.status, sent.writeError && sent.writeError.code], [413, null]);
            assert.deepStrictEqual((await post('{}')).body, {ok: true}, 'The server keeps answering');
        } finally {
            await close();
        }
    });
    assert.strictEqual(requestLimits.limits({}).message, 1024*1024);
    assert.strictEqual(requestLimits.limits({apiMessageLimitMb: 2}).message, 2*1024*1024);
    assert.strictEqual(requestLimits.limits({apiMessageLimitMb: 99}).message, 16*1024*1024);
    assert.throws(() => requestLimits.checkImport({lists: Array.from({length: 1001}, () => ({}))}), /1000/);
    assert.throws(() => requestLimits.checkImport({lists: [{books: Array(100001).fill('book')}]}), /100000/);
}

// Files come as the body of POST api/<import action>: access is checked before the body is stored, the body is cut at
// the action's limit, and a JSON request cannot name a file on the server.
async function testHttpUploadsGoThroughRequestChecks() {
    await temporary(async(dir) => {
        const tempDir = path.join(dir, 'tmp');
        const config = {importLimitMb: 1, backupUploadLimitMb: 1, tempDir, rootPathStatic: ''};
        const security = new Security(config);
        security.secret = 'test-secret';
        const seen = [];
        let signedIn = true;
        const controller = apiController({config, security, profileAccess: null, workerState: {getState: () => ({})},
            webWorker: {
                requireAuthorizedUser: async() => {
                    if (!signedIn)
                        throw new Error('need_profile_login');
                    return {id: 'reader'};
                },
                isProtectedProfile: async() => true,
                importReadingLists: async(userId, data) => {
                    seen.push(data);
                    return {userId, lists: data.lists.length};
                },
            },
            isProtectedProfile: async() => true,
        });
        const {base, close} = await listen(apiApp({config, security, controller, health: false}));
        const port = new URL(base).port;
        const api = ApiTestClient.forSession(base, security);
        const post = (body, options = {}) => api.call('import-reading-lists', {}, Object.assign({body}, options));
        try {
            //кто не прошёл проверки, ничего не пишет на диск: тело читается и отбрасывается
            signedIn = false;
            const stranger = await post(Buffer.alloc(512*1024));
            signedIn = true;
            assert.deepStrictEqual([stranger.status, stranger.body.error], [401, 'need_profile_login']);
            assert.strictEqual(await fs.pathExists(tempDir), false, 'nothing is stored before the checks pass');
            const ok = await post(JSON.stringify({lists: [{name: 'A', books: []}]}));
            assert.deepStrictEqual([ok.status, ok.body], [200, {userId: 'reader', lists: 1}]);
            assert.strictEqual(ok.headers.get('cache-control'), 'no-store');
            const stale = await post('{}', {csrfToken: 'stale'});
            assert.deepStrictEqual([stale.status, stale.body.error], [403, 'bad_csrf_token']);
            assert.strictEqual((await post('{}', {headers: {Origin: 'https://evil.example'}})).status, 403);
            assert.strictEqual((await post(JSON.stringify({lists: []}), {headers: {Origin: base}})).status, 200, 'Same origin');
            //файл принимают только действия загрузки, и только как application/octet-stream
            assert.strictEqual((await api.request('PATCH', 'api/me/reader-preferences', {body: '{}',
                headers: {'content-type': 'application/octet-stream', 'x-csrf-token': api.csrfToken}})).status, 415);
            assert.strictEqual((await post('{}', {headers: {'content-type': 'application/json'}})).status, 415);
            assert.match((await post('{broken')).body.error, /JSON/);
            //слишком большой Content-Length - отказ сразу, тело не нужно
            const declared = await new Promise((resolve, reject) => {
                const request = http.request({host: '127.0.0.1', port, method: 'POST', path: '/api/me/import',
                    headers: {'Content-Length': String(1024*1024 + 1), 'Content-Type': 'application/octet-stream', 'X-Inpx-Api': '1',
                        'X-CSRF-Token': api.csrfToken, cookie: api.cookie}}, response => {
                    response.resume();
                    resolve(response.statusCode);
                });
                request.on('error', reject);
                request.flushHeaders();
            });
            assert.strictEqual(declared, 413);
            //без Content-Length тело обрывается на лимите
            const stream = new (require('stream').Readable)({read() {}});
            const streamed = post(stream);
            for (let i = 0; i < 3; i++)
                stream.push(Buffer.alloc(512*1024));
            stream.push(null);
            assert.strictEqual((await streamed).status, 413);
            assert.deepStrictEqual(await fs.readdir(tempDir), [], 'uploads are removed');
            assert.strictEqual(seen.length, 2);

            //JSON-запрос не может указать файл на сервере: ни телом, ни параметром адреса
            const named = await api.request('POST', 'api/me/import', {body: JSON.stringify({uploadFile: '/etc/passwd', data: {lists: []}}),
                headers: {'content-type': 'application/json', 'x-csrf-token': api.csrfToken}});
            assert.strictEqual(named.status, 415);
            const query = await api.request('POST', 'api/me/import?uploadFile=%2Fetc%2Fpasswd', {body: '{"lists":[]}',
                headers: {'content-type': 'application/octet-stream', 'x-csrf-token': api.csrfToken}});
            assert.strictEqual(query.status, 400);
            assert.strictEqual(seen.length, 2);
        } finally {
            await close();
        }
    });
}

async function testBackupValidationBeforeMutation() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.config = {dataDir, configFile: path.join(dataDir, 'config.json'), tempDir: path.join(dataDir, 'tmp'),
            backupExpandedLimitMb: 1, opds: {password: 'old'}};
        worker.checkMyState = () => {};
        worker.requireAdmin = async() => {};
        worker.addAdminEvent = () => {};
        worker.readingListStore = new ReadingListStore(worker.config);
        await worker.readingListStore.load();
        await fs.writeJson(worker.config.configFile, {opds: {password: 'old'}});
        const before = await fs.readFile(worker.config.configFile, 'utf8');
        const listsBefore = await fs.readFile(worker.readingListStore.file, 'utf8');
        const base = {'backup-info.json': {version: 'test'}, 'config.json': {opds: {password: 'new'}}};
        const invalid = await archive({...base, 'reading-lists.json': '{broken'});
        await assert.rejects(worker.importAdminBackup('admin', 'token', invalid));
        const bomb = await archive({...base, 'kobo-sync.json': JSON.stringify({devices: [], large: 'x'.repeat(1024*1024)})});
        await assert.rejects(worker.importAdminBackup('admin', 'token', bomb), /распакованный размер/);
        const secretStore = new (require('../server/core/SecretStore'))(worker.config);
        const protectedConfig = await secretStore.protectConfig({opds: {password: 'new'}});
        const mismatch = await archive({...base, 'config.json': protectedConfig,
            'secret.key': require('crypto').randomBytes(32).toString('base64')});
        await assert.rejects(worker.importAdminBackup('admin', 'token', mismatch));
        assert.strictEqual(await fs.readFile(worker.config.configFile, 'utf8'), before);
        assert.strictEqual(await fs.readFile(worker.readingListStore.file, 'utf8'), listsBefore);
        assert.strictEqual(worker.config.opds.password, 'old');
        assert.deepStrictEqual(await fs.readdir(worker.config.tempDir), []);

        // Upstream inpx-web backups carry the discovery cache and upstream release links: neither is restored.
        worker.config.checkReleaseLink = 'https://api.github.com/repos/vvorth/inpx-shelf/releases/latest';
        //локальные ключи восстановленного config.json берутся из текущего файла
        await fs.writeJson(worker.config.configFile, {opds: {password: 'old'}, checkReleaseLink: worker.config.checkReleaseLink});
        const upstream = await archive({...base, 'config.json': {opds: {password: 'new'},
            checkReleaseLink: 'https://api.github.com/repos/AceAsket/inpx-web/releases/latest'},
        'discovery-cache.json': {stale: {time: 0, value: {}}}});
        const restored = await worker.importAdminBackup('admin', 'token', upstream);
        assert.ok(!restored.restored.includes('discovery-cache.json'));
        assert.strictEqual(await fs.pathExists(path.join(dataDir, 'discovery-cache.json')), false);
        assert.strictEqual(worker.config.checkReleaseLink, 'https://api.github.com/repos/vvorth/inpx-shelf/releases/latest');
        assert.strictEqual((await fs.readJson(worker.config.configFile)).checkReleaseLink, worker.config.checkReleaseLink);
    });
}

// Полное восстановление сохраняет прежние файлы (3 последние копии), называет сменившиеся настройки доступа,
// на config.json с ключом другого сервера отвечает понятной ошибкой, ничего не меняя
async function testRestoreSnapshotSecurityChangesAndKeyMismatch() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const StreamZip = require('node-stream-zip');
        const worker = Object.create(Worker.prototype);
        worker.config = {dataDir, configFile: path.join(dataDir, 'config.json'), tempDir: path.join(dataDir, 'tmp'),
            authMode: 'none', trustProxy: false, proxyAuthHeader: '', loggingEnabled: false, opds: {}};
        const events = [];
        worker.checkMyState = () => {};
        worker.requireAdmin = async() => {};
        worker.addAdminEvent = (level, category, message, details) => events.push({level, message, details});
        worker.readingListStore = new ReadingListStore(worker.config);
        await worker.readingListStore.load();
        await fs.writeJson(worker.config.configFile, {authMode: 'none', loggingEnabled: false});
        const backups = path.join(dataDir, 'backups');
        await fs.outputFile(path.join(backups, 'inpx-shelf-backup-2000-01-01.zip'), 'own backup');
        const before = await fs.readFile(worker.config.configFile, 'utf8');
        const listsBefore = await fs.readFile(worker.readingListStore.file, 'utf8');
        const backup = await archive({'backup-info.json': {version: 'test'}, 'reading-lists.json': {users: [], lists: []},
            'config.json': {authMode: 'proxy', trustProxy: true, proxyAuthHeader: 'X-User', loggingEnabled: true}});

        const result = await worker.importAdminBackup('admin', 'token', backup);
        assert.match(result.snapshot, /^inpx-shelf-pre-restore-.+\.zip$/);
        assert.deepStrictEqual(result.securityChanged, ['authMode', 'trustProxy', 'proxyAuthHeader']);
        assert.strictEqual(worker.config.authMode, 'proxy', 'the admin chose the backup: its settings apply');
        const zip = new StreamZip.async({file: path.join(backups, result.snapshot)});
        try {
            assert.strictEqual((await zip.entryData('config.json')).toString('utf8'), before);
            assert.strictEqual((await zip.entryData('reading-lists.json')).toString('utf8'), listsBefore);
        } finally {
            await zip.close();
        }
        assert.deepStrictEqual(events.map(event => event.message.key), ['admin.fullBackupRestoredSnapshot', 'admin.restoreSecurityChanged']);
        assert.strictEqual(events[1].message.params.keys, 'authMode, trustProxy, proxyAuthHeader');
        assert.deepStrictEqual(events[1].details.securityChanged, result.securityChanged);
        assert.strictEqual(events[0].details.snapshot, result.snapshot);

        for (let i = 0; i < 3; i++)
            assert.deepStrictEqual((await worker.importAdminBackup('admin', 'token', backup)).securityChanged, []);
        const names = (await fs.readdir(backups)).sort();
        assert.strictEqual(names.filter(name => name.startsWith('inpx-shelf-pre-restore-')).length, 3);
        assert.ok(names.includes('inpx-shelf-backup-2000-01-01.zip'), 'other backups are kept');

        //config.json зашифрован ключом другого сервера, secret.key в архиве нет
        const other = new (require('../server/core/SecretStore'))({dataDir: path.join(dataDir, 'other')});
        const foreign = await archive({'backup-info.json': {version: 'test'},
            'config.json': await other.protectConfig({opds: {password: 'foreign'}})});
        await fs.writeFile(path.join(dataDir, 'secret.key'), require('crypto').randomBytes(32).toString('base64'));
        const configNow = await fs.readFile(worker.config.configFile, 'utf8');
        const backupsNow = (await fs.readdir(backups)).sort();
        await assert.rejects(worker.importAdminBackup('admin', 'token', foreign), /другого сервера|another server/);
        assert.strictEqual(await fs.readFile(worker.config.configFile, 'utf8'), configNow);
        assert.deepStrictEqual((await fs.readdir(backups)).sort(), backupsNow, 'no snapshot for a rejected archive');

        //испорченный журнал: сообщение называет папку журнала
        await fs.outputFile(path.join(dataDir, '.restore-transaction', 'manifest.json'), '{broken');
        await assert.rejects(transaction.recover(worker.config), error => error.message.includes(path.join(dataDir, '.restore-transaction')));
    });
}

async function testBackupRollbackAndCrashRecovery() {
    await temporary(async(dataDir) => {
        const config = {dataDir, configFile: path.join(dataDir, 'config.json')};
        const original = {'config.json': JSON.stringify({dataDir, loggingEnabled: false}), 'reading-lists.json': '{"users":[],"lists":[]}'};
        const content = {'config.json': JSON.stringify({dataDir, loggingEnabled: true}), 'reading-lists.json': '{"new":true}'};
        const targets = transaction.targets(config);
        for (const [name, value] of Object.entries(original))
            await fs.writeFile(targets[name], value);
        const rename = fs.rename;
        let failed = false;
        fs.rename = async(from, to) => {
            if (!failed && to === targets['reading-lists.json']) {
                failed = true;
                throw new Error('injected write failure');
            }
            return rename(from, to);
        };
        try {
            await assert.rejects(transaction.commit(config, content), /injected/);
        } finally {
            fs.rename = rename;
        }
        for (const [name, value] of Object.entries(original))
            assert.strictEqual(await fs.readFile(targets[name], 'utf8'), value);
        const child = `
            const fs = require(process.argv[1]);
            const transaction = require(process.argv[2]);
            const config = JSON.parse(process.argv[3]);
            const rename = fs.rename;
            fs.rename = async(from, to) => {
                await rename(from, to);
                if (to === config.configFile) process.exit(86);
            };
            transaction.commit(config, JSON.parse(process.argv[4])).catch(error => {console.error(error); process.exit(1)});
        `;
        await assert.rejects(execFile(process.execPath, ['-e', child, require.resolve('fs-extra'),
            require.resolve('../server/core/BackupTransaction'), JSON.stringify(config), JSON.stringify(content)]), error => error.code === 86);
        assert.strictEqual(await fs.readFile(config.configFile, 'utf8'), content['config.json']);
        const restart = `
            const Manager = require(process.argv[1]);
            const config = JSON.parse(process.argv[2]);
            (async() => {
                const manager = new Manager();
                await manager.init(config.dataDir, config.configFile);
                await manager.load();
                require('assert').strictEqual(manager.config.loggingEnabled, false);
            })().catch(error => {console.error(error); process.exit(1)});
        `;
        await execFile(process.execPath, ['-e', restart, require.resolve('../server/config'), JSON.stringify(config)]);
        assert.strictEqual((await fs.readJson(config.configFile)).loggingEnabled, false);
        assert.strictEqual(await fs.readFile(targets['reading-lists.json'], 'utf8'), original['reading-lists.json']);
        await transaction.commit(config, content);
        for (const [name, value] of Object.entries(content))
            assert.strictEqual(await fs.readFile(targets[name], 'utf8'), value);
        assert.strictEqual(await fs.pathExists(path.join(dataDir, '.restore-transaction')), false);
    });
}

const realUid = name => require('crypto').createHash('sha256').update(String(name)).digest('base64');

// Limits of RequestLimits.userData, lowered for a test and restored after it.
async function withUserDataLimits(values, task) {
    const saved = Object.assign({}, requestLimits.userData);
    Object.assign(requestLimits.userData, values);
    try {
        await task();
    } finally {
        Object.assign(requestLimits.userData, saved);
    }
}

// One profile cannot grow reading-lists.json without bound: positions, bookmarks, lists and their books are capped,
// and repeated imports add up to the same caps (the oldest is dropped, the answer says how much).
async function testProfileDataCapsAndImportTrim() {
    await withUserDataLimits({progressPerProfile: 3, bookmarksPerBook: 2, bookmarksPerProfile: 3, listsPerProfile: 2, booksPerList: 3,
        listBooksPerProfile: 4, bookmarkTitle: 5, bookmarkExcerpt: 6, bookmarkNote: 7}, async() => temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(realUid);

        //позиции: сверх предела уходят самые старые по updatedAt
        for (const [i, uid] of [a, b, c, d].entries())
            await store.updateReaderProgress('', uid, {percent: 0.1, updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`});
        assert.deepStrictEqual(Object.keys((await store.resolveUser('')).user.readerProgress).sort(), [b, c, d].sort());

        //закладки: текст обрезается, на книгу и на профиль - не больше предела
        const [first] = await store.addReaderBookmark('', a, {title: 'Title long', excerpt: 'Excerpt long', note: 'Note is long'});
        assert.deepStrictEqual([first.title, first.excerpt, first.note], ['Title', 'Excerpt'.slice(0, 6), 'Note is']);
        await store.addReaderBookmark('', a, {title: 'Second'});
        await assert.rejects(store.addReaderBookmark('', a, {title: 'Third'}), /bookmarks|закладок/);
        await store.addReaderBookmark('', b, {title: 'Other'});
        await assert.rejects(store.addReaderBookmark('', c, {title: 'Over'}), /bookmarks|закладок/);

        //списки: число списков и книг в них
        const one = await store.createList('', 'One');
        await store.createList('', 'Two');
        await assert.rejects(store.createList('', 'Three'), /2/);
        await store.addBooks('', one.id, [a, b]);
        await store.setBookMembership('', one.id, c, true);
        await assert.rejects(store.setBookMembership('', one.id, d, true), /books|книг/);
        await store.setBookMembership('', one.id, c, true);

        //импорт: чужие uid и пустые записи пропускаются, лишнее отбрасывается и считается
        const payload = {user: {
            readerProgress: {[e]: {percent: 0.5, updatedAt: '2026-02-01T00:00:00.000Z'}, 'not-a-uid': {percent: 0.5, updatedAt: '2026-02-01T00:00:00.000Z'}},
            readerBookmarks: {[c]: [{id: 'x1', title: 'Imported long title', createdAt: '2099-01-01T00:00:00.000Z'},
                {id: 'x2', title: 'Old', createdAt: '2000-01-01T00:00:00.000Z'}], 'not-a-uid': [{id: 'x3'}]},
        }, lists: [{name: 'Two', books: [a, null, 'not-a-uid', b, c]}, {name: 'Four', books: [d]}]};
        const imported = await store.importData('', payload);
        assert.deepStrictEqual(imported.trimmed, {lists: 1, books: 3, progress: 1, bookmarks: 2});
        const sizes = async() => {
            const {user, data} = await store.resolveUser('');
            return {progress: Object.keys(user.readerProgress).sort(), bookmarks: Object.values(user.readerBookmarks).flat().length,
                imported: user.readerBookmarks[c].map(item => item.title), lists: data.lists.map(item => [item.name, item.books.length])};
        };
        const after = await sizes();
        assert.deepStrictEqual(after, {progress: [c, d, e].sort(), bookmarks: 3, imported: ['Impor'], lists: [['One', 3], ['Two', 1]]},
            'the oldest position and bookmarks go, the newest imported bookmark stays with its text cut');
        //повторный импорт ничего не растит
        assert.deepStrictEqual((await store.importData('', payload)).trimmed, {lists: 1, books: 3, progress: 0, bookmarks: 1});
        assert.deepStrictEqual(await sizes(), after);
    }));
}

// A broken reading-lists.json is kept as a copy and reported at error level (and so in the admin event log); a bad row
// of the file or of an import is skipped or refused with a user error, not a 500 on every request.
// Reader position from a device whose clock runs a day ahead: stored with server time, so the next real save still wins.
async function testReaderProgressFromFutureClockIsClamped() {
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const ahead = await store.updateReaderProgress('', 'book:1', {percent: 0.8, updatedAt: new Date(Date.now() + 86400000).toISOString()});
        assert.ok(Date.parse(ahead.updatedAt) <= Date.now() + 5*60*1000, ahead.updatedAt);
        assert.strictEqual(ahead.percent, 0.8);

        //часы немного впереди (в пределах допуска) - время устройства остаётся
        const near = new Date(Date.now() + 60000).toISOString();
        const next = await store.updateReaderProgress('', 'book:1', {percent: 0.3, updatedAt: near});
        assert.deepStrictEqual([next.percent, next.updatedAt], [0.3, near]);
    });
}

async function testBrokenReadingListsAreVisibleAndBadRowsSkipped() {
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        //журнал может быть ещё не запущен: тогда строка идёт в console.warn
        const messages = [];
        const logger = new (require('../server/core/AppLogger'))();
        const listener = logger.eventListener;
        const warn = console.warn;
        logger.setEventListener((level, message) => messages.push(`${level >= LM_ERR ? 'ERROR' : 'WARN'} ${message}`));
        console.warn = message => messages.push(`ERROR ${message}`);
        try {
            await fs.outputFile(store.file, '{broken');
            await store.load();
            const [copy] = (await fs.readdir(dataDir)).filter(name => /\.broken-[^.]+$/.test(name));
            assert.ok(copy, 'the broken file is kept');
            assert.ok(messages.some(message => message.startsWith('ERROR') && message.includes('unreadable') && message.includes(copy)), messages.join('\n'));
            //файл не перезаписывается, пока администратор не решит, что с ним делать
            await assert.rejects(store.createList('default', 'List'), error => error.status === 503 && error.message.includes('reading-lists.json'));
            assert.strictEqual(await fs.readFile(store.file, 'utf8'), '{broken');
            assert.deepStrictEqual(store.blockedState(), {file: 'reading-lists.json', copy: path.join(dataDir, copy)});

            //файл заменили руками: читается без перезапуска, блокировки больше нет

            const uid = realUid('a');
            await fs.writeJson(store.file, {version: 5, users: [{id: 'admin', name: 'Admin', login: 'admin', isAdmin: true}],
                lists: [{id: 'l1', userId: 'admin', name: 'List', books: [null, uid, 7]}],
                metadataOverrides: {[uid]: {title: 'Kept'}, [realUid('b')]: {title: ' '}}});
            const data = await store.load();
            assert.strictEqual(store.blockedState(), null);
            assert.deepStrictEqual(data.lists[0].books, [{bookUid: uid}]);
            assert.deepStrictEqual(Object.keys(await store.getMetadataOverrides()), [uid]);
            assert.ok(messages.some(message => message.includes('metadata override') && message.includes('skipped')), messages.join('\n'));
        } finally {
            console.warn = warn;
            logger.setEventListener(listener);
        }
        await assert.rejects(store.importData('', {lists: [null]}), error => error.constructor === Error);
    });
}

// A broken reading-lists.json is never replaced without an admin decision: reads show empty data, every write is refused
// with 503 and the file stays; only an admin accepts empty data (POST admin/user-data/accept-reset) or restores a backup.
async function testBrokenReadingListsBlockWritesUntilAdminDecides() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const ProfileAccess = require('../server/core/ProfileAccess');
        const config = {dataDir, configFile: path.join(dataDir, 'config.json'), tempDir: path.join(dataDir, 'tmp'), rootPathStatic: '',
            adminLogin: 'admin', adminPassword: 'admin-fixture', name: 'inpx-shelf', version: 'test', webConfigParams: ['name'], opds: {}};
        const worker = Object.create(Worker.prototype);
        const events = [];
        Object.assign(worker, {config, checkMyState() {}, readingListStore: new ReadingListStore(config),
            addAdminEvent: (level, category, message) => events.push(message.key)});
        const store = worker.readingListStore;
        const security = new Security(config);
        await security.init();
        const controller = apiController({config, security, webWorker: worker, profileAccess: new ProfileAccess(config, worker, security),
            workerState: {getState: () => ({state: 'normal'})}});
        const {base, close} = await listen(apiApp({config, security, controller, health: false}));
        //ошибка о файле идёт в console.warn, пока журнал не запущен
        const warn = console.warn;
        console.warn = () => {};
        try {
            await fs.outputFile(store.file, '{broken');
            const data = await store.load();
            assert.deepStrictEqual([data.users.map(user => user.id).sort(), data.lists], [['admin', 'default'], []], 'reads give empty data');

            //вход не пишет в файл: администратор входит с паролем из конфигурации
            const admin = new ApiTestClient(base);
            assert.strictEqual((await admin.call('login-user-profile', {login: 'admin', password: 'admin-fixture'})).status, 200);
            const created = await admin.call('create-reading-list', {name: 'New'});
            assert.strictEqual(created.status, 503);
            assert.match(created.body.error, /reading-lists\.json/);
            assert.strictEqual((await new ApiTestClient(base).call('admin-accept-user-data-reset')).status, 401, 'a guest is refused');
            await assert.rejects(worker.acceptUserDataReset('default', worker.profileToken('default')), /администратор|administrator/i);
            assert.strictEqual(await fs.readFile(store.file, 'utf8'), '{broken', 'the file on disk is untouched');

            //администратор начинает с пустых данных: его сеанс остаётся, запись снова принимается
            const reset = await admin.call('admin-accept-user-data-reset');
            assert.deepStrictEqual([reset.status, reset.body.reset], [200, ['reading-lists.json']]);
            assert.deepStrictEqual(events, ['admin.userDataReset']);
            assert.deepStrictEqual((await fs.readJson(store.file)).lists, []);
            assert.strictEqual(store.blockedState(), null);
            assert.strictEqual((await admin.call('create-reading-list', {name: 'After reset'})).status, 200);
            assert.deepStrictEqual((await admin.call('admin-accept-user-data-reset')).body.reset, [], 'nothing left to reset');

            //снова испорчен - полное восстановление снимает блокировку без перезапуска
            await fs.outputFile(store.file, '');
            await store.load();
            assert.ok(store.blockedState());
            const backup = await archive({'backup-info.json': {version: 'test'},
                'reading-lists.json': {users: [], lists: [{id: 'restored', userId: 'default', name: 'Restored'}]}});
            await worker.importAdminBackup('admin', worker.profileToken('admin'), backup);
            assert.strictEqual(store.blockedState(), null);
            await store.createList('default', 'After restore');
            assert.deepStrictEqual((await store.getLists('default')).map(list => list.name).sort(), ['After restore', 'Restored']);
        } finally {
            console.warn = warn;
            await close();
        }
    });
}

module.exports = [testScryptMigrationAndOpds, testApiBodyBoundsAndRecovery, testHttpUploadsGoThroughRequestChecks,
    testBackupValidationBeforeMutation, testRestoreSnapshotSecurityChangesAndKeyMismatch, testBackupRollbackAndCrashRecovery, testProfileDataCapsAndImportTrim,
    testBrokenReadingListsAreVisibleAndBadRowsSkipped, testBrokenReadingListsBlockWritesUntilAdminDecides, testReaderProgressFromFutureClockIsClamped];
