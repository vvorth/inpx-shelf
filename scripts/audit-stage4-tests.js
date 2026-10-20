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
        const post = body => api.request('POST', 'api/update-reader-preferences', {body,
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
            const sent = await rawPost(base, '/api/update-reader-preferences', {'Content-Type': 'application/json', 'X-Inpx-Api': '1',
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
        const controller = apiController({config, security, profileAccess: null, workerState: {getState: () => ({})},
            webWorker: {
                requireAuthorizedUser: async(userId) => {
                    if (userId === 'stranger')
                        throw new Error('need_profile_login');
                    return {id: userId || 'default'};
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
        const post = (body, options = {}) => api.call('import-reading-lists', {}, Object.assign({body, userId: 'reader'}, options));
        try {
            //кто не прошёл проверки, ничего не пишет на диск: тело читается и отбрасывается
            const stranger = await post(Buffer.alloc(512*1024), {userId: 'stranger'});
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
            assert.strictEqual((await api.request('POST', 'api/update-reader-preferences', {body: '{}',
                headers: {'content-type': 'application/octet-stream', 'x-csrf-token': api.csrfToken}})).status, 415);
            assert.strictEqual((await post('{}', {headers: {'content-type': 'application/json'}})).status, 415);
            assert.match((await post('{broken')).body.error, /JSON/);
            //слишком большой Content-Length - отказ сразу, тело не нужно
            const declared = await new Promise((resolve, reject) => {
                const request = http.request({host: '127.0.0.1', port, method: 'POST', path: '/api/import-reading-lists',
                    headers: {'Content-Length': String(1024*1024 + 1), 'Content-Type': 'application/octet-stream', 'X-Inpx-Api': '1',
                        'X-CSRF-Token': api.csrfToken, 'X-User-Id': 'reader', cookie: api.cookie}}, response => {
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
            const named = await api.request('POST', 'api/import-reading-lists', {body: JSON.stringify({uploadFile: '/etc/passwd', data: {lists: []}}),
                headers: {'content-type': 'application/json', 'x-csrf-token': api.csrfToken, 'x-user-id': 'reader'}});
            assert.strictEqual(named.status, 415);
            const query = await api.request('POST', 'api/import-reading-lists?uploadFile=%2Fetc%2Fpasswd', {body: '{"lists":[]}',
                headers: {'content-type': 'application/octet-stream', 'x-csrf-token': api.csrfToken, 'x-user-id': 'reader'}});
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
        worker.profileSessions = new Map([['old', {userId: 'admin'}]]);
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
        assert.strictEqual(worker.profileSessions.size, 1);
        assert.deepStrictEqual(await fs.readdir(worker.config.tempDir), []);

        // Upstream inpx-web backups carry the discovery cache and upstream release links: neither is restored.
        worker.config.checkReleaseLink = 'https://api.github.com/repos/vvorth/inpx-shelf/releases/latest';
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

module.exports = [testScryptMigrationAndOpds, testApiBodyBoundsAndRecovery, testHttpUploadsGoThroughRequestChecks,
    testBackupValidationBeforeMutation, testBackupRollbackAndCrashRecovery];
