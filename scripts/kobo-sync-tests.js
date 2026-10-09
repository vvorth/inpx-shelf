const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');
const yazl = require('yazl');
const Security = require('../server/core/Security');
const ReadingListStore = require('../server/core/ReadingListStore');
const kobo = require('../server/core/kobo');

const png = makePng(1, 1);

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
                if (output.busy && output.busy.delete(uid))
                    throw Object.assign(new Error('Очередь конвертации заполнена'), {code: 'INPX_CONVERSION_QUEUE_FULL'});
                if (options.slowUid === uid)
                    await new Promise(resolve => setTimeout(resolve, 300));
                const name = `${uid}.${format || books.get(uid).ext}`;
                const file = path.join(dir, 'prepared', name);
                await fs.outputFile(file, (output.authors && output.authors[uid])
                    ? await makeEpub(output.authors[uid]) : `content of ${name}${output.suffix}`);
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
        assert.strictEqual(cover.headers.get('content-type'), 'image/jpeg');
        const decodedCover = jpeg.decode(Buffer.from(await cover.arrayBuffer()));
        assert.deepStrictEqual([decodedCover.width, decodedCover.height], [1, 1], 'a small PNG cover becomes a JPEG');
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

            assert.strictEqual((await call('/v1/library/tags', {method: 'POST', body: '{}'})).status, 202,
                'collections made on the device go to the store account when it is connected');
            assert.strictEqual((await call(`/v1/library/tags/${kobo.uuidv5(`list:${listA.id}`)}`, {method: 'DELETE'})).status, 200,
                'bound lists stay local');
            assert.ok(!seen.some(item => item.path.startsWith(`/v1/library/tags/`)));
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

async function testKoboPrewarmsBooksAddedToBoundLists() {
    await fixture({slowUid: 'late-uid'}, async({service, store, worker, listA, sync, prepareCalls, output}) => {
        const WebWorker = require('../server/core/WebWorker');
        Object.assign(worker, {checkMyState() {}, koboService: service,
            dbSearcher: {getSeriesBookList: async() => ({books: [{_uid: 'epub-uid'}]})}});
        const call = (name, ...args) => WebWorker.prototype[name].call(worker, ...args);
        const idle = async() => {
            while (service.prewarmRunning)
                await service.prewarmRunning;
        };

        // Adding a book to a bound list starts its conversion before any sync.
        await call('updateReadingListBook', 'default', listA.id, 'late-uid', true);
        await idle();
        assert.deepStrictEqual(prepareCalls, [['late-uid', 'kepub']]);
        service.prepareBudgetMs = 0;
        assert.deepStrictEqual(entitlementIds((await sync({fresh: true})).items, 'NewEntitlement'), [kobo.uuidv5('late-uid')],
            'a pre-warmed book is announced on the first sync');

        // Lists that aren't bound to a device are left alone until they are bound.
        const listC = await store.createList('default', 'Не на Kobo');
        await call('addSeriesToReadingList', 'default', listC.id, 'Цикл');
        await idle();
        assert.ok(!prepareCalls.some(([uid]) => uid === 'epub-uid'));
        await service.updateDevice('default', service.store.data.devices[0].id, {listIds: [listA.id, listC.id]});
        for (let waited = 0; !prepareCalls.some(([uid]) => uid === 'epub-uid') && waited < 2000; waited += 10)
            await new Promise(resolve => setTimeout(resolve, 10));
        await idle();
        assert.ok(prepareCalls.some(([uid]) => uid === 'epub-uid'), 'binding a list prepares its books');

        // Books already on a device are not prepared again.
        const before = prepareCalls.length;
        await call('updateReadingListBook', 'default', listA.id, 'late-uid', true);
        await idle();
        assert.strictEqual(prepareCalls.length, before);

        // A busy converter is retried instead of blocking the book for the error back-off.
        service.prewarmBusyRetryMs = 10;
        output.busy = new Set(['fb2-uid']);
        await call('updateReadingListBook', 'default', listA.id, 'fb2-uid', true);
        await idle();
        assert.strictEqual(prepareCalls.filter(([uid]) => uid === 'fb2-uid').length, 2);
        assert.ok(entitlementIds((await sync()).items, 'NewEntitlement').includes(kobo.uuidv5('main:101')));
    });
}

