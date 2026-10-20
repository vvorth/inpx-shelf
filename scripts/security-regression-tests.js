const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const SecretStore = require('../server/core/SecretStore');
const ReadingListStore = require('../server/core/ReadingListStore');
const Security = require('../server/core/Security');
const FileDownloader = require('../server/core/FileDownloader');
const lifetime = require('../server/core/SessionLifetime');
const apiRoutes = require('../shared/apiRoutes');
const {ApiTestClient, apiController, apiApp, listen, fakeResponse, sampleParams, sampleUid} = require('./api-test-client');

async function temporary(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-security-test-'));
    try {
        return await fn(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function testConcurrentSecretKeyCreation() {
    await temporary(async(dir) => {
        const values = await Promise.all(Array.from({length: 16}, (_, i) => new SecretStore({dataDir: dir}).encrypt(`value-${i}`)));
        for (let i = 0; i < values.length; i++)
            assert.strictEqual(await new SecretStore({dataDir: dir}).decrypt(values[i]), `value-${i}`);

        const multiDir = path.join(dir, 'multiprocess');
        const modulePath = require.resolve('../server/core/SecretStore');
        const source = `new (require(process.argv[1]))({dataDir:process.argv[2]}).encrypt(process.argv[3]).then(v=>process.stdout.write(v)).catch(e=>{console.error(e);process.exitCode=1;});`;
        const children = await Promise.all(Array.from({length: 8}, (_, i) => execFile(process.execPath, ['-e', source, modulePath, multiDir, `child-${i}`])));
        for (let i = 0; i < children.length; i++)
            assert.strictEqual(await new SecretStore({dataDir: multiDir}).decrypt(children[i].stdout), `child-${i}`);

        const missing = new SecretStore({dataDir: path.join(dir, 'missing')});
        await assert.rejects(missing.decrypt(values[0]), /Secret key is missing/);
        assert.strictEqual(await fs.pathExists(missing.keyFile), false);
        await fs.writeFile(path.join(dir, 'secret.key'), 'broken');
        await assert.rejects(new SecretStore({dataDir: dir}).encrypt('test'), /Invalid secret key/);
        assert.strictEqual(await fs.readFile(path.join(dir, 'secret.key'), 'utf8'), 'broken');
    });
}

async function testConcurrentStoreMutations() {
    await temporary(async(dataDir) => {
        const stores = [new ReadingListStore({dataDir}), new ReadingListStore({dataDir})];
        // Include first initialization, multiple instances, and distinct mutation types.
        await Promise.all(Array.from({length: 12}, (_, i) => stores[i % 2].createList('default', `List ${i}`)));
        assert.strictEqual((await stores[0].load()).lists.length, 12);
        const list = (await stores[0].load()).lists[0];
        await Promise.all([
            stores[0].addBooks('default', list.id, ['book:1']),
            stores[1].addBooks('default', list.id, ['book:2']),
            stores[0].updateReaderProgress('default', 'book:3', {percent: 0.4}),
            stores[1].updateReaderProgress('default', 'book:4', {percent: 0.7}),
            stores[0].updateMetadataOverride('book:1', {title: 'Corrected'}),
        ]);
        const saved = await stores[0].load();
        assert.deepStrictEqual(saved.lists[0].books.map(b => b.bookUid).sort(), ['book:1', 'book:2']);
        assert.strictEqual(saved.users.find(u => u.id === 'default').readerProgress['book:3'].percent, 0.4);
        assert.strictEqual(saved.users.find(u => u.id === 'default').readerProgress['book:4'].percent, 0.7);
        const attempts = await Promise.allSettled([
            stores[0].createList('default', ''),
            stores[1].createList('default', 'After error'),
        ]);
        assert.strictEqual(attempts[0].status, 'rejected');
        assert.strictEqual(attempts[1].status, 'fulfilled');
        assert.strictEqual((await stores[0].load()).lists.length, 13);
    });
}

async function testAtomicConfigSave() {
    await temporary(async(dataDir) => {
        const ConfigManager = require('../server/config');
        const manager = new ConfigManager();
        manager.inited = true;
        manager._config = {dataDir, configFile: path.join(dataDir, 'config.json'), smtpPass: 'one'};
        const first = manager.save();
        manager._config.smtpPass = 'two';
        await Promise.all([first, manager.save()]);
        const disk = await fs.readFile(manager._config.configFile, 'utf8');
        assert.strictEqual(await new SecretStore({dataDir}).decrypt(JSON.parse(disk).smtpPass), 'two');
        const rename = fs.rename;
        fs.rename = async() => { throw new Error('simulated replacement failure'); };
        try {
            manager._config.smtpPass = 'three';
            await assert.rejects(manager.save(), /simulated replacement failure/);
        } finally {
            fs.rename = rename;
        }
        assert.strictEqual(await fs.readFile(manager._config.configFile, 'utf8'), disk);
        assert.ok(!(await fs.readdir(dataDir)).some(name => name.includes('.tmp-')));
        await manager.save();
        assert.strictEqual(await new SecretStore({dataDir}).decrypt((await fs.readJson(manager._config.configFile)).smtpPass), 'three');
    });
}

async function testSessionLifetimeAndMalformedCookies() {
    const security = new Security({});
    security.secret = 'test-secret';
    const middleware = security.middleware();
    const response = {setHeader: name => assert.notStrictEqual(name, 'Set-Cookie', 'Polling or assets must not set cookies')};
    for (let i = 0; i < 1000; i++) {
        for (const pathname of ['/health', '/ready', '/metrics', '/app.js'])
            middleware({path: pathname, headers: {}, socket: {}}, response, () => {});
    }
    assert.strictEqual(security.sessions.size, 0);
    let cookie;
    const headers = {};
    middleware({path: '/', headers: {}, socket: {}}, {setHeader: (name, value) => { headers[name] = value; }}, () => {});
    cookie = headers['Set-Cookie'];
    //no framing by other sites, no MIME sniffing, no referrer to other sites; scripts and styles are not restricted
    assert.strictEqual(headers['X-Frame-Options'], 'DENY');
    assert.strictEqual(headers['Content-Security-Policy'], "frame-ancestors 'none'");
    assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
    assert.strictEqual(headers['Referrer-Policy'], 'same-origin');
    middleware({path: '/', headers: {}, socket: {encrypted: true}}, {setHeader: (name, value) => { headers[name] = value; }}, () => {});
    assert.strictEqual(headers['Content-Security-Policy'], "frame-ancestors 'none'; upgrade-insecure-requests");
    assert.ok(headers['Strict-Transport-Security']);
    assert.ok(cookie.startsWith('inpx_web_session='));
    const request = {headers: {cookie}};
    const session = security.getSession(request);
    assert.ok(session);
    session.updatedAt = Date.now() - lifetime.idleMs - 1;
    assert.strictEqual(security.getSession(request), null);
    const absolute = security.ensureSession({headers: {}});
    absolute.createdAt = Date.now() - lifetime.maxAgeMs - 1;
    assert.strictEqual(security.getSession({headers: {}, securitySession: absolute}), null);
    assert.deepStrictEqual(security.parseCookies('bad=%ZZ; good=value'), {good: 'value'});
    assert.strictEqual(security.unpackSessionId(`id.${'я'.repeat(64)}`), '');
    assert.strictEqual(security.hasValidCsrf({headers: {}}, 'я'.repeat(64)), false);
    const loggedIn = security.ensureSession({headers: {}});
    loggedIn.profileAccessToken = 'profile-token';
    for (let i = 0; i < lifetime.maxSessions + 10; i++)
        security.ensureSession({headers: {}});
    assert.strictEqual(security.sessions.size, lifetime.maxSessions);
    assert.strictEqual(security.sessions.get(loggedIn.id), loggedIn, 'Anonymous sessions are evicted before logged-in ones');
}

async function testProfileCredentialChangesRevokeSessions() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.checkMyState = () => {};
        worker.profileSessions = new Map();
        worker.readingListStore = new ReadingListStore({dataDir});
        const user = await worker.readingListStore.createUser({name: 'Reader', login: 'reader',
            passwordHash: require('../server/core/ProfilePassword').legacy('reader', 'old')});
        await assert.rejects(worker.updateUserProfile(user.id, {login: 'renamed'}), /пароль заново/);
        const login = await worker.loginUserProfile('reader', 'old');
        await worker.updateUserProfile(user.id, {login: 'reader', name: 'Changed name'});
        assert.strictEqual(worker.getProfileSessionUser(login.profileAccessToken), user.id);
        assert.match((await worker.readingListStore.getUser(user.id)).passwordHash, /^scrypt:v1:/);
        await worker.loginUserProfile('reader', 'old');
        await worker.updateUserProfile(user.id, {passwordHash: await worker.hashProfilePassword('reader', 'new-password')});
        await assert.rejects(worker.requireAuthorizedUser(user.id, login.profileAccessToken), /need_profile_login/);
        await assert.rejects(worker.loginUserProfile('reader', 'old'), /Неверный/);
        const current = await worker.loginUserProfile('reader', 'new-password');
        await worker.updateUserProfile(user.id, {login: 'renamed'});
        assert.strictEqual(worker.getProfileSessionUser(current.profileAccessToken), '');
        const renamed = await worker.loginUserProfile('renamed', 'new-password');
        worker.profileSessions.get(renamed.profileAccessToken).updatedAt = Date.now() - lifetime.idleMs - 1;
        assert.strictEqual(worker.getProfileSessionUser(renamed.profileAccessToken), '');
        const deleted = await worker.loginUserProfile('renamed', 'new-password');
        await worker.deleteUserProfile(user.id);
        assert.strictEqual(worker.getProfileSessionUser(deleted.profileAccessToken), '');
    });
}

