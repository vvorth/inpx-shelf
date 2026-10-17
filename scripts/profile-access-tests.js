const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const Security = require('../server/core/Security');
const ProfileAccess = require('../server/core/ProfileAccess');
const ReadingListStore = require('../server/core/ReadingListStore');

async function fixture(options, test) {
    const Worker = require('../server/core/WebWorker');
    const Controller = require('../server/controllers/WebSocketController');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-access-'));
    const config = Object.assign({dataDir: dir, rootPathStatic: '', bookPathStatic: '/book', libDir: dir, bookDir: path.join(dir, 'books'),
        publicDir: path.join(dir, 'public'), publicFilesDir: path.join(dir, 'public-files'), tempDir: path.join(dir, 'tmp'),
        librarySources: [], name: 'inpx-shelf', version: 'test', webConfigParams: ['name'], opds: {enabled: true}}, options);
    const worker = Object.create(Worker.prototype);
    worker.config = config;
    worker.checkMyState = () => {};
    worker.profileSessions = new Map();
    worker.readingListStore = new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
    worker.dbConfig = async() => ({inpxInfo: {collection: 'Test collection'}});
    worker.getSharedDiscoveryConfig = async() => ({});
    worker.buildUserReadingSummary = async() => ({count: 0, items: []});
    const alice = await worker.readingListStore.createUser({name: 'Alice', login: 'alice', emailTo: 'alice@example.test',
        passwordHash: await worker.hashProfilePassword('alice', 'alice-fixture')});
    await worker.readingListStore.setOpdsPassword(alice.id, await worker.hashProfilePassword('alice', 'alice-opds-pass'));
    const bob = await worker.readingListStore.createUser({name: 'Bob', login: 'bob', emailTo: 'bob@example.test'});
    const security = new Security(config);
    await security.init();
    const access = new ProfileAccess(config, worker, security);
    const controller = Object.create(Controller.prototype);
    Object.assign(controller, {config, security, webWorker: worker, profileAccess: access, activeRequests: 0,
        workerState: {getState: () => ({state: 'normal', fileName: 'PRIVATE_LIBRARY_PATH'})}});
    const app = express();
    app.use(security.middleware());
    app.use(security.requiredAuthMiddleware());
    await fs.outputFile(path.join(config.publicDir, 'index.html'), '<html>Login shell</html>');
    await fs.outputFile(path.join(config.bookDir, 'fixture.txt'), 'BOOK_FIXTURE');
    await fs.outputFile(path.join(config.dataDir, 'backups', 'fixture.zip'), 'BACKUP_FIXTURE');
    app.post('/upload', controller.uploadHandler());
    app.post('/session/rotate', security.sessionRotateHandler());
    require('../server/static')(app, config, worker, security);
    app.use('/opds', access.httpGuard(true));
    app.use('/opds', require('../server/core/opds').scopeGuard(() => worker, security));
    app.get('/opds', (req, res) => res.json({user: req.query.user || ''}));
    for (const [url, name] of [['/opds/reading-profiles', 'ReadingProfilesPage'], ['/opds/reading-lists/list', 'ReadingListPage']]) {
        const page = Object.create(require(`../server/core/opds/${name}`).prototype);
        Object.assign(page, {config, webWorker: worker, opdsRoot: '/opds', rootTag: 'feed', id: name, title: name});
        app.get(url, async(req, res) => {
            try { res.send(await page.body(req)); }
            catch (error) { res.status(404).send(error.message); }
        });
    }
    const server = http.createServer(app);
    const wss = new WebSocket.Server({server, verifyClient: info => security.verifyWebSocket(info.req)});
    wss.on('headers', (headers, req) => {
        const cookie = security.upgradeCookie(req);
        if (cookie)
            headers.push(`Set-Cookie: ${cookie}`);
    });
    wss.on('connection', (socket, req) => {
        socket.req = req;
        socket.on('message', raw => controller.onMessage(socket, raw.toString()));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, headers = {}) => fetch(base + url, {headers, redirect: 'manual'});
    const session = (userId = '') => {
        const value = security.ensureSession({headers: {}});
        if (userId)
            value.profileAccessToken = worker.createProfileSession(userId);
        return {value, cookie: `inpx_web_session=${security.packSessionId(value.id)}`};
    };
    //cookie после входа: POST /session/rotate с токеном из ответа на вход, как в Api.vue
    const rotate = async(token, headers = {}) => {
        const response = await fetch(`${base}/session/rotate`, {method: 'POST', headers: {'x-session-rotate': String(token || ''), ...headers}});
        return {status: response.status, cookie: String(response.headers.get('set-cookie') || '').split(';')[0]};
    };
    const sockets = new Set();
    const connect = async(headers = {}) => {
        const socket = new WebSocket(base.replace('http', 'ws'), {headers});
        sockets.add(socket);
        await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
        let counter = 0;
        return async(params) => {
            const requestId = String(++counter);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {socket.off('message', listener); reject(new Error('WebSocket request timed out'));}, 5000);
                const listener = raw => {
                    const result = JSON.parse(raw);
                    if (result.requestId === requestId && !result._rok) {
                        clearTimeout(timer);
                        socket.off('message', listener);
                        resolve(result);
                    }
                };
                socket.on('message', listener);
                socket.send(JSON.stringify({...params, requestId}));
            });
        };
    };
    try {
        await test({config, worker, security, access, alice, bob, request, session, connect, rotate, base});
    } finally {
        for (const socket of sockets) socket.terminate();
        for (const socket of wss.clients) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.remove(dir);
    }
}

