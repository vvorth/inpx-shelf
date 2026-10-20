const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const Security = require('../server/core/Security');
const ReadingListStore = require('../server/core/ReadingListStore');
const StateStore = require('../server/core/StateStore');
const kosync = require('../server/core/Kosync');

const md5 = value => crypto.createHash('md5').update(value).digest('hex');

// KOReader's "Progress sync" plugin against a real profile store and state.sqlite; no library needed.
async function fixture(config, test) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kosync-'));
    let server;
    const worker = {};
    try {
        config = Object.assign({dataDir: dir, rootPathStatic: '', kosyncEnabled: true,
            requireAuth: true, authMode: 'proxy', trustProxy: false}, config);
        Object.assign(worker, {
            config,
            readingListStore: new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'}),
            stateStore: new StateStore(config),
        });
        const security = new Security(config);
        await security.init();
        const app = express();
        app.use(security.middleware());
        app.use(security.requiredAuthMiddleware());
        kosync.init(app, config, worker, security);
        app.get('/protected', (req, res) => res.send('protected'));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = (suffix, password, init = {}) => fetch(`${base}/kosync${suffix}`, Object.assign({}, init, {
            headers: Object.assign({accept: 'application/vnd.koreader.v1+json', 'content-type': 'application/json'},
                (password !== undefined ? {'x-auth-user': 'reader', 'x-auth-key': md5(password)} : {})),
        }));
        await test({dir, base, call, worker, store: worker.readingListStore});
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        if (worker.stateStore)
            worker.stateStore.close();
        await fs.remove(dir);
    }
}

async function testKosyncPartialMd5MatchesKoreader() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kosync-md5-'));
    try {
        const small = path.join(dir, 'small');
        await fs.writeFile(small, 'tiny book');
        assert.strictEqual(await kosync.partialMd5(small), md5('tiny book'));

        // Samples of 1 KiB at 0, 1024, 4096, 16384, … while inside the file.
        const data = crypto.randomBytes(20000);
        const big = path.join(dir, 'big');
        await fs.writeFile(big, data);
        const expected = md5(Buffer.concat([data.subarray(0, 1024), data.subarray(1024, 2048), data.subarray(4096, 5120), data.subarray(16384, 17408)]));
        assert.strictEqual(await kosync.partialMd5(big), expected);
    } finally {
        await fs.remove(dir);
    }
}

async function testKosyncProtocolAndWebProgress() {
    await fixture({}, async({dir, base, call, worker, store}) => {
        assert.strictEqual((await fetch(`${base}/protected`)).status, 403, 'SSO still guards the app');
        assert.strictEqual((await call('/other', 'x')).status, 403, 'only the protocol routes skip SSO');

        const register = await call('/users/create', undefined, {method: 'POST', body: JSON.stringify({username: 'reader', password: md5('x')})});
        assert.strictEqual(register.status, 402);
        assert.strictEqual((await register.json()).code, 2005);

        assert.strictEqual((await call('/users/auth')).status, 401);
        assert.strictEqual((await call('/users/auth', 'wrong')).status, 401);
        const password = await store.createKosyncPassword('default');
        assert.ok(!JSON.stringify(await store.load()).includes(md5(password)), 'only a hash of the key is stored');
        const auth = await call('/users/auth', password);
        assert.strictEqual(auth.status, 200);
        assert.deepStrictEqual(await auth.json(), {authorized: 'OK'});

        // A book file served by inpx-shelf: its KOReader hash leads to the book.
        const file = path.join(dir, 'book.epub');
        await fs.writeFile(file, crypto.randomBytes(3000));
        await kosync.rememberFile(worker, file, 'book-uid');
        const document = await kosync.partialMd5(file);

        assert.deepStrictEqual(await (await call(`/syncs/progress/${document}`, password)).json(), {});
        const put = await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({
            document, progress: '/body/DocFragment[3]/body/p[7]/text().0', percentage: 0.42, device: 'Clara', device_id: 'dev-1'})});
        assert.strictEqual(put.status, 200);
        const putBody = await put.json();
        assert.strictEqual(putBody.document, document);
        assert.ok(Number.isInteger(putBody.timestamp));
        const got = await (await call(`/syncs/progress/${document}`, password)).json();
        assert.deepStrictEqual(got, {document, progress: '/body/DocFragment[3]/body/p[7]/text().0', percentage: 0.42,
            device: 'Clara', device_id: 'dev-1', timestamp: putBody.timestamp});
        assert.strictEqual((await store.getReaderState('default', 'book-uid')).progress.percent, 0.42, 'reaches continue reading');

        // A newer web position is not overwritten.
        await store.updateReaderProgress('default', 'book-uid', {percent: 0.6, sectionId: 's2', updatedAt: new Date(Date.now() + 60000).toISOString(), generation: 0});
        await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({document, progress: 'x', percentage: 0.5, device: 'Clara', device_id: 'dev-1'})});
        assert.strictEqual((await store.getReaderState('default', 'book-uid')).progress.sectionId, 's2');

        // A book not from inpx-shelf still syncs between KOReader devices.
        const other = md5('other book');
        assert.strictEqual((await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({
            document: other, progress: '12', percentage: 0.1, device: 'Phone', device_id: 'dev-2'})})).status, 200);
        assert.strictEqual((await (await call(`/syncs/progress/${other}`, password)).json()).progress, '12');

        assert.strictEqual((await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({progress: '1'})})).status, 403);
        assert.strictEqual((await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({
            document: '__proto__', progress: '1', percentage: 0, device: 'a', device_id: 'b'})})).status, 403);
        assert.strictEqual((await call('/syncs/progress', password, {method: 'PUT', body: '{'})).status, 400);

        // Another profile does not see this progress; a new password revokes the old one.
        const otherPassword = await store.createKosyncPassword('admin');
        assert.deepStrictEqual(await (await call(`/syncs/progress/${other}`, otherPassword)).json(), {});
        await store.createKosyncPassword('default');
        assert.strictEqual((await call('/users/auth', password)).status, 401);
    });
}