async function testKoboRetriesBusyConversionOnNextSync() {
    await fixture({}, async({store, listA, sync, output}) => {
        await store.addBooks('default', listA.id, ['fb2-uid']);
        output.busy = new Set(['fb2-uid']);
        assert.deepStrictEqual(entitlementIds((await sync({fresh: true})).items, 'NewEntitlement'), []);
        assert.deepStrictEqual(entitlementIds((await sync()).items, 'NewEntitlement'), [kobo.uuidv5('main:101')]);
    });
}

async function testKoboRekeysOrphansByLibid() {
    await fixture({}, async({service, store, worker, books, listA, listB, sync, call}) => {
        await store.addBooks('default', listA.id, ['epub-uid', 'fb2-uid', 'late-uid']);
        await store.addBooks('default', listB.id, ['fb2-uid']);
        await store.setBookRead('default', listA.id, 'fb2-uid', true);
        await store.updateReaderProgress('default', 'fb2-uid', {percent: 0.4, sectionId: 's2', updatedAt: '2026-01-01T00:00:00.000Z', generation: 0});
        await store.addReaderBookmark('default', 'fb2-uid', {title: 'Глава 2', percent: 0.4});
        await store.updateMetadataOverride('fb2-uid', {title: 'Правка'});
        await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');

        const lookups = [];
        worker.findBookRecordsByStableKeys = async(keys) => {
            lookups.push(keys.slice().sort());
            const found = {};
            for (const book of books.values()) {
                const key = `${book.sourceId || ''}:${book.libid || ''}`;
                if (book.libid && keys.includes(key))
                    (found[key] = found[key] || []).push(book);
            }
            return found;
        };

        // Re-index rewrote the FB2's INP line: new _uid, same libid. late-uid (no libid) vanished too.
        const fb2 = books.get('fb2-uid');
        books.delete('fb2-uid');
        books.delete('late-uid');
        books.set('fb2-uid-new', Object.assign({}, fb2, {_uid: 'fb2-uid-new'}));
        assert.deepStrictEqual((await sync()).items, [], 'the device sees nothing');
        assert.deepStrictEqual(lookups, [['main:101']], 'one scan, and only for books with a libid');

        const listAfter = await store.getList('default', listA.id);
        assert.deepStrictEqual(listAfter.books, [{bookUid: 'epub-uid', read: false}, {bookUid: 'fb2-uid-new', read: true},
            {bookUid: 'late-uid', read: false}], 'order and read flag kept; the libid-less orphan stays');
        assert.deepStrictEqual((await store.getList('default', listB.id)).books.map(entry => entry.bookUid), ['fb2-uid-new']);
        const user = (await store.load()).users.find(item => item.id === 'default');
        assert.strictEqual(user.readerProgress['fb2-uid-new'].percent, 0.4);
        assert.strictEqual(user.readerProgress['fb2-uid'], undefined);
        assert.strictEqual(user.readerBookmarks['fb2-uid-new'][0].title, 'Глава 2');
        const overrides = await store.getMetadataOverrides();
        assert.strictEqual(overrides['fb2-uid-new'].title, 'Правка', 'metadata edits follow the book');
        assert.strictEqual(overrides['fb2-uid'], undefined);
        assert.strictEqual(service.store.data.devices[0].books[fb2Uuid].bookUid, 'fb2-uid-new');
        assert.strictEqual(await (await call(`/download/${fb2Uuid}/kepub`)).text(), 'content of fb2-uid-new.kepub');
        // The stand-in converter names its output after the uid, so the size changed: announced as an update.
        const update = (await sync()).items;
        assert.deepStrictEqual(entitlementIds(update, 'ChangedEntitlement'), [fb2Uuid]);
        assert.strictEqual(update[0].ChangedEntitlement.BookEntitlement.IsRemoved, false);

        // Two records with one libid are ambiguous: the entry stays an orphan, is never removed,
        // and the lookup is not repeated on every sync.
        const twin = books.get('fb2-uid-new');
        books.delete('fb2-uid-new');
        books.set('fb2-copy-1', Object.assign({}, twin, {_uid: 'fb2-copy-1'}));
        books.set('fb2-copy-2', Object.assign({}, twin, {_uid: 'fb2-copy-2'}));
        assert.deepStrictEqual((await sync()).items, []);
        assert.deepStrictEqual((await sync()).items, []);
        assert.strictEqual(lookups.length, 2);
        assert.ok((await store.getList('default', listA.id)).books.some(entry => entry.bookUid === 'fb2-uid-new'));
    });
}

