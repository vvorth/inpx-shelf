const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const Security = require('../server/core/Security');
const remoteAccess = require('../server/core/RemoteAccess');
const RemoteLib = require('../server/core/RemoteLib');

// Book uids as InpxParser makes them: base64 SHA-256 of the INPX line, "+" and "/" included.
const uid = n => require('crypto').createHash('sha256').update(`line ${n}`).digest('base64');
const urlUid = n => remoteAccess.uidToPath(uid(n));

// A main server with two libraries (a, b) and the /remote/ API; the token opens only b.
async function fixture(test) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-remote-'));
    let server;
    try {
        const token = remoteAccess.newToken();
        const source = id => ({id, name: id.toUpperCase(), inpx: path.join(dir, `${id}.inpx`), inpxFile: path.join(dir, `${id}.inpx`), libDir: path.join(dir, id), enabled: true});
        const config = {
            dataDir: dir, rootPathStatic: '', requireAuth: true, authMode: 'proxy', trustProxy: false,
            bookDir: path.join(dir, 'book'), coverDir: path.join(dir, 'cover'), publicFilesDir: dir,
            librarySources: [source('a'), source('b'), Object.assign(source('r'), {remote: {url: 'http://x', source: 'z', token: 't'}})],
            remoteAccess: [{id: '1', name: 'friend', hash: remoteAccess.hashToken(token), sources: ['b', 'r']}],
            loginRateLimitMaxAttempts: 3,
        };
        await fs.ensureDir(config.bookDir);
        await fs.writeFile(config.librarySources[1].inpxFile, 'inpx of b');
        // Book 1 is only in b; book 2 is in a and b, its DB row went to a (first library wins).
        const books = new Map([[uid(1), {_uid: uid(1), sourceId: 'b'}], [uid(2), {_uid: uid(2), sourceId: 'a'}],
            [uid(3), {_uid: uid(3), sourceId: 'a'}]]);
        const calls = {links: [], covers: []};
        const worker = {
            config,
            inpxHashCreator: {sourceHashes: new Map([['b', 'hash-b']])},
            getBookRecordsByUids: async uids => new Map(uids.filter(id => books.has(id)).map(id => [id, books.get(id)])),
            getBookLink: async(bookUid, sourceId) => {
                calls.links.push([bookUid, sourceId]);
                await fs.writeFile(path.join(config.bookDir, 'h1'), zlib.gzipSync(`book ${bookUid}`));
                return {link: '/book/h1'};
            },
            getBookCover: async book => {
                calls.covers.push(book);
                return {data: Buffer.from('png'), contentType: 'image/png'};
            },
        };
        const security = new Security(config);
        await security.init();
        const app = express();
        app.use(security.middleware());
        app.use(security.requiredAuthMiddleware());
        remoteAccess.init(app, config, worker, security);
        app.get('/protected', (req, res) => res.send('protected'));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        await test({dir, base, token, config, calls});
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await fs.remove(dir);
    }
}

async function testRemoteApiTokenAndSources() {
    await fixture(async({base, token, config}) => {
        const get = (suffix, headers = {}) => fetch(`${base}/remote${suffix}`, {headers});
        const auth = {authorization: `Bearer ${token}`};
        assert.strictEqual((await fetch(`${base}/protected`)).status, 403, 'SSO still guards the app');
        assert.strictEqual((await get('/sources')).status, 401);
        assert.strictEqual((await get('/sources', {authorization: 'Bearer wrong'})).status, 401);
        assert.ok(!JSON.stringify(config.remoteAccess).includes(token), 'only a hash of the token is stored');

        const list = await get('/sources', auth);
        assert.strictEqual(list.status, 200);
        // b only: a is not given to the token, r is a remote library of this server and is not shared further
        assert.deepStrictEqual(await list.json(), {sources: [{id: 'b', name: 'B'}]});
        for (const id of ['a', 'r', 'missing'])
            assert.strictEqual((await get(`/sources/${id}/inpx`, auth)).status, 404, id);
        assert.strictEqual((await get(`/sources/b/books/${urlUid(1)}`)).status, 401);

        // wrong tokens are limited per address like other logins
        await get('/sources', {authorization: 'Bearer wrong'});
        assert.strictEqual((await get('/sources', {authorization: 'Bearer wrong'})).status, 429);
    });
}

