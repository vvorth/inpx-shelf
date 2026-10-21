const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const apiRoutes = require('../shared/apiRoutes');
const Security = require('../server/core/Security');
const ProfileAccess = require('../server/core/ProfileAccess');
const ReadingListStore = require('../server/core/ReadingListStore');
const {ApiTestClient, sessionCookie, apiController, apiApp, listen, sampleParams} = require('./api-test-client');

//bookUid в пути API - настоящий: base64 от SHA-256
const bookUid = require('crypto').createHash('sha256').update('book').digest('base64');

async function fixture(options, test) {
    const Worker = require('../server/core/WebWorker');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-profile-access-'));
    const config = Object.assign({dataDir: dir, rootPathStatic: '', bookPathStatic: '/book', libDir: dir, bookDir: path.join(dir, 'books'),
        publicDir: path.join(dir, 'public'), publicFilesDir: path.join(dir, 'public-files'), tempDir: path.join(dir, 'tmp'),
        librarySources: [], name: 'inpx-shelf', version: 'test', webConfigParams: ['name'], opds: {enabled: true}}, options);
    const worker = Object.create(Worker.prototype);
    worker.config = config;
    worker.checkMyState = () => {};
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
    const controller = apiController({config, security, webWorker: worker, profileAccess: access,
        workerState: {getState: () => ({state: 'normal', fileName: 'PRIVATE_LIBRARY_PATH'})}});
    await fs.outputFile(path.join(config.publicDir, 'index.html'), '<html>Login shell</html>');
    await fs.outputFile(path.join(config.bookDir, 'fixture.txt'), 'BOOK_FIXTURE');
    await fs.outputFile(path.join(config.dataDir, 'backups', 'fixture.zip'), 'BACKUP_FIXTURE');
    const app = apiApp({config, security, controller, health: false, after: app => {
        require('../server/static')(app, config, worker, security);
        app.use('/opds', access.httpGuard({opds: true, guest: true}));
        app.use('/opds', require('../server/core/opds').scopeGuard(() => worker));
        app.get('/opds', (req, res) => res.json({user: req.query.user || ''}));
        for (const [url, name] of [['/opds/reading-profiles', 'ReadingProfilesPage'], ['/opds/reading-lists/list', 'ReadingListPage']]) {
            const page = Object.create(require(`../server/core/opds/${name}`).prototype);
            Object.assign(page, {config, webWorker: worker, opdsRoot: '/opds', rootTag: 'feed', id: name, title: name});
            app.get(url, async(req, res) => {
                try { res.send(await page.body(req)); }
                catch (error) { res.status(404).send(error.message); }
            });
        }
    }});
    const {base, close} = await listen(app);
    const request = (url, headers = {}) => fetch(base + url, {headers, redirect: 'manual'});
    //cookie браузера, вошедшего в профиль userId ('' - без входа)
    const session = (userId = '') => sessionCookie(security, userId);
    //клиент браузера: cookie обновляется из ответов (вход ставит новую), заголовки headers - в каждом запросе
    const client = (headers = {}) => new ApiTestClient(base, {headers});
    //запрос как от Api.vue: профиль - по cookie, CSRF-токен - текущей сессии (csrfToken: null - без него);
    //ответ - тело (JSON), в том числе {error}
    const connect = async(headers = {}) => {
        const api = client(headers);
        const call = async({action, csrfToken, ...params}) =>
            (await api.call(action, params, {csrfToken: (csrfToken === null ? null : undefined)})).body;
        call.api = api;
        return call;
    };
    //новый браузер, вошедший через login-user-profile
    const signIn = async(login, password) => {
        const call = await connect();
        const result = await call({action: 'login-user-profile', login, password});
        assert.ok(!result.error, result.error);
        return call;
    };
    try {
        await test({config, worker, security, access, alice, bob, request, session, client, connect, signIn, base});
    } finally {
        await close();
        await fs.remove(dir);
    }
}