async function testKoboFindsRecordsByStableKeyInDb() {
    const {JembaDb} = require('jembadb');
    const WebWorker = require('../server/core/WebWorker');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kobo-db-'));
    const db = new JembaDb();
    await fs.ensureDir(path.join(dir, 'db'));
    await db.lock({dbPath: path.join(dir, 'db')});
    try {
        await db.create({table: 'book', hash: {field: '_uid', unique: true, type: 'string'}});
        await db.insert({table: 'book', rows: [
            {id: 1, _uid: 'a', libid: '101', sourceId: 'main', ext: 'fb2'},
            {id: 2, _uid: 'b', libid: '102', sourceId: 'main', ext: 'fb2'},
            {id: 3, _uid: 'c', libid: '102', sourceId: 'main', ext: 'epub'},
            {id: 4, _uid: 'd', libid: '101', sourceId: 'other', ext: 'fb2'},
            {id: 5, _uid: 'e', libid: '', sourceId: 'main', ext: 'fb2'},
        ]});
        const found = await WebWorker.prototype.findBookRecordsByStableKeys.call({db}, ['main:101', 'main:102', 'main:999']);
        assert.deepStrictEqual(Object.keys(found).sort(), ['main:101', 'main:102']);
        assert.deepStrictEqual(found['main:101'].map(row => row._uid), ['a']);
        assert.deepStrictEqual(found['main:102'].map(row => row._uid).sort(), ['b', 'c']);
    } finally {
        await db.unlock();
        await fs.remove(dir);
    }
}

async function testKoboReannouncesMetadataEdits() {
    await fixture({}, async({service, store, worker, books, listA, sync, call}) => {
        const WebWorker = require('../server/core/WebWorker');
        worker.metadataBookUid = WebWorker.prototype.metadataBookUid;
        worker.applyMetadataOverrideToBook = WebWorker.prototype.applyMetadataOverrideToBook;
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await store.updateMetadataOverride('epub-uid', {title: 'Исправленное название'});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        const first = await sync({fresh: true});
        const titleOf = (items, kind, uuid) => items.find(item => item[kind] && item[kind].BookEntitlement.Id === uuid)[kind].BookMetadata.Title;
        assert.strictEqual(titleOf(first.items, 'NewEntitlement', epubUuid), 'Исправленное название', 'edits apply to new books');
        const size = first.items.find(item => item.NewEntitlement && item.NewEntitlement.BookEntitlement.Id === fb2Uuid)
            .NewEntitlement.BookMetadata.DownloadUrls[0].Size;
        assert.deepStrictEqual((await sync()).items, []);

        // An edit after the book was sent: announced once, same ids and file.
        await store.updateMetadataOverride('fb2-uid', {title: 'Новое название', series: 'Другой цикл', serno: 3});
        let next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [fb2Uuid]);
        const changed = next.items[0].ChangedEntitlement;
        assert.strictEqual(changed.BookEntitlement.IsRemoved, false);
        assert.strictEqual(changed.BookMetadata.Title, 'Новое название');
        assert.strictEqual(changed.BookMetadata.Series.Name, 'Другой цикл');
        assert.strictEqual(changed.BookMetadata.Series.Number, 3);
        assert.strictEqual(changed.BookMetadata.DownloadUrls[0].Size, size);
        assert.deepStrictEqual((await sync()).items, []);
        assert.strictEqual((await (await call(`/v1/library/${fb2Uuid}/metadata`)).json())[0].Title, 'Новое название');

        // A re-index that changed the record's own metadata counts too.
        books.get('epub-uid').author = 'Другой Автор';
        next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [epubUuid]);
        assert.deepStrictEqual(next.items[0].ChangedEntitlement.BookMetadata.Contributors, ['Другой Автор']);

        // Rows announced before metadata hashes existed adopt the current one silently.
        for (const row of Object.values(service.store.data.devices[0].books))
            row.metaHash = '';
        assert.deepStrictEqual((await sync()).items, []);
    });
}