async function testRemoteApiInpxBooksAndCovers() {
    await fixture(async({dir, base, token, calls, config: mainConfig}) => {
        const auth = {authorization: `Bearer ${token}`};
        const inpx = await fetch(`${base}/remote/sources/b/inpx`, {headers: auth});
        assert.strictEqual(inpx.status, 200);
        assert.strictEqual(inpx.headers.get('etag'), '"hash-b"');
        assert.strictEqual(await inpx.text(), 'inpx of b');
        assert.strictEqual((await fetch(`${base}/remote/sources/b/inpx`, {headers: Object.assign({'if-none-match': '"hash-b"'}, auth)})).status, 304);

        // an INPX in S3 streams through, it is not read into memory
        const libraryFs = require('../server/core/LibraryFs');
        const {Readable} = require('stream');
        const client = libraryFs.s3.client;
        const reads = [];
        libraryFs.s3.client = {send: async command => {
            reads.push(command.constructor.name);
            return {Body: Readable.from([Buffer.from('inpx '), Buffer.from('from s3')])};
        }};
        const localInpx = mainConfig.librarySources[1].inpxFile;
        mainConfig.librarySources[1].inpxFile = 's3://bucket/b.inpx';
        try {
            assert.strictEqual(await (await fetch(`${base}/remote/sources/b/inpx`, {headers: auth})).text(), 'inpx from s3');
            assert.deepStrictEqual(reads, ['GetObjectCommand']);
        } finally {
            libraryFs.s3.client = client;
            mainConfig.librarySources[1].inpxFile = localInpx;
        }

        const book = await fetch(`${base}/remote/sources/b/books/${urlUid(1)}`, {headers: auth});
        assert.strictEqual(book.status, 200);
        assert.strictEqual(await book.text(), `book ${uid(1)}`);
        // book 2's row belongs to a: it is prepared from b's files
        assert.strictEqual((await fetch(`${base}/remote/sources/b/books/${urlUid(2)}`, {headers: auth})).status, 200);
        assert.deepStrictEqual(calls.links, [[uid(1), 'b'], [uid(2), 'b']]);
        assert.strictEqual((await fetch(`${base}/remote/sources/b/books/${urlUid(9)}`, {headers: auth})).status, 404);
        assert.strictEqual((await fetch(`${base}/remote/sources/b/books/not-a-uid`, {headers: auth})).status, 404);

        const cover = await fetch(`${base}/remote/sources/b/covers/${urlUid(2)}`, {headers: auth});
        assert.strictEqual(cover.status, 200);
        assert.strictEqual(cover.headers.get('content-type'), 'image/png');
        assert.strictEqual(calls.covers[0].sourceId, 'b');
        assert.strictEqual(require('../server/core/LibrarySources').getSourceLibDir(mainConfig, calls.covers[0].sourceId), path.join(dir, 'b'));
        assert.ok(!('sourceLibDir' in calls.covers[0]), 'records carry no server paths');

        // The connecting side: INPX is downloaded once, then 304; books and covers by uid.
        const local = path.join(dir, 'client');
        const config = {tempDir: path.join(local, 'tmp'), maxPayloadSize: 1};
        await fs.ensureDir(config.tempDir);
        assert.ok([1, 2, 3, 9].some(n => /[+/]/.test(uid(n))), 'the fixture covers uids with + and /');
        const remote = {url: `${base}/`, source: 'b', token};
        const lib = new RemoteLib(config);
        assert.deepStrictEqual(await lib.listSources(remote), [{id: 'b', name: 'B'}]);
        const source = {id: 'friend-b', inpxFile: path.join(local, 'remote', 'friend-b.inpx'), remote};
        assert.strictEqual(await lib.syncInpx(source), true);
        assert.strictEqual(await fs.readFile(source.inpxFile, 'utf8'), 'inpx of b');
        assert.strictEqual(await lib.syncInpx(source), false, 'unchanged INPX is not downloaded again');
        const file = await lib.downloadBook(remote, uid(1));
        assert.strictEqual(await fs.readFile(file, 'utf8'), `book ${uid(1)}`);
        assert.deepStrictEqual(await lib.getCover(remote, uid(1)), {data: Buffer.from('png'), contentType: 'image/png'});
        await assert.rejects(lib.downloadBook(remote, uid(9)), error => error.status === 404);
        await assert.rejects(lib.listSources(Object.assign({}, remote, {token: 'wrong'})), /HTTP 401/);
        await assert.rejects(lib.listSources({url: 'http://127.0.0.1:1', token}), /unavailable|недоступна/);
        assert.deepStrictEqual(await fs.readdir(config.tempDir), [file].map(item => path.basename(item)), 'failed downloads leave no temp files');
    });
}