async function testProxyHeaderRequiredWithOldCookie() {
    await fixture({requireAuth: true, authMode: 'proxy', trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']}, async({security, request, connect}) => {
        // the cookie that older versions signed for a proxy user
        const issuedAt = Date.now();
        const cookie = `inpx_web_proxy_auth=alice.${issuedAt}.${security.sign(`proxy:alice:${issuedAt}`)}; broken=%ZZ`;
        const headers = {'Remote-User': 'alice', cookie};
        const ok = await request('/', headers);
        assert.strictEqual(ok.status, 200);
        assert.ok(!(ok.headers.get('set-cookie') || '').includes('inpx_web_proxy_auth'));
        assert.strictEqual((await request('/', {cookie})).status, 401);
        await assert.rejects(connect({cookie}), /401/);
        assert.ok(!(await (await connect(headers))({action: 'test'})).error);
        security.trustedProxyRanges = new Security({trustedProxyCidrs: ['10.0.0.0/8']}).trustedProxyRanges;
        assert.strictEqual((await request('/', headers)).status, 403);
    });
}

async function testAnonymousAccessDisabledHttpAndWebSocket() {
    //the removed allowAnonymousAccess switch must not open anything
    await fixture({allowAnonymousAccess: true}, async({worker, alice, bob, request, session, connect, rotate}) => {
        assert.strictEqual((await request('/')).status, 200, 'Login shell stays reachable');
        for (const url of ['/book/fixture.txt', '/cover/by-uid?uid=x', '/opds'])
            assert.strictEqual((await request(url)).status, 401, url);
        const browser = session();
        const call = await connect({cookie: browser.cookie});
        const config = await call({action: 'get-config', userId: bob.id, profileLoginRequired: false});
        assert.strictEqual(config.profileLoginRequired, true);
        assert.deepStrictEqual(config.userProfiles, []);
        assert.strictEqual(config.dbConfig, undefined);
        const state = await call({action: 'get-worker-state', workerId: 'server_state'});
        assert.strictEqual(state.state, 'normal');
        assert.strictEqual(state.fileName, undefined);
        for (const action of ['search', 'get-user-profiles', 'get-reading-lists', 'create-reading-list', 'get-admin-dashboard']) {
            const response = await call({action, userId: bob.id, csrfToken: config.csrfToken});
            assert.strictEqual(response.error, 'need_profile_login', action);
        }
        const bad = await call({action: 'login-user-profile', login: 'alice', password: 'wrong', csrfToken: config.csrfToken});
        assert.match(bad.error, /Неверный/);
        const login = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken: config.csrfToken});
        assert.strictEqual(login.userId, alice.id);
        browser.cookie = (await rotate(login.sessionRotateToken)).cookie;
        const authed = await call({action: 'get-config', userId: bob.id});
        assert.strictEqual(authed.currentUserId, alice.id, 'Stale selection must be replaced');
        assert.strictEqual(authed.profileAuthorized, true);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 200);
        assert.strictEqual((await request('/opds?user=bob', {cookie: browser.cookie})).status, 401);
        assert.strictEqual((await (await request('/opds', {cookie: browser.cookie})).json()).user, alice.id);
        assert.strictEqual((await call({action: 'get-reading-lists', userId: bob.id})).error, 'need_profile_login');
        await call({action: 'logout-user-profile', csrfToken: config.csrfToken});
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 401);
        assert.strictEqual((await call({action: 'get-reading-lists', userId: alice.id, profileAccessToken: login.profileAccessToken})).error, 'need_profile_login');
        browser.value.profileAccessToken = worker.createProfileSession(alice.id);
        worker.revokeUserSessions(alice.id);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 401);
        const basic = {authorization: 'Basic ' + Buffer.from('alice:alice-opds-pass').toString('base64')};
        assert.strictEqual((await request('/book/fixture.txt', basic)).status, 200);
        assert.strictEqual((await (await request('/opds', basic)).json()).user, alice.id);
        assert.strictEqual((await request('/opds?user=bob', basic)).status, 403);
    });
}

