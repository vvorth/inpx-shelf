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
const {ApiTestClient, sessionCookie, apiController, apiApp, listen, fakeResponse, sampleParams, sampleUid} = require('./api-test-client');

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
    for (const pathname of ['/health', '/ready', '/metrics', '/app.js'])
        middleware({path: pathname, headers: {}, socket: {}}, response, () => {});
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
    assert.match(cookie, /^inpx_web_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    assert.match(headers['Set-Cookie'], /; Secure$/);
    assert.deepStrictEqual(Object.keys(security.getSession({headers: {cookie}})), ['sid', 'uid', 'createdAt', 'updatedAt']);

    const now = Date.now();
    const valid = fields => !!security.getSession({headers: {cookie: sessionCookie(security, 'alice', fields).cookie}});
    assert.strictEqual(valid({}), true);
    assert.strictEqual(valid({updatedAt: now - lifetime.idleMs - 1}), false, '7 days idle');
    assert.strictEqual(valid({createdAt: now - lifetime.maxAgeMs - 1, updatedAt: now}), false, '30 days after the login');
    assert.strictEqual(valid({updatedAt: 'now'}), false);

    //подпись закрывает весь payload: другой uid с прежней подписью не проходит
    const [body, signature] = sessionCookie(security, 'bob').cookie.split('=')[1].split('.');
    const forged = Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body, 'base64url')), uid: 'admin'})).toString('base64url');
    assert.strictEqual(security.getSession({headers: {cookie: `inpx_web_session=${forged}.${signature}`}}), null, 'Tampered uid');
    const other = new Security({});
    other.secret = 'other-secret';
    assert.strictEqual(other.getSession({headers: {cookie: sessionCookie(security, 'bob').cookie}}), null, 'Another session-secret');

    assert.deepStrictEqual(security.parseCookies('bad=%ZZ; good=value'), {good: 'value'});
    assert.strictEqual(security.unpackSession(`id.${'я'.repeat(64)}`), null);
    assert.strictEqual(security.unpackSession(`${Buffer.from('not json').toString('base64url')}.${security.sign(Buffer.from('not json').toString('base64url'))}`), null);
    assert.strictEqual(security.hasValidCsrf({headers: {}}, 'я'.repeat(64)), false);
}

// The cookie is issued again (same sid, uid and createdAt, updatedAt = now) once it is an hour old, not before.
async function testIdleSessionReissue() {
    const security = new Security({});
    security.secret = 'test-secret';
    const middleware = security.middleware();
    const hour = 60*60*1000;
    const touched = (age) => {
        const {session, cookie} = sessionCookie(security, 'alice', {updatedAt: Date.now() - age});
        const response = fakeResponse();
        middleware({path: '/app.js', headers: {cookie}, socket: {}}, response, () => {});
        const issued = response.getHeader('set-cookie');
        return {session, issued: issued && security.getSession({headers: {cookie: issued.split(';')[0]}})};
    };
    assert.strictEqual(touched(hour - 60*1000).issued, undefined, 'Not before an hour');
    const {session, issued} = touched(hour + 1000);
    assert.deepStrictEqual([issued.sid, issued.uid, issued.createdAt], [session.sid, session.uid, session.createdAt]);
    assert.ok(Date.now() - issued.updatedAt < 1000);
}