async function testRemoteSourceConfig() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-remote-config-'));
    try {
        const {resolveLibrarySources, getIndexedLibrarySources} = require('../server/core/LibrarySources');
        await fs.ensureDir(path.join(dir, 'local'));
        await fs.writeFile(path.join(dir, 'local', 'local.inpx'), 'x');
        const config = {dataDir: dir, librarySources: [
            {id: 'friend', name: 'Friend', remote: {url: 'https://friend.example', source: 'flib', token: 'secret-token'}},
            {id: 'local', name: 'Local', inpx: path.join(dir, 'local', 'local.inpx'), libDir: path.join(dir, 'local')},
        ]};
        await resolveLibrarySources(config);
        const friend = config.librarySources[0];
        assert.strictEqual(friend.inpxFile, path.join(dir, 'remote', 'friend.inpx'));
        assert.ok(await fs.pathExists(friend.libDir), 'an empty folder of its own');
        assert.strictEqual(config.libDir, path.join(dir, 'local'), 'the default folder is a local library');
        assert.deepStrictEqual((await getIndexedLibrarySources(config)).map(item => item.id), ['local'], 'no INPX yet - not indexed');
        await fs.ensureDir(path.dirname(friend.inpxFile));
        await fs.writeFile(friend.inpxFile, 'y');
        assert.deepStrictEqual((await getIndexedLibrarySources(config)).map(item => item.id), ['friend', 'local']);

        // the token is encrypted in config.json
        const SecretStore = require('../server/core/SecretStore');
        const store = new SecretStore({dataDir: dir});
        const saved = await store.protectConfig({librarySources: config.librarySources});
        assert.ok(!JSON.stringify(saved).includes('secret-token'));
        assert.strictEqual((await store.unprotectConfig(saved)).config.librarySources[0].remote.token, 'secret-token');

        // the settings file leaves the token out; importing it keeps the current one
        const WebWorker = require('../server/core/WebWorker');
        const worker = Object.create(WebWorker.prototype);
        Object.assign(worker, {config, checkMyState: () => {}, requireAdmin: async() => true});
        const exported = await worker.exportAdminSettings();
        assert.ok(!JSON.stringify(exported).includes('secret-token'));
        assert.strictEqual(exported.settings.librarySources[0].remote.tokenSet, true);
        const patch = worker.normalizeImportedAdminSettings(exported);
        assert.strictEqual(patch.librarySources[0].remote.token, 'secret-token');
        assert.ok(!('tokenSet' in patch.librarySources[0].remote));
        // the admin page sends __KEEP__ for an unchanged token
        const normalized = worker.normalizeAdminLibrarySources([{id: 'friend', name: 'Friend', remote: {url: 'https://friend.example', source: 'flib', token: '__KEEP__'}}]);
        assert.strictEqual(normalized[0].remote.token, 'secret-token');
        assert.strictEqual(normalized[0].inpxFile, friend.inpxFile);
    } finally {
        await fs.remove(dir);
    }
}