async function testProxyProfileBindingAndIdentityChange() {
    await fixture({authMode: 'proxy', proxyBindProfile: true, trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']},
        async({config, worker, alice, bob, request, session, connect}) => {
            assert.strictEqual((await request('/')).status, 401, 'Binding itself requires trusted SSO identity');
            const browser = session();
            browser.value.profileAccessToken = worker.createProfileSession('admin');
            const oldToken = browser.value.profileAccessToken;
            const headers = {cookie: browser.cookie, 'Remote-User': ' ALICE '};
            const call = await connect(headers);
            const authed = await call({action: 'get-config', userId: bob.id, profileAccessToken: oldToken});
            assert.strictEqual(authed.currentUserId, alice.id);
            assert.strictEqual(authed.profileBoundId, alice.id);
            assert.strictEqual(authed.profileAuthorized, true, 'SSO avoids a second password prompt');
            assert.deepStrictEqual(authed.userProfiles.map(user => user.id), [alice.id]);
            assert.strictEqual(authed.userProfiles[0].requiresLogin, false);
            assert.strictEqual(authed.currentUserProfile.emailTo, 'alice@example.test');
            assert.strictEqual((await request('/admin-backups/fixture.zip', headers)).status, 403, 'Stale admin cookie cannot grant backup access');
            const switched = await call({action: 'get-reading-lists', userId: bob.id, profileAccessToken: oldToken, profileBoundId: ''});
            assert.match(switched.error, /закреплён/);
            const renamed = await call({action: 'update-user-profile', targetUserId: alice.id, profile: {login: 'changed'}, csrfToken: authed.csrfToken});
            assert.match(renamed.error, /закреплён/);
            assert.match((await call({action: 'login-user-profile', login: 'bob', password: 'ignored', csrfToken: authed.csrfToken})).error, /закреплён/);
            assert.strictEqual((await request('/opds?user=bob', headers)).status, 403);
            assert.strictEqual((await (await request('/opds?user=alice', headers)).json()).user, alice.id);
            const ownList = await worker.readingListStore.createList(alice.id, 'Alice OPDS list', 'opds');
            const otherList = await worker.readingListStore.createList(bob.id, 'Bob OPDS list', 'opds');
            const profiles = await (await request('/opds/reading-profiles', headers)).text();
            assert.ok(profiles.includes('Alice'));
            assert.ok(!profiles.includes('Bob'));
            assert.strictEqual((await request(`/opds/reading-lists/list?id=${ownList.id}`, headers)).status, 200);
            const other = await request(`/opds/reading-lists/list?id=${otherList.id}`, headers);
            assert.strictEqual(other.status, 404);
            assert.ok(!(await other.text()).includes('Bob OPDS list'));
            const boundToken = browser.value.profileAccessToken;
            const bobCall = await connect({...headers, 'Remote-User': 'bob'});
            const bobConfig = await bobCall({action: 'get-config', userId: alice.id, profileAccessToken: boundToken});
            assert.strictEqual(bobConfig.currentUserId, bob.id);
            assert.strictEqual(bobConfig.currentUserProfile.emailTo, 'bob@example.test');
            assert.strictEqual(worker.getProfileSessionUser(boundToken), '', 'Previous bound token must be revoked');
            const adminHeaders = {...headers, 'Remote-User': 'admin'};
            const adminCall = await connect(adminHeaders);
            const adminConfig = await adminCall({action: 'get-config', userId: bob.id});
            assert.strictEqual(adminConfig.currentUserProfile.isAdmin, true);
            assert.ok(adminConfig.userProfiles.some(user => user.id === bob.id), 'Bound admins retain profile management');
            assert.strictEqual((await request('/admin-backups/fixture.zip', adminHeaders)).status, 200);
            const unknownCall = await connect({...headers, 'Remote-User': 'unmapped'});
            const legacy = await unknownCall({action: 'get-config', userId: bob.id});
            assert.deepStrictEqual([legacy.profileLoginRequired, legacy.currentUserId], [true, ''], 'Unmapped SSO user must log in');
            assert.strictEqual(browser.value.proxyProfileUserId, undefined);
            await worker.deleteUserProfile(alice.id);
            const removed = await call({action: 'get-config', userId: bob.id});
            assert.deepStrictEqual([removed.profileLoginRequired, removed.currentUserId], [true, '']);
            config.proxyBindProfile = false;
            assert.strictEqual((await request('/')).status, 200);
        });
}

async function testGlobalOpdsCredentials() {
    await fixture({opds: {enabled: true, user: 'catalog', password: 'opds-fixture'}}, async({request}) => {
        const headers = {authorization: 'Basic ' + Buffer.from('catalog:opds-fixture').toString('base64')};
        assert.strictEqual((await request('/opds', headers)).status, 200);
        assert.strictEqual((await request('/book/fixture.txt', headers)).status, 200, 'OPDS readers can download acquisitions');
        assert.strictEqual((await request('/book/fixture.txt')).status, 401);
    });
}

// Profile lookups fall back to the admin: an unknown or OPDS-disabled ?user= must not reach its lists.
async function testOpdsScopeNeedsAnOpdsProfile() {
    await fixture({opds: {enabled: true, user: 'catalog', password: 'opds-fixture'}}, async({worker, bob, request}) => {
        const headers = {authorization: 'Basic ' + Buffer.from('catalog:opds-fixture').toString('base64')};
        const store = worker.readingListStore;
        const admin = (await store.load()).users.find(user => user.isAdmin);
        const adminList = await store.createList(admin.id, 'Admin OPDS list', 'opds');
        const bobList = await store.createList(bob.id, 'Bob OPDS list', 'opds');
        const list = (user, id) => request(`/opds/reading-lists/list?user=${encodeURIComponent(user)}&id=${encodeURIComponent(id)}`, headers);
        assert.strictEqual((await list('no-such-user', adminList.id)).status, 404);
        assert.strictEqual((await list(admin.id, adminList.id)).status, 404, 'OPDS is off for the admin');
        assert.strictEqual((await list(bob.id, bobList.id)).status, 200);
        assert.strictEqual((await list('bob', bobList.id)).status, 200, 'A login names the profile too');
        await store.updateUser(bob.id, {opdsEnabled: false});
        assert.strictEqual((await list(bob.id, bobList.id)).status, 404, 'A profile that turned OPDS off');
    });
}

// OPDS shows a signed-in viewer only its own profile: other profiles' lists are refused, password profiles stay hidden.
async function testOpdsHidesPasswordProfiles() {
    await fixture({}, async({worker, alice, bob, request, session}) => {
        const store = worker.readingListStore;
        const carol = await store.createUser({name: 'Carol', login: 'carol', passwordHash: await worker.hashProfilePassword('carol', 'carol-fixture')});
        const lists = {};
        for (const user of [alice, bob, carol])
            lists[user.id] = await store.createList(user.id, `${user.name} OPDS list`, 'opds');
        await store.updateReaderProgress(carol.id, 'book:1', {percent: 0.5});
        const list = (user, headers) => request(`/opds/reading-lists/list?user=${user.login}&id=${lists[user.id].id}`, headers);

        assert.strictEqual((await list(bob)).status, 401, 'No anonymous OPDS');
        const asBob = await (await request('/opds/reading-profiles', {cookie: session(bob.id).cookie})).text();
        assert.ok(asBob.includes('Bob') && !asBob.includes('Alice') && !asBob.includes('Carol'), asBob);

        const aliceBasic = {authorization: 'Basic ' + Buffer.from('alice:alice-opds-pass').toString('base64')};
        const profilePassword = {authorization: 'Basic ' + Buffer.from('alice:alice-fixture').toString('base64')};
        assert.strictEqual((await list(alice, profilePassword)).status, 401, 'The profile password does not open OPDS');
        assert.strictEqual((await list(alice, aliceBasic)).status, 200);
        assert.strictEqual((await list(carol, aliceBasic)).status, 403, 'Another profile');
        const asAlice = await (await request('/opds/reading-profiles?user=alice', aliceBasic)).text();
        assert.ok(asAlice.includes('Alice') && !asAlice.includes('Carol'), asAlice);
        const carolBasic = {authorization: 'Basic ' + Buffer.from('carol:carol-fixture').toString('base64')};
        assert.strictEqual((await list(carol, carolBasic)).status, 401, 'Basic login needs an OPDS password');

        assert.strictEqual((await list(carol, {cookie: session(alice.id).cookie})).status, 401, 'Another reader');
        assert.strictEqual((await list(carol, {cookie: session(carol.id).cookie})).status, 200, 'Own web session');
    });
}

// A profile without a password (reached through an SSO binding): only an admin gives it credentials. Own password needs the current one.
async function testOpenProfileCredentialsAdminOnly() {
    await fixture({kosyncEnabled: true}, async({worker, alice, bob, connect, session}) => {
        worker.koboService = {createDevice: async() => ({device: {}}), regenerateToken: async() => ({device: {}})};
        const call = await connect({cookie: session(bob.id).cookie});
        const {csrfToken} = await call({action: 'get-config'});
        const asBob = {userId: bob.id, csrfToken};
        const update = (profile, as = asBob, targetUserId = bob.id) => call({action: 'update-user-profile', targetUserId, profile, ...as});
        for (const profile of [{password: 'taken-over'}, {login: 'bobby'}, {login: 'bobby', password: 'taken-over'}, {login: ''}])
            assert.match((await update(profile)).error || '', /administrator|администратор/, JSON.stringify(profile));
        for (const action of ['create-kobo-device', 'regenerate-kobo-device-token', 'create-kosync-password'])
            assert.match((await call({action, ...asBob})).error || '', /administrator|администратор/, action);
        const renamed = await update({name: 'Bobby', login: 'BOB'});
        assert.strictEqual(renamed.user && renamed.user.name, 'Bobby', JSON.stringify(renamed), 'Name and other settings stay editable');
        assert.strictEqual((await worker.readingListStore.getUser(bob.id)).passwordHash, '');

        const aliceLogin = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken});
        const asAlice = {userId: alice.id, profileAccessToken: aliceLogin.profileAccessToken, csrfToken};
        assert.ok((await call({action: 'create-kosync-password', ...asAlice})).password, 'A protected profile makes its own');
        assert.match((await update({password: 'new-password'}, asAlice, alice.id)).error, /current password|текущий пароль/);
        assert.match((await update({password: 'new-password', currentPassword: 'wrong'}, asAlice, alice.id)).error, /current password|текущий пароль/);
        assert.ok(!(await update({password: 'new-password', currentPassword: 'alice-fixture'}, asAlice, alice.id)).error);
        assert.ok(await worker.readingListStore.verifyUserPassword(alice.id, 'new-password'));

        const adminLogin = await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture', csrfToken});
        const asAdmin = {userId: adminLogin.userId, profileAccessToken: adminLogin.profileAccessToken, csrfToken};
        assert.strictEqual((await update({login: 'bobby', password: 'bob-password'}, asAdmin)).user.login, 'bobby', 'The admin sets credentials');
        assert.ok(!(await update({password: 'alice-reset'}, asAdmin, alice.id)).error, 'The admin needs no current password of others');
    });
}

