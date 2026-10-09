const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const Security = require('../server/core/Security');
const ReadingListStore = require('../server/core/ReadingListStore');
const kobo = require('../server/core/kobo');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');

// A Kobo talks to /kobo/<token>/…; this fixture plays the device against a real
// reading-list store, with the library and the converter stubbed.
async function fixture(options, test) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kobo-'));
    let server;
    try {
        const config = Object.assign({dataDir: dir, rootPathStatic: '', publicFilesDir: path.join(dir, 'public-files'),
            coverDir: path.join(dir, 'public-files', 'cover'), tempDir: path.join(dir, 'tmp'),
            koboEnabled: true, conversionEnabled: true, conversionFormats: ['epub', 'kepub']}, options.config || {});
        const books = new Map([
            ['fb2-uid', {_uid: 'fb2-uid', libid: '101', sourceId: 'main', title: 'Первая книга', author: 'Тестов Автор,Второй Автор', series: 'Цикл', serno: '2', lang: 'ru', ext: 'fb2'}],
            ['epub-uid', {_uid: 'epub-uid', libid: '102', sourceId: 'main', title: 'EPUB book', author: 'Author', lang: 'en', ext: 'epub'}],
            ['pdf-uid', {_uid: 'pdf-uid', libid: '103', sourceId: 'main', title: 'PDF book', author: 'Author', ext: 'pdf'}],
            ['late-uid', {_uid: 'late-uid', title: 'Late book', author: 'Author', ext: 'fb2'}],
        ]);
        const prepareCalls = [];
        // What the stand-in converter currently produces; tests change it to mimic regenerated files.
        const output = {suffix: ''};
        const worker = {
            config,
            readingListStore: new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'}),
            getBookRecordByUid: async uid => books.get(uid) || null,
            getBookCover: async() => ({contentType: 'image/png', data: png}),
            getPreparedBookFile: async(uid, format) => {
                prepareCalls.push([uid, format]);
                if (options.slowUid === uid)
                    await new Promise(resolve => setTimeout(resolve, 300));
                const name = `${uid}.${format || books.get(uid).ext}`;
                const file = path.join(dir, 'prepared', name);
                await fs.outputFile(file, `content of ${name}${output.suffix}`);
                return {book: books.get(uid), rawFile: file, downFileName: format === 'kepub' ? `${uid}.kepub.epub` : `${uid}.epub`};
            },
        };
        const security = new Security(config);
        await security.init();
        const app = express();
        app.use(security.middleware());
        app.use(security.requiredAuthMiddleware());
        const service = kobo.init(app, config, worker, security);
        service.metadata.read = async() => ({description: 'Аннотация', publisher: 'Издатель', publishedYear: '2020'});
        app.get('/protected', (req, res) => res.send('protected'));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;

        const store = worker.readingListStore;
        const listA = await store.createList('default', 'На Kobo');
        const listB = await store.createList('default', 'Отпуск');
        const {device, endpoint} = await service.createDevice('default', {name: 'Clara', listIds: [listA.id, listB.id]},
            {headers: {host: `127.0.0.1:${server.address().port}`}, socket: {}, protocol: 'http'});
        const token = endpoint.split('/kobo/')[1];

        let syncToken = '';
        const call = (suffix, init = {}) => fetch(`${endpoint}${suffix}`, init);
        const sync = async(options = {}) => {
            const headers = (options.fresh ? {} : (syncToken ? {'x-kobo-synctoken': syncToken} : {}));
            const response = await call('/v1/library/sync', {headers});
            assert.strictEqual(response.status, 200);
            syncToken = response.headers.get('x-kobo-synctoken');
            assert.ok(syncToken);
            return {items: await response.json(), more: response.headers.get('x-kobo-sync') === 'continue'};
        };
        await test({config, service, store, worker, books, device, endpoint, token, base, listA, listB, call, sync, prepareCalls, output});
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await fs.remove(dir);
    }
}

const entitlementIds = (items, kind) => items.filter(item => item[kind]).map(item => item[kind].BookEntitlement.Id);