// A minimal EPUB whose OPF lists the given creators: a string, or [name, opf:role].
async function makeEpub(creators) {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', {compress: false});
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'META-INF/container.xml');
    const items = creators.map(item => (Array.isArray(item)
        ? `<dc:creator opf:role="${item[1]}">${item[0]}</dc:creator>` : `<dc:creator>${item}</dc:creator>`)).join('');
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
        + `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>T</dc:title>${items}</metadata>`
        + '</package>'), 'OEBPS/content.opf');
    zip.end();
    const chunks = [];
    for await (const chunk of zip.outputStream)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function testKoboAuthorsComeFromTheConvertedFile() {
    await fixture({}, async({service, store, worker, listA, output, sync, call}) => {
        const WebWorker = require('../server/core/WebWorker');
        worker.metadataBookUid = WebWorker.prototype.metadataBookUid;
        worker.applyMetadataOverrideToBook = WebWorker.prototype.applyMetadataOverrideToBook;
        output.authors = {'fb2-uid': ['Автор Тестов', ['Второй Автор', 'aut'], ['Переводчик Иванов', 'trl']]};
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        const metadataOf = (items, kind, uuid) => items.find(item => item[kind] && item[kind].BookEntitlement.Id === uuid)[kind].BookMetadata;

        const first = await sync({fresh: true});
        const fb2 = metadataOf(first.items, 'NewEntitlement', fb2Uuid);
        assert.deepStrictEqual(fb2.Contributors, ['Автор Тестов', 'Второй Автор'], 'the file\'s authors, translators left out');
        assert.deepStrictEqual(fb2.ContributorRoles, [{Name: 'Автор Тестов'}, {Name: 'Второй Автор'}]);
        assert.deepStrictEqual(metadataOf(first.items, 'NewEntitlement', epubUuid).Contributors, ['Author'], 'no creators in the file: the record');
        assert.deepStrictEqual((await (await call(`/v1/library/${fb2Uuid}/metadata`)).json())[0].Contributors, ['Автор Тестов', 'Второй Автор']);
        assert.deepStrictEqual((await sync()).items, []);

        // An admin author edit wins over the file.
        await store.updateMetadataOverride('fb2-uid', {author: 'Редактор Админов'});
        let next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [fb2Uuid]);
        assert.deepStrictEqual(next.items[0].ChangedEntitlement.BookMetadata.Contributors, ['Редактор Админов']);
        assert.deepStrictEqual((await sync()).items, []);

        // A book announced before file authors were read (record's "Last First" sent) gets them
        // once, as a metadata change with the same file.
        const row = service.store.data.devices[0].books[epubUuid];
        const size = row.size;
        output.authors['epub-uid'] = ['Имя Фамилия'];
        service.prepared.clear();
        delete row.fileAuthors;
        row.metaHash = service.metadataHash(await service.bookRecord('epub-uid'));
        next = await sync();
        assert.deepStrictEqual(entitlementIds(next.items, 'ChangedEntitlement'), [epubUuid]);
        assert.deepStrictEqual(next.items[0].ChangedEntitlement.BookMetadata.Contributors, ['Имя Фамилия']);
        assert.strictEqual(next.items[0].ChangedEntitlement.BookMetadata.DownloadUrls[0].Size, size);
        assert.deepStrictEqual((await sync()).items, []);
        const saved = service.store.normalizeData(JSON.parse(JSON.stringify(service.store.data)));
        assert.deepStrictEqual(saved.devices[0].books[epubUuid].fileAuthors, ['Имя Фамилия']);
    });
}

