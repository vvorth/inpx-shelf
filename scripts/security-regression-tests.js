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
        await worker.updateUserProfile(user.id, {passwordHash: await worker.hashProfilePassword('reader', 'new')});
        await assert.rejects(worker.requireAuthorizedUser(user.id, login.profileAccessToken), /need_profile_login/);
        await assert.rejects(worker.loginUserProfile('reader', 'old'), /Неверный/);
        const current = await worker.loginUserProfile('reader', 'new');
        await worker.updateUserProfile(user.id, {login: 'renamed'});
        assert.strictEqual(worker.getProfileSessionUser(current.profileAccessToken), '');
        const renamed = await worker.loginUserProfile('renamed', 'new');
        worker.profileSessions.get(renamed.profileAccessToken).updatedAt = Date.now() - lifetime.idleMs - 1;
        assert.strictEqual(worker.getProfileSessionUser(renamed.profileAccessToken), '');
        const deleted = await worker.loginUserProfile('renamed', 'new');
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

// RemoteLib verifies the server certificate (WebSocket and book download) unless remoteLib.ignoreCertErrors is set.
async function testRemoteLibVerifiesTlsCertificates() {
    const https = require('https');
    const {WebSocketServer} = require('ws');
    const cert = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'));
    const key = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-key.pem'));
    const server = https.createServer({key, cert}, (_req, res) => res.end('book'));
    const wss = new WebSocketServer({server});
    wss.on('connection', ws => ws.on('message', data => {
        const {requestId} = JSON.parse(data);
        ws.send(JSON.stringify({requestId, _rok: 1}));
        ws.send(JSON.stringify({requestId, link: '/book/abc123'}));
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const modulePath = require.resolve('../server/core/RemoteLib');
    await temporary(async dir => {
        for (const ignoreCertErrors of [false, true]) {
            delete require.cache[modulePath];// RemoteLib is a module-level singleton
            const RemoteLib = require(modulePath);
            const remoteLib = new RemoteLib({remoteLib: {url: `wss://127.0.0.1:${server.address().port}`, ignoreCertErrors},
                maxPayloadSize: 1, bookDir: dir, inpxFile: path.join(dir, 'x.inpx')});
            try {
                if (ignoreCertErrors) {
                    assert.strictEqual(await remoteLib.downloadBook('uid'), 'abc123');
                    assert.strictEqual(await fs.readFile(path.join(dir, 'abc123'), 'utf8'), 'book');
                } else {
                    await assert.rejects(remoteLib.downloadBook('uid'), /502/);
                }
            } finally {
                remoteLib.wsc.close();
                if (remoteLib.httpsAgent)
                    remoteLib.httpsAgent.destroy();
            }
        }
    });
    delete require.cache[modulePath];
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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

// One address cannot hold an unbounded number of WebSockets; behind a trusted proxy the client address counts.
async function testWebSocketConnectionsCappedPerIp() {
    const security = new Security({trustProxy: true, trustedProxyCidrs: ['10.0.0.1/32']});
    security.secret = 'test-secret';
    const direct = ip => ({headers: {}, socket: {remoteAddress: ip}});
    const proxied = ip => ({headers: {'x-forwarded-for': ip}, socket: {remoteAddress: '10.0.0.1'}});
    const clients = Array.from({length: 50}, () => ({req: proxied('192.0.2.1')}));
    assert.strictEqual(security.verifyWebSocket(proxied('192.0.2.1'), clients), false);
    assert.strictEqual(security.verifyWebSocket(proxied('192.0.2.2'), clients), true);
    assert.strictEqual(security.verifyWebSocket(direct('10.0.0.1'), clients), true, 'The proxy address itself is not the client');
    assert.strictEqual(security.verifyWebSocket(direct('192.0.2.1'), clients.slice(1)), true);
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
    require('../server/core/HealthRoutes')(app, config, worker, new Security(config));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/metrics`)).status, 401, 'No anonymous scrape');
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`, {headers: {authorization: 'Bearer metrics-fixture'}});
            assert.match(await res.text(), /inpx_web_cover_cache_files 1/);
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

// Reads are listed; every other action, including one added later, needs the CSRF token.
async function testWriteActionsNeedCsrf() {
    const {WebSocketController} = require('../server/controllers');
    const isProtected = action => WebSocketController.prototype.isCsrfProtectedAction(action);
    for (const action of ['update-book-metadata', 'create-admin-backup', 'test-admin-integration', 'update-reader-progress', 'future-write'])
        assert.strictEqual(isProtected(action), true, action);
    for (const action of ['get-config', 'catalog-search', 'get-book'])
        assert.strictEqual(isProtected(action), false, action);
}

// Every request without the access password gets a salt: unused ones are capped and never written to disk.
async function testUnusedAccessTokensAreCapped() {
    const WebAccess = require('../server/core/WebAccess');
    const saved = [];
    const webAccess = Object.assign(Object.create(WebAccess.prototype),
        {config: {accessPassword: 'secret'}, freeAccess: false, accessTimeout: 0, accessMap: new Map(),
            db: {putAccess: token => saved.push(token), deleteAccess() {}}});
    webAccess.accessMap.set('signed-in', {time: Date.now(), used: 3});
    for (let i = 0; i < WebAccess.maxUnusedTokens + 50; i++)
        webAccess.newToken();
    assert.strictEqual(webAccess.accessMap.size, WebAccess.maxUnusedTokens);
    assert.ok(webAccess.accessMap.has('signed-in'), 'a signed-in token is never pushed out');
    const sleep = require('../server/core/utils').sleep;
    require('../server/core/utils').sleep = () => Promise.reject(new Error('stop'));
    try {
        await webAccess.periodicClean().catch(() => {});
    } finally {
        require('../server/core/utils').sleep = sleep;
    }
    assert.deepStrictEqual(saved, ['signed-in']);
}

// A client over the login limit must not get in even with the right access password.
async function testAccessPasswordLimitBlocksCorrectGuess() {
    const Controller = require('../server/controllers/WebSocketController');
    const WebAccess = require('../server/core/WebAccess');
    const config = {accessPassword: 'secret', loginRateLimitMaxAttempts: 2};
    const webAccess = Object.assign(Object.create(WebAccess.prototype),
        {config, freeAccess: false, accessTimeout: 0, accessMap: new Map(), db: {putAccess() {}}});
    const controller = Object.assign(Object.create(Controller.prototype), {config, webAccess, security: new Security(config), activeRequests: 0});
    controller.test = async(req, ws) => controller.send({ok: true}, req, ws);
    const sent = [];
    const ws = {readyState: 1, req: {headers: {}, socket: {remoteAddress: '192.0.2.1'}}, send: message => sent.push(JSON.parse(message))};
    const call = async(accessToken) => {
        sent.length = 0;
        await controller.processMessage(ws, JSON.stringify({action: 'test', accessToken}));
        return sent.find(message => !message._rok);
    };
    for (let i = 0; i < 2; i++)
        assert.strictEqual((await call('wrong')).error, 'need_access_token');
    const token = require('../server/core/utils').getBufHash(`secret${webAccess.newToken()}`, 'sha256', 'hex');
    assert.match((await call(token)).error, /Too many login attempts/);
    assert.strictEqual(webAccess.isActiveToken(token), false, 'A blocked guess must not activate the token');
    controller.security.loginAttempts.clear();
    assert.strictEqual((await call(token)).ok, true);
}

// Anonymous callers of /api/index-status see only the indexing progress; WebSocket errors and the book cache keep server paths.
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

        const Controller = require('../server/controllers/WebSocketController');
        const controller = Object.assign(Object.create(Controller.prototype), {config, webAccess: {hasAccess: async() => true}, activeRequests: 0});
        controller.webWorker = {getBookLink: async() => { throw new Error(`archive not found: ${config.libDir}/fb2-000001.zip`); }};
        const sent = [];
        const ws = {readyState: 1, req: {headers: {}}, send: message => sent.push(JSON.parse(message))};
        await controller.processMessage(ws, JSON.stringify({action: 'get-book-link', bookUid: 'x'}));
        const error = sent.find(message => !message._rok).error;
        assert.ok(error && !error.includes(dir), error);
        assert.match(error, /журнале сервера|server log/);
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
        security.recordLoginAttempt(from(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`), false, 'access');
    security.recordLoginAttempt(from('10.0.0.0'), false, 'access');//the first one fails again: no longer the oldest
    security.checkLoginRate(from('192.0.2.200'));
    security.recordLoginAttempt(from('192.0.2.200'), false);
    assert.strictEqual(security.loginAttempts.size, 10000);
    assert.ok(security.loginAttempts.has('access:192.0.2.200') && security.loginAttempts.has('access:10.0.0.0'));
    assert.ok(!security.loginAttempts.has('access:10.0.0.1'), 'The oldest entry goes');
}

// The server-wide request cap rejects one message and keeps the socket; throttled guesses do not hold its slots.
async function testWebSocketCapRejectsMessageNotSocket() {
    const WebSocket = require('ws');
    const Controller = require('../server/controllers/WebSocketController');
    const controller = Object.assign(Object.create(Controller.prototype), {config: {}, activeRequests: 0,
        webAccess: {hasAccess: async token => token === 'open', isActiveToken: () => true, newToken: () => 'salt'}});
    let release;
    const gate = new Promise(resolve => release = resolve);
    controller.test = async(req, ws) => {
        if (req.hold)
            await gate;
        controller.send({ok: true}, req, ws);
    };
    const server = new WebSocket.Server({port: 0, host: '127.0.0.1'});
    server.on('connection', (socket, req) => {
        socket.req = req;
        socket.on('message', raw => controller.onMessage(socket, raw.toString()));
    });
    await new Promise(resolve => server.once('listening', resolve));
    const sockets = [];
    const open = async() => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
        sockets.push(socket);
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        return socket;
    };
    const answer = (socket, requestId, params) => new Promise(resolve => {
        const receive = raw => {
            const message = JSON.parse(raw);
            if (message.requestId === requestId && !message._rok) {
                socket.off('message', receive);
                resolve(message);
            }
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({requestId, action: 'test', ...params}));
    });
    try {
        const reader = await open();
        //поток неверных токенов: 8 соединений по 8 запросов ждут задержку, но общий лимит свободен
        const guesses = [];
        for (let i = 0; i < 8; i++) {
            const socket = await open();
            for (let j = 0; j < 8; j++)
                guesses.push(answer(socket, j + 1, {accessToken: 'wrong'}));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(controller.activeRequests, 0, 'Throttled guesses hold no server-wide slot');
        assert.strictEqual((await answer(reader, 1, {accessToken: 'open'})).ok, true);
        assert.ok((await Promise.all(guesses)).every(message => message.error === 'need_access_token'));

        const held = [];
        for (let i = 0; i < 8; i++) {
            const socket = await open();
            for (let j = 0; j < 8; j++)
                held.push(answer(socket, j + 1, {accessToken: 'open', hold: true}));
        }
        while (controller.activeRequests < 64)
            await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual((await answer(reader, 2, {accessToken: 'open'})).error, 'too_many_requests');
        assert.strictEqual(reader.readyState, WebSocket.OPEN, 'The socket stays open');
        release();
        await Promise.all(held);
        assert.strictEqual((await answer(reader, 3, {accessToken: 'open'})).ok, true);
    } finally {
        release();
        for (const socket of sockets)
            socket.terminate();
        await new Promise(resolve => server.close(resolve));
    }
}

// Query logging must not write passwords and tokens; unknown actions share one metric label.
async function testWebSocketLogHidesSecretsAndBoundsMetrics() {
    const Controller = require('../server/controllers/WebSocketController');
    const runtimeMetrics = require('../server/core/RuntimeMetrics');
    const logger = new (require('../server/core/AppLogger'))().logger;
    const config = {logQueries: true};
    const controller = Object.assign(Object.create(Controller.prototype), {config, webAccess: {hasAccess: async() => true}, activeRequests: 0});
    controller.test = async(req, ws) => controller.send({ok: true, profileAccessToken: 'OUT_SECRET'}, req, ws);
    const ws = {readyState: 1, req: {headers: {}}, send() {}};
    const lines = [];
    const capture = {log: (type, message) => lines.push(message)};
    logger.handlers.push(capture);
    try {
        await controller.processMessage(ws, JSON.stringify({action: 'test', password: 'IN_SECRET', accessToken: 'IN_SECRET',
            profile: {password: 'IN_SECRET'}, csrfToken: 'IN_SECRET'}));
        await controller.processMessage(ws, JSON.stringify({action: 'random-action-name'}));
    } finally {
        logger.handlers.splice(logger.handlers.indexOf(capture), 1);
    }
    assert.ok(lines.some(line => line.includes('WebSocket-IN')) && lines.some(line => line.includes('WebSocket-OUT')));
    assert.ok(!lines.some(line => line.includes('_SECRET')), lines.join(''));
    const labels = [...runtimeMetrics.actionStats.keys()];
    assert.ok(labels.includes('unknown') && !labels.includes('random-action-name'), labels.join());
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
    testServerDetailsStayPrivate, testOpdsEscapesLibraryText, testLoginLimiterKeysIpv6PrefixAndEvictsOldest, testWebSocketCapRejectsMessageNotSocket, testAtomicWriteSyncsDirectory, testMetricsReuseDirectorySizes, testOpdsQueryValuesAreStrings,
    testWebSocketConnectionsCappedPerIp, testCoverCacheWriteIsAtomic, testRootPathRewriteAtExtraction, testWebSocketLogHidesSecretsAndBoundsMetrics,
    testAccessPasswordLimitBlocksCorrectGuess, testUnusedAccessTokensAreCapped, testWriteActionsNeedCsrf, testBookByUidStatusAndHiddenPaths, testBookRouteRejectsTraversal,
    testConversionErrorHidesConverterOutput, testBookCacheErrorIsNotServedRaw, testProxmoxInstallerKeepsForeignAppRoot, testDialogsEscapeMessages, testRepeatedPasswordCheckSkipsScrypt, testLibraryHtmlIsCleaned,
    testStoreLoadCacheStaysCurrent, testStoreReadErrorKeepsData, testAdminGetsRandomPasswordByDefault, testConcurrentSecretKeyCreation,
    testConcurrentStoreMutations, testAtomicConfigSave, testSessionLifetimeAndMalformedCookies, testProfileCredentialChangesRevokeSessions,
    testDownloaderClosesFailedTransfers, testDownloaderVerifiesTlsCertificates, testHugePngIsRejectedBeforeDecoding, testGunzipBufferIsBounded, testRemoteLibVerifiesTlsCertificates];