async function testKoboSyncListsAndDownloads() {
    await fixture({}, async({service, store, listA, listB, endpoint, base, call, sync, token}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await store.addBooks('default', listB.id, ['epub-uid', 'pdf-uid']);

        assert.strictEqual((await fetch(`${base}/kobo/${'0'.repeat(32)}/v1/initialization`)).status, 401);
        const init = await call('/v1/initialization');
        assert.strictEqual(init.status, 200);
        const {Resources: resources} = await init.json();
        assert.strictEqual(resources.library_sync, `${endpoint}/v1/library/sync`);
        assert.ok(resources.image_url_template.startsWith(`${endpoint}/{ImageId}/`));
        assert.ok(!JSON.stringify(resources).includes('storeapi.kobo.com'), 'store calls must not leave inpx-web');

        const first = await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        assert.deepStrictEqual(entitlementIds(first.items, 'NewEntitlement').sort(), [fb2Uuid, epubUuid].sort());
        assert.strictEqual(first.more, false);
        const fb2 = first.items.find(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === fb2Uuid).NewEntitlement;
        assert.strictEqual(fb2.BookMetadata.Title, 'Первая книга');
        assert.deepStrictEqual(fb2.BookMetadata.Contributors, ['Тестов Автор', 'Второй Автор']);
        assert.strictEqual(fb2.BookMetadata.Series.Number, 2);
        assert.strictEqual(fb2.BookMetadata.Language, 'ru');
        assert.strictEqual(fb2.BookMetadata.Description, 'Аннотация');
        assert.strictEqual(fb2.BookMetadata.DownloadUrls[0].Format, 'KEPUB');
        assert.strictEqual(fb2.BookMetadata.DownloadUrls[0].Size, Buffer.byteLength('content of fb2-uid.kepub'));
        const epub = first.items.find(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === epubUuid).NewEntitlement;
        assert.deepStrictEqual(epub.BookMetadata.DownloadUrls.map(url => url.Format), ['EPUB3', 'EPUB']);
        assert.strictEqual(first.items.filter(item => item.NewTag).length, 2, 'each bound list is a collection');
        const tagA = first.items.find(item => item.NewTag && item.NewTag.Tag.Name === 'На Kobo').NewTag.Tag;
        assert.deepStrictEqual(tagA.Items.map(item => item.RevisionId).sort(), [fb2Uuid, epubUuid].sort());

        assert.deepStrictEqual((await sync()).items, [], 'nothing changed');

        const download = await fetch(fb2.BookMetadata.DownloadUrls[0].Url);
        assert.strictEqual(download.status, 200);
        assert.strictEqual(await download.text(), 'content of fb2-uid.kepub');
        assert.ok(download.headers.get('content-disposition').includes('.kepub.epub'));
        const cover = await call(`/${fb2Uuid}/150/200/false/image.jpg`);
        assert.strictEqual(cover.status, 200);
        assert.ok(Buffer.from(await cover.arrayBuffer()).equals(png));
        assert.strictEqual((await call(`/${kobo.uuidv5('main:999')}/150/200/false/image.jpg`)).status, 404);
        const metadata = await call(`/v1/library/${epubUuid}/metadata`);
        assert.strictEqual((await metadata.json())[0].Title, 'EPUB book');
        assert.deepStrictEqual(await (await call('/v1/user/profile')).json(), {});

        // Removal from one list keeps a book that is still in the other one.
        await store.setBookMembership('default', listB.id, 'epub-uid', false);
        let next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), []);
        assert.ok(next.items.some(item => item.ChangedTag && item.ChangedTag.Tag.Name === 'Отпуск'));
        await store.setBookMembership('default', listA.id, 'epub-uid', false);
        next = await sync();
        const removed = next.items.find(item => item.ChangedEntitlement);
        assert.strictEqual(removed.ChangedEntitlement.BookEntitlement.Id, epubUuid);
        assert.strictEqual(removed.ChangedEntitlement.BookEntitlement.IsRemoved, true);

        // Unbinding a list deletes its collection.
        await service.updateDevice('default', service.store.data.devices[0].id, {listIds: [listA.id]});
        next = await sync();
        assert.ok(next.items.some(item => item.DeletedTag));
        assert.strictEqual(token.length, 32);
    });
}