// Book delivery: one recipient, only from a profile with a password (or an admin), at most deliveryRateLimit sends an hour.
async function testDeliveryNeedsPasswordOneRecipientAndRate() {
    const options = {emailShareEnabled: true, smtpHost: '127.0.0.1', telegramShareEnabled: true, telegramBotToken: 'test', deliveryRateLimit: 2};
    await fixture(options, async({worker, alice, bob, connect, session, base}) => {
        worker.getPreparedBookFile = async() => { throw new Error('PREPARE_STUB'); };
        const call = await connect({cookie: session(bob.id).cookie});
        const {csrfToken} = await call({action: 'get-config'});
        const update = (targetUserId, profile, as) => call({action: 'update-user-profile', targetUserId, profile, ...as});
        const asBob = {userId: bob.id, csrfToken};
        assert.strictEqual((await call({action: 'get-config', userId: bob.id})).emailShareEnabled, false);
        assert.match((await update(bob.id, {emailTo: 'relay@example.test'}, asBob)).error, /password|паролем/);
        assert.match((await update(bob.id, {telegramChatId: '42'}, asBob)).error, /password|паролем/);
        assert.match((await call({action: 'send-book-email', bookUid: 'book', ...asBob})).error, /password|паролем/);
        assert.strictEqual((await update(bob.id, {name: 'Bobby', emailTo: 'bob@example.test'}, asBob)).user.name, 'Bobby', 'Unchanged address is no change');

        const login = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken});
        const asAlice = {userId: alice.id, profileAccessToken: login.profileAccessToken, csrfToken};
        assert.strictEqual((await call({action: 'get-config', ...asAlice})).emailShareEnabled, true);
        for (const emailTo of ['a@example.test, b@example.test', 'a@example.test;b@example.test', 'a@example.test\nBcc: b@example.test', 'nobody', '<a@example.test>'])
            assert.match((await update(alice.id, {emailTo}, asAlice)).error, /one email|один адрес/, emailTo);
        assert.strictEqual((await update(alice.id, {emailTo: 'alice2@example.test', telegramChatId: '42'}, asAlice)).user.emailTo, 'alice2@example.test');
        for (let i = 0; i < 2; i++)
            assert.match((await call({action: i ? 'send-book-telegram' : 'send-book-email', bookUid: 'book', ...asAlice})).error, /PREPARE_STUB/);
        for (const action of ['send-book-email', 'send-book-telegram'])
            assert.match((await call({action, bookUid: 'book', ...asAlice})).error, /2 per hour|2 в час/, action);

        //a profile backup imported into an open profile brings no delivery addresses (nor Kobo tokens)
        const browser = session(bob.id);
        const imported = await fetch(`${base}/upload?action=import-reading-lists`, {method: 'POST', body: JSON.stringify({lists: [],
            user: {emailTo: 'relay@example.test', telegramChatId: '42'}, kobo: {devices: []}}),
        headers: {cookie: browser.cookie, 'x-csrf-token': browser.value.csrfToken, 'x-user-id': bob.id}});
        assert.strictEqual(imported.status, 200, await imported.clone().text());
        const stored = await worker.readingListStore.getUser(bob.id);
        assert.deepStrictEqual([stored.emailTo, stored.telegramChatId], ['bob@example.test', '']);

        const adminLogin = await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture', csrfToken});
        const asAdmin = {userId: adminLogin.userId, profileAccessToken: adminLogin.profileAccessToken, csrfToken};
        assert.strictEqual((await update(bob.id, {emailTo: 'bob2@example.test'}, asAdmin)).user.emailTo, 'bob2@example.test');
        await assert.rejects(worker.readingListStore.updateUser(bob.id, {emailTo: 'a@example.test,b@example.test'}), /один адрес|one email/);
    });
}