async function testProxyHeaderRequiredWithOldCookie() {
    await fixture({requireAuth: true, authMode: 'proxy', trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']}, async({security, request, client, connect}) => {
        // the cookie that older versions signed for a proxy user
        const issuedAt = Date.now();
        const cookie = `inpx_web_proxy_auth=alice.${issuedAt}.${security.sign(`proxy:alice:${issuedAt}`)}; broken=%ZZ`;
        const headers = {'Remote-User': 'alice', cookie};
        const ok = await request('/', headers);
        assert.strictEqual(ok.status, 200);
        assert.ok(!(ok.headers.get('set-cookie') || '').includes('inpx_web_proxy_auth'));
        assert.strictEqual((await request('/', {cookie})).status, 401);
        assert.strictEqual((await client({cookie}).request('GET', 'api/ping')).status, 401, 'The API needs the proxy header too');
        assert.ok(!(await (await connect(headers))({action: 'test'})).error);
        security.trustedProxyRanges = new Security({trustedProxyCidrs: ['10.0.0.0/8']}).trustedProxyRanges;
        assert.strictEqual((await request('/', headers)).status, 403);
    });
}

async function testAnonymousAccessDisabledHttpAndApi() {
    //the removed allowAnonymousAccess switch must not open anything
    await fixture({allowAnonymousAccess: true}, async({worker, alice, request, session, connect}) => {
        assert.strictEqual((await request('/')).status, 200, 'Login shell stays reachable');
        for (const url of ['/book/fixture.txt', '/cover/by-uid?uid=x', '/opds'])
            assert.strictEqual((await request(url)).status, 401, url);
        const browser = session();
        const call = await connect({cookie: browser.cookie});
        const config = await call({action: 'get-config'});
        assert.strictEqual(config.profileLoginRequired, true);
        assert.deepStrictEqual(config.userProfiles, []);
        assert.strictEqual(config.dbConfig, undefined);
        const state = await call({action: 'get-worker-state', workerId: 'server_state'});
        assert.strictEqual(state.state, 'normal');
        assert.strictEqual(state.fileName, undefined);
        for (const action of ['catalog-search', 'get-user-profiles', 'get-reading-lists', 'create-reading-list', 'get-admin-dashboard']) {
            const response = await call.api.call(action, {});
            assert.deepStrictEqual([response.status, response.body.error], [401, 'need_profile_login'], action);
        }
        const bad = await call({action: 'login-user-profile', login: 'alice', password: 'wrong'});
        assert.match(bad.error, /Неверный/);
        const login = await call({action: 'login-user-profile', login: 'alice', password: 'alice-fixture'});
        assert.strictEqual(login.userId, alice.id);
        assert.notStrictEqual(call.api.cookie, browser.cookie, 'The login response sets a new session cookie');
        browser.cookie = call.api.cookie;
        const authed = await call({action: 'get-config'});
        assert.strictEqual(authed.currentUserId, alice.id);
        assert.strictEqual(authed.profileAuthorized, true);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 200);
        assert.strictEqual((await request('/opds?user=bob', {cookie: browser.cookie})).status, 401);
        assert.strictEqual((await (await request('/opds', {cookie: browser.cookie})).json()).user, alice.id);
        await call({action: 'logout-user-profile'});
        //сервер сессий не хранит: копия cookie действует до своих сроков (docs/auth-monitoring.md)
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 200, 'A copy of the cookie');
        assert.strictEqual((await request('/book/fixture.txt', {cookie: call.api.cookie})).status, 401, 'The cookie after logout');
        assert.strictEqual((await call({action: 'get-reading-lists'})).error, 'need_profile_login');
        await worker.updateUserProfile(alice.id, {passwordHash: await worker.hashProfilePassword('alice', 'alice-changed')});
        assert.strictEqual((await request('/book/fixture.txt', {cookie: browser.cookie})).status, 401, 'A password change ends the copy too');
        const basic = {authorization: 'Basic ' + Buffer.from('alice:alice-opds-pass').toString('base64')};
        assert.strictEqual((await request('/book/fixture.txt', basic)).status, 200);
        assert.strictEqual((await (await request('/opds', basic)).json()).user, alice.id);
        assert.strictEqual((await request('/opds?user=bob', basic)).status, 403);
    });
}