async function testKoboReadStateBothWays() {
    await fixture({}, async({store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');

        // Web → Kobo
        await store.setBooksRead('default', ['epub-uid'], true);
        let next = await sync();
        const changed = next.items.find(item => item.ChangedReadingState).ChangedReadingState.ReadingState;
        assert.strictEqual(changed.EntitlementId, epubUuid);
        assert.strictEqual(changed.StatusInfo.Status, 'Finished');
        assert.deepStrictEqual((await sync()).items, []);

        // Kobo → web, without echoing the change back
        const put = await call(`/v1/library/${fb2Uuid}/state`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ReadingStates: [{
                CurrentBookmark: {ProgressPercent: 100, ContentSourceProgressPercent: 100, Location: {Value: 'kobo.1.1', Type: 'KoboSpan', Source: 'ch1.xhtml'}},
                Statistics: {SpentReadingMinutes: 42, RemainingTimeMinutes: 0},
                StatusInfo: {Status: 'Finished'},
            }]})});
        assert.strictEqual(put.status, 200);
        const putBody = await put.json();
        assert.strictEqual(putBody.RequestResult, 'Success');
        assert.strictEqual(putBody.UpdateResults[0].StatusInfoResult.Result, 'Success');
        const list = await store.getList('default', listA.id);
        assert.strictEqual(list.books.find(entry => entry.bookUid === 'fb2-uid').read, true);
        next = await sync();
        assert.ok(!next.items.some(item => item.ChangedReadingState), 'state from the device is not echoed');

        const state = await (await call(`/v1/library/${fb2Uuid}/state`)).json();
        assert.strictEqual(state[0].StatusInfo.Status, 'Finished');
        assert.strictEqual(state[0].Statistics.SpentReadingMinutes, 42);
        assert.strictEqual(state[0].CurrentBookmark.Location.Value, 'kobo.1.1');

        // Unticking "read" on the web reopens the book on the device.
        await store.setBookRead('default', listA.id, 'fb2-uid', false);
        next = await sync();
        assert.strictEqual(next.items.find(item => item.ChangedReadingState).ChangedReadingState.ReadingState.StatusInfo.Status, 'ReadyToRead');
        assert.strictEqual((await call(`/v1/library/${kobo.uuidv5('x')}/state`, {method: 'PUT',
            headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 404);
    });
}

async function testKoboDeleteOnDeviceAndKeepRemovedBooks() {
    await fixture({}, async({service, store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');

        // Deleting on the device marks the book read and stops re-sending it.
        assert.strictEqual((await call(`/v1/library/${fb2Uuid}`, {method: 'DELETE'})).status, 204);
        assert.strictEqual((await store.getList('default', listA.id)).books.find(entry => entry.bookUid === 'fb2-uid').read, true);
        assert.deepStrictEqual(entitlementIds((await sync()).items, 'NewEntitlement'), []);
        assert.deepStrictEqual(entitlementIds((await sync({fresh: true})).items, 'NewEntitlement'), [epubUuid],
            'a device without a sync token gets the list again, minus books deleted on it');
        // Taking it off the list and back sends it again.
        await store.setBookMembership('default', listA.id, 'fb2-uid', false);
        await sync();
        await store.setBookMembership('default', listA.id, 'fb2-uid', true);
        assert.deepStrictEqual(entitlementIds((await sync()).items, 'NewEntitlement'), [fb2Uuid]);

        // keepRemovedBooks: leaving the list does not delete the book from the device.
        await service.updateDevice('default', service.store.data.devices[0].id, {keepRemovedBooks: true});
        await store.setBookMembership('default', listA.id, 'epub-uid', false);
        const next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), []);
        assert.strictEqual((await call(`/download/${epubUuid}/raw`)).status, 200, 'kept books stay downloadable');
        await store.setBookMembership('default', listA.id, 'epub-uid', true);
        assert.deepStrictEqual(entitlementIds((await sync()).items, 'NewEntitlement'), [], 'a kept book is not sent twice');

        // A listed book missing from the DB (re-index) is never removed.
        await service.updateDevice('default', service.store.data.devices[0].id, {keepRemovedBooks: false});
        const bookStore = service.worker;
        const original = bookStore.getBookRecordByUid;
        bookStore.getBookRecordByUid = async uid => (uid === 'epub-uid' ? null : original(uid));
        assert.deepStrictEqual(entitlementIds((await sync()).items, 'ChangedEntitlement'), []);
        bookStore.getBookRecordByUid = original;
    });
}

