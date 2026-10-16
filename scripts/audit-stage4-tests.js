const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const passwords = require('../server/core/ProfilePassword');
const ReadingListStore = require('../server/core/ReadingListStore');
const transaction = require('../server/core/BackupTransaction');
const requestLimits = require('../server/core/RequestLimits');

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
            opdsAuthEnabled: true, passwordHash: passwords.legacy('legacy', 'secret')});
        assert.strictEqual((await store.verifyOpdsPassword(user.id, 'legacy', 'wrong')).authorized, false);
        assert.strictEqual((await store.getUser(user.id)).passwordHash, user.passwordHash);
        assert.strictEqual((await store.verifyOpdsPassword(user.id, 'legacy', 'secret')).authorized, true);
        const migrated = await store.getUser(user.id);
        assert.match(migrated.passwordHash, /^scrypt:v1:/);
        await store.updateUser(user.id, {login: 'renamed'});
        const restarted = new ReadingListStore({dataDir});
        assert.strictEqual((await restarted.verifyOpdsPassword(user.id, 'renamed', 'secret')).authorized, true);
        assert.strictEqual((await restarted.getUser(user.id)).passwordHash, migrated.passwordHash);
        assert.match((await restarted.getUser('admin')).passwordHash, /^scrypt:v1:/);
    });
}