async function testDownloaderClosesFailedTransfers() {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.url === '/ok') {
            assert.strictEqual(req.headers['x-test'], 'present');
            res.end('complete');
        } else if (req.url === '/large-header') {
            res.writeHead(200, {'content-length': '100000'});
            res.flushHeaders();
        } else if (req.url === '/large-stream') {
            res.write('too much data');
        } else if (req.url === '/stall') {
            res.write('a');
        } // /no-headers deliberately never responds.
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const downloader = new FileDownloader(8);
    const options = {timeout: 1000, idleTimeout: 100, proxy: false};
    try {
        assert.strictEqual((await downloader.load(`${url}/ok`, {...options, headers: {'x-test': 'present'}})).toString(), 'complete');
        await assert.rejects(downloader.load(`${url}/large-header`, options), /слишком большой/);
        await assert.rejects(downloader.load(`${url}/large-stream`, options), /слишком большой/);
        await assert.rejects(downloader.load(`${url}/stall`, options), /timed out/);
        await assert.rejects(downloader.load(`${url}/no-headers`, {...options, timeout: 100}), /timed out|timeout/);
        await assert.rejects(downloader.head(`${url}/no-headers`, {...options, timeout: 100}), /timeout/);
        let abort = false;
        const cancelled = downloader.load(`${url}/no-headers`, options, null, () => abort);
        abort = true;
        await assert.rejects(cancelled, /abort/);
        const deadline = Date.now() + 1000;
        while (sockets.size && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(sockets.size, 0, 'Failed downloads must close their server sockets');
    } finally {
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testDownloaderVerifiesTlsCertificates() {
    const https = require('https');
    const cert = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'));
    const key = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-key.pem'));
    const server = https.createServer({key, cert}, (_req, res) => res.end('verified'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${server.address().port}`;
    const agent = new https.Agent({ca: cert});
    try {
        const downloader = new FileDownloader(100);
        await assert.rejects(downloader.load(url, {proxy: false}), /self.signed certificate/i);
        assert.strictEqual((await downloader.load(url, {proxy: false, httpsAgent: agent})).toString(), 'verified');
    } finally {
        agent.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

// RemoteLib verifies the main server's certificate: a self-signed one is refused.
async function testRemoteLibVerifiesTlsCertificates() {
    const https = require('https');
    const cert = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'));
    const key = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-key.pem'));
    const server = https.createServer({key, cert}, (_req, res) => res.end('{"sources": []}'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const RemoteLib = require('../server/core/RemoteLib');
        await assert.rejects(new RemoteLib({}).listSources({url: `https://127.0.0.1:${server.address().port}`, token: 't'}),
            /self.signed certificate/i);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testBookRouteRejectsTraversal() {
    await temporary(async(dir) => {
        const config = {dataDir: path.join(dir, 'data'), rootPathStatic: '', bookPathStatic: '/book',
            publicDir: path.join(dir, 'data', 'public'), bookDir: path.join(dir, 'data', 'public-files', 'book')};
        await fs.ensureDir(config.bookDir);
        await fs.outputFile(path.join(config.dataDir, 'reading-lists.json'), '{}');
        const app = require('express')();
        require('../server/static')(app, config);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            // Raw paths: fetch() would normalize the encoded dots away.
            for (const url of ['/book/%2E%2E', '/book/..%2F..', '/book/..%2F..%2Fraw', '/book/..%2F../zip']) {
                await new Promise((resolve, reject) => http.get({host: '127.0.0.1', port: server.address().port, path: url},
                    res => res.resume().on('end', resolve)).on('error', reject));
            }
            assert.ok(await fs.pathExists(path.join(config.dataDir, 'reading-lists.json')), 'Data dir must survive');
            assert.ok(await fs.pathExists(config.bookDir), 'Book cache must survive');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

// Converter stderr holds server paths: the download answer keeps them in the log only.
async function testConversionErrorHidesConverterOutput() {
    await temporary(async(dir) => {
        const config = {dataDir: path.join(dir, 'data'), rootPathStatic: '', bookPathStatic: '/book',
            publicDir: path.join(dir, 'data', 'public'), bookDir: path.join(dir, 'data', 'public-files', 'book'),
            tempDir: path.join(dir, 'tmp'), conversionEnabled: true,
            // node treats "convert" as a script path and fails, printing that path to stderr
            converterPaths: {fb2cng: process.execPath}};
        const hash = 'abcdef0123';
        const book = Buffer.from('<FictionBook><body><p>x</p></body></FictionBook>');
        await fs.ensureDir(config.bookDir);
        await fs.ensureDir(config.tempDir);
        await fs.writeFile(path.join(config.bookDir, hash), require('zlib').gzipSync(book));
        await fs.writeJson(path.join(config.bookDir, `${hash}.d.json`), {downFileName: 'book.fb2', size: book.length});
        const app = require('express')();
        require('../server/static')(app, config);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/book/${hash}/epub`);
            const text = await res.text();
            assert.strictEqual(res.status, 500);
            assert.ok(!text.includes(process.execPath) && !text.includes('exit code'), `Response must not contain converter output: ${text}`);
            assert.match(text, /Не удалось конвертировать книгу/);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

// The installer copies the repo with rsync --delete: it must refuse an app root that holds anything else.
async function testProxmoxInstallerKeepsForeignAppRoot() {
    if (process.platform === 'win32')
        return;
    await temporary(async(dir) => {
        const script = path.join(dir, 'install.sh');
        //без последней строки (main "$@"): только функции
        const source = await fs.readFile(path.join(__dirname, 'proxmox-lxc-install.sh'), 'utf8');
        await fs.writeFile(script, source.trimEnd().split('\n').slice(0, -1).join('\n'));
        await fs.outputFile(path.join(dir, 'lib', 'a.inpx'), '');
        await fs.outputFile(path.join(dir, 'other', 'keep'), '');
        const check = root => execFile('bash', ['-c', `source "$0"; parse_args --library-dir "$1" --inpx-file a.inpx --app-root "$2" --data-dir "$3"; validate_paths`,
            script, path.join(dir, 'lib'), path.join(dir, root), path.join(dir, 'data')]);
        await assert.rejects(check('other'), /not an inpx-shelf install/);
        assert.ok(await fs.pathExists(path.join(dir, 'other', 'keep')));
        await check('fresh');
    });
}

// A broken cache description (half-written, disk full) must not hand out the gzip cache file as the book.
async function testBookCacheErrorIsNotServedRaw() {
    await temporary(async(dir) => {
        const config = {dataDir: path.join(dir, 'data'), rootPathStatic: '', bookPathStatic: '/book',
            publicDir: path.join(dir, 'data', 'public'), bookDir: path.join(dir, 'data', 'public-files', 'book')};
        const hash = 'abcdef0123';
        await fs.ensureDir(config.bookDir);
        await fs.writeFile(path.join(config.bookDir, hash), require('zlib').gzipSync('<FictionBook/>'));
        await fs.writeFile(path.join(config.bookDir, `${hash}.d.json`), '');
        const app = require('express')();
        require('../server/static')(app, config);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/book/${hash}`);
            await res.arrayBuffer();
            assert.strictEqual(res.status, 500);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

// The web app is rewritten for rootPath once at extraction: requests never modify files that are being served.
async function testRootPathRewriteAtExtraction() {
    await temporary(async(dir) => {
        const appDir = require('../build/appdir');
        const config = {dataDir: path.join(dir, 'data'), rootPathStatic: '/root', bookPathStatic: '/root/book',
            publicDir: path.join(dir, 'data', 'public'), bookDir: path.join(dir, 'data', 'public-files', 'book')};
        await fs.ensureDir(config.bookDir);
        const source = `<script src="/${appDir}/app.js"></script>`;
        await fs.outputFile(path.join(config.publicDir, 'index.html'), source);
        await fs.outputFile(path.join(config.publicDir, appDir, 'app.js'), `import("/${appDir}/chunk.js")`);
        await fs.outputFile(path.join(config.publicDir, appDir, 'app.json'), `"/${appDir}/"`);
        await require('../server/createWebApp').applyRootPath(config);
        assert.strictEqual(await fs.readFile(path.join(config.publicDir, 'index.html'), 'utf8'), `<script src="/root/${appDir}/app.js"></script>`);
        assert.strictEqual(await fs.readFile(path.join(config.publicDir, appDir, 'app.js'), 'utf8'), `import("/root/${appDir}/chunk.js")`);
        assert.strictEqual(await fs.readFile(path.join(config.publicDir, appDir, 'app.json'), 'utf8'), `"/${appDir}/"`);

        const app = require('express')();
        require('../server/static')(app, config);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/root/`);
            assert.strictEqual(await res.text(), `<script src="/root/${appDir}/app.js"></script>`, 'Applied once, not again on request');
            assert.deepStrictEqual((await fs.readdir(config.publicDir)).sort(), [appDir, 'index.html'].sort(), 'No flag files');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

// A failed cover write must not leave a partial file under the cached name.
async function testCoverCacheWriteIsAtomic() {
    await temporary(async(dir) => {
        const {writeCachedCover} = require('../server/static');
        const writeFile = fs.writeFile;
        fs.writeFile = async(file, data) => {
            await writeFile(file, data.subarray(0, 2));
            throw new Error('simulated disk full');
        };
        try {
            await assert.rejects(writeCachedCover(dir, 'cover', {contentType: 'image/png', data: Buffer.from('png-data')}), /disk full/);
        } finally {
            fs.writeFile = writeFile;
        }
        assert.deepStrictEqual(await fs.readdir(dir), []);
        await writeCachedCover(dir, 'cover', {contentType: 'image/png', data: Buffer.from('png-data')});
        assert.strictEqual(await fs.readFile(path.join(dir, 'cover.png'), 'utf8'), 'png-data');
    });
}

// OPDS pages call string methods on query values: bracket syntax must not reach them as arrays or objects.
async function testOpdsQueryValuesAreStrings() {
    const req = {query: {author: ['a', 'b'], term: {x: '1'}, user: 'reader', list: [{}]}};
    require('../server/core/opds').stringQuery(req, null, () => {});
    assert.deepStrictEqual(req.query, {author: 'a', term: '', user: 'reader', list: ''});
}

// Every metrics scrape must not walk the caches again.
async function testMetricsReuseDirectorySizes() {
    let walks = 0;
    const worker = {config: {}, adminEvents: [], catalogSearch: {file: 'library.sqlite'}, getIndexStatus: async() => ({}),
        dirSize: async() => { walks++; return {size: 1, files: 1}; }};
    const app = require('express')();
    const config = {metricsEnabled: true, metricsToken: 'metrics-fixture', server: {}};
    const online = {getOnlineMetrics: () => ({clients: 3, users: 2, anonymousClients: 1})};
    require('../server/core/HealthRoutes')(app, config, worker, new Security(config), online);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/metrics`)).status, 401, 'No anonymous scrape');
        assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/metrics?token=metrics-fixture`)).status, 401, 'Header only');
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`, {headers: {authorization: 'Bearer metrics-fixture'}});
            const text = await res.text();
            assert.match(text, /inpx_web_cover_cache_files 1/);
            //активные клиенты HTTP API: сессии с запросом за последние 5 минут
            assert.match(text, /^inpx_web_active_clients 3$/m);
            assert.match(text, /^inpx_web_users_online 2$/m);
            assert.match(text, /^inpx_web_anonymous_clients 1$/m);
            assert.doesNotMatch(text, /inpx_web_ws_/);
        }
        assert.strictEqual(walks, 3, 'One walk per directory');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

// After the rename the directory is synced too; platforms that cannot do it (Windows) still save.
async function testAtomicWriteSyncsDirectory() {
    await temporary(async(dir) => {
        const {writeFileAtomic} = require('../server/core/FilePersistence');
        const promises = require('fs').promises;
        const open = promises.open;
        const opened = [];
        promises.open = async(file, ...args) => {
            opened.push(file);
            return open(file, ...args);
        };
        try {
            await writeFileAtomic(path.join(dir, 'data.json'), '1');
            assert.ok(opened.includes(dir), 'The directory must be synced');
            promises.open = async(file, ...args) => {
                if (file === dir)
                    throw Object.assign(new Error('not supported'), {code: 'EISDIR'});
                return open(file, ...args);
            };
            await writeFileAtomic(path.join(dir, 'data.json'), '2');
        } finally {
            promises.open = open;
        }
        assert.strictEqual(await fs.readFile(path.join(dir, 'data.json'), 'utf8'), '2');
    });
}

// OPDS sends the password with every request: a repeated success must skip scrypt.
async function testRepeatedPasswordCheckSkipsScrypt() {
    const profilePassword = require('../server/core/ProfilePassword');
    const stored = await profilePassword.hash('secret');
    let started = Date.now();
    assert.strictEqual(await profilePassword.verify(stored, 'user', 'secret'), true);
    const first = Date.now() - started;
    started = Date.now();
    assert.strictEqual(await profilePassword.verify(stored, 'user', 'secret'), true);
    assert.ok(Date.now() - started < first / 4, 'Second check must come from the cache');
    assert.strictEqual(await profilePassword.verify(stored, 'user', 'wrong'), false);
    assert.strictEqual(await profilePassword.verify(await profilePassword.hash('other'), 'user', 'secret'), false,
        'A changed hash must not reuse the cached success');
}

async function testAdminGetsRandomPasswordByDefault() {
    await temporary(async(dataDir) => {
        const config = {dataDir, adminLogin: 'admin', adminPassword: ''};
        const store = new ReadingListStore(config);
        const admin = (await store.load()).users.find(user => user.isAdmin);
        assert.ok(config.adminPassword.length >= 16, 'A random password must be generated');
        assert.ok(await store.verifyUserPassword(admin.id, config.adminPassword));
        assert.strictEqual(await store.verifyUserPassword(admin.id, 'admin'), false);
    });
}

async function testStoreReadErrorKeepsData() {
    await temporary(async(dataDir) => {
        const store = new ReadingListStore({dataDir, adminPassword: 'fixture'});
        await store.createList('default', 'Keep me');
        const before = await fs.readFile(store.file, 'utf8');
        const readFile = fs.readFile;
        fs.readFile = async() => { throw Object.assign(new Error('EMFILE: too many open files'), {code: 'EMFILE'}); };
        try {
            await assert.rejects(store.load(), /EMFILE/);
        } finally {
            fs.readFile = readFile;
        }
        assert.strictEqual(await fs.readFile(store.file, 'utf8'), before, 'A read error must not reset the store');
    });
}

async function testStoreLoadCacheStaysCurrent() {
    await temporary(async(dataDir) => {
        const [first, second] = [new ReadingListStore({dataDir, adminPassword: 'fixture'}), new ReadingListStore({dataDir, adminPassword: 'fixture'})];
        await first.load();
        const copy = await first.load();
        copy.lists.push({id: 'leaked'});
        assert.strictEqual((await first.load()).lists.length, 0, 'Mutating a loaded copy must not reach the cache');
        await second.createList('default', 'From another instance');
        assert.deepStrictEqual((await first.load()).lists.map(list => list.name), ['From another instance']);
    });
}

// Author bios and FB2 annotations come from library files and are shown with v-html.
async function testLibraryHtmlIsCleaned() {
    const {safeHtml} = require('../shared/safeHtml');
    assert.strictEqual(safeHtml('<P align="justify">Bio <b>bold</b><br/>&nbsp;&#171;q&#187;</P>'),
        '<p>Bio <b>bold</b><br>&nbsp;&#171;q&#187;</p>');
    assert.strictEqual(safeHtml('<subtitle>Part 1</subtitle>'), 'Part 1', 'Unknown tags are dropped, text stays');
    assert.strictEqual(safeHtml('&lt;b&gt; and a < b'), '&lt;b&gt; and a &lt; b', 'Escaped text stays text');
    for (const hostile of ['<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', '<p onclick="alert(1)">x</p>',
        '<a href="javascript:alert(1)">x</a>', '<b\nonmouseover=alert(1)>x</b>', '<scr<script>ipt>alert(1)</script>',
        '<p title="a>b" onmouseover="alert(1)">x</p>', '<iframe srcdoc="<script>alert(1)</script>">'])
        assert.ok(!/<(?!\/?(p|br|b|i|u|em|strong|h[1-6]|sub|sup|ul|ol|li|blockquote|div|span)>)/i.test(safeHtml(hostile)), hostile);
}

// User names and book titles reach dialogs and notifications: they render text unless asked for HTML.
async function testDialogsEscapeMessages() {
    const dialog = await fs.readFile(path.resolve(__dirname, '../client/components/share/StdDialog.vue'), 'utf8');
    assert.ok(!/v-html="(message|caption)"/.test(dialog), 'Dialog must not render raw message or caption');
    assert.match(dialog, /get messageHtml\(\) \{\s*return \(this\.html \? this\.message : escapeHtml\(this\.message\)\);/);
    assert.match(dialog, /get captionHtml\(\) \{\s*return \(this\.html \? this\.caption : escapeHtml\(this\.caption\)\);/);
    const notify = await fs.readFile(path.resolve(__dirname, '../client/components/share/Notify.vue'), 'utf8');
    assert.match(notify, /if \(!html\) \{\s*message = escapeHtml\(message\);\s*caption = \(caption \? escapeHtml\(caption\) : caption\);/);
}

// A missing book is a 404 in any interface language; other errors keep server paths in the log.
async function testBookByUidStatusAndHiddenPaths() {
    await temporary(async(dir) => {
        const config = {dataDir: dir, rootPathStatic: '', bookPathStatic: '/book', publicDir: path.join(dir, 'public'),
            bookDir: path.join(dir, 'book'), tempDir: dir};
        const worker = {getBookLink: async uid => {
            if (uid === 'missing')
                throw Object.assign(new Error('not here'), {status: 404});
            throw new Error(`7z failed on ${dir}/lib/archive.7z`);
        }};
        const app = require('express')();
        require('../server/static')(app, config, worker);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const get = uid => fetch(`http://127.0.0.1:${server.address().port}/book/by-uid?uid=${uid}`);
            assert.strictEqual((await get('missing')).status, 404);
            const failed = await get('broken');
            assert.strictEqual(failed.status, 500);
            assert.ok(!(await failed.text()).includes(dir));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

// Anonymous callers of /api/index-status see only the indexing progress; API errors and the book cache keep server paths.
async function testServerDetailsStayPrivate() {
    await temporary(async(dir) => {
        const config = {dataDir: dir, libDir: path.join(dir, 'library'), rootPathStatic: '', bookPathStatic: '/book', publicDir: path.join(dir, 'public'),
            bookDir: path.join(dir, 'book'), tempDir: dir, server: {ready: true}, version: '1.2.3', metricsToken: 'metrics-fixture'};
        const security = new Security(config);
        security.secret = 'test-secret';
        const worker = {getIndexStatus: async() => ({ready: true, state: 'normal', progress: 1, sources: [{id: 'a', name: 'Private shelf'}],
            inpxInfo: {collection: 'Private collection'}, stats: {bookCount: 5}, inpxFileHash: 'hash'}),
        getProfileSessionUser: token => (token === 'admin-token' ? 'admin' : ''),
        readingListStore: {load: async() => ({users: [{id: 'admin', isAdmin: true}]})},
        requireAdmin: async(userId) => { if (userId !== 'admin') throw new Error('not admin'); }};
        await fs.outputFile(path.join(config.bookDir, 'abcdef.d.json'), JSON.stringify({sourceLibDir: config.libDir}));
        const app = require('express')();
        app.use(security.middleware());
        require('../server/core/HealthRoutes')(app, config, worker, security);
        require('../server/static')(app, config, worker, security);
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const get = (url, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {headers});
        try {
            const anonymous = await (await get('/api/index-status')).json();
            assert.deepStrictEqual(anonymous, {serverReady: true, ready: true, state: 'normal', progress: 1});
            const scraper = await (await get('/api/index-status', {authorization: 'Bearer metrics-fixture'})).json();
            assert.strictEqual(scraper.sources[0].name, 'Private shelf');
            const session = security.ensureSession({headers: {}});
            const cookie = `inpx_web_session=${security.packSessionId(session.id)}`;
            assert.strictEqual((await (await get('/api/index-status', {cookie})).json()).inpxInfo, undefined, 'Not signed in');
            session.profileAccessToken = 'admin-token';
            assert.strictEqual((await (await get('/api/index-status', {cookie})).json()).inpxInfo.collection, 'Private collection');
            assert.strictEqual((await get('/book/abcdef.d.json')).status, 401, 'No anonymous books');
            assert.strictEqual((await get('/book/abcdef.d.json', {cookie})).status, 404);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }

        const controller = apiController({config, security, profileAccess: null, workerState: {getState: () => ({})},
            webWorker: {getBookLink: async() => { throw new Error(`archive not found: ${config.libDir}/fb2-000001.zip`); }}});
        const api = await listen(apiApp({config, security, controller, health: false}));
        try {
            const response = await ApiTestClient.forSession(api.base, security).call('get-book-link', {bookUid: sampleUid});
            assert.strictEqual(response.status, 400);
            const error = response.body.error;
            assert.ok(error && !error.includes(dir), error);
            assert.match(error, /журнале сервера|server log/);
        } finally {
            await api.close();
        }
    });
}

// INPX text (authors, titles, series) reaches OPDS XML as text: escaped once, never as markup.
async function testOpdsEscapesLibraryText() {
    const XmlParser = require('../server/core/xml/XmlParser');
    const hostile = '<script>alert(1)</script> Tom & "Jerry"';
    const book = {_uid: 'uid&1', title: hostile, author: `${hostile},Second`, series: hostile, serno: 1, ext: 'fb2',
        genre: '', lang: 'ru', folder: 'f', file: 'x', size: 10, date: '2020-01-01', libid: '1', keywords: '<img src=x onerror=alert(1)>'};
    const page = name => Object.assign(Object.create(require(`../server/core/opds/${name}`).prototype),
        {config: {opdsRoot: '/opds', bookPathStatic: '/book'}, opdsRoot: '/opds', rootTag: 'feed', id: name, title: 'opds.book'});
    const req = {query: {user: 'reader&co'}, originalUrl: '/opds/x?a=1&b=<2>'};
    const check = (xml, label, html = false) => {
        assert.ok(!xml.includes('<script') && !xml.includes('<img'), `${label}: ${xml}`);
        assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(xml), `${label}: a bare &: ${xml}`);
        if (!html)
            assert.ok(!xml.includes('&amp;amp;') && !xml.includes('&amp;lt;'), `${label}: escaped twice: ${xml}`);
        const parsed = new XmlParser().fromString(xml);
        assert.ok(parsed.$$('/feed/'), label);
        return xml;
    };

    const base = page('BasePage');
    const feed = check(base.makeBody({entry: [base.bookEntry(book)]}, req), 'book entry');
    assert.ok(feed.includes('&lt;script&gt;alert(1)&lt;/script&gt; Tom &amp; &quot;Jerry&quot;'), feed);
    assert.ok(feed.includes('href="/opds/x?a=1&amp;b=%3C2%3E&amp;user=reader%26co"'), 'Links are escaped once');

    const list = page('ReadingListPage');
    list.webWorker = {getReadingList: async() => ({list: {name: hostile}, books: [book]})};
    check(await list.body({...req, query: {user: 'reader', id: 'list'}}), 'reading list');

    const bookPage = page('BookPage');
    bookPage.webWorker = {getBookRecordByUid: async() => ({...book, ext: 'epub'}), applyMetadataOverridesToSearchResult: async() => {},
        getGenreTree: async() => ({genreTree: []}), getGenreMap: async() => new Map()};
    const details = check(await bookPage.body({...req, query: {uid: 'uid&1'}}), 'book page', true);
    //the HTML description (XML text) keeps its formatting tags and loses the library's markup
    const description = require('he').decode(/<content type="text\/html">([^<]*)<\/content>/.exec(details)[1]);
    assert.ok(description.includes('<p>') && !/<(script|img)/i.test(description), description);
    assert.ok(description.includes('alert(1) Tom &amp; &quot;Jerry&quot;'), description);
}

// An IPv6 client counts as its /64; a full table drops its oldest entry instead of refusing every new address.
async function testLoginLimiterKeysIpv6PrefixAndEvictsOldest() {
    const security = new Security({loginRateLimitMaxAttempts: 2});
    const from = address => ({headers: {}, socket: {remoteAddress: address}});
    for (const address of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff::5'])
        security.recordLoginAttempt(from(address), false, 'profile');
    assert.throws(() => security.checkLoginRate(from('2001:db8:1:2:abcd::9'), 'profile'), {code: 'INPX_LOGIN_RATE_LIMIT'});
    security.checkLoginRate(from('2001:db8:1:3::1'), 'profile');
    security.checkLoginRate(from('::ffff:192.0.2.1'), 'profile');
    assert.strictEqual(security.loginAttemptKey(from('::ffff:192.0.2.1'), 'profile'), 'profile:::ffff:192.0.2.1');

    security.loginAttempts.clear();
    for (let i = 0; i < 10000; i++)
        security.recordLoginAttempt(from(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`), false, 'opds');
    security.recordLoginAttempt(from('10.0.0.0'), false, 'opds');//the first one fails again: no longer the oldest
    security.checkLoginRate(from('192.0.2.200'));
    security.recordLoginAttempt(from('192.0.2.200'), false);
    assert.strictEqual(security.loginAttempts.size, 10000);
    assert.ok(security.loginAttempts.has('profile:192.0.2.200') && security.loginAttempts.has('opds:10.0.0.0'));
    assert.ok(!security.loginAttempts.has('opds:10.0.0.1'), 'The oldest entry goes');
}

// A signed-in browser session survives a restart: state.sqlite keeps the sha256 of its id and the profile, not the tokens.
// Anonymous sessions stay in memory; a password change or logout removes the row.
async function testSignedInSessionsSurviveRestart() {
    await temporary(async(dir) => {
        const StateStore = require('../server/core/StateStore');
        const WebWorker = require('../server/core/WebWorker');
        const stateStore = new StateStore({dataDir: dir});
        const start = () => {
            const worker = Object.assign(Object.create(WebWorker.prototype), {profileSessions: new Map(), stateStore});
            const security = new Security({});
            security.secret = 'test-secret';
            security.attachProfiles(worker);
            return {worker, security};
        };
        const first = start();
        const session = first.security.ensureSession({headers: {}});
        session.profileAccessToken = first.worker.createProfileSession('alice');
        first.security.rotateSession({headers: {}, securitySession: session}, fakeResponse());
        const loginAt = session.createdAt;
        const cookie = {cookie: `inpx_web_session=${first.security.packSessionId(session.id)}`};
        const anonymous = first.security.ensureSession({headers: {}});
        assert.strictEqual(stateStore.getWebSession(first.security.sessionHash(anonymous.id)), null, 'Anonymous sessions stay in memory');
        assert.strictEqual(stateStore.getWebSession(session.id), null, 'Rows are keyed by a hash of the id');

        const second = start();
        const restored = second.security.getSession({headers: cookie});
        assert.strictEqual(second.worker.getProfileSessionUser(restored.profileAccessToken), 'alice');
        assert.notStrictEqual(restored.profileAccessToken, session.profileAccessToken, 'The profile token is new');
        assert.deepStrictEqual([restored.csrfToken, restored.createdAt], [session.csrfToken, loginAt]);
        assert.strictEqual(second.worker.profileSessions.get(restored.profileAccessToken).createdAt, loginAt, 'The 30-day limit counts from the login');

        second.worker.revokeUserSessions('alice');
        assert.strictEqual(start().security.getSession({headers: cookie}), null, 'A password change ends it after a restart too');

        const third = start();
        const again = third.security.ensureSession({headers: {}});
        again.profileAccessToken = third.worker.createProfileSession('bob');
        third.security.rotateSession({headers: {}, securitySession: again}, fakeResponse());
        delete again.profileAccessToken;
        third.security.persistSession(again);
        assert.strictEqual(start().security.getSession({headers: {cookie: `inpx_web_session=${third.security.packSessionId(again.id)}`}}), null, 'Logout');
        stateStore.close();
    });
}

// ApiController behind apiGuard with handler stubs (handlers): the transport rules without the application behind them.
async function apiFixture({config: overrides = {}, worker: workerFields = {}, handlers = {}}, test) {
    await temporary(async(dir) => {
        const config = Object.assign({dataDir: dir, tempDir: path.join(dir, 'tmp'), rootPathStatic: '', bookPathStatic: '/book',
            publicDir: path.join(dir, 'public'), bookDir: path.join(dir, 'book'), name: 'inpx-shelf', version: 'test',
            apiMessageLimitMb: 1, server: {ready: true}}, overrides);
        const security = new Security(config);
        security.secret = 'test-secret';
        const worker = Object.assign({getIndexStatus: async() => ({ready: true, state: 'normal', progress: 1})}, workerFields);
        const controller = apiController(Object.assign({config, security, profileAccess: null, webWorker: worker,
            workerState: {getState: () => ({state: 'normal'})}, test: async() => ({message: 'inpx-shelf project is awesome'})}, handlers));
        await fs.outputFile(path.join(config.publicDir, 'index.html'), '<html>App</html>');
        const {base: origin, close} = await listen(apiApp({config, security, controller,
            after: app => require('../server/static')(app, config, worker, security)}));
        const base = origin + String(config.rootPathStatic || '').replace(/\/$/, '');
        try {
            await test({config, security, controller, origin, base, api: ApiTestClient.forSession(base, security)});
        } finally {
            await close();
        }
    });
}

// Every /api request: X-Inpx-Api, same-origin Sec-Fetch-Site and Origin; every POST: a JSON body and the session's
// CSRF token. Unknown routes, methods and parameters are JSON errors; nothing is cached.
async function testApiRequestRules() {
    const seen = [];
    await apiFixture({handlers: {
        updateReaderPreferences: async(req) => { seen.push(req); return {ok: true}; },
        catalogSearch: async(req) => ({q: req.q, limit: req.limit, hideCopies: req.hideCopies, filters: req.filters}),
    }}, async({origin, base, security, api}) => {
        const answers = [];
        const send = async(method, url, headers = {}, body) => {
            const response = await api.request(method, url, {headers, body});
            answers.push([method, url, response]);
            return response;
        };
        const ping = headers => send('GET', 'api/ping', headers);
        const json = (url, body = '{}', headers = {}) => send('POST', url, {'content-type': 'application/json', 'x-csrf-token': api.csrfToken, ...headers}, body);

        //заголовок X-Inpx-Api не поставить ни ссылкой, ни формой, ни <img> с чужого сайта
        const bare = await ping({'x-inpx-api': null});
        assert.deepStrictEqual([bare.status, bare.body], [403, {error: 'Forbidden'}]);
        assert.strictEqual((await ping({'x-inpx-api': '0'})).status, 403);
        assert.strictEqual((await json('api/update-reader-preferences', '{}', {'x-inpx-api': null})).status, 403);
        assert.deepStrictEqual((await ping()).body, {message: 'inpx-shelf project is awesome'});
        for (const site of ['cross-site', 'same-site'])
            assert.strictEqual((await ping({'sec-fetch-site': site})).status, 403, site);
        for (const site of ['same-origin', 'none'])
            assert.strictEqual((await ping({'sec-fetch-site': site})).status, 200, site);
        for (const foreign of ['http://evil.example', 'null', `https://${new URL(origin).host}`])
            assert.strictEqual((await ping({origin: foreign})).status, 403, foreign);
        assert.strictEqual((await ping({origin})).status, 200);

        //POST - только с CSRF-токеном своей сессии; GET токена не требует
        const write = options => api.call('update-reader-preferences', {preferences: {fontSize: 20}}, options);
        for (const csrfToken of [null, '', 'x'.repeat(64), security.ensureSession({headers: {}}).csrfToken]) {
            const response = await write({csrfToken});
            assert.deepStrictEqual([response.status, response.body.error], [403, 'bad_csrf_token'], String(csrfToken));
        }
        assert.strictEqual(seen.length, 0);
        assert.deepStrictEqual((await write()).body, {ok: true});
        assert.deepStrictEqual(seen[0].preferences, {fontSize: 20});
        const search = await api.call('catalog-search', {q: 'x', limit: 5, hideCopies: true, filters: {lang: ['ru']}});
        assert.deepStrictEqual([search.status, search.body], [200, {q: 'x', limit: 5, hideCopies: true, filters: {lang: ['ru']}}], 'Typed query');
        for (const route of apiRoutes.routes.filter(item => item.method === 'POST')) {
            const response = await api.call(route.action, sampleParams(route.action), {csrfToken: null, body: (route.upload ? '{}' : undefined)});
            assert.deepStrictEqual([response.status, response.body.error], [403, 'bad_csrf_token'], route.action);
        }

        //тело POST - JSON (файл - только у действий загрузки)
        for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream'])
            assert.strictEqual((await json('api/update-reader-preferences', '{}', {'content-type': type})).status, 415, type);
        assert.strictEqual((await json('api/update-reader-preferences', '{}', {'content-type': 'application/json; charset=utf-8'})).status, 200);
        assert.strictEqual(seen.length, 2);

        //неизвестный адрес - JSON 404, а не страница приложения
        for (const [method, url] of [['GET', 'api/nope'], ['GET', 'api/books/not-a-uid'], ['GET', 'api/ping/more'], ['GET', 'api/'],
            ['POST', 'api/nope']]) {
            const response = await (method === 'GET' ? send('GET', url) : json(url));
            assert.strictEqual(response.status, 404, `${method} ${url}`);
            assert.match(String(response.headers.get('content-type')), /^application\/json/, `${method} ${url}`);
            assert.ok(response.body.error, `${method} ${url}`);
        }
        const post = await json('api/ping');
        assert.strictEqual(post.status, 405);
        assert.match(String(post.headers.get('allow')), /\bGET\b/);
        const get = await send('GET', 'api/update-reader-preferences');
        assert.strictEqual(get.status, 405);
        assert.match(String(get.headers.get('allow')), /\bPOST\b/);
        assert.strictEqual((await send('DELETE', 'api/ping')).status, 405);

        //параметры адреса - только объявленные в shared/apiRoutes.js, по одному разу и своего типа
        for (const query of ['q=x&zzz=1', 'q=a&q=b', 'limit=abc', 'limit=1.5', 'hideCopies=yes', 'filters=%7Bbroken', 'filters=1',
            'userId=admin', 'csrfToken=x'])
            assert.strictEqual((await send('GET', `api/catalog/search?${query}`)).status, 400, query);
        assert.strictEqual((await json('api/update-reader-preferences?preferences=1')).status, 400, 'A POST takes no query');
        assert.strictEqual((await send('GET', `api/catalog/search?q=${'x'.repeat(9000)}`)).status, 414);
        assert.strictEqual(seen.length, 2, 'Rejected requests do not reach the handler');

        for (const [method, url, response] of answers)
            assert.strictEqual(response.headers.get('cache-control'), 'no-store', `${method} ${url} ${response.status}`);

        //health-check не требует X-Inpx-Api, хотя путь начинается с /api
        const status = await fetch(`${base}/api/index-status`);
        assert.strictEqual(status.status, 200);
        assert.strictEqual((await status.json()).ready, true);
        //запрос без известной сессии получает cookie
        const fresh = await new ApiTestClient(base).request('GET', 'api/ping');
        assert.match(String(fresh.headers.get('set-cookie')), /^inpx_web_session=/);
    });
}

// Under a root path the API lives at <root>/api, and the session cookie is scoped to the root.
async function testApiUnderRootPath() {
    await apiFixture({config: {rootPathStatic: '/lib', bookPathStatic: '/lib/book'}}, async({origin, base, api}) => {
        assert.strictEqual(base, `${origin}/lib`);
        assert.strictEqual((await api.request('GET', 'api/ping')).status, 200);
        assert.notStrictEqual((await fetch(`${origin}/api/ping`, {headers: {'X-Inpx-Api': '1'}})).status, 200);
        const fresh = await new ApiTestClient(base).request('GET', 'api/ping');
        assert.match(String(fresh.headers.get('set-cookie')), /Path=\/lib(;|$)/);
    });
}

// Startup lists <root>/api/ instead of the WebSocket, /upload and /session/rotate; the health path stays.
function testExposedPathsListApi() {
    const {exposedPaths, exposedPathsText} = require('../server/core/ExposedPaths');
    for (const root of ['', '/lib']) {
        const paths = exposedPaths({rootPathStatic: root}).map(item => item.path);
        assert.ok(paths.includes(`${root}/api/`), paths.join());
        assert.ok(!paths.some(item => /WebSocket|\/upload$|session\/rotate/.test(item)), paths.join());
        assert.ok(paths.includes('/api/index-status'));
    }
    assert.doesNotMatch(exposedPathsText({rootPathStatic: ''}), /WebSocket/);
    //в server/index.js health-маршруты стоят до /api: /api/index-status не проходит apiGuard
    const index = require('fs').readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert.ok(index.indexOf('initHealthRoutes(app') >= 0 && index.indexOf('initHealthRoutes(app') < index.indexOf('.router()'),
        'HealthRoutes before the API router');
    assert.doesNotMatch(index, /require\s*\(\s*'ws'\s*\)/);
}

// 8 active requests per session, 64 per server: one more gets 429 with Retry-After, other sessions keep working.
async function testApiConcurrencyLimits() {
    let release = () => {};
    let gate = null;
    let active = 0;
    await apiFixture({handlers: {test: async() => {
        if (gate) {
            active++;
            await gate;
            active--;
        }
        return {ok: true};
    }}}, async({base, security}) => {
        const clients = Array.from({length: 9}, () => ApiTestClient.forSession(base, security));
        const ping = client => client.request('GET', 'api/ping');
        const waitFor = async count => {
            const deadline = Date.now() + 10000;
            while (active < count && Date.now() < deadline)
                await new Promise(resolve => setTimeout(resolve, 10));
            assert.strictEqual(active, count);
        };
        gate = new Promise(resolve => release = resolve);
        const held = [];
        try {
            for (let i = 0; i < 8; i++)
                held.push(ping(clients[0]));
            await waitFor(8);
            const over = await ping(clients[0]);
            assert.deepStrictEqual([over.status, over.body.error], [429, 'too_many_requests']);
            assert.strictEqual(over.headers.get('retry-after'), '1');
            for (const client of clients.slice(1, 8)) {
                for (let i = 0; i < 8; i++)
                    held.push(ping(client));
            }
            await waitFor(64);
            const global = await ping(clients[8]);
            assert.deepStrictEqual([global.status, global.body.error], [429, 'too_many_requests'], 'The server-wide cap');
            assert.strictEqual(global.headers.get('retry-after'), '1');
        } finally {
            gate = null;
            release();
        }
        assert.ok((await Promise.all(held)).every(response => response.status === 200));
        assert.strictEqual((await ping(clients[0])).status, 200);
        assert.strictEqual((await ping(clients[8])).status, 200);
    });
}

// Query logging writes method, path and body without passwords and tokens, never the header tokens;
// unknown routes add no metric labels.
async function testApiLogHidesSecretsAndBoundsMetrics() {
    const runtimeMetrics = require('../server/core/RuntimeMetrics');
    const logger = new (require('../server/core/AppLogger'))().logger;
    const lines = [];
    const capture = {log: (type, message) => lines.push(String(message))};
    await apiFixture({config: {logQueries: true}, handlers: {
        updateReaderPreferences: async() => ({ok: true, profileAccessToken: 'OUT_SECRET'}),
    }}, async({api}) => {
        logger.handlers.push(capture);
        try {
            const response = await api.call('update-reader-preferences', {password: 'IN_SECRET', accessToken: 'IN_SECRET',
                profile: {password: 'IN_SECRET'}, preferences: {fontSize: 20}}, {profileToken: 'HEADER_SECRET', userId: 'reader'});
            assert.strictEqual(response.status, 200);
            await api.request('GET', 'api/random-action-name');
        } finally {
            logger.handlers.splice(logger.handlers.indexOf(capture), 1);
        }
        assert.ok(lines.some(line => line.includes('update-reader-preferences')), lines.join('\n'));
        assert.ok(!lines.some(line => line.includes('_SECRET') || line.includes(api.csrfToken)), lines.join('\n'));
    });
    const labels = [...runtimeMetrics.actionStats.keys()];
    assert.ok(!labels.includes('random-action-name'), labels.join());
}

// A PNG header claiming 20000x20000 is rejected before pngjs allocates the whole image.
function testHugePngIsRejectedBeforeDecoding() {
    const {PNG} = require('pngjs');
    const imageUtils = require('../server/core/ImageUtils');
    const small = new PNG({width: 2, height: 2});
    small.data.fill(255);
    const png = PNG.sync.write(small);
    assert.ok(imageUtils.fitToJpeg(png, 10, 10).length > 0);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(20000, 16);
    huge.writeUInt32BE(20000, 20);
    assert.throws(() => imageUtils.fitToJpeg(huge, 10, 10), /20000x20000/);
}

// gunzip of a compressed book stops at the output limit instead of filling memory.
async function testGunzipBufferIsBounded() {
    const utils = require('../server/core/utils');
    const packed = require('zlib').gzipSync(Buffer.alloc(1024*1024));
    assert.strictEqual((await utils.gunzipBuffer(packed)).length, 1024*1024);
    await assert.rejects(utils.gunzipBuffer(packed, 1000), {code: 'ERR_BUFFER_TOO_LARGE'});
}

module.exports = [
    testSignedInSessionsSurviveRestart,
    testServerDetailsStayPrivate, testOpdsEscapesLibraryText, testLoginLimiterKeysIpv6PrefixAndEvictsOldest, testApiConcurrencyLimits, testAtomicWriteSyncsDirectory, testMetricsReuseDirectorySizes, testOpdsQueryValuesAreStrings,
    testApiRequestRules, testApiUnderRootPath, testExposedPathsListApi, testCoverCacheWriteIsAtomic, testRootPathRewriteAtExtraction,
    testApiLogHidesSecretsAndBoundsMetrics, testBookByUidStatusAndHiddenPaths, testBookRouteRejectsTraversal,
    testConversionErrorHidesConverterOutput, testBookCacheErrorIsNotServedRaw, testProxmoxInstallerKeepsForeignAppRoot, testDialogsEscapeMessages, testRepeatedPasswordCheckSkipsScrypt, testLibraryHtmlIsCleaned,
    testStoreLoadCacheStaysCurrent, testStoreReadErrorKeepsData, testAdminGetsRandomPasswordByDefault, testConcurrentSecretKeyCreation,
    testConcurrentStoreMutations, testAtomicConfigSave, testSessionLifetimeAndMalformedCookies, testProfileCredentialChangesRevokeSessions,
    testDownloaderClosesFailedTransfers, testDownloaderVerifiesTlsCertificates, testHugePngIsRejectedBeforeDecoding, testGunzipBufferIsBounded, testRemoteLibVerifiesTlsCertificates];