// A password or login change ends the profile's sessions (sessionsValidAfter), a name change does not; so does deleting it.
async function testProfileCredentialChangesRevokeSessions() {
    await temporary(async(dataDir) => {
        const Worker = require('../server/core/WebWorker');
        const worker = Object.create(Worker.prototype);
        worker.checkMyState = () => {};
        worker.readingListStore = new ReadingListStore({dataDir});
        const security = new Security({dataDir});
        await security.init();
        const access = new (require('../server/core/ProfileAccess'))({}, worker, security);
        const login = async(name, password) => {
            const result = await worker.loginUserProfile(name, password);
            const response = fakeResponse();
            security.startSession({headers: {}}, response, result.userId, result.sessionsValidAfter);
            return response.getHeader('set-cookie').split(';')[0];
        };
        const signedIn = async cookie => ((await access.resolve({headers: {cookie}})) || {user: {}}).user.id || '';
        const user = await worker.readingListStore.createUser({name: 'Reader', login: 'reader',
            passwordHash: require('../server/core/ProfilePassword').legacy('reader', 'old')});
        await assert.rejects(worker.updateUserProfile(user.id, {login: 'renamed'}), /пароль заново/);
        const first = await login('reader', 'old');
        await worker.updateUserProfile(user.id, {login: 'reader', name: 'Changed name'});
        assert.strictEqual(await signedIn(first), user.id);
        assert.match((await worker.readingListStore.getUser(user.id)).passwordHash, /^scrypt:v1:/);
        await worker.updateUserProfile(user.id, {passwordHash: await worker.hashProfilePassword('reader', 'new-password')});
        assert.strictEqual(await signedIn(first), '');
        await assert.rejects(worker.loginUserProfile('reader', 'old'), /Неверный/);
        const current = await login('reader', 'new-password');
        assert.strictEqual(await signedIn(current), user.id, 'A login right after the change');
        await worker.updateUserProfile(user.id, {login: 'renamed'});
        assert.strictEqual(await signedIn(current), '');
        const renamed = await login('renamed', 'new-password');
        //сессия, созданная до sessionsValidAfter: подпись верна, но профиль её не принимает
        const older = (await worker.readingListStore.getUser(user.id)).sessionsValidAfter - 1;
        assert.strictEqual(await signedIn(sessionCookie(security, user.id, {createdAt: older, updatedAt: Date.now()}).cookie), '');

        const deleted = await login('renamed', 'new-password');
        assert.strictEqual(await signedIn(renamed), user.id);
        await worker.deleteUserProfile(user.id);
        assert.strictEqual(await signedIn(deleted), '');
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

// The web app is extracted next to public/ and renamed into place: an old or half-extracted copy is never served.
async function testWebAppExtractionIsAtomic() {
    await temporary(async(dir) => {
        const appDir = require('../build/appdir');
        const zip = new (require('yazl').ZipFile)();
        const chunks = [];
        const done = new Promise((resolve, reject) => {
            zip.outputStream.on('data', chunk => chunks.push(chunk));
            zip.outputStream.on('end', resolve);
            zip.outputStream.on('error', reject);
        });
        zip.addBuffer(Buffer.from(`<script src="/${appDir}/app.js"></script>`), 'index.html');
        zip.addBuffer(Buffer.from('console.log(1);'.repeat(100)), `${appDir}/app.js`);
        zip.end();
        await done;
        const webApp = {data: Buffer.concat(chunks).toString('base64')};
        const data = path.join(dir, 'data');
        const config = {version: 'test', rootPathStatic: '/root', publicDir: path.join(data, 'public'), tempDir: path.join(dir, 'tmp')};
        await fs.ensureDir(config.tempDir);
        await fs.outputFile(path.join(config.publicDir, 'version.txt'), 'old');
        await fs.outputFile(path.join(config.publicDir, 'stale.js'), 'old');
        // An extraction interrupted long ago is removed; a recent one may belong to another running instance.
        const leftover = path.join(data, 'public.0123abcd.tmp');
        const recent = path.join(data, 'public.4567cdef.tmp');
        await fs.outputFile(path.join(leftover, 'index.html'), 'half');
        await fs.outputFile(path.join(recent, 'index.html'), 'half');
        const old = new Date(Date.now() - 2*60*60*1000);
        await fs.utimes(leftover, old, old);
        await fs.ensureDir(path.join(data, 'public-files'));

        const createWebApp = require('../server/createWebApp');
        await createWebApp(config, webApp);
        assert.deepStrictEqual((await fs.readdir(data)).sort(), ['public', 'public-files', 'public.4567cdef.tmp']);
        const files = (await fs.readdir(config.publicDir)).filter(name => !/\.(br|gz)$/.test(name));
        assert.deepStrictEqual(files.sort(), [appDir, 'index.html', 'version.txt'], 'Files of the old copy are gone');
        assert.strictEqual(await fs.readFile(path.join(config.publicDir, 'index.html'), 'utf8'), `<script src="/root/${appDir}/app.js"></script>`);
        assert.ok(await fs.pathExists(path.join(config.publicDir, appDir, 'app.js.gz')), 'Precompressed in place before the rename');
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);

        // The same version is not extracted again.
        await fs.outputFile(path.join(config.publicDir, 'marker'), '');
        await createWebApp(config, webApp);
        assert.ok(await fs.pathExists(path.join(config.publicDir, 'marker')));

        // A failed extraction leaves the working copy and no temporary files.
        await assert.rejects(createWebApp(config, {data: Buffer.from('not a zip').toString('base64')}));
        assert.ok(await fs.pathExists(path.join(config.publicDir, 'marker')));
        assert.deepStrictEqual((await fs.readdir(data)).sort(), ['public', 'public-files', 'public.4567cdef.tmp']);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), []);
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

// Токен метрик подбирается как пароль: неверные токены упираются в лимит (429), верный токен и запросы без токена - нет.
async function testMetricsTokenRateLimit() {
    const worker = {config: {}, adminEvents: [], catalogSearch: {file: 'library.sqlite'}, getIndexStatus: async() => ({ready: true, state: 'normal'}),
        dirSize: async() => ({size: 1, files: 1})};
    const config = {metricsEnabled: true, metricsToken: 'metrics-fixture', server: {}, loginRateLimitMaxAttempts: 3};
    const security = new Security(config);
    const app = require('express')();
    require('../server/core/HealthRoutes')(app, config, worker, security, {getOnlineMetrics: () => ({clients: 0, users: 0, anonymousClients: 0})});
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const get = (url, token) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {headers: token ? {authorization: `Bearer ${token}`} : {}});
    try {
        for (let i = 0; i < 5; i++)
            assert.strictEqual((await get('/metrics')).status, 401, 'No token is not an attempt');
        assert.strictEqual(security.loginAttempts.size, 0);
        for (let i = 0; i < 3; i++)
            assert.strictEqual((await get('/metrics', `guess-${i}`)).status, 401);
        const blocked = await get('/metrics', 'guess-3');
        assert.strictEqual(blocked.status, 429);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
        assert.strictEqual((await get('/metrics', 'metrics-fixture')).status, 429, 'Blocked address, even with the right token');
        assert.strictEqual((await get('/api/index-status', 'guess-4')).status, 429);
        assert.strictEqual((await get('/api/index-status')).status, 200, 'Health checks without a token stay open');
        assert.ok(security.getLoginMetrics().attempts.some(row => row.labels.kind === 'metrics' && row.labels.result === 'failure' && row.value === 3));
        assert.ok(security.getLoginMetrics().attempts.some(row => row.labels.kind === 'metrics' && row.labels.result === 'blocked' && row.value >= 1));

        security.loginAttempts.clear();
        assert.strictEqual((await get('/metrics', 'metrics-fixture')).status, 200);
        assert.strictEqual((await get('/metrics', 'guess')).status, 401);
        assert.strictEqual((await get('/metrics', 'metrics-fixture')).status, 200, 'Right token still works under the limit');
        assert.strictEqual(security.loginAttempts.get('metrics:127.0.0.1').count, 1, 'One failure per request');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

// X-Forwarded-Proto: https от любого клиента добавляет Secure к cookie, но не включает HSTS и не делает его прокси доверенным.
async function testCookieSecureFromForwardedProto() {
    const security = new Security({trustProxy: false});
    const plain = {headers: {}, socket: {}};
    const forwarded = {headers: {'x-forwarded-proto': 'HTTPS'}, socket: {remoteAddress: '203.0.113.7'}};
    assert.doesNotMatch(security.cookieOptions(plain), /Secure/);
    assert.doesNotMatch(security.cookieOptions({headers: {'x-forwarded-proto': 'http'}, socket: {}}), /Secure/);
    assert.match(security.cookieOptions(forwarded), /; Secure$/);
    assert.strictEqual(security.isSecureRequest(forwarded), false, 'Nothing else follows an untrusted header');
    const headers = {};
    security.applySecurityHeaders(forwarded, {setHeader: (name, value) => { headers[name] = value; }});
    assert.strictEqual(headers['Strict-Transport-Security'], undefined);
    const trusted = new Security({trustProxy: true, trustedProxyCidrs: ['2001:db8::/32']});
    const viaProxy = {headers: {'x-forwarded-proto': 'https'}, socket: {remoteAddress: '2001:db8::1'}};
    assert.match(trusted.cookieOptions(viaProxy), /; Secure$/);
    assert.strictEqual(trusted.isSecureRequest(viaProxy), true);
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

// Windows: a target held by an indexer fails the rename for a moment; the write retries instead of failing.
async function testAtomicWriteRetriesBusyRename() {
    await temporary(async(dir) => {
        const {writeFileAtomic} = require('../server/core/FilePersistence');
        const rename = fs.rename;
        let calls = 0;
        fs.rename = async(...args) => {
            if (++calls <= 2)
                throw Object.assign(new Error('operation not permitted'), {code: 'EPERM'});
            return rename(...args);
        };
        try {
            await writeFileAtomic(path.join(dir, 'data.json'), 'saved');
            assert.strictEqual(calls, 3);
            fs.rename = async() => {
                throw Object.assign(new Error('no space'), {code: 'ENOSPC'});
            };
            await assert.rejects(writeFileAtomic(path.join(dir, 'data.json'), 'lost'), {code: 'ENOSPC'}, 'Other errors are not retried');
        } finally {
            fs.rename = rename;
        }
        assert.strictEqual(await fs.readFile(path.join(dir, 'data.json'), 'utf8'), 'saved');
        assert.deepStrictEqual(await fs.readdir(dir), ['data.json'], 'No temporary file is left');
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

// A failed safety copy of a broken store must not end with the defaults written over it.
async function testBrokenStoreWithoutCopyIsNotOverwritten() {
    await temporary(async(dataDir) => {
        const KoboStore = require('../server/core/kobo/KoboStore');
        const stores = [new ReadingListStore({dataDir, adminPassword: 'fixture'}), new KoboStore({dataDir})];
        const copy = fs.copy;
        for (const store of stores) {
            await fs.outputFile(store.file, '{broken');
            fs.copy = async() => { throw Object.assign(new Error('ENOSPC: no space left on device'), {code: 'ENOSPC'}); };
            try {
                await assert.rejects(store.load(), /ENOSPC/);
            } finally {
                fs.copy = copy;
            }
            assert.strictEqual(await fs.readFile(store.file, 'utf8'), '{broken', `${path.basename(store.file)} must stay as it is`);
        }
    });
}

async function testBackupsKeepNewestTen() {
    await temporary(async(dir) => {
        const WebWorker = require('../server/core/WebWorker');
        const config = {dataDir: dir, configFile: path.join(dir, 'config.json'), name: 'inpx-shelf', version: 'test'};
        const worker = Object.assign(Object.create(WebWorker.prototype), {config, checkMyState() {}, requireAdmin: async() => true,
            catalogSearch: {ready: false},
            readingListStore: new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin'})});
        await fs.outputJson(config.configFile, {opds: {}});
        const backups = path.join(dir, 'backups');
        const old = [...Array(12).keys()].map(i => `inpx-shelf-backup-2020-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-aaaa.zip`);
        const staleTmp = 'inpx-shelf-backup-2020-01-01T00-00-00-000Z-aaaa.zip.tmp';
        const runningTmp = 'inpx-shelf-backup-2020-01-02T00-00-00-000Z-bbbb.zip.tmp';
        for (const name of [...old, staleTmp, runningTmp, 'notes.zip', 'inpx-shelf-author-names-2020-01-01.zip'])
            await fs.outputFile(path.join(backups, name), 'x');
        //.tmp старше суток - оборванный, свежий может писать параллельный бэкап
        const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000);
        await fs.utimes(path.join(backups, staleTmp), twoDaysAgo, twoDaysAgo);
        const {fileName} = await worker.createAdminBackup('admin', 'token');
        const left = (await fs.readdir(backups)).sort();
        assert.deepStrictEqual(left, ['inpx-shelf-author-names-2020-01-01.zip', fileName, 'notes.zip', runningTmp, ...old.slice(3)].sort(),
            'the newest 10 of this kind stay, old ones and the stale .tmp go, other files are not touched');
    });
}

async function testWikidataDownloadWaitsForFileLock() {
    await temporary(async(dir) => {
        const AuthorNames = require('../server/core/search/AuthorNames');
        const {withFileTransaction} = require('../server/core/FilePersistence');
        const names = new AuthorNames({dataDir: dir, version: 'test'}, async(query) => ({results: {bindings:
            (query.includes('wd:Q36180') && /OFFSET 0/.test(query) ? [{item: {value: 'Q1'}, ru: {value: 'Айзек Азимов'}, en: {value: 'Isaac Asimov'}}] : [])}}));
        let release;
        const held = withFileTransaction(names.file, () => new Promise(resolve => { release = resolve; }));
        const download = names.download();
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.strictEqual(await fs.pathExists(names.file), false, 'a restore holding the lock must not be overwritten');
        release();
        await held;
        await download;
        assert.deepStrictEqual((await fs.readJson(names.file)).entries, [['Айзек Азимов', 'Isaac Asimov']]);
        assert.deepStrictEqual(await fs.readdir(dir), ['author-names.json'], 'no temporary files are left');
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
        profileToken: userId => ({userId}),
        readingListStore: {load: async() => ({users: [{id: 'admin', isAdmin: true, sessionsValidAfter: 0}, {id: 'reader', sessionsValidAfter: 0}]})},
        requireAdmin: async(userId) => { if (userId !== 'admin') throw new Error('not admin'); }};
        for (const name of ['abcdef.d.json', 'abcdef.i.json', 'abcdef.dev'])
            await fs.outputFile(path.join(config.bookDir, name), JSON.stringify({sourceLibDir: config.libDir}));
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
            for (const uid of ['', 'reader'])
                assert.strictEqual((await (await get('/api/index-status', {cookie: sessionCookie(security, uid).cookie})).json()).inpxInfo, undefined, uid);
            const cookie = sessionCookie(security, 'admin').cookie;
            assert.strictEqual((await (await get('/api/index-status', {cookie})).json()).inpxInfo.collection, 'Private collection');
            assert.strictEqual((await get('/book/abcdef.d.json')).status, 401, 'No anonymous books');
            for (const name of ['abcdef.d.json', 'abcdef.i.json', 'abcdef.I.JSON', 'abcdef.dev', 'abcdef%2Ei.json'])
                assert.strictEqual((await get(`/book/${name}`, {cookie})).status, 404, name);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }

        const controller = apiController({config, security, profileAccess: null,
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

// Book records from a real library DB reach clients without the library folder: search, book page, book info
// and its cache file, author and series lists, reading lists.
async function testBookRecordsCarryNoServerPaths() {
    await temporary(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const CatalogSearch = require('../server/core/search/CatalogSearch');
        const libDir = path.join(dir, 'private-library');
        const config = {dataDir: dir, libDir, librarySources: [{id: 'main', name: 'Main', libDir}], rootPathStatic: '', bookPathStatic: '/book',
            bookDir: path.join(dir, 'book'), publicFilesDir: dir, tempDir: dir, server: {ready: true}, branch: 'production'};
        const index = new CatalogIndex();
        index.beginBuild(path.join(dir, 'library.sqlite'), [], [{id: 'main', name: 'Main', libDir}]);
        index.insertBooks([{_uid: sampleUid, title: 'Тайная книга', author: 'Автор Один', series: 'Серия', serno: 1, genre: 'sf', lang: 'ru', ext: 'fb2',
            date: '2026-01-01', sourceId: 'main', folder: 'a.zip', file: '1', libid: '1'}]);
        index.finishBuild({});
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        Object.assign(worker, {config, checkMyState: () => true, stateStore: {getBookFiles: () => []},
            readingListStore: new ReadingListStore({dataDir: dir}), fb2Helper: new (require('../server/core/fb2/Fb2Helper'))(),
            requireAuthorizedUser: async() => ({id: 'default'}), dbConfig: async() => ({inpxHash: 'h'})});
        worker.resetLibraryAssetCaches();
        worker.getBookLink = async() => {
            await fs.outputFile(path.join(config.bookDir, 'hash'), require('zlib').gzipSync('<FictionBook><description><title-info>' +
                '<book-title>Тайная книга</book-title></title-info></description><body><section><p>Text</p></section></body></FictionBook>'));
            return {link: '/book/hash', size: 10};
        };
        worker.catalogSearch = new CatalogSearch(config, worker);
        await worker.catalogSearch.openIndex(worker.catalogSearch.getThread());
        worker.catalogSearch.ready = true;
        const list = await worker.readingListStore.createList('default', 'Список');
        await worker.readingListStore.addBooks('default', list.id, [sampleUid]);
        const security = new Security(config);
        security.secret = 'test-secret';
        const controller = apiController({config, security, profileAccess: null, webWorker: worker});
        const api = await listen(apiApp({config, security, controller, health: false}));
        try {
            const client = ApiTestClient.forSession(api.base, security);
            for (const [action, params] of [['catalog-search', {q: 'тайная'}], ['catalog-suggest', {q: 'тайная'}], ['get-book', {bookUid: sampleUid}],
                ['get-book-info', {bookUid: sampleUid}], ['get-author-book-list', {author: 'Автор Один'}], ['get-series-book-list', {series: 'Серия'}],
                ['get-reading-list', {listId: list.id}]]) {
                const response = await client.call(action, params);
                assert.strictEqual(response.status, 200, `${action}: ${response.text}`);
                assert.ok(response.text.includes('Тайная книга'), `${action}: ${response.text}`);
                assert.ok(!response.text.includes(dir) && !response.text.includes('sourceLibDir'), `${action}: ${response.text}`);
            }
            const cached = await fs.readFile(path.join(config.bookDir, 'hash.i.json'), 'utf8');
            assert.ok(cached.includes('Тайная книга') && !cached.includes(dir), cached);
        } finally {
            await api.close();
            await worker.catalogSearch.close();
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

// OPDS follows the library: after an INPX swap the genre names and the collection title change without a restart.
async function testOpdsGenresAndTitleFollowLibrary() {
    const page = name => Object.assign(Object.create(require(`../server/core/opds/${name}`).prototype),
        {config: {opdsRoot: '/opds', bookPathStatic: '/book'}, opdsRoot: '/opds', rootTag: 'feed', id: name});
    const tree = {genreTree: [{id: 1, name: 'Section', value: [{value: 'zz_custom', name: 'Old genre'}]}]};
    let collection = 'Old library\nrest';
    const webWorker = {getGenreTree: async() => tree, dbConfig: async() => ({inpxInfo: {collection}}), getOpdsUsers: async() => []};
    const genre = page('GenrePage');
    genre.webWorker = webWorker;
    const genreFeed = () => genre.body({query: {from: 'author', section: 'Section'}, originalUrl: '/opds/genre'});
    const root = page('RootPage');
    root.webWorker = webWorker;
    root.authorPage = root.seriesPage = root.titlePage = root.genrePage = {myEntry: () => ({id: 'x', title: 'x'})};
    const rootFeed = () => root.body({query: {}, originalUrl: '/opds'});
    assert.ok((await genreFeed()).includes('Old genre'));
    assert.ok((await rootFeed()).includes('Old library'));
    collection = 'New library';
    tree.genreTree = [{id: 1, name: 'Section', value: [{value: 'zz_custom', name: 'New genre'}]}];
    assert.ok((await genreFeed()).includes('New genre'), 'The genre tree is read for every request');
    assert.ok((await rootFeed()).includes('New library'), 'The collection title is read for every request');
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

// A signed-in browser session survives a restart: the cookie is signed with session-secret and the server keeps nothing.
// The CSRF token is computed from the sid: the same after a restart, another for another sid. A new session-secret signs everyone out.
async function testSignedInSessionsSurviveRestart() {
    await temporary(async(dir) => {
        const WebWorker = require('../server/core/WebWorker');
        const store = new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        const alice = await store.createUser({name: 'Alice', login: 'alice', passwordHash: 'scrypt:fixture'});
        const start = async() => {
            const security = new Security({dataDir: dir});
            await security.init();
            const worker = Object.assign(Object.create(WebWorker.prototype), {readingListStore: store});
            return {security, access: new (require('../server/core/ProfileAccess'))({}, worker, security)};
        };
        const first = await start();
        const response = fakeResponse();
        first.security.startSession({headers: {}}, response, alice.id, alice.sessionsValidAfter);
        const cookie = response.getHeader('set-cookie').split(';')[0];
        const csrfToken = first.security.getCsrfToken({headers: {cookie}});

        const second = await start();
        assert.strictEqual((await second.access.resolve({headers: {cookie}})).user.id, alice.id);
        assert.strictEqual(second.security.getCsrfToken({headers: {cookie}}), csrfToken, 'The CSRF token after a restart');
        assert.notStrictEqual(second.security.getCsrfToken({headers: {cookie: sessionCookie(second.security, alice.id).cookie}}), csrfToken,
            'Another sid, another CSRF token');
        assert.ok(!(await fs.pathExists(path.join(dir, 'state.sqlite'))), 'Nothing is written for a session');

        await fs.remove(path.join(dir, 'session-secret'));
        assert.strictEqual(await (await start()).access.resolve({headers: {cookie}}), null, 'A new session-secret');
    });
}

// Сохранённые входы в браузере не переживают ни полное восстановление бэкапа, ни сброс пароля администратора
async function testRestoreAndAdminResetEndSavedLogins() {
    await temporary(async(dir) => {
        const WebWorker = require('../server/core/WebWorker');
        const config = {dataDir: dir, tempDir: path.join(dir, 'tmp'), configFile: path.join(dir, 'config.json'),
            name: 'inpx-shelf', version: 'test', librarySources: [], opds: {}};
        const storeConfig = {dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'};
        const worker = Object.assign(Object.create(WebWorker.prototype), {config, checkMyState() {}, requireAdmin: async() => true,
            addAdminEvent() {}, readingListStore: new ReadingListStore(storeConfig)});
        const security = new Security({dataDir: dir});
        await security.init();
        const access = new (require('../server/core/ProfileAccess'))(config, worker, security);
        const signIn = async() => {
            const result = await worker.loginUserProfile('admin', 'admin-fixture');
            const response = fakeResponse();
            security.startSession({headers: {}}, response, result.userId, result.sessionsValidAfter);
            return response.getHeader('set-cookie').split(';')[0];
        };
        const signedIn = async cookie => !!(await access.resolve({headers: {cookie}}));

        let cookie = await signIn();
        assert.strictEqual(await signedIn(cookie), true);
        await new ReadingListStore(Object.assign({}, storeConfig, {resetAdminPassword: true})).load();
        assert.strictEqual(await signedIn(cookie), false, 'An admin password reset ends saved logins');

        //бэкап сделан после входа: его sessionsValidAfter старше cookie, а восстановление всё равно завершает вход
        cookie = await signIn();
        await fs.outputJson(config.configFile, {opds: {}});
        const backup = await worker.createAdminBackup('admin', 'token');
        await worker.importAdminBackup('admin', 'token', {file: path.join(dir, 'backups', backup.fileName)});
        assert.strictEqual(await signedIn(cookie), false, 'A full restore ends saved logins');
        assert.strictEqual(await signedIn(await signIn()), true, 'A new login works');
    });
}

// An admin save writes the patch over config.json's own values: env overrides, CLI values and resolved paths stay out.
async function testAdminSaveKeepsEnvOutOfConfigFile() {
    await temporary(async(dir) => {
        const ConfigManager = require('../server/config');
        const WebWorker = require('../server/core/WebWorker');
        const configFile = path.join(dir, 'config.json');
        await fs.outputJson(configFile, {guestAccess: false, opds: {user: 'reader', guestAccess: false}, server: {root: '/lib/'}});
        const manager = new ConfigManager();
        const state = {inited: manager.inited, _config: manager._config};
        const names = ['INPX_GUEST_ACCESS', 'INPX_OPDS_GUEST_ACCESS'];
        const previous = names.map(name => process.env[name]);
        names.forEach(name => { process.env[name] = 'true'; });
        try {
            const config = ConfigManager.applyEnvOverrides({dataDir: dir, configFile, tempDir: path.join(dir, 'tmp'),
                guestAccess: false, opds: {user: 'reader', guestAccess: false}, server: {root: '/lib', port: 9999}});
            const worker = Object.assign(Object.create(WebWorker.prototype), {config});
            //менеджер конфигурации - как после запуска: рабочий конфиг с env у него в памяти
            Object.assign(manager, {inited: true, _config: structuredClone(config)});
            await worker.saveRuntimeConfigPatch({bookCacheSize: 123});
            //patch opds собирается из рабочего opds, где guestAccess пришёл из env
            await worker.saveRuntimeConfigPatch({opds: worker.normalizeAdminOpdsPatch({user: 'other'})});
            assert.deepStrictEqual(await fs.readJson(configFile),
                {guestAccess: false, opds: {user: 'other', guestAccess: false}, server: {root: '/lib/'}, bookCacheSize: 123});
            assert.strictEqual(config.guestAccess, true);
            assert.deepStrictEqual(config.opds, {user: 'other', guestAccess: true});
            assert.strictEqual(config.bookCacheSize, 123);
        } finally {
            Object.assign(manager, state);
            names.forEach((name, i) => (previous[i] === undefined ? delete process.env[name] : (process.env[name] = previous[i])));
        }
    });
}

// A restore of a backup without remoteAccess ends the old tokens; the next save does not write them back.
// Library sources are resolved as at startup: LIBDIR stays in effect though config.json has no libDir.
async function testRestoreResetsKeysMissingFromBackup() {
    await temporary(async(dir) => {
        const manager = new (require('../server/config'))();
        const WebWorker = require('../server/core/WebWorker');
        const configFile = path.join(dir, 'config.json');
        const libDir = path.join(dir, 'library');
        await fs.outputFile(path.join(libDir, 'books.inpx'), '');
        const previousLibDir = process.env.LIBDIR;
        process.env.LIBDIR = libDir;
        const config = {dataDir: dir, tempDir: path.join(dir, 'tmp'), configFile, name: 'inpx-shelf', version: 'test', librarySources: [], opds: {}};
        await require('../server/core/LibrarySources').resolveLibrarySources(config);
        const worker = Object.assign(Object.create(WebWorker.prototype), {config,
            checkMyState() {}, requireAdmin: async() => true, addAdminEvent() {},
            readingListStore: new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin'})});
        await fs.outputJson(configFile, {opds: {}});
        const backup = await worker.createAdminBackup('admin', 'token');
        await worker.saveRuntimeConfigPatch({remoteAccess: [{id: 'old', hash: 'hash'}]});
        const defaults = manager.defaults;
        manager.defaults = {remoteAccess: [], libDir: '', inpx: '', librarySources: []};
        try {
            await worker.importAdminBackup('admin', 'token', {file: path.join(dir, 'backups', backup.fileName)});
        } finally {
            manager.defaults = defaults;
            (previousLibDir === undefined ? delete process.env.LIBDIR : (process.env.LIBDIR = previousLibDir));
        }
        assert.deepStrictEqual(config.remoteAccess, []);
        assert.strictEqual(config.libDir, libDir);
        assert.deepStrictEqual(config.librarySources.map(source => source.libDir), [libDir]);
        await worker.saveRuntimeConfigPatch({bookCacheSize: 123});
        assert.deepStrictEqual(await fs.readJson(configFile), {opds: {}, bookCacheSize: 123});
    });
}

// server.root "/lib/" becomes "/lib": "/lib//cover/by-uid" would skip the guard on "/lib/cover".
function testRootPathLosesTrailingSlash() {
    const index = require('fs').readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    const line = index.match(/config\.rootPathStatic = (.+);/);
    const rootPath = root => new Function('config', `return ${line[1]};`)({server: {root}});
    assert.strictEqual(rootPath('/lib/'), '/lib');
    assert.strictEqual(rootPath('/'), '');
    assert.strictEqual(rootPath(''), '');
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
            test: async() => ({message: 'inpx-shelf project is awesome'})}, handlers));
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
        const json = (url, body = '{}', headers = {}, method = 'POST') => send(method, url, {'content-type': 'application/json', 'x-csrf-token': api.csrfToken, ...headers}, body);

        //заголовок X-Inpx-Api не поставить ни ссылкой, ни формой, ни <img> с чужого сайта
        const bare = await ping({'x-inpx-api': null});
        assert.deepStrictEqual([bare.status, bare.body], [403, {error: 'Forbidden'}]);
        assert.strictEqual((await ping({'x-inpx-api': '0'})).status, 403);
        assert.strictEqual((await json('api/me/reader-preferences', '{}', {'x-inpx-api': null}, 'PATCH')).status, 403);
        assert.deepStrictEqual((await ping()).body, {message: 'inpx-shelf project is awesome'});
        for (const site of ['cross-site', 'same-site'])
            assert.strictEqual((await ping({'sec-fetch-site': site})).status, 403, site);
        for (const site of ['same-origin', 'none'])
            assert.strictEqual((await ping({'sec-fetch-site': site})).status, 200, site);
        for (const foreign of ['http://evil.example', 'null', `https://${new URL(origin).host}`])
            assert.strictEqual((await ping({origin: foreign})).status, 403, foreign);
        assert.strictEqual((await ping({origin})).status, 200);

        //POST, PUT, PATCH, DELETE - только с CSRF-токеном своей сессии; GET токена не требует
        const write = options => api.call('update-reader-preferences', {preferences: {fontSize: 20}}, options);
        for (const csrfToken of [null, '', 'x'.repeat(64), security.getCsrfToken({headers: {}})]) {
            const response = await write({csrfToken});
            assert.deepStrictEqual([response.status, response.body.error], [403, 'bad_csrf_token'], String(csrfToken));
        }
        assert.strictEqual(seen.length, 0);
        assert.deepStrictEqual((await write()).body, {ok: true});
        assert.deepStrictEqual(seen[0].preferences, {fontSize: 20});
        const search = await api.call('catalog-search', {q: 'x', limit: 5, hideCopies: true, filters: {lang: ['ru']}});
        assert.deepStrictEqual([search.status, search.body], [200, {q: 'x', limit: 5, hideCopies: true, filters: {lang: ['ru']}}], 'Typed query');
        for (const route of apiRoutes.routes.filter(item => item.method !== 'GET')) {
            const response = await api.call(route.action, sampleParams(route.action), {csrfToken: null, body: (route.upload ? '{}' : undefined)});
            assert.deepStrictEqual([response.status, response.body.error], [403, 'bad_csrf_token'], route.action);
        }

        //тело POST - JSON (файл - только у действий загрузки)
        for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream'])
            assert.strictEqual((await json('api/me/reader-preferences', '{}', {'content-type': type}, 'PATCH')).status, 415, type);
        assert.strictEqual((await json('api/me/reader-preferences', '{}', {'content-type': 'application/json; charset=utf-8'}, 'PATCH')).status, 200);
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
        const get = await send('GET', 'api/me/reader-preferences');
        assert.strictEqual(get.status, 405);
        assert.match(String(get.headers.get('allow')), /\bPATCH\b/);
        assert.strictEqual((await send('DELETE', 'api/ping')).status, 405);

        //параметры адреса - только объявленные в shared/apiRoutes.js, по одному разу и своего типа
        for (const query of ['q=x&zzz=1', 'q=a&q=b', 'limit=abc', 'limit=1.5', 'hideCopies=yes', 'filters=%7Bbroken', 'filters=1',
            'userId=admin', 'csrfToken=x'])
            assert.strictEqual((await send('GET', `api/catalog/search?${query}`)).status, 400, query);
        assert.strictEqual((await json('api/me/reader-preferences?preferences=1', '{}', {}, 'PATCH')).status, 400, 'A POST takes no query');
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
                profile: {password: 'IN_SECRET'}, preferences: {fontSize: 20}});
            assert.strictEqual(response.status, 200);
            await api.request('GET', 'api/random-action-name');
        } finally {
            logger.handlers.splice(logger.handlers.indexOf(capture), 1);
        }
        assert.ok(lines.some(line => line.includes('PATCH /me/reader-preferences')), lines.join('\n'));
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
    testSignedInSessionsSurviveRestart, testRestoreAndAdminResetEndSavedLogins,
    testServerDetailsStayPrivate, testBookRecordsCarryNoServerPaths, testOpdsEscapesLibraryText, testOpdsGenresAndTitleFollowLibrary, testLoginLimiterKeysIpv6PrefixAndEvictsOldest, testApiConcurrencyLimits, testAtomicWriteSyncsDirectory, testAtomicWriteRetriesBusyRename, testMetricsReuseDirectorySizes, testMetricsTokenRateLimit, testCookieSecureFromForwardedProto, testOpdsQueryValuesAreStrings,
    testApiRequestRules, testApiUnderRootPath, testRootPathLosesTrailingSlash, testAdminSaveKeepsEnvOutOfConfigFile, testRestoreResetsKeysMissingFromBackup, testExposedPathsListApi, testCoverCacheWriteIsAtomic, testRootPathRewriteAtExtraction, testWebAppExtractionIsAtomic,
    testApiLogHidesSecretsAndBoundsMetrics, testBookByUidStatusAndHiddenPaths, testBookRouteRejectsTraversal,
    testConversionErrorHidesConverterOutput, testBookCacheErrorIsNotServedRaw, testProxmoxInstallerKeepsForeignAppRoot, testDialogsEscapeMessages, testRepeatedPasswordCheckSkipsScrypt, testLibraryHtmlIsCleaned,
    testStoreLoadCacheStaysCurrent, testStoreReadErrorKeepsData, testBrokenStoreWithoutCopyIsNotOverwritten, testBackupsKeepNewestTen, testWikidataDownloadWaitsForFileLock, testAdminGetsRandomPasswordByDefault, testConcurrentSecretKeyCreation,
    testConcurrentStoreMutations, testAtomicConfigSave, testSessionLifetimeAndMalformedCookies, testIdleSessionReissue, testProfileCredentialChangesRevokeSessions,
    testDownloaderClosesFailedTransfers, testDownloaderVerifiesTlsCertificates, testHugePngIsRejectedBeforeDecoding, testGunzipBufferIsBounded, testRemoteLibVerifiesTlsCertificates];