// A cookie of a session the server no longer knows (restart) is replaced on the WebSocket upgrade.
async function testStaleCookieReplacedOnUpgrade() {
    await fixture({}, async({security, base}) => {
        const stale = `inpx_web_session=${security.packSessionId('gone')}`;
        const socket = new WebSocket(base.replace('http', 'ws'), {headers: {cookie: stale}});
        const upgrade = await new Promise((resolve, reject) => { socket.once('upgrade', resolve); socket.once('error', reject); });
        socket.terminate();
        assert.match(String(upgrade.headers['set-cookie']), /^inpx_web_session=/);
    });
}

// A login over the WebSocket moves the browser session to a new id: a cookie planted before it (session fixation) does
// not get the login. The browser gets the new cookie with a one-time token; open sockets keep the session object.
async function testLoginRotatesSession() {
    await fixture({}, async({security, alice, request, session, connect, rotate}) => {
        const planted = session();
        const call = await connect({cookie: planted.cookie});
        const otherTab = await connect({cookie: planted.cookie});
        const {csrfToken} = await call({action: 'get-config'});
        const sessions = security.sessions.size;
        const signIn = () => call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken});
        const login = await signIn();
        assert.match(login.sessionRotateToken, /^[0-9a-f]{64}$/);
        assert.strictEqual(security.sessions.size, sessions, 'The session is moved, not copied');
        assert.strictEqual((await request('/book/fixture.txt', {cookie: planted.cookie})).status, 401, 'The planted cookie');
        assert.strictEqual((await (await connect({cookie: planted.cookie}))({action: 'get-config'})).profileAuthorized, false);
        assert.strictEqual((await call({action: 'get-config'})).profileAuthorized, true, 'The open socket keeps the login');
        assert.strictEqual((await call({action: 'get-config', profileAccessToken: 'stale-after-restart'})).profileAuthorized, true,
            'A stale token from an open tab falls back to the session');
        assert.strictEqual((await otherTab({action: 'get-config'})).profileAuthorized, true, 'So does another tab on the same cookie');

        const rotated = await rotate(login.sessionRotateToken);
        assert.strictEqual(rotated.status, 204);
        assert.notStrictEqual(rotated.cookie, planted.cookie);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: rotated.cookie})).status, 200, 'The new cookie');
        const reloaded = await (await connect({cookie: rotated.cookie}))({action: 'get-config'});
        assert.deepStrictEqual([reloaded.profileAuthorized, reloaded.currentUserId], [true, alice.id], 'A reload stays signed in');
        assert.strictEqual((await rotate(login.sessionRotateToken)).status, 403, 'The token is single-use');
        assert.strictEqual((await rotate('')).status, 403);
        assert.strictEqual((await rotate((await signIn()).sessionRotateToken, {origin: 'http://evil.example'})).status, 403, 'Another site');
        const late = (await signIn()).sessionRotateToken;
        security.sessionRotations.get(late).expiresAt = Date.now() - 1;
        assert.strictEqual((await rotate(late)).status, 403, 'An expired token');

        //повторные входы не растят ни реестр сессий, ни таблицу токенов
        for (let i = 0; i < 1100; i++)
            security.rotateSession(planted.value);
        assert.ok(security.sessionRotations.size <= 1000, String(security.sessionRotations.size));
        const lifetime = require('../server/core/SessionLifetime');
        while (security.sessions.size < lifetime.maxSessions)
            security.ensureSession({headers: {}});
        security.sessions.delete(planted.value.id);
        security.rotateSession(planted.value);
        assert.strictEqual(security.sessions.size, lifetime.maxSessions, 'A session evicted meanwhile comes back within the limit');
        assert.strictEqual(security.sessions.get(planted.value.id), planted.value);
    });
}