async function testKoboSlowConversionAndProxyAuth() {
    await fixture({slowUid: 'late-uid', config: {requireAuth: true, authMode: 'proxy', trustProxy: false}},
        async({service, store, listA, base, sync, prepareCalls}) => {
            assert.strictEqual((await fetch(`${base}/protected`)).status, 403, 'proxy SSO still guards the app');
            service.prepareBudgetMs = 50;
            await store.addBooks('default', listA.id, ['late-uid', 'pdf-uid']);
            let next = await sync({fresh: true});
            assert.deepStrictEqual(entitlementIds(next.items, 'NewEntitlement'), [], 'not announced before the file exists');
            assert.strictEqual(next.more, false, 'a pending conversion must not make the device spin');
            await new Promise(resolve => setTimeout(resolve, 400));
            next = await sync();
            const late = next.items.find(item => item.NewEntitlement).NewEntitlement;
            assert.strictEqual(late.BookEntitlement.Id, kobo.uuidv5('late-uid'), 'without libid the uid is the key');
            assert.strictEqual(prepareCalls.filter(([uid]) => uid === 'late-uid').length, 1);
            assert.ok(!prepareCalls.some(([uid]) => uid === 'pdf-uid'), 'unsupported formats are skipped');
        });
}

async function testKoboDevicesAreScopedAndRevocable() {
    await fixture({}, async({service, store, listA, base, call, token}) => {
        const other = await store.createUser({name: 'Other', login: 'other'});
        const otherList = await store.createList(other.id, 'Чужой');
        const req = {headers: {host: 'books.example'}, socket: {}, protocol: 'https'};
        await assert.rejects(service.createDevice('default', {listIds: [otherList.id]}, req), /Список не найден/);
        await assert.rejects(service.updateDevice(other.id, service.store.data.devices[0].id, {name: 'x'}), /Устройство не найдено/);
        assert.deepStrictEqual((await service.getDevices(other.id)).devices, []);

        const deviceId = service.store.data.devices[0].id;
        const {endpoint} = await service.regenerateToken('default', deviceId, req);
        assert.ok(endpoint.startsWith('http://books.example/kobo/'));
        assert.strictEqual((await call('/v1/initialization')).status, 401, 'old token is revoked');
        const fresh = endpoint.split('/kobo/')[1];
        assert.notStrictEqual(fresh, token);
        assert.strictEqual((await fetch(`${base}/kobo/${fresh}/v1/initialization`)).status, 200);

        const saved = await fs.readJson(service.store.file);
        assert.ok(!JSON.stringify(saved).includes(fresh), 'only the token hash is stored');

        await service.store.deleteDevice('default', deviceId);
        assert.strictEqual((await fetch(`${base}/kobo/${fresh}/v1/initialization`)).status, 401);
        assert.ok(listA.id);
    });
}