async function testKoboProgressReachesWebReader() {
    await fixture({}, async({store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        const put = (uuid, bookmark) => call(`/v1/library/${uuid}/state`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ReadingStates: [{CurrentBookmark: bookmark, StatusInfo: {Status: 'Reading'}}]})});
        const progressOf = async uid => (await store.getReaderState('default', uid)).progress;
        const minutesAgo = minutes => new Date(Date.now() - minutes*60*1000).toISOString();

        // Opening a book at its start on the Kobo doesn't create a web position.
        assert.strictEqual((await put(epubUuid, {ProgressPercent: 0, LastModified: minutesAgo(0)})).status, 200);
        assert.strictEqual((await progressOf('epub-uid')).updatedAt, '');

        // A newer Kobo percent replaces an older web position.
        await store.updateReaderProgress('default', 'fb2-uid', {percent: 0.2, sectionId: 's1', pageIndex: 7, textOffset: 40,
            textSnippet: 'текст', updatedAt: minutesAgo(30), generation: 0});
        const pageTurn = minutesAgo(10);
        assert.strictEqual((await put(fb2Uuid, {ProgressPercent: 37, LastModified: pageTurn})).status, 200);
        let progress = await progressOf('fb2-uid');
        assert.strictEqual(progress.percent, 0.37);
        assert.strictEqual(progress.sectionId, '', 'the exact web position is replaced by the percent');
        assert.strictEqual(progress.pageIndex, 0);
        assert.strictEqual(progress.textOffset, -1);
        assert.strictEqual(progress.updatedAt, pageTurn, 'the device time of the page turn is kept');

        // A newer web position is never overwritten by an older Kobo one.
        await store.updateReaderProgress('default', 'fb2-uid', {percent: 0.5, sectionId: 's3', updatedAt: minutesAgo(2), generation: 0});
        await put(fb2Uuid, {ProgressPercent: 45, LastModified: minutesAgo(5)});
        progress = await progressOf('fb2-uid');
        assert.strictEqual(progress.percent, 0.5);
        assert.strictEqual(progress.sectionId, 's3');

        // A clock far in the future counts as now; a reset web history (new generation) is respected.
        await store.clearReaderProgress('default');
        await put(fb2Uuid, {ProgressPercent: 60, LastModified: '2099-01-01T00:00:00Z'});
        progress = await progressOf('fb2-uid');
        assert.strictEqual(progress.percent, 0.6);
        assert.strictEqual(progress.generation, 1);
        assert.ok(Date.parse(progress.updatedAt) <= Date.now());
    });
}