// An unknown login costs the same scrypt run as a wrong password: the answer time does not tell which logins exist.
async function testUnknownLoginTakesAsLong() {
    await fixture({}, async({worker}) => {
        const time = async(login) => {
            const start = process.hrtime.bigint();
            await assert.rejects(worker.loginUserProfile(login, 'wrong-password'));
            return Number(process.hrtime.bigint() - start);
        };
        await time('alice');
        const known = await time('alice');
        const unknown = await time('nobody-here');
        assert.ok(unknown > known/3, `unknown ${unknown}ns, known ${known}ns`);
    });
}

// Passwords people set are at least 10 characters. One login is slowed down after 5 failures from any address, never locked.
async function testPasswordLengthAndPerLoginThrottle() {
    await fixture({}, async({worker, security}) => {
        await assert.rejects(worker.hashProfilePassword('alice', 'short-pwd'), /10/);
        assert.match(await worker.hashProfilePassword('alice', 'long-enough'), /^scrypt:/);
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
            security.checkAccountRate('profile', 'Alice', now);
            security.recordAccountAttempt('profile', 'alice', false, now);
        }
        security.checkAccountRate('profile', 'alice', now);
        security.recordAccountAttempt('profile', 'alice', false, now);
        assert.throws(() => security.checkAccountRate('profile', 'alice', now), error => error.retryAfter === 2);
        security.checkAccountRate('profile', 'bob', now);
        security.checkAccountRate('opds', 'alice', now);
        security.checkAccountRate('profile', 'alice', now + 2000);
        security.recordAccountAttempt('profile', 'alice', true, now + 2000);
        security.checkAccountRate('profile', 'alice', now + 2000);
    });
}