async function testKoboStoreProxyToggle() {
    // A stand-in for storeapi.kobo.com that records what reaches it.
    const seen = [];
    const store = express();
    store.use(express.raw({type: () => true}));
    store.all('*', (req, res) => {
        seen.push({method: req.method, path: req.path, syncToken: req.headers['x-kobo-synctoken'] || '',
            body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''});
        if (req.path === '/v1/initialization')
            return res.json({Resources: {from_store: 'yes', library_sync: 'https://storeapi.kobo.com/v1/library/sync',
                user_profile: 'https://storeapi.kobo.com/v1/user/profile'}});
        if (req.path === '/v1/auth/device')
            return res.json({AccessToken: 'store-access', UserKey: 'store-key'});
        if (req.path === '/v1/library/sync') {
            res.set('x-kobo-synctoken', 'store.token2');
            return res.json([{NewEntitlement: {BookEntitlement: {Id: 'purchased-book'}}}]);
        }
        res.status(202).json({proxied: req.path});
    });
    const storeServer = http.createServer(store);
    await new Promise(resolve => storeServer.listen(0, '127.0.0.1', resolve));
    try {
        const storeUrl = `http://127.0.0.1:${storeServer.address().port}`;
        await fixture({config: {koboStoreApiUrl: storeUrl}}, async({service, store: lists, listA, endpoint, call}) => {
            await lists.addBooks('default', listA.id, ['epub-uid']);
            const deviceId = service.store.data.devices[0].id;

            // Off (default): nothing reaches the store.
            assert.deepStrictEqual(await (await call('/v1/user/profile', {method: 'POST', body: '{}'})).json(), {});
            const offSync = await call('/v1/library/sync', {headers: {'x-kobo-synctoken': 'store.token1'}});
            assert.ok(!(await offSync.json()).some(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === 'purchased-book'));
            assert.strictEqual(seen.length, 0);

            await service.updateDevice('default', deviceId, {storeProxy: true});
            await service.store.resetDevice('default', deviceId);

            const init = await (await call('/v1/initialization')).json();
            assert.strictEqual(init.Resources.from_store, 'yes', 'store resources are used');
            assert.strictEqual(init.Resources.library_sync, `${endpoint}/v1/library/sync`);
            assert.strictEqual(init.Resources.user_profile, `${endpoint}/v1/user/profile`);

            const auth = await (await call('/v1/auth/device', {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({UserKey: 'device-key'})})).json();
            assert.strictEqual(auth.AccessToken, 'store-access');
            assert.strictEqual(seen.find(item => item.path === '/v1/auth/device').body, '{"UserKey":"device-key"}');

            const sync = await call('/v1/library/sync', {headers: {'x-kobo-synctoken': 'store.token1'}});
            const items = await sync.json();
            assert.ok(items.some(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === kobo.uuidv5('main:102')));
            assert.ok(items.some(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === 'purchased-book'));
            assert.strictEqual(seen.find(item => item.path === '/v1/library/sync').syncToken, 'store.token1',
                'the store sees its own token, not ours');
            const ours = sync.headers.get('x-kobo-synctoken');
            await call('/v1/library/sync', {headers: {'x-kobo-synctoken': ours}});
            assert.strictEqual(seen.filter(item => item.path === '/v1/library/sync')[1].syncToken, 'store.token2');

            const post = await call('/v1/user/wishlist', {method: 'POST', body: 'x'});
            assert.strictEqual(post.status, 202, 'non-GET store calls are proxied server-side');
            const get = await call('/v1/products/featured/', {redirect: 'manual'});
            assert.strictEqual(get.status, 307);
            assert.strictEqual(get.headers.get('location'), `${storeUrl}/v1/products/featured/`);
            const unknownState = await call(`/v1/library/${kobo.uuidv5('store-only')}/state`, {method: 'PUT', body: '{}'});
            assert.strictEqual(unknownState.status, 202, 'store books keep their reading state in the store');
            const cover = await call(`/${kobo.uuidv5('store-only')}/150/200/false/image.jpg`, {redirect: 'manual'});
            assert.ok(cover.headers.get('location').startsWith('https://cdn.kobo.com/book-images/'));
        });
    } finally {
        storeServer.closeAllConnections();
        await new Promise(resolve => storeServer.close(resolve));
    }
}

async function testKoboSyncKeepsChangesMadeDuringConversion() {
    await fixture({slowUid: 'late-uid'}, async({service, store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['epub-uid']);
        await sync({fresh: true});
        const epubUuid = kobo.uuidv5('main:102');
        await store.addBooks('default', listA.id, ['late-uid']);
        service.prepareBudgetMs = 2000;
        // The device deletes a book while the sync is still waiting for a conversion.
        const pendingSync = sync();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual((await call(`/v1/library/${epubUuid}`, {method: 'DELETE'})).status, 204);
        await pendingSync;
        assert.strictEqual(service.store.data.devices[0].books[epubUuid].deletedOnDevice, true);
        assert.deepStrictEqual(entitlementIds((await sync({fresh: true})).items, 'NewEntitlement'), [kobo.uuidv5('late-uid')]);
    });
}