async function testKosyncFailedLoginsAreRateLimited() {
    await fixture({loginRateLimitMaxAttempts: 3}, async({call, store}) => {
        const password = await store.createKosyncPassword('default');
        for (let i = 0; i < 3; i++)
            assert.strictEqual((await call('/users/auth', `guess-${i}`)).status, 401);
        assert.strictEqual((await call('/users/auth', password)).status, 429, 'a blocked address is refused even with the right key');
    });
}

async function testKosyncChecksKeyBeforeReadingBody() {
    await fixture({}, async({call}) => {
        //тело больше лимита разбора: без пароля оно не читается, ответ - 401, а не 413
        const body = JSON.stringify({document: 'a'.repeat(32), progress: 'x'.repeat(100 * 1024), percentage: 0.5, device: 'd', device_id: 'i'});
        assert.strictEqual((await call('/syncs/progress', 'wrong-key', {method: 'PUT', body})).status, 401);
    });
}

async function testKosyncFindsServedCacheFile() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kosync-state-'));
    const state = new StateStore({dataDir: dir});
    try {
        state.putBookFile({id: 'uid-1', hash: 'abc123', size: 1, assetVersion: ''});
        assert.strictEqual(state.getBookFileUid('abc123'), 'uid-1');
        assert.strictEqual(state.getBookFileUid('nope'), '');
        // Off by default: nothing is hashed.
        await kosync.rememberFile({config: {}, stateStore: state}, path.join(dir, 'missing'), 'uid-1');
        assert.strictEqual(state.getKosyncDocument(md5('x')), '');
    } finally {
        state.close();
        await fs.remove(dir);
    }
}

// One push is one store write: the KOReader row and "continue reading" are saved together.
async function testKosyncPushIsOneStoreWrite() {
    await fixture({}, async({dir, call, worker, store}) => {
        const password = await store.createKosyncPassword('default');
        const file = path.join(dir, 'book.epub');
        await fs.writeFile(file, crypto.randomBytes(3000));
        await kosync.rememberFile(worker, file, 'book-uid');
        const document = await kosync.partialMd5(file);
        const writeData = store.writeData;
        let writes = 0;
        store.writeData = function(...args) {
            writes++;
            return writeData.apply(this, args);
        };
        const push = async(doc, percentage) => {
            writes = 0;
            const res = await call('/syncs/progress', password, {method: 'PUT', body: JSON.stringify({
                document: doc, progress: 'p', percentage, device: 'Clara', device_id: 'dev-1'})});
            assert.strictEqual(res.status, 200);
            return (await res.json()).timestamp;
        };
        const user = async() => (await store.load()).users.find(item => item.id === 'default');

        const timestamp = await push(document, 0.42);
        const saved = await user();
        assert.deepStrictEqual(saved.kosyncProgress[document], {progress: 'p', percentage: 0.42,
            device: 'Clara', device_id: 'dev-1', timestamp, bookUid: 'book-uid'});
        assert.deepStrictEqual(saved.readerProgress['book-uid'], {percent: 0.42, sectionId: '', pageIndex: 0, textOffset: -1,
            textSnippet: '', updatedAt: new Date(timestamp*1000).toISOString(), hidden: false, generation: 0});
        assert.strictEqual(writes, 1, 'kosync row and reader progress in one write');

        // A newer web position stays; the KOReader row still updates.
        await store.updateReaderProgress('default', 'book-uid', {percent: 0.6, sectionId: 's2', updatedAt: new Date(Date.now() + 60000).toISOString(), generation: 0});
        const web = (await user()).readerProgress['book-uid'];
        await push(document, 0.5);
        assert.deepStrictEqual((await user()).readerProgress['book-uid'], web);
        assert.strictEqual((await user()).kosyncProgress[document].percentage, 0.5);
        assert.strictEqual(writes, 1);

        // A book not from inpx-shelf: only the KOReader row.
        await push(md5('other'), 0.1);
        assert.strictEqual((await user()).kosyncProgress[md5('other')].bookUid, '');
        assert.strictEqual(writes, 1);
    });
}

module.exports = [
    testKosyncPartialMd5MatchesKoreader,
    testKosyncProtocolAndWebProgress,
    testKosyncPushIsOneStoreWrite,
    testKosyncFailedLoginsAreRateLimited,
    testKosyncChecksKeyBeforeReadingBody,
    testKosyncFindsServedCacheFile,
];

if (require.main === module) {
    (async() => {
        require('../server/core/Logger');
        const logger = new (require('../server/core/AppLogger'))();
        if (!logger.inited)
            await logger.init({loggingEnabled: false, name: 'kosync-tests'});
        for (const test of module.exports) {
            await test();
            console.log(`ok ${test.name}`);
        }
    })().catch(e => {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    });
}