// OPDS Basic: a request without credentials costs nothing; failures run into the per-IP limit, a parallel burst included.
async function testOpdsAuthenticationRateLimit() {
    await fixture({loginRateLimitMaxAttempts: 2}, async({config, security, request}) => {
        const auth = password => ({authorization: 'Basic ' + Buffer.from(`alice:${password}`).toString('base64')});
        for (let i = 0; i < 4; i++)
            assert.strictEqual((await request('/opds')).status, 401);
        assert.strictEqual(security.loginAttempts.size, 0);
        assert.strictEqual((await request('/opds', auth('alice-opds-pass'))).status, 200);
        assert.strictEqual((await request('/opds', auth('wrong'))).status, 401);
        assert.strictEqual((await request('/opds', auth('wrong'))).status, 401);
        const blocked = await request('/opds', auth('wrong'));
        assert.strictEqual(blocked.status, 429);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);

        config.loginRateLimitEnabled = false;
        for (let i = 0; i < 3; i++)
            assert.strictEqual((await request('/opds', auth('wrong'))).status, 401);
        assert.ok(security.getLoginMetrics().attempts.some(row => row.labels.kind === 'opds' && row.labels.result === 'blocked' && row.value >= 1));
        config.loginRateLimitEnabled = true;
        security.loginAttempts.clear();
        security.accountFailures.clear();
        const burst = await Promise.all(Array.from({length: 12}, () => request('/opds', auth('wrong'))));
        assert.strictEqual(burst.filter(response => response.status === 401).length, 2, burst.map(response => response.status).join());
        assert.strictEqual(burst.filter(response => response.status === 429).length, 10);
    });
}

// The OPDS password: generated and shown once, or the user's own of 10+ characters; a new one replaces the old.
async function testSetOpdsPassword() {
    await fixture({}, async({bob, request, session, connect}) => {
        const call = await connect({cookie: session().cookie});
        const {csrfToken} = await call({action: 'get-config'});
        const login = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken});
        const as = {profileAccessToken: login.profileAccessToken, csrfToken};
        const basic = password => ({authorization: 'Basic ' + Buffer.from(`alice:${password}`).toString('base64')});
        const generated = await call({action: 'set-opds-password', ...as});
        assert.strictEqual(generated.username, 'alice');
        assert.strictEqual(generated.password.length, 16);
        assert.strictEqual((await request('/opds', basic(generated.password))).status, 200);
        assert.strictEqual((await request('/opds', basic('alice-opds-pass'))).status, 401, 'The old one stops working');
        assert.match((await call({action: 'set-opds-password', password: 'short', ...as})).error, /10/);
        const own = await call({action: 'set-opds-password', password: 'my-own-opds-pass', ...as});
        assert.strictEqual(own.password, '', 'A chosen password is not sent back');
        assert.strictEqual((await request('/opds', basic('my-own-opds-pass'))).status, 200);
        const bobCall = await connect({cookie: session(bob.id).cookie});
        const bobConfig = await bobCall({action: 'get-config'});
        assert.match((await bobCall({action: 'set-opds-password', csrfToken: bobConfig.csrfToken})).error, /.+/, 'A profile without a password');
    });
}

// A client cannot widen the store lookup to someone else's list.
async function testForeignListNotReadable() {
    await fixture({}, async({worker, alice, bob, connect, session}) => {
        const secret = await worker.readingListStore.createList(alice.id, 'Alice private list');
        const call = await connect({cookie: session(bob.id).cookie});
        for (const options of [undefined, {allowForeign: true}, {allowForeign: true, visibility: 'private'}]) {
            const response = await call({action: 'get-reading-list', userId: bob.id, listId: secret.id, options});
            assert.ok(response.error && !JSON.stringify(response).includes('Alice private list'), JSON.stringify(response));
        }
        assert.strictEqual(await worker.readingListStore.getList(bob.id, secret.id, {allowForeign: true}), null);
    });
}