async function testKoboCollectionsAreReadOnlyFromDevice() {
    await fixture({}, async({service, store, listA, listB, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await store.addBooks('default', listB.id, ['fb2-uid']);
        await sync({fresh: true});
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        const tagA = kobo.uuidv5(`list:${listA.id}`);
        const tagB = kobo.uuidv5(`list:${listB.id}`);
        const json = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const items = (...uuids) => ({Items: uuids.map(uuid => ({RevisionId: uuid, Type: 'ProductRevisionTagItem'}))});
        const tagItems = (result, id) => {
            const item = result.items.find(entry => (entry.ChangedTag || entry.NewTag) && (entry.ChangedTag || entry.NewTag).Tag.Id === id);
            return item && (item.ChangedTag || item.NewTag).Tag.Items.map(entry => entry.RevisionId).sort();
        };
        const listBooks = async listId => (await store.getList('default', listId)).books.map(entry => entry.bookUid);
        const listCount = (await store.getLists('default')).length;

        // A collection made on the device stays there.
        const created = await call('/v1/library/tags', json({Name: 'Своя полка', Items: items(epubUuid).Items}));
        assert.strictEqual(created.status, 201);
        assert.match(await created.json(), /^[0-9a-f-]{36}$/);
        assert.strictEqual((await call(`/v1/library/tags/${kobo.uuidv5('device-only')}/items`, json(items(fb2Uuid)))).status, 201);
        assert.strictEqual((await call(`/v1/library/tags/${kobo.uuidv5('device-only')}`, {method: 'DELETE'})).status, 200);
        assert.deepStrictEqual((await sync()).items, []);
        assert.strictEqual((await store.getLists('default')).length, listCount, 'no list is created');

        // A book taken out of a bound collection stays out of it; the list and the book stay.
        assert.strictEqual((await call(`/v1/library/tags/${tagA}/items/delete`, json(items(fb2Uuid)))).status, 200);
        let next = await sync();
        assert.ok(!next.items.some(item => item.NewEntitlement || item.ChangedEntitlement), 'nothing is downloaded or removed');
        assert.deepStrictEqual(tagItems(next, tagA), [epubUuid]);
        assert.strictEqual(tagItems(next, tagB), undefined, 'other collections keep the book');
        assert.deepStrictEqual(await listBooks(listA.id), ['fb2-uid', 'epub-uid']);
        assert.deepStrictEqual((await sync()).items, []);
        await store.setBookMembership('default', listA.id, 'epub-uid', false);
        await store.setBookMembership('default', listA.id, 'epub-uid', true);
        assert.deepStrictEqual(tagItems(await sync(), tagA) || [epubUuid], [epubUuid], 'list changes keep the suppression');

        // Leaving the list here lifts the suppression: adding it again puts it back in the collection.
        await store.setBookMembership('default', listA.id, 'fb2-uid', false);
        assert.deepStrictEqual(tagItems(await sync(), tagA) || [epubUuid], [epubUuid]);
        await store.setBookMembership('default', listA.id, 'fb2-uid', true);
        assert.deepStrictEqual(tagItems(await sync(), tagA), [epubUuid, fb2Uuid].sort());

        // So does putting it back into the collection on the device; adding is otherwise ignored.
        await call(`/v1/library/tags/${tagA}/items/delete`, json(items(fb2Uuid)));
        await sync();
        assert.strictEqual((await call(`/v1/library/tags/${tagA}/items`, json(items(fb2Uuid, kobo.uuidv5('unknown'))))).status, 201);
        assert.deepStrictEqual(tagItems(await sync(), tagA), [epubUuid, fb2Uuid].sort());
        assert.deepStrictEqual((await sync()).items, []);

        // Renaming or deleting a bound collection on the device: the list wins on the next sync.
        assert.strictEqual((await call(`/v1/library/tags/${tagA}`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({Name: 'Переименовано'})})).status, 200);
        next = await sync();
        assert.strictEqual(next.items.find(item => item.ChangedTag).ChangedTag.Tag.Name, 'На Kobo');
        assert.strictEqual((await store.getList('default', listA.id)).name, 'На Kobo');
        assert.strictEqual((await call(`/v1/library/tags/${tagB}`, {method: 'DELETE'})).status, 200);
        next = await sync();
        assert.deepStrictEqual(next.items.find(item => item.NewTag).NewTag.Tag.Items.map(item => item.RevisionId), [fb2Uuid]);
        assert.deepStrictEqual(service.store.data.devices[0].listIds, [listA.id, listB.id], 'the list stays bound');
        assert.deepStrictEqual((await sync()).items, []);
    });
}

function makePng(width, height) {
    const image = new PNG({width, height});
    image.data.fill(200);
    return PNG.sync.write(image);
}