async function testRemoteAccessAdmin() {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    const config = {librarySources: [{id: 'a', name: 'A', inpx: 'a.inpx', libDir: 'a'}, {id: 'r', name: 'R', remote: {url: 'x', source: 'y', token: 'z'}}], remoteAccess: []};
    const events = [];
    Object.assign(worker, {config, requireAdmin: async() => true, addAdminEvent: (...args) => events.push(args),
        saveRuntimeConfigPatch: async patch => Object.assign(config, patch)});
    const created = await worker.createRemoteAccess('', '', {name: ' friend ', sources: ['a', 'r', 'missing', 'a']});
    assert.ok(created.token.length >= 40);
    assert.deepStrictEqual(created.created.sources, ['a'], 'only local libraries of this server');
    assert.strictEqual(config.remoteAccess[0].name, 'friend');
    assert.strictEqual(remoteAccess.findToken(config, created.token).id, config.remoteAccess[0].id);
    assert.ok(!JSON.stringify(await worker.getRemoteAccess()).includes(config.remoteAccess[0].hash), 'the hash stays on the server');
    assert.deepStrictEqual((await worker.getRemoteAccess()).sources.map(item => item.id), ['a']);
    await worker.updateRemoteAccess('', '', {id: config.remoteAccess[0].id, name: 'friend', sources: []});
    assert.deepStrictEqual(config.remoteAccess[0].sources, []);
    await assert.rejects(worker.createRemoteAccess('', '', {name: ' '}));
    await worker.deleteRemoteAccess('', '', config.remoteAccess[0].id);
    assert.deepStrictEqual(config.remoteAccess, []);
    assert.strictEqual(remoteAccess.findToken(config, created.token), null);
}

// A remote book is downloaded for its description only on request; a cached one is described at once.
async function testRemoteBookInfoWaitsForRequest() {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    const links = [];
    let cached = [];
    Object.assign(worker, {
        config: {bookDir: os.tmpdir(), librarySources: [{id: 'friend', remote: {url: 'x', source: 'b', token: 't'}}, {id: 'local'}]},
        checkMyState: () => {},
        getBookRecordByUid: async bookUid => ({_uid: bookUid, title: 'Remote', sourceId: (bookUid === 'local-uid' ? 'local' : 'friend')}),
        stateStore: {getBookFiles: () => cached},
        readingListStore: {getMetadataOverrides: async() => ({})},
        getBookLink: async bookUid => {
            links.push(bookUid);
            throw new Error('stop here');
        },
    });
    const info = await worker.getBookInfo('remote-uid');
    assert.deepStrictEqual(info.bookInfo, {book: {_uid: 'remote-uid', title: 'Remote', sourceId: 'friend'}, remote: true, notFetched: true});
    assert.deepStrictEqual(links, []);
    await assert.rejects(worker.getBookInfo('remote-uid', {fetchRemote: true}), /stop here/);
    await assert.rejects(worker.getBookInfo('local-uid'), /stop here/, 'a local book is read as before');
    cached = [{hash: path.basename(os.tmpdir())}];
    worker.config.bookDir = path.dirname(os.tmpdir());
    await assert.rejects(worker.getBookInfo('remote-uid'), /stop here/, 'already downloaded');
    assert.deepStrictEqual(links, ['remote-uid', 'local-uid', 'remote-uid']);
}