// A stored row that fails today's validation (edited by hand, older rules) keeps its data and lists.
async function testInvalidStoredRowsAreRepairedNotDropped() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-repair-'));
    try {
        const store = new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin-fixture'});
        await fs.writeJson(store.file, {version: 5, users: [
            {id: 'admin', name: 'Admin', login: 'admin', isAdmin: true},
            {id: 'long', name: 'N'.repeat(100), readerProgress: {book: {percent: 0.5}}},
            {id: 'odd', name: 'Odd', login: 'bad login!'},
        ], lists: [
            {id: 'list-long', userId: 'long', name: 'Long list', books: ['book']},
            {id: 'list-odd', userId: 'odd', name: ' ', books: ['other']},
        ]});
        await store.createList('admin', 'Write once');
        const data = await store.load();
        const long = data.users.find(user => user.id === 'long');
        assert.strictEqual(long.name, 'N'.repeat(80));
        assert.strictEqual(long.readerProgress.book.percent, 0.5);
        assert.strictEqual(data.users.find(user => user.id === 'odd').login, 'bad login!');
        assert.strictEqual(data.lists.find(list => list.id === 'list-long').userId, 'long');
        const odd = data.lists.find(list => list.id === 'list-odd');
        assert.deepStrictEqual([odd.userId, odd.name, odd.books.length], ['odd', 'list-odd', 1]);
    } finally {
        await fs.remove(dir);
    }
}

// The admin role can be given to a profile with a login and password; the last admin keeps it, nobody changes their own role.
async function testAdminRoleToggle() {
    await fixture({}, async({config, worker, alice, bob, connect}) => {
        const call = await connect();
        const cfg = await call({action: 'get-config'});
        const login = await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture', csrfToken: cfg.csrfToken});
        const admin = {userId: login.userId, profileAccessToken: login.profileAccessToken, csrfToken: cfg.csrfToken};
        const update = (targetUserId, profile, as = admin) => call({action: 'update-user-profile', targetUserId, profile, ...as});

        assert.match((await update(bob.id, {isAdmin: true})).error, /login and password|логин и пароль/);
        assert.strictEqual((await update(alice.id, {isAdmin: true})).user.isAdmin, true);
        const aliceLogin = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture', csrfToken: cfg.csrfToken});
        const asAlice = {userId: alice.id, profileAccessToken: aliceLogin.profileAccessToken, csrfToken: cfg.csrfToken};
        await worker.requireAdmin(alice.id, aliceLogin.profileAccessToken);
        assert.strictEqual((await update(alice.id, {isAdmin: false}, asAlice)).user.isAdmin, true, 'Own role is not changed');
        assert.strictEqual((await update(alice.id, {isAdmin: false})).user.isAdmin, false);
        assert.match((await update('admin', {isAdmin: false}, asAlice)).error, /.+/, 'A reader cannot change roles');
        await worker.readingListStore.updateUser(alice.id, {isAdmin: true});
        assert.match((await update('admin', {isAdmin: false}, asAlice)).error, /main administrator|главного администратора/);
        const profiles = (await worker.getUserProfiles()).users;
        assert.deepStrictEqual(profiles.filter(item => item.mainAdmin).map(item => item.id), ['admin']);
        const created = await call({action: 'create-user-profile', profile: {name: 'Dora', login: 'dora', password: 'dora-password', isAdmin: true}, ...asAlice});
        assert.strictEqual(created.user.isAdmin, true);
        assert.match((await call({action: 'create-user-profile', profile: {name: 'Eve', isAdmin: true}, ...asAlice})).error, /.+/);
        assert.match((await call({action: 'create-user-profile', profile: {name: 'Fay', login: 'fay'}, ...asAlice})).error, /login and password|логин и пароль/, 'No password without SSO');
        assert.ok(config);
    });
}

module.exports = [testUnknownLoginTakesAsLong, testSetOpdsPassword, testOpdsAuthenticationRateLimit, testPasswordLengthAndPerLoginThrottle, testStaleCookieReplacedOnUpgrade, testLoginRotatesSession, testDeliveryNeedsPasswordOneRecipientAndRate, testOpenProfileCredentialsAdminOnly, testForeignListNotReadable, testOpdsHidesPasswordProfiles, testAdminRoleToggle, testInvalidStoredRowsAreRepairedNotDropped,
    testOpdsScopeNeedsAnOpdsProfile, testProxyHeaderRequiredWithOldCookie, testAnonymousAccessDisabledHttpAndWebSocket,
    testProxyProfileBindingAndIdentityChange, testGlobalOpdsCredentials];