async function testKoboResizesCovers() {
    await fixture({}, async({config, worker, store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid', 'epub-uid']);
        await sync();
        const fb2Uuid = kobo.uuidv5('main:101');
        const epubUuid = kobo.uuidv5('main:102');
        const small = jpeg.encode({width: 100, height: 150, data: Buffer.alloc(100*150*4, 90)}, 90).data;
        const covers = {'fb2-uid': {contentType: 'image/png', data: makePng(600, 900)}, 'epub-uid': {contentType: 'image/jpeg', data: small}};
        let coverCalls = 0;
        worker.getBookCover = async book => (coverCalls++, covers[book._uid]);
        const fetchCover = async suffix => {
            const response = await call(suffix);
            assert.strictEqual(response.status, 200);
            return {type: response.headers.get('content-type'), data: Buffer.from(await response.arrayBuffer())};
        };
        const size = data => {
            const decoded = jpeg.decode(data);
            return [decoded.width, decoded.height];
        };

        const first = await fetchCover(`/${fb2Uuid}/150/200/false/image.jpg`);
        assert.strictEqual(first.type, 'image/jpeg');
        assert.deepStrictEqual(size(first.data), [133, 200], 'fits inside the requested box, aspect kept');
        const again = await fetchCover(`/${fb2Uuid}/150/200/false/image.jpg`);
        assert.ok(again.data.equals(first.data));
        assert.deepStrictEqual(size((await fetchCover(`/${fb2Uuid}/355/530/60/false/image.jpg`)).data), [353, 530]);
        assert.deepStrictEqual(size((await fetchCover(`/${fb2Uuid}/1200/1800/false/image.jpg`)).data), [600, 900], 'never enlarged');
        assert.strictEqual(coverCalls, 1, 'the shared cover is made once and reused for every size');
        const cached = (await fs.readdir(config.coverDir)).filter(name => name.includes('-kobo-')).sort();
        assert.strictEqual(cached.length, 3);
        assert.ok(cached.some(name => name.endsWith('-kobo-150x200-q85.jpg')));
        assert.ok(cached.some(name => name.endsWith('-kobo-355x530-q60.jpg')));

        const fitting = await fetchCover(`/${epubUuid}/150/200/false/image.jpg`);
        assert.ok(fitting.data.equals(small), 'a JPEG that already fits is sent as is');
        assert.ok((await fetchCover(`/${epubUuid}/0/0/false/image.jpg`)).data.equals(small), 'unusable size: the original');
    });

    // A cover that can't be decoded (GIF here) is served at its original size and type.
    await fixture({}, async({worker, store, listA, call, sync}) => {
        await store.addBooks('default', listA.id, ['fb2-uid']);
        await sync();
        const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
        worker.getBookCover = async() => ({contentType: 'image/gif', data: gif});
        const response = await call(`/${kobo.uuidv5('main:101')}/150/200/false/image.jpg`);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'image/gif');
        assert.ok(Buffer.from(await response.arrayBuffer()).equals(gif));
    });
}

async function testKoboTokensAreMaskedInLogs() {
    const token = '0123456789abcdef0123456789abcdef';
    assert.strictEqual(kobo.maskTokens(`/kobo/${token}/v1/library/sync?x=1`), '/kobo/***/v1/library/sync?x=1');
    assert.strictEqual(kobo.maskTokens(`/books/kobo/${token}`), '/books/kobo/***');
    assert.strictEqual(kobo.maskTokens('/kobo/not-a-token/x'), '/kobo/not-a-token/x');
    for (const file of ['server/index.js', 'server/dev.js']) {
        const source = await fs.readFile(path.join(__dirname, '..', file), 'utf8');
        assert.ok(!/log\(`[^`]*\$\{req\.originalUrl\}/.test(source), `${file} logs request URLs unmasked`);
    }
}

async function testKoboBackupEntryIsValidated() {
    const yazl = require('yazl');
    const BackupArchive = require('../server/core/BackupArchive');
    const zipOf = async(files) => {
        const zip = new yazl.ZipFile();
        for (const [name, value] of Object.entries(files))
            zip.addBuffer(Buffer.from(JSON.stringify(value)), name);
        zip.end();
        const chunks = [];
        for await (const chunk of zip.outputStream)
            chunks.push(chunk);
        return {contentBase64: Buffer.concat(chunks).toString('base64')};
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-kobo-backup-'));
    try {
        const base = {'backup-info.json': {}, 'reading-lists.json': {users: [], lists: []}};
        const good = await BackupArchive.read(await zipOf(Object.assign({'kobo-sync.json': {version: 1, devices: [], states: {}}}, base)), {}, dir);
        assert.deepStrictEqual(good['kobo-sync.json'].devices, []);
        await assert.rejects(BackupArchive.read(await zipOf(Object.assign({'kobo-sync.json': {devices: {}}}, base)), {}, dir),
            /kobo-sync\.json/);
    } finally {
        await fs.remove(dir);
    }
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
    testKoboTokensAreMaskedInLogs,
    testKoboPrewarmsBooksAddedToBoundLists,
    testKoboRetriesBusyConversionOnNextSync,
    testKoboRekeysOrphansByLibid,
    testKoboFindsRecordsByStableKeyInDb,
    testKoboReannouncesMetadataEdits,
    testKoboProgressReachesWebReader,
    testKoboCollectionsAreReadOnlyFromDevice,
    testKoboBackupEntryIsValidated,
    testKoboResizesCovers,
    testKoboAuthorsComeFromTheConvertedFile,
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