// A remote answer that is not a book or an INPX (cover, listing) is read with a cap: a larger or endless
// body is dropped as soon as the cap is passed, the wrong type is refused before the body is read.
async function testRemoteSmallResponsesAreBounded() {
    const stats = {written: 0, closed: []};
    // an endless body: it stops only when the client drops the connection
    const endless = (res, type, head = '') => {
        res.writeHead(200, {'content-type': type});
        res.write(head);
        let stop;
        stats.closed.push(new Promise(resolve => {
            stop = resolve;
        }));
        const timer = setInterval(() => {
            if (res.writableLength < 1024*1024 && stats.written < 200*1024*1024) {
                stats.written += 256*1024;
                res.write(Buffer.alloc(256*1024, 'x'));
            }
        }, 1);
        res.on('close', () => {
            clearInterval(timer);
            stop();
        });
    };
    const png = Buffer.from('png');
    const server = http.createServer((req, res) => {
        const n = [1, 2, 3, 4, 5].find(i => req.url.endsWith(`/covers/${urlUid(i)}`));
        if (n === 1)
            return res.writeHead(200, {'content-type': 'image/png'}).end(png);
        if (n === 2) {// the declared size is over the cap: the body is never sent
            res.writeHead(200, {'content-type': 'image/png', 'content-length': 100*1024*1024});
            res.flushHeaders();
            stats.closed.push(new Promise(resolve => res.on('close', resolve)));
            return;
        }
        if (n === 3)
            return endless(res, 'image/png');
        if (n === 4)
            return endless(res, 'text/html');
        if (n === 5)
            return res.writeHead(200, {'content-type': 'image/png'}).end();
        if (req.url.endsWith('/remote/sources'))
            return endless(res, 'application/json', '{"sources":[');
        res.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const remote = {url: `http://127.0.0.1:${server.address().port}`, source: 'z', token: 't'};
        const lib = new RemoteLib({});
        const tooLarge = /too large|слишком большой/;
        assert.deepStrictEqual(await lib.getCover(remote, uid(1)), {data: png, contentType: 'image/png'});
        assert.strictEqual(await lib.getCover(remote, uid(5)), null, 'an empty image is no cover');

        await assert.rejects(lib.getCover(remote, uid(2)), tooLarge);
        await assert.rejects(lib.getCover(remote, uid(3)), tooLarge);
        await assert.rejects(lib.getCover(remote, uid(4)), /content type text\/html/);
        await assert.rejects(lib.listSources(remote), tooLarge);
        // every endless body was dropped by the client, long before it could be buffered
        await Promise.race([Promise.all(stats.closed), new Promise((resolve, reject) => setTimeout(() => reject(new Error('the client kept reading')), 5000))]);
        assert.ok(stats.written < 64*1024*1024, `the client read ${stats.written} bytes`);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

// Startup waits for the response headers only briefly; a slow body is not cut by that timeout.
async function testRemoteConnectTimeoutOnlyCoversHeaders() {
    const sockets = [];
    const blackHole = require('net').createServer(socket => sockets.push(socket));
    const slow = http.createServer((req, res) => {
        res.writeHead(200, {'content-type': 'text/plain'});
        res.flushHeaders();
        setTimeout(() => res.end('late body'), 400);
    });
    await Promise.all([blackHole, slow].map(item => new Promise(resolve => item.listen(0, '127.0.0.1', resolve))));
    try {
        const lib = new RemoteLib({});
        const started = Date.now();
        await assert.rejects(lib.request({url: `http://127.0.0.1:${blackHole.address().port}`, source: 'z'}, '', {}, 200), /unavailable|недоступна/);
        assert.ok(Date.now() - started < 3000, 'the silent host is given up on after the connect timeout');
        const response = await lib.request({url: `http://127.0.0.1:${slow.address().port}`, source: 'z'}, '', {}, 200);
        assert.strictEqual(await response.text(), 'late body');
    } finally {
        sockets.forEach(socket => socket.destroy());
        slow.closeAllConnections();
        await Promise.all([blackHole, slow].map(item => new Promise(resolve => item.close(resolve))));
    }
}

// First start: the remote INPX is fetched in the startup chain (after listen), and the library DB is built from it.
async function testRemoteInpxIsSyncedBeforeFirstIndexing() {
    await fixture(async({dir, base, token}) => {
        const WebWorker = require('../server/core/WebWorker');
        const inpxFile = path.join(dir, 'client', 'remote', 'friend-b.inpx');
        const source = {id: 'friend-b', inpxFile, enabled: true, remote: {url: base, source: 'b', token}};
        const config = {tempDir: path.join(dir, 'client', 'tmp'), maxPayloadSize: 1, librarySources: [source]};
        await fs.ensureDir(config.tempDir);
        const hashes = [];
        const worker = Object.create(WebWorker.prototype);
        Object.assign(worker, {
            config,
            remoteLib: new RemoteLib(config),
            catalogSearch: {ready: false},
            inpxHashCreator: {getHash: async() => ((await fs.pathExists(inpxFile)) ? 'with-remote-inpx' : 'no-inpx')},
            setMyState: () => {},
            logServerStats: () => {},
            removeLegacyDb: async() => {},
            trySyncListedBooks: async() => {},
        });
        worker.catalogSearch.ensure = async hash => {
            hashes.push(hash);
            worker.catalogSearch.ready = true;
            return true;
        };
        await worker.loadOrCreateDbOnce();
        assert.deepStrictEqual(hashes, ['with-remote-inpx']);
        assert.strictEqual(await fs.readFile(inpxFile, 'utf8'), 'inpx of b');
    });
}

module.exports = [
    testRemoteBookInfoWaitsForRequest,
    testRemoteApiTokenAndSources,
    testRemoteApiInpxBooksAndCovers,
    testRemoteSourceConfig,
    testRemoteAccessAdmin,
    testRemoteSmallResponsesAreBounded,
    testRemoteConnectTimeoutOnlyCoversHeaders,
    testRemoteInpxIsSyncedBeforeFirstIndexing,
];