async function testWebSocketBoundsAndRecovery() {
    const WebSocket = require('ws');
    const Controller = require('../server/controllers/WebSocketController');
    const controller = Object.create(Controller.prototype);
    controller.config = {importLimitMb: 1, backupUploadLimitMb: 1};
    controller.webAccess = {hasAccess: async() => true};
    controller.test = async(req, ws) => controller.send({ok: true}, req, ws);
    const server = new WebSocket.Server({port: 0, host: '127.0.0.1', maxPayload: requestLimits.transportLimit(controller.config)});
    server.on('connection', socket => {
        socket.on('error', () => {});
        socket.on('message', data => controller.onMessage(socket, data.toString()));
    });
    await new Promise(resolve => server.on('listening', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise(resolve => socket.on('open', resolve));
    const call = (message) => new Promise(resolve => {
        const receive = data => {
            const response = JSON.parse(data);
            if (!response._rok) {
                socket.off('message', receive);
                resolve(response);
            }
        };
        socket.on('message', receive);
        socket.send(message);
    });
    try {
        for (const malformed of ['null', '[]', 'false', '{'])
            assert.ok((await call(malformed)).error);
        assert.match((await call(JSON.stringify({action: 'test', data: 'x'.repeat(1024*1024)}))).error, /размер/);
        assert.strictEqual((await call(JSON.stringify({action: 'test'}))).ok, true);
        const closed = new Promise(resolve => socket.once('close', resolve));
        socket.send('x'.repeat(7*1024*1024));
        assert.strictEqual(await closed, 1009);
    } finally {
        socket.terminate();
        for (const client of server.clients)
            client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
    let release;
    const gate = new Promise(resolve => release = resolve);
    controller.test = async() => gate;
    const fake = {readyState: WebSocket.OPEN, send() {}, close(code) { this.code = code; }};
    const busy = Array.from({length: 8}, () => controller.onMessage(fake, '{"action":"test"}'));
    await controller.onMessage(fake, '{"action":"test"}');
    assert.strictEqual(fake.code, 1013);
    release();
    await Promise.all(busy);
    assert.strictEqual(controller.activeRequests, 0);
    assert.strictEqual(fake.activeRequests, 0);
    requestLimits.checkRequest({action: 'update-reader-preferences'}, 1024*1024, controller.config);
    assert.throws(() => requestLimits.checkRequest({action: 'update-reader-preferences'}, 1024*1024 + 1, controller.config), /размер/);
    assert.throws(() => requestLimits.checkImport({lists: Array.from({length: 1001}, () => ({}))}), /1000/);
    assert.throws(() => requestLimits.checkImport({lists: [{books: Array(100001).fill('book')}]}), /100000/);
}

// Files come over HTTP: the body is cut at the limit, and the request passes the same checks as a WebSocket one.
async function testHttpUploadsGoThroughRequestChecks() {
    await temporary(async(dir) => {
        const express = require('express');
        const http = require('http');
        const Controller = require('../server/controllers/WebSocketController');
        const controller = Object.create(Controller.prototype);
        const tempDir = path.join(dir, 'tmp');
        controller.config = {importLimitMb: 1, backupUploadLimitMb: 1, tempDir};
        controller.webAccess = {hasAccess: async token => token === 'open', isActiveToken: () => true, newToken: () => 'salt'};
        let port = 0;
        controller.security = {
            sameOriginCheck: req => ({ok: !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`}),
            hasValidCsrf: (req, token) => token === 'csrf',
            checkLoginRate() {}, recordLoginAttempt() {},
        };
        controller.profileAccess = null;
        const seen = [];
        controller.webWorker = {
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
        };
        const app = express();
        app.post('/upload', controller.uploadHandler());
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
        const post = (body, headers = {}, action = 'import-reading-lists') => fetch(`http://127.0.0.1:${port}/upload?action=${action}`,
            {method: 'POST', body, duplex: 'half', headers: Object.assign({'X-Access-Token': 'open', 'X-CSRF-Token': 'csrf', 'X-User-Id': 'reader'}, headers)})
            .then(async response => ({status: response.status, body: await response.json()}));
        try {
            //кто не прошёл проверки, ничего не пишет на диск: тело читается и отбрасывается
            const stranger = await post(Buffer.alloc(512*1024), {'X-User-Id': 'stranger'});
            assert.deepStrictEqual([stranger.status, stranger.body.error], [403, 'need_profile_login']);
            assert.strictEqual(await fs.pathExists(tempDir), false, 'nothing is stored before the checks pass');
            const ok = await post(JSON.stringify({lists: [{name: 'A', books: []}]}));
            assert.deepStrictEqual(ok, {status: 200, body: {userId: 'reader', lists: 1}});
            assert.strictEqual((await post('{}', {'X-CSRF-Token': 'stale'})).body.error, 'bad_csrf_token');
            assert.strictEqual((await post('{}', {'X-Access-Token': 'wrong'})).body.error, 'need_access_token');
            assert.strictEqual((await post('{}', {Origin: 'https://evil.example'})).status, 403);
            assert.strictEqual((await post('{}', {}, 'test')).status, 404, 'only import actions take files');
            assert.match((await post('{broken')).body.error, /JSON/);
            //слишком большой Content-Length - отказ сразу, тело не нужно
            const declared = await new Promise((resolve, reject) => {
                const request = http.request({host: '127.0.0.1', port, method: 'POST', path: '/upload?action=import-reading-lists',
                    headers: {'Content-Length': String(1024*1024 + 1)}}, response => resolve(response.statusCode));
                request.on('error', reject);
                request.flushHeaders();
            });
            assert.strictEqual(declared, 413);
            //без Content-Length тело обрывается на лимите
            const stream = new (require('stream').Readable)({read() {}});
            const streamed = post(stream, {'Content-Type': 'application/octet-stream'});
            for (let i = 0; i < 3; i++)
                stream.push(Buffer.alloc(512*1024));
            stream.push(null);
            assert.strictEqual((await streamed).status, 413);
            assert.deepStrictEqual(await fs.readdir(tempDir), [], 'uploads are removed');
            assert.strictEqual(seen.length, 1);

            //WebSocket-сообщение не может указать файл на сервере
            const responses = [];
            const socket = {readyState: require('ws').OPEN, send: text => responses.push(JSON.parse(text)), close() {}};
            await controller.onMessage(socket, JSON.stringify({action: 'import-reading-lists', accessToken: 'open', csrfToken: 'csrf',
                uploadFile: '/etc/passwd', data: {lists: []}}));
            assert.match(responses.pop().error, /HTTP/);
            assert.strictEqual(seen.length, 1);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
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

module.exports = [testScryptMigrationAndOpds, testWebSocketBoundsAndRecovery, testHttpUploadsGoThroughRequestChecks,
    testBackupValidationBeforeMutation, testBackupRollbackAndCrashRecovery];