async function testProxyProfileBindingAndIdentityChange() {
    await fixture({authMode: 'proxy', proxyBindProfile: true, trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32']},
        async({config, security, worker, alice, bob, request, session, connect}) => {
            assert.strictEqual((await request('/')).status, 401, 'Binding itself requires trusted SSO identity');
            const browser = session('admin');
            const headers = {cookie: browser.cookie, 'Remote-User': ' ALICE '};
            const call = await connect(headers);
            const authed = await call({action: 'get-config'});
            assert.strictEqual(authed.currentUserId, alice.id);
            assert.strictEqual(authed.profileBoundId, alice.id);
            assert.strictEqual(authed.profileAuthorized, true, 'SSO avoids a second password prompt');
            assert.deepStrictEqual(authed.userProfiles.map(user => user.id), [alice.id]);
            assert.strictEqual(authed.userProfiles[0].requiresLogin, false);
            assert.strictEqual(authed.currentUserProfile.emailTo, 'alice@example.test');
            assert.strictEqual((await request('/admin-backups/fixture.zip', headers)).status, 403, 'Stale admin cookie cannot grant backup access');
            //вход паролем из cookie привязка убирает: без заголовка SSO-профиля он не вернётся
            assert.strictEqual(security.getSession({headers: {cookie: call.api.cookie}}).uid, '');
            headers.cookie = call.api.cookie;
            const renamed = await call({action: 'update-user-profile', targetUserId: alice.id, profile: {login: 'changed'}});
            assert.match(renamed.error, /закреплён/);
            assert.match((await call({action: 'login-user-profile', login: 'bob', password: 'ignored'})).error, /закреплён/);
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
            const bobCall = await connect({...headers, 'Remote-User': 'bob'});
            const bobConfig = await bobCall({action: 'get-config'});
            assert.strictEqual(bobConfig.currentUserId, bob.id);
            assert.strictEqual(bobConfig.currentUserProfile.emailTo, 'bob@example.test');
            const adminHeaders = {...headers, 'Remote-User': 'admin'};
            const adminCall = await connect(adminHeaders);
            const adminConfig = await adminCall({action: 'get-config'});
            assert.strictEqual(adminConfig.currentUserProfile.isAdmin, true);
            assert.ok(adminConfig.userProfiles.some(user => user.id === bob.id), 'Bound admins retain profile management');
            assert.strictEqual((await request('/admin-backups/fixture.zip', adminHeaders)).status, 200);
            const unknownCall = await connect({...headers, 'Remote-User': 'unmapped'});
            const legacy = await unknownCall({action: 'get-config'});
            assert.deepStrictEqual([legacy.profileLoginRequired, legacy.currentUserId], [true, ''], 'Unmapped SSO user must log in');
            await worker.deleteUserProfile(alice.id);
            const removed = await call({action: 'get-config'});
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
    await fixture({kosyncEnabled: true}, async({worker, alice, bob, connect, signIn, session}) => {
        worker.koboService = {createDevice: async() => ({device: {}}), regenerateToken: async() => ({device: {}})};
        const asBob = await connect({cookie: session(bob.id).cookie});
        const update = (profile, as = asBob, targetUserId = bob.id) => as({action: 'update-user-profile', targetUserId, profile});
        for (const profile of [{password: 'taken-over'}, {login: 'bobby'}, {login: 'bobby', password: 'taken-over'}, {login: ''}])
            assert.match((await update(profile)).error || '', /administrator|администратор/, JSON.stringify(profile));
        for (const action of ['create-kobo-device', 'regenerate-kobo-device-token', 'create-kosync-password'])
            assert.match((await asBob(Object.assign({action}, sampleParams(action)))).error || '', /administrator|администратор/, action);
        const renamed = await update({name: 'Bobby', login: 'BOB'});
        assert.strictEqual(renamed.user && renamed.user.name, 'Bobby', JSON.stringify(renamed), 'Name and other settings stay editable');
        assert.strictEqual((await worker.readingListStore.getUser(bob.id)).passwordHash, '');

        const asAlice = await signIn('alice', 'alice-fixture');
        assert.ok((await asAlice({action: 'create-kosync-password'})).password, 'A protected profile makes its own');
        assert.match((await update({password: 'new-password'}, asAlice, alice.id)).error, /current password|текущий пароль/);
        assert.match((await update({password: 'new-password', currentPassword: 'wrong'}, asAlice, alice.id)).error, /current password|текущий пароль/);
        assert.ok(!(await update({password: 'new-password', currentPassword: 'alice-fixture'}, asAlice, alice.id)).error);
        assert.ok(await worker.readingListStore.verifyUserPassword(alice.id, 'new-password'));

        const asAdmin = await signIn('admin', 'admin-fixture');
        assert.strictEqual((await update({login: 'bobby', password: 'bob-password'}, asAdmin)).user.login, 'bobby', 'The admin sets credentials');
        assert.ok(!(await update({password: 'alice-reset'}, asAdmin, alice.id)).error, 'The admin needs no current password of others');
    });
}

// Book delivery: one recipient, only from a profile with a password (or an admin), at most deliveryRateLimit sends an hour.
async function testDeliveryNeedsPasswordOneRecipientAndRate() {
    const options = {emailShareEnabled: true, smtpHost: '127.0.0.1', telegramShareEnabled: true, telegramBotToken: 'test', deliveryRateLimit: 2};
    await fixture(options, async({worker, security, alice, bob, connect, signIn, session, base}) => {
        worker.getPreparedBookFile = async() => { throw new Error('PREPARE_STUB'); };
        const asBob = await connect({cookie: session(bob.id).cookie});
        const update = (targetUserId, profile, as) => as({action: 'update-user-profile', targetUserId, profile});
        assert.strictEqual((await asBob({action: 'get-config'})).emailShareEnabled, false);
        assert.match((await update(bob.id, {emailTo: 'relay@example.test'}, asBob)).error, /password|паролем/);
        assert.match((await update(bob.id, {telegramChatId: '42'}, asBob)).error, /password|паролем/);
        assert.match((await asBob({action: 'send-book-email', bookUid})).error, /password|паролем/);
        assert.strictEqual((await update(bob.id, {name: 'Bobby', emailTo: 'bob@example.test'}, asBob)).user.name, 'Bobby', 'Unchanged address is no change');

        const asAlice = await signIn('alice', 'alice-fixture');
        assert.strictEqual((await asAlice({action: 'get-config'})).emailShareEnabled, true);
        for (const emailTo of ['a@example.test, b@example.test', 'a@example.test;b@example.test', 'a@example.test\nBcc: b@example.test', 'nobody', '<a@example.test>'])
            assert.match((await update(alice.id, {emailTo}, asAlice)).error, /one email|один адрес/, emailTo);
        assert.strictEqual((await update(alice.id, {emailTo: 'alice2@example.test', telegramChatId: '42'}, asAlice)).user.emailTo, 'alice2@example.test');
        for (let i = 0; i < 2; i++)
            assert.match((await asAlice({action: i ? 'send-book-telegram' : 'send-book-email', bookUid})).error, /PREPARE_STUB/);
        for (const action of ['send-book-email', 'send-book-telegram'])
            assert.match((await asAlice({action, bookUid})).error, /2 per hour|2 в час/, action);

        //a profile backup imported into an open profile brings no delivery addresses (nor Kobo tokens)
        const uploader = ApiTestClient.forSession(base, security, bob.id);
        const imported = await uploader.call('import-reading-lists', {}, {body: JSON.stringify({lists: [],
            user: {emailTo: 'relay@example.test', telegramChatId: '42'}, kobo: {devices: []}})});
        assert.strictEqual(imported.status, 200, imported.text);
        const stored = await worker.readingListStore.getUser(bob.id);
        assert.deepStrictEqual([stored.emailTo, stored.telegramChatId], ['bob@example.test', '']);

        const asAdmin = await signIn('admin', 'admin-fixture');
        assert.strictEqual((await update(bob.id, {emailTo: 'bob2@example.test'}, asAdmin)).user.emailTo, 'bob2@example.test');
        await assert.rejects(worker.readingListStore.updateUser(bob.id, {emailTo: 'a@example.test,b@example.test'}), /один адрес|one email/);
    });
}

// A cookie that fails verification (the format of earlier versions, another session-secret) is replaced by the next API response.
async function testStaleCookieReplacedByApi() {
    await fixture({}, async({security, client}) => {
        const stale = `inpx_web_session=${'a'.repeat(48)}.${security.sign('a'.repeat(48))}`;
        const api = client({cookie: stale});
        const response = await api.request('GET', 'api/ping');
        assert.strictEqual(response.status, 200);
        assert.match(String(response.headers.get('set-cookie')), /^inpx_web_session=/);
        assert.notStrictEqual(api.cookie, stale);
        assert.ok(security.getSession({headers: {cookie: api.cookie}}), 'The new cookie verifies');
        const fresh = client();
        assert.match(String((await fresh.request('GET', 'api/ping')).headers.get('set-cookie')), /^inpx_web_session=/, 'No cookie at all');
    });
}

// A login starts a new session (new sid) and sets the new cookie in its own response: a cookie planted before it
// (session fixation) does not get the login.
async function testLoginRotatesSession() {
    await fixture({}, async({security, alice, request, session, connect}) => {
        const planted = session();
        const call = await connect({cookie: planted.cookie});
        const login = await call.api.call('login-user-profile', {login: 'alice', password: 'alice-fixture'});
        assert.strictEqual(login.status, 200, login.text);
        assert.deepStrictEqual(login.body, {userId: alice.id}, 'No token in the answer');
        const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^inpx_web_session=/);
        assert.strictEqual(call.api.cookie, cookie);
        const signed = security.getSession({headers: {cookie}});
        assert.notStrictEqual(signed.sid, planted.session.sid);
        assert.strictEqual(signed.uid, alice.id);
        assert.strictEqual((await request('/book/fixture.txt', {cookie: planted.cookie})).status, 401, 'The planted cookie');
        assert.strictEqual((await (await connect({cookie: planted.cookie}))({action: 'get-config'})).profileAuthorized, false);
        assert.strictEqual((await request('/book/fixture.txt', {cookie})).status, 200, 'The new cookie');
        const reloaded = await (await connect({cookie}))({action: 'get-config'});
        assert.deepStrictEqual([reloaded.profileAuthorized, reloaded.currentUserId], [true, alice.id], 'A reload stays signed in');
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
    await fixture({}, async({bob, request, session, connect, signIn}) => {
        const call = await signIn('alice', 'alice-fixture');
        const basic = password => ({authorization: 'Basic ' + Buffer.from(`alice:${password}`).toString('base64')});
        const generated = await call({action: 'set-opds-password'});
        assert.strictEqual(generated.username, 'alice');
        assert.strictEqual(generated.password.length, 16);
        assert.strictEqual((await request('/opds', basic(generated.password))).status, 200);
        assert.strictEqual((await request('/opds', basic('alice-opds-pass'))).status, 401, 'The old one stops working');
        assert.match((await call({action: 'set-opds-password', password: 'short'})).error, /10/);
        const own = await call({action: 'set-opds-password', password: 'my-own-opds-pass'});
        assert.strictEqual(own.password, '', 'A chosen password is not sent back');
        assert.strictEqual((await request('/opds', basic('my-own-opds-pass'))).status, 200);
        const bobCall = await connect({cookie: session(bob.id).cookie});
        assert.match((await bobCall({action: 'set-opds-password'})).error, /.+/, 'A profile without a password');
    });
}

// A client cannot widen the store lookup to someone else's list.
async function testForeignListNotReadable() {
    await fixture({}, async({worker, alice, bob, connect, session}) => {
        const secret = await worker.readingListStore.createList(alice.id, 'Alice private list');
        const call = await connect({cookie: session(bob.id).cookie});
        for (const options of [undefined, {allowForeign: true}, {allowForeign: true, visibility: 'private'}]) {
            const response = await call({action: 'get-reading-list', listId: secret.id, options});
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
    await fixture({}, async({config, worker, alice, bob, signIn}) => {
        const admin = await signIn('admin', 'admin-fixture');
        const update = (targetUserId, profile, as = admin) => as({action: 'update-user-profile', targetUserId, profile});

        assert.match((await update(bob.id, {isAdmin: true})).error, /login and password|логин и пароль/);
        assert.strictEqual((await update(alice.id, {isAdmin: true})).user.isAdmin, true);
        const asAlice = await signIn('alice', 'alice-fixture');
        assert.strictEqual((await asAlice({action: 'get-config'})).currentUserProfile.isAdmin, true);
        assert.strictEqual((await update(alice.id, {isAdmin: false}, asAlice)).user.isAdmin, true, 'Own role is not changed');
        assert.strictEqual((await update(alice.id, {isAdmin: false})).user.isAdmin, false);
        assert.match((await update('admin', {isAdmin: false}, asAlice)).error, /.+/, 'A reader cannot change roles');
        await worker.readingListStore.updateUser(alice.id, {isAdmin: true});
        assert.match((await update('admin', {isAdmin: false}, asAlice)).error, /main administrator|главного администратора/);
        const profiles = (await worker.getUserProfiles()).users;
        assert.deepStrictEqual(profiles.filter(item => item.mainAdmin).map(item => item.id), ['admin']);
        const created = await asAlice({action: 'create-user-profile', profile: {name: 'Dora', login: 'dora', password: 'dora-password', isAdmin: true}});
        assert.strictEqual(created.user.isAdmin, true);
        assert.deepStrictEqual(['passwordHash', 'sessionsValidAfter'].filter(key => Object.hasOwn(created.user, key)), [], 'No secrets in the answer');
        assert.match((await asAlice({action: 'create-user-profile', profile: {name: 'Eve', isAdmin: true}})).error, /.+/);
        assert.match((await asAlice({action: 'create-user-profile', profile: {name: 'Fay', login: 'fay'}})).error, /login and password|логин и пароль/, 'No password without SSO');
        assert.ok(config);
    });
}

// Администратор правит профиль только по точному id: логин или неизвестный id - ошибка, а не другой профиль
async function testAdminEditNeedsExactProfileId() {
    await fixture({}, async({worker, alice, signIn}) => {
        const admin = await signIn('admin', 'admin-fixture');
        const update = (targetUserId, profile) => admin({action: 'update-user-profile', targetUserId, profile});

        assert.match((await update('no-such-user', {name: 'Hijacked'})).error, /not found|не найден/);
        assert.notStrictEqual((await worker.readingListStore.getUser('admin')).name, 'Hijacked', 'The main admin is not edited');
        const asAlice = await signIn('alice', 'alice-fixture');
        assert.match((await update('alice', {password: 'alice-new-password'})).error, /not found|не найден/, 'A login is not an id');
        assert.strictEqual((await update(alice.id, {password: 'alice-new-password'})).user.id, alice.id);
        assert.strictEqual((await asAlice({action: 'get-config'})).profileAuthorized, false, 'The new password signs Alice out');
    });
}

// Guest access (web): the catalog without a profile. A guest never acts as a profile, not even a passwordless one,
// and gets nothing of a profile: lists, progress, admin, the profile list.
async function testGuestAccessWeb() {
    await fixture({guestAccess: true}, async({config, worker, bob, request, session, connect}) => {
        const calls = [];
        worker.catalogSearch = {status: () => ({enabled: true, ready: true}), authorNames: {info: async() => ({ready: true})},
            search: async(options) => { calls.push(['search', options]); return {rows: ['ROW']}; }};
        worker.getDiscoveryShelvesV2 = async(options) => { calls.push(['shelves', options]); return {shelves: []}; };
        worker.recordDiscoveryEvents = async() => { calls.push(['events']); return {}; };
        await worker.readingListStore.createList(bob.id, 'Bob private list', 'private');

        const call = await connect({cookie: session().cookie});
        const guestConfig = await call({action: 'get-config'});
        assert.deepStrictEqual([guestConfig.profileLoginRequired, guestConfig.guest, guestConfig.profileAuthorized], [false, true, false]);
        assert.deepStrictEqual([guestConfig.userProfiles, guestConfig.currentUserId, guestConfig.currentUserProfile], [[], '', null]);
        assert.strictEqual(guestConfig.adminGuestAccess, undefined);

        assert.deepStrictEqual((await call({action: 'catalog-search', q: 'x'})).rows, ['ROW']);
        assert.deepStrictEqual((await call({action: 'get-reading-lists'})).lists, [], 'Not the lists of the passwordless profile');
        assert.ok(!(await call({action: 'get-book-states', bookUids: ['a']})).error);
        assert.ok(!(await call({action: 'record-discovery-events', events: [{bookUid: 'a', type: 'open'}]})).error);
        await call({action: 'get-discovery-shelves', section: 'personal', forceRefresh: true, externalSource: 'none'});
        const shelves = calls.find(item => item[0] === 'shelves')[1];
        assert.deepStrictEqual([shelves.section, shelves.userId, shelves.forceRefresh, shelves.externalSource], ['external', undefined, false, undefined]);
        assert.ok(!calls.some(item => item[0] === 'events'), 'Guest events are not stored');
        for (const action of ['get-user-profiles', 'get-reading-list', 'create-reading-list', 'get-reader-state', 'update-reader-progress',
            'get-reading-now', 'update-discovery-preferences', 'get-admin-dashboard', 'update-admin-guest-access']) {
            const response = await call.api.call(action, sampleParams(action));
            assert.deepStrictEqual([response.status, response.body.error], [401, 'need_profile_login'], action);
        }

        assert.strictEqual((await request('/book/fixture.txt')).status, 200);
        assert.notStrictEqual((await request('/cover/by-uid?uid=x')).status, 401);
        assert.strictEqual((await request('/book/fixture.txt?user=bob')).status, 401, 'A guest names no profile');
        const wrong = {authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64')};
        assert.strictEqual((await request('/book/fixture.txt', wrong)).status, 401, 'Wrong credentials are not a guest');
        assert.strictEqual((await request('/admin-backups/fixture.zip')).status, 401);
        assert.strictEqual((await request('/opds')).status, 401, 'OPDS has its own switch');

        config.guestAccess = false;
        assert.strictEqual((await call({action: 'get-config'})).profileLoginRequired, true);
        assert.strictEqual((await call({action: 'catalog-search', q: 'x'})).error, 'need_profile_login');
        assert.strictEqual((await request('/book/fixture.txt')).status, 401);
    });
}

// Guest access (OPDS): the catalog and downloads without credentials; profiles, lists and progress keep the Basic challenge.
async function testGuestAccessOpds() {
    await fixture({opds: {enabled: true, guestAccess: true}}, async({alice, request, session, connect}) => {
        assert.deepStrictEqual(await (await request('/opds')).json(), {user: ''});
        assert.strictEqual((await request('/book/fixture.txt')).status, 200);
        for (const url of ['/opds?user=bob', '/opds/reading-profiles', '/opds/reading-lists/list?id=x', '/opds/reading-lists/list/?id=x']) {
            const response = await request(url);
            assert.strictEqual(response.status, 401, url);
            assert.match(String(response.headers.get('www-authenticate')), /^Basic/, url);
        }
        const aliceBasic = {authorization: 'Basic ' + Buffer.from('alice:alice-opds-pass').toString('base64')};
        assert.strictEqual((await (await request('/opds', aliceBasic)).json()).user, alice.id);
        assert.strictEqual((await request('/opds', {authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64')})).status, 401);
        assert.strictEqual((await request('/admin-backups/fixture.zip')).status, 401);
        const config = await (await connect({cookie: session().cookie}))({action: 'get-config'});
        assert.strictEqual(config.profileLoginRequired, true, 'The web app has its own switch');
    });
}

// The admin switches web guest access; a reader cannot, and INPX_GUEST_ACCESS locks the switch.
async function testGuestAccessAdminToggle() {
    await fixture({}, async({config, worker, bob, session, connect}) => {
        worker.saveRuntimeConfigPatch = async(patch) => Object.assign(config, patch);
        worker.addAdminEvent = () => {};
        const call = await connect({cookie: session(bob.id).cookie});
        assert.match((await call({action: 'update-admin-guest-access', guestAccess: true})).error, /administrator|администратор/);
        assert.notStrictEqual(config.guestAccess, true);

        assert.ok(!(await call({action: 'login-user-profile', login: 'admin', password: 'admin-fixture'})).error);
        assert.deepStrictEqual((await call({action: 'get-config'})).adminGuestAccess, {guestAccess: false, guestAccessFromEnv: false});
        const updated = await call({action: 'update-admin-guest-access', guestAccess: true});
        assert.deepStrictEqual([updated.guestAccess, updated.guestAccessFromEnv], [true, false]);
        assert.strictEqual(config.guestAccess, true);
        process.env.INPX_GUEST_ACCESS = 'true';
        try {
            assert.match((await call({action: 'update-admin-guest-access', guestAccess: false})).error, /INPX_GUEST_ACCESS/);
            assert.strictEqual(config.guestAccess, true);
        } finally {
            delete process.env.INPX_GUEST_ACCESS;
        }
    });
}

// Every route without a profile: the login bootstrap reaches its handler, a guest also the catalog, everything else
// is 401 need_profile_login before the handler runs.
async function testAnonymousAndGuestRoutes() {
    const bootstrap = ['test', 'get-config', 'get-worker-state', 'login-user-profile', 'logout-user-profile'];
    const guest = bootstrap.concat(['get-author-book-list', 'get-author-info', 'get-series-book-list', 'get-genre-tree',
        'get-discovery-shelves', 'get-book-link', 'get-author-aliases', 'catalog-names', 'catalog-search', 'catalog-suggest',
        'get-book', 'get-book-info', 'get-book-states', 'get-reading-lists', 'record-discovery-events']);
    const check = async(api, allowed) => {
        for (const route of apiRoutes.routes) {
            const response = await api.call(route.action, sampleParams(route.action), {body: (route.upload ? '{}' : undefined)});
            if (allowed.includes(route.action))
                assert.notStrictEqual(response.body.error, 'need_profile_login', route.action);
            else
                assert.deepStrictEqual([response.status, response.body.error], [401, 'need_profile_login'], route.action);
        }
    };
    for (const guestAccess of [false, true]) {
        await fixture({guestAccess}, async({worker, client}) => {
            worker.getDiscoveryShelvesV2 = async() => ({shelves: []});
            await check(client(), guestAccess ? guest : bootstrap);
        });
    }
}

// The profile comes only from the session cookie: userId or a profile token in the body, the query or the headers
// (X-User-Id, X-Profile-Token of earlier versions) does not switch it.
async function testProfileComesFromCookieOnly() {
    await fixture({}, async({worker, alice, bob, session, client}) => {
        const store = worker.readingListStore;
        const owns = async(user, name) => (await store.getLists(user.id)).some(list => list.name === name);
        const asBob = client({cookie: session(bob.id).cookie});
        const fromBody = await asBob.call('create-reading-list', {name: 'From body', userId: alice.id});
        assert.ok([200, 400].includes(fromBody.status), fromBody.text);
        assert.strictEqual(await owns(alice, 'From body'), false, 'A userId in the body');
        assert.strictEqual(await owns(bob, 'From body'), fromBody.status === 200);
        const fromHeader = await asBob.call('create-reading-list', {name: 'From header'}, {headers: {'x-user-id': alice.id}});
        assert.strictEqual(fromHeader.status, 200, fromHeader.text);
        assert.deepStrictEqual([await owns(alice, 'From header'), await owns(bob, 'From header')], [false, true], 'X-User-Id is ignored');
        assert.strictEqual((await asBob.request('GET', `api/reading-lists?userId=${alice.id}`)).status, 400, 'A userId in the query');

        const aliceToken = session(alice.id).cookie.split('=')[1];
        const anonymous = client();
        const bodyToken = await anonymous.call('create-reading-list', {name: 'Body token', profileAccessToken: aliceToken});
        assert.notStrictEqual(bodyToken.status, 200, bodyToken.text);
        assert.strictEqual(await owns(alice, 'Body token'), false, 'A profile token in the body');
        assert.strictEqual((await anonymous.request('GET', `api/reading-lists?profileAccessToken=${aliceToken}`)).status, 400);
        const headerToken = await anonymous.call('create-reading-list', {name: 'Header token'}, {headers: {'x-profile-token': aliceToken}});
        assert.deepStrictEqual([headerToken.status, headerToken.body.error], [401, 'need_profile_login'], 'X-Profile-Token is ignored');
        assert.strictEqual(await owns(alice, 'Header token'), false);
    });
}

// The OPDS scope guard and the pages must pick the same profile: an id wins over another profile's equal login.
async function testOpdsUserPrefersIdOverLogin() {
    await fixture({}, async({worker, alice, bob}) => {
        const store = worker.readingListStore;
        const data = await store.load();
        data.users.find(user => user.id === alice.id).login = bob.id;
        await store.save(data);
        assert.ok(data.users.findIndex(user => user.id === alice.id) < data.users.findIndex(user => user.id === bob.id));
        assert.strictEqual((await store.getOpdsUser(bob.id)).id, bob.id);
        assert.strictEqual((await store.resolveUser(bob.id)).user.id, bob.id);
    });
}

module.exports = [testAnonymousAndGuestRoutes, testProfileComesFromCookieOnly, testGuestAccessWeb, testGuestAccessOpds, testGuestAccessAdminToggle,
    testUnknownLoginTakesAsLong, testSetOpdsPassword, testOpdsAuthenticationRateLimit, testPasswordLengthAndPerLoginThrottle, testStaleCookieReplacedByApi, testLoginRotatesSession, testDeliveryNeedsPasswordOneRecipientAndRate, testOpenProfileCredentialsAdminOnly, testForeignListNotReadable, testOpdsHidesPasswordProfiles, testAdminRoleToggle, testAdminEditNeedsExactProfileId, testInvalidStoredRowsAreRepairedNotDropped,
    testOpdsScopeNeedsAnOpdsProfile, testProxyHeaderRequiredWithOldCookie, testAnonymousAccessDisabledHttpAndApi,
    testProxyProfileBindingAndIdentityChange, testGlobalOpdsCredentials, testOpdsUserPrefersIdOverLogin];