async function testKoboReannouncesRegeneratedFiles() {
    await withFb2cngConfig(async(configPath) => fixture({config: {fb2cngConfigPath: configPath}}, async({config, store, listA, call, sync, output}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        const first = await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const sizeOf = items => items.find(item => item.ChangedEntitlement).ChangedEntitlement.BookMetadata.DownloadUrls[0].Size;
        assert.strictEqual(first.items.find(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === fb2Uuid)
            .NewEntitlement.BookMetadata.DownloadUrls[0].Size, Buffer.byteLength('content of fb2-uid.kepub'));

        // Edited fb2cng config: converted books are announced again with their new size; EPUBs are untouched.
        await fs.writeFile(configPath, 'document:\n  title: edited\n');
        output.suffix = ' (edited config)';
        let next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [fb2Uuid]);
        assert.strictEqual(sizeOf(next.items), Buffer.byteLength('content of fb2-uid.kepub (edited config)'));
        const changed = next.items.find(item => item.ChangedEntitlement).ChangedEntitlement.BookEntitlement;
        assert.strictEqual(changed.IsRemoved, false);
        assert.deepStrictEqual((await sync()).items, [], 'announced once');

        // A newer fb2cng build changes the fingerprint too.
        config.fb2cngVersion = 'v9.9.9';
        output.suffix = ' (new fb2cng)';
        next = await sync();
        assert.strictEqual(sizeOf(next.items), Buffer.byteLength('content of fb2-uid.kepub (new fb2cng)'));

        // Flushed cache, regenerated with another size: noticed on download, announced on the next sync.
        output.suffix = ' (regenerated after a cache flush)';
        const download = await call(`/download/${fb2Uuid}/kepub`);
        assert.strictEqual(await download.text(), 'content of fb2-uid.kepub (regenerated after a cache flush)');
        next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [fb2Uuid]);
        assert.strictEqual(sizeOf(next.items), Buffer.byteLength('content of fb2-uid.kepub (regenerated after a cache flush)'));
        assert.deepStrictEqual((await sync()).items, []);

        // KEPUB turned off: the book switches to EPUB in place.
        config.conversionFormats = ['epub'];
        next = await sync();
        const switched = next.items.find(item => item.ChangedEntitlement).ChangedEntitlement.BookMetadata.DownloadUrls[0];
        assert.strictEqual(switched.Format, 'EPUB');
        assert.ok(switched.Url.endsWith(`/download/${fb2Uuid}/epub`));
        assert.deepStrictEqual((await sync()).items, []);
    }));
}

async function withFb2cngConfig(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kobo-fb2cng-'));
    try {
        const configPath = path.join(dir, 'config.yaml');
        await fs.writeFile(configPath, 'document:\n  title: first\n');
        return await fn(configPath);
    } finally {
        await fs.remove(dir);
    }
}

module.exports = [
    testKoboSyncListsAndDownloads,
    testKoboReadStateBothWays,
    testKoboDeleteOnDeviceAndKeepRemovedBooks,
    testKoboSlowConversionAndProxyAuth,
    testKoboDevicesAreScopedAndRevocable,
    testKoboStoreProxyToggle,
    testKoboSyncKeepsChangesMadeDuringConversion,
    testKoboReannouncesRegeneratedFiles,
];

if (require.main === module) {
    (async() => {
        require('../server/core/Logger');
        const logger = new (require('../server/core/AppLogger'))();
        if (!logger.inited)
            await logger.init({loggingEnabled: false, name: 'kobo-sync-tests'});
        for (const test of module.exports) {
            await test();
            console.log(`ok ${test.name}`);
        }
    })().catch(e => {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    });
}
