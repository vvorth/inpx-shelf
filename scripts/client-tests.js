const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const vm = require('vm');

// Запускает client/assets/sw.js в песочнице с каталогом сборки, подставленным как при сборке; cache - ключи-пути.
async function loadServiceWorker(response, scope = 'http://host/') {
    const appDir = require('../build/appdir');
    const source = (await fs.readFile(path.resolve(__dirname, '../client/assets/sw.js'), 'utf8')).replace(/__INPX_WEB_APP_DIR__/g, appDir);
    const listeners = {};
    const cache = new Map();
    const fetched = [];
    const keyOf = (request) => (typeof request === 'string' ? request : new URL(request.url).pathname);
    const self = {
        registration: {scope},
        location: {origin: 'http://host'},
        addEventListener: (type, fn) => { listeners[type] = fn; },
    };
    const caches = {
        open: async() => ({put: async(request, value) => { cache.set(keyOf(request), value); }}),
        match: async(request) => cache.get(keyOf(request)),
    };
    vm.runInNewContext(source, {self, caches, URL, Request: function(request) { return request; },
        fetch: async(request) => { fetched.push(keyOf(request)); return response; }});
    //ответ worker'а или null, если запрос он не перехватил
    const handle = (request) => {
        let responded = null;
        listeners.fetch({request: Object.assign({method: 'GET', mode: 'cors', headers: {}}, request), respondWith: (p) => { responded = p; }});
        return responded;
    };
    return {source, appDir, cache, fetched, handle};
}

// Возвращает ключи, которые попали в кэш после навигации.
async function runServiceWorkerNavigation(pathname, contentType, status = 200) {
    const response = {
        ok: status >= 200 && status < 300,
        headers: {get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null)},
        clone() { return this; },
    };
    const sw = await loadServiceWorker(response);
    assert.strictEqual(await sw.handle({mode: 'navigate', url: `http://host${pathname}`}), response);
    await new Promise(resolve => setImmediate(resolve));
    return [...sw.cache.keys()];
}

// Скачивание книги или резервной копии (в ней secret.key) — тоже навигация: оно не должно оседать в кэше как index.html.
async function testServiceWorkerCachesOnlyAppShellNavigation() {
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html; charset=utf-8'), ['/index.html']);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/admin-backups/backup.zip', 'application/zip'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/book/1.fb2', 'application/octet-stream'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/app-reset', 'text/html'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html', 503), []);
}

// API, OPDS и прочие ответы сервера worker не трогает: Cache API не знает no-store, и после выхода из профиля
// следующий получил бы чужие конфиг, списки и панель администратора. Кэшируются только файлы сборки.
async function testServiceWorkerCachesOnlyBuildFiles() {
    const response = {ok: true, headers: {get: () => 'application/json'}, clone() { return this; }};
    for (const base of ['', '/root']) {
        const sw = await loadServiceWorker(response, `http://host${base}/`);
        assert.ok(!sw.source.includes(`/${sw.appDir}`), 'rootPath rewrite at extraction must not touch the worker');
        //запись старого worker'а не отдаётся
        sw.cache.set(`${base}/api/config`, {stale: true});
        assert.strictEqual(sw.handle({url: `http://host${base}/api/config`, headers: {'X-Inpx-Api': '1'}}), null);
        for (const pathname of ['/api/me/library', '/opds/', '/opds/search?term=x', '/remote/api/config', '/kosync/users/auth',
            '/admin-backups/backup.zip', '/book/1.fb2', '/cover/1.jpg', '/robots.txt'])
            assert.strictEqual(sw.handle({url: `http://host${base}${pathname}`}), null, pathname);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual([...sw.cache.keys()], [`${base}/api/config`]);
        assert.deepStrictEqual(sw.fetched, []);

        const asset = `${base}/${sw.appDir}/bundle.0123abcd.js`;
        assert.strictEqual(await sw.handle({url: `http://host${asset}`}), response);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(sw.cache.has(asset));
        assert.strictEqual(await sw.handle({url: `http://host${asset}`}), response);
        assert.deepStrictEqual(sw.fetched, [asset], 'The second request is served from the cache');
    }
}

// Загружает ES-модуль клиента (client/share/*.js, <script> компонента .vue) в песочнице: импорты заменяются заглушками из imports.
async function loadClientModule(file, imports = {}) {
    let source = await fs.readFile(path.resolve(__dirname, '../client', file), 'utf8');
    if (file.endsWith('.vue'))
        source = source.match(/<script>([\s\S]*?)<\/script>/)[1];
    const names = [];
    source = source.replace(/^import\b[\s\S]*?['"][^'"\n]+['"];?[ \t]*$/gm, '').replace(/^export default /gm, '').replace(/^export (async function|function|const|let|class) (\w+)/gm, (m, kind, name) => {
        names.push(name);
        return `${kind} ${name}`;
    });
    return vm.runInNewContext(`${source}\n({${names.join(', ')}})`, Object.assign({}, imports));
}

// «Языки книг» без выбора - все языки: язык интерфейса не должен прятать книги на других языках.
async function testBookLanguagesDefaultToAll() {
    const session = {isSignedIn: config => !!config.signedIn, currentProfile: config => config.profile || {}};
    const {myLanguages, languageMatches, langDefaultFor} = await loadClientModule('share/languages.js', Object.assign({getLang: () => 'en'}, session));

    const guest = myLanguages({}, {});
    assert.strictEqual(guest.all, true);
    assert.ok(languageMatches({lang: 'ru'}, guest));
    assert.strictEqual(langDefaultFor(guest), '');
    assert.strictEqual(myLanguages({signedIn: true, profile: {libraryLanguages: []}}, {}).all, true);
    assert.strictEqual(myLanguages({}, {libraryLanguages: ['*']}).all, true);

    const chosen = myLanguages({signedIn: true, profile: {libraryLanguages: ['RU']}}, {libraryLanguages: ['en']});
    assert.strictEqual(chosen.all, false);
    assert.deepStrictEqual([...chosen.list], ['ru']);
    assert.ok(languageMatches({lang: 'ru'}, chosen));
    assert.ok(!languageMatches({lang: 'en'}, chosen));
}

// Ошибка запроса как строка: ключ ошибки клиента или 'no error'
async function failure(promise) {
    try {
        await promise;
    } catch (e) {
        return String(e && e.message !== undefined ? e.message : e);
    }
    return 'no error';
}

// HTTP API клиента: адрес и метод по shared/apiRoutes.js; обрыв связи, тайм-аут и не-JSON ответ (страница прокси) -
// ключи ошибок, JSON-ответ сервера, в том числе с ошибкой, возвращается как есть.
async function testApiConnectionMapsErrors() {
    const apiRoutes = require('../shared/apiRoutes');
    const requests = [];
    let reply;
    const location = {href: 'http://host/', origin: 'http://host', pathname: '/', protocol: 'http:', host: 'host'};
    const {call} = await loadClientModule('components/Api/apiConnection.js', Object.assign({apiRoutes}, apiRoutes, {
        fetch: (url, init = {}) => {
            requests.push({url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body});
            return reply(init);
        },
        AbortController, AbortSignal, DOMException, Headers, Response, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout,
        console, window: {location}, location,
    }));
    const json = (status, body) => () => Promise.resolve(new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}}));
    const plain = value => JSON.parse(JSON.stringify(value));

    reply = json(200, {rows: [1]});
    assert.deepStrictEqual(plain(await call('catalog-search', {q: 'x', limit: 5})), {rows: [1]});
    let sent = requests.pop();
    assert.strictEqual(sent.method, 'GET');
    assert.match(sent.url, /(^|\/)api\/catalog\/search\?/);
    assert.deepStrictEqual(Object.fromEntries(new URL(sent.url, 'http://host/').searchParams), {q: 'x', limit: '5'});
    assert.strictEqual(sent.headers.get('x-inpx-api'), '1');
    assert.ok(sent.body === undefined || sent.body === null);

    reply = json(200, {ok: true});
    //bookUid - в пути (base64url), остальное - тело
    const bookUid = require('crypto').createHash('sha256').update('book').digest('base64');
    const progress = {progress: {percent: 0.5}};
    assert.strictEqual((await call('update-reader-progress', Object.assign({bookUid}, progress), {headers: {'X-CSRF-Token': 'csrf'}})).ok, true);
    sent = requests.pop();
    assert.strictEqual(sent.method, 'PATCH');
    assert.strictEqual(sent.url, `api/books/${bookUid.replace(/\+/g, '-').replace(/\//g, '_').slice(0, 43)}/progress`);
    assert.match(String(sent.headers.get('content-type')), /^application\/json/);
    assert.strictEqual(sent.headers.get('x-csrf-token'), 'csrf');
    assert.strictEqual(sent.headers.get('x-inpx-api'), '1');
    assert.deepStrictEqual(JSON.parse(sent.body), progress);

    //DELETE - без тела
    await call('delete-reading-list', {listId: 'l1'});
    sent = requests.pop();
    assert.deepStrictEqual([sent.method, sent.url, sent.body], ['DELETE', 'api/reading-lists/l1', undefined]);

    //файл - тело запроса, скалярные параметры - в адресе
    await call('import-admin-backup', {scope: 'all'}, {body: 'FILE'});
    sent = requests.pop();
    assert.strictEqual(sent.method, 'POST');
    assert.match(sent.url, /(^|\/)api\/admin\/backups\/restore\?scope=all$/);
    assert.strictEqual(sent.headers.get('content-type'), 'application/octet-stream');
    assert.strictEqual(sent.body, 'FILE');

    reply = json(401, {error: 'need_profile_login'});
    assert.strictEqual((await call('get-reading-lists', {})).error, 'need_profile_login', 'A JSON error passes through');

    reply = () => Promise.reject(new TypeError('fetch failed'));
    assert.strictEqual(await failure(call('test', {})), 'errors.apiConnectFailed');

    //ответа нет: запрос прерывается по тайм-ауту
    let aborted = false;
    reply = init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('This operation was aborted', 'AbortError'));
    }));
    const started = Date.now();
    assert.strictEqual(await failure(call('test', {}, {timeoutSecs: 0.05})), 'errors.apiNoResponse');
    assert.ok(aborted, 'The request is aborted');
    assert.ok(Date.now() - started < 2000);

    //страница ошибки прокси вместо JSON
    reply = () => Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', {status: 502, headers: {'Content-Type': 'text/html'}}));
    assert.strictEqual(await failure(call('test', {})), 'errors.apiBadResponse');
    reply = () => Promise.resolve(new Response('not json', {status: 200, headers: {'Content-Type': 'application/json'}}));
    assert.strictEqual(await failure(call('test', {})), 'errors.apiBadResponse');
}

// Устаревший токен CSRF: конфиг обновляется один раз, потом ошибка. Браузер, который не хранит cookie сессии,
// иначе получал бы новую сессию на каждой попытке без конца.
async function testApiRequestRefreshesCsrfTokenOnce() {
    const apiRoutes = require('../shared/apiRoutes');
    const connection = await loadClientModule('share/connection.js', Object.assign({apiRoutes}, apiRoutes));
    let Api = null;
    let replies = [];
    let calls = 0;
    await loadClientModule('components/Api/Api.vue', Object.assign({}, connection, {
        vueComponent: cls => { Api = cls; },
        call: async() => {
            if (++calls > 5)
                throw new Error('looped');
            return replies.shift() || {error: 'bad_csrf_token'};
        },
    }));
    let refreshes = 0;
    const api = Object.assign(Object.create(Api.prototype), {
        authHeaders: () => ({}),
        connectionRestored() {},
        connectionLost() {},
        updateConfig: async() => { refreshes++; },
    });

    assert.strictEqual(await failure(api.request({action: 'update-reading-list', listId: 'l1'})), 'bad_csrf_token');
    assert.deepStrictEqual({calls, refreshes}, {calls: 2, refreshes: 1});

    [calls, refreshes, replies] = [0, 0, [{error: 'bad_csrf_token'}, {ok: true}]];
    assert.strictEqual((await api.request({action: 'update-reading-list', listId: 'l1'})).ok, true);
    assert.deepStrictEqual({calls, refreshes}, {calls: 2, refreshes: 1});
}

// Ответы get-config пришли не по порядку: запоздавший ранний (гость при загрузке) не затирает конфиг после входа.
async function testApiDropsOutOfOrderConfig() {
    const apiRoutes = require('../shared/apiRoutes');
    const connection = await loadClientModule('share/connection.js', Object.assign({apiRoutes}, apiRoutes));
    let Api = null;
    await loadClientModule('components/Api/Api.vue', Object.assign({}, connection, {
        vueComponent: cls => { Api = cls; },
        packageJson: {version: 'test'},
    }));
    const pending = [];
    const committed = [];
    const api = Object.assign(Object.create(Api.prototype), {
        configSeq: 0,
        configAppliedSeq: 0,
        $store: {state: {settings: {currentUserId: 'reader'}}},
        $root: {stdDialog: {alert: message => { throw new Error(message); }}},
        getConfig: () => new Promise(resolve => pending.push(resolve)),
        commit: (name, value) => committed.push([name, value.currentUserId]),
    });

    const early = api.updateConfig();
    const login = api.updateConfig();
    pending[1]({currentUserId: 'reader', profileAuthorized: true});
    await login;
    pending[0]({currentUserId: 'guest', profileAuthorized: false});
    await early;
    assert.deepStrictEqual(committed, [['setConfig', 'reader']]);

    //по порядку - применяются оба
    const next = api.updateConfig();
    pending[2]({currentUserId: 'reader', profileAuthorized: true});
    await next;
    assert.strictEqual(committed.length, 2);
}

// Страницы библиотеки живут в фоне (keep-alive): после входа, выхода или смены профиля они не показывают
// прочитанное, прогресс и списки прежнего профиля, а запрашивают их заново.
async function testLibraryPagesDropPreviousProfileStates() {
    const session = await loadClientModule('share/session.js');
    const signedIn = id => ({currentUserId: id, profileAuthorized: true, currentUserProfile: {id}});
    assert.strictEqual(session.profileKey(signedIn('reader')), 'reader');
    assert.strictEqual(session.profileKey({currentUserId: 'reader', profileAuthorized: false, currentUserProfile: {id: 'reader'}}), '');
    assert.strictEqual(session.profileKey({currentUserId: 'guest', profileAuthorized: true, currentUserProfile: {id: 'guest', anonymousProfile: true}}), '');

    for (const file of ['SearchPage', 'BookPage', 'AuthorPage', 'SeriesPage']) {
        const source = await fs.readFile(path.resolve(__dirname, `../client/components/Library/${file}.vue`), 'utf8');
        const imports = {};
        for (const [, names] of source.matchAll(/^import\s+([\s\S]*?)\s+from\s/gm))
            for (const name of names.replace(/[{}]/g, '').split(',').map(item => item.trim().split(/\s+as\s+/).pop()).filter(Boolean))
                imports[name] = () => ({});
        let Page = null;
        await loadClientModule(`components/Library/${file}.vue`, Object.assign(imports, session, {vueComponent: cls => { Page = cls; }}));
        const page = new Page();
        const config = signedIn('second');
        const getter = Object.getOwnPropertyDescriptor(Page.prototype, 'profileKey').get;
        assert.strictEqual(getter.call({config, $store: {state: {config}}}), 'second', file);

        const loaded = [];
        const state = {
            states: {old: {read: true}}, inLists: ['Old list'], book: {_uid: 'b'}, books: [], editions: [], replacements: [], related: [],
            loadStates: async() => loaded.push('states'), loadLists: async() => loaded.push('lists'),
        };
        page._options.watch.profileKey.call(state);
        //объекты из песочницы - другого realm: сравниваем содержимое, а не прототипы
        assert.strictEqual(JSON.stringify(state.states), '{}', file);
        assert.ok(loaded.includes('states'), file);
        if (file === 'BookPage')
            assert.deepStrictEqual([JSON.stringify(state.inLists), loaded.includes('lists')], ['[]', true]);
    }
}

// Кнопка «очистить» в поиске: на странице поиска возвращает её к открытию «с нуля» (маршрут без запроса и фильтров),
// на остальных страницах только очищает поле; подсказки закрываются, устаревший ответ не возвращается.
async function testOmniboxClearResetsSearch() {
    let Omnibox = null;
    await loadClientModule('components/Shell/Omnibox.vue', {vueComponent: cls => { Omnibox = cls; }, t: key => key, bookAuthors: () => [], clearTimeout});
    const make = (path) => {
        const pushed = [];
        const calls = [];
        const state = {
            query: 'tolkien', activeIndex: 2, requestSeq: 5, timer: null,
            suggestion: {authors: [{name: 'a'}], series: [], books: [], corrected: 'x', layout: true},
            $route: {path, query: {q: 'tolkien', lang: 'en', sort: 'title'}},
            $router: {push: to => pushed.push(to)},
            $refs: {input: {focus: () => calls.push('focus')}},
        };
        Omnibox.prototype.clear.call(state);
        return {state, pushed, calls};
    };

    const onSearch = make('/search');
    assert.strictEqual(onSearch.state.query, '');
    assert.strictEqual(onSearch.state.activeIndex, -1);
    assert.strictEqual(onSearch.state.requestSeq, 6);
    assert.strictEqual(JSON.stringify(onSearch.state.suggestion), '{"authors":[],"series":[],"books":[],"corrected":"","layout":false}');
    assert.deepStrictEqual(onSearch.calls, ['focus']);
    assert.strictEqual(JSON.stringify(onSearch.pushed), '[{"path":"/search"}]');

    const elsewhere = make('/book/1');
    assert.strictEqual(elsewhere.state.query, '');
    assert.deepStrictEqual(elsewhere.calls, ['focus']);
    assert.strictEqual(elsewhere.pushed.length, 0);
}

// Пауза переподключения растёт вдвое до 30 с и случайно уменьшается не больше чем вдвое.
async function testConnectionErrorsAndReconnectDelay() {
    const apiRoutes = require('../shared/apiRoutes');
    const {isConnectionError, reconnectDelay} = await loadClientModule('share/connection.js', Object.assign({apiRoutes}, apiRoutes));
    for (const key of ['errors.apiConnectFailed', 'errors.apiNoResponse', 'errors.apiBadResponse']) {
        assert.ok(isConnectionError(new Error(key)), key);
        assert.ok(isConnectionError(key), key);
    }
    assert.ok(!isConnectionError(new Error('errors.bookNotFound')));
    assert.ok(!isConnectionError(new Error('need_profile_login')));
    assert.ok(!isConnectionError(new Error('')));
    assert.deepStrictEqual([0, 1, 2, 3, 10].map(attempt => reconnectDelay(attempt, () => 1)), [1000, 2000, 4000, 8000, 30000]);
    assert.strictEqual(reconnectDelay(2, () => 0), 2000);
}

// После ошибки связи повторяются GET, PUT и DELETE: их повтор даёт тот же результат. POST и PATCH могли дойти до сервера,
// повтор выполнил бы их дважды. Список действий не ведётся отдельно - правило задаёт метод маршрута.
async function testOnlyIdempotentRequestsAreRetried() {
    const apiRoutes = require('../shared/apiRoutes');
    const clientSource = await fs.readFile(path.resolve(__dirname, '../client/share/connection.js'), 'utf8');
    assert.doesNotMatch(clientSource, /retrySafeActions/);
    const {canRetryRequest} = await loadClientModule('share/connection.js', Object.assign({apiRoutes}, apiRoutes));
    for (const error of ['errors.apiConnectFailed', 'errors.apiNoResponse', 'errors.apiBadResponse']) {
        for (const route of apiRoutes.routes)
            assert.strictEqual(canRetryRequest(route.action, new Error(error)), ['GET', 'PUT', 'DELETE'].includes(route.method), `${route.action} after ${error}`);
    }
    assert.ok(canRetryRequest('catalog-search', new Error('errors.apiNoResponse')));
    for (const action of ['get-book-states', 'update-reading-list', 'login-user-profile', 'import-reading-lists'])
        assert.ok(!canRetryRequest(action, new Error('errors.apiConnectFailed')), action);
    for (const action of ['add-reading-list-book', 'mark-book-read', 'delete-reading-list'])
        assert.ok(canRetryRequest(action, new Error('errors.apiConnectFailed')), action);
    assert.ok(!canRetryRequest('catalog-search', new Error('errors.bookNotFound')));
    assert.ok(!canRetryRequest('catalog-search', new Error('need_profile_login')));
}

// В localStorage попадают только настройки: без конфигурации сервера (csrfToken, профили) и токена профиля;
// сохранённое прежними версиями целиком состояние отбрасывается при чтении.
async function testStorePersistsOnlySettings() {
    let options = null;
    class VuexPersistence {
        constructor(value) {
            options = value;
        }
    }
    const brokenStorage = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('blocked'); }};
    const window = {localStorage: brokenStorage};
    await loadClientModule('store/index.js', {VuexPersistence, createStore: value => value, root: {}, process: {env: {}}, window});
    // localStorage бросает исключения: хранилище отдаёт пустое значение и не падает
    assert.strictEqual(options.storage.getItem('vuex'), null);
    assert.doesNotThrow(() => options.storage.setItem('vuex', '{}'));
    assert.doesNotThrow(() => options.storage.removeItem('vuex'));
    assert.deepStrictEqual(Object.keys(options.restoreState('vuex', options.storage)), ['settings']);
    const written = [];
    window.localStorage = {getItem: key => `read:${key}`, setItem: (key, value) => written.push([key, value])};
    assert.strictEqual(options.storage.getItem('vuex'), 'read:vuex');
    options.storage.setItem('vuex', '{}');
    assert.deepStrictEqual(written, [['vuex', '{}']]);
    const state = {
        config: {csrfToken: 'csrf', userProfiles: [{id: 'admin'}]},
        settings: {accessToken: 'library-pass-hash', currentUserId: 'admin', profileAccessToken: 'profile-token', darkTheme: true},
    };
    const expected = {settings: {accessToken: 'library-pass-hash', currentUserId: 'admin', darkTheme: true}};
    assert.deepStrictEqual(JSON.parse(JSON.stringify(options.reducer(state))), expected);
    const storage = {getItem: () => JSON.stringify(state)};
    assert.deepStrictEqual(JSON.parse(JSON.stringify(options.restoreState('vuex', storage))), expected);
    assert.deepStrictEqual(Object.keys(options.restoreState('vuex', {getItem: () => '{broken'})), []);
}

// Старый адрес «=Имя» открывает страницу автора или серии: имя с / ? # % кодируется, чтобы vue-router не разобрал его как адрес.
async function testLegacyCatalogEncodesExactNames() {
    const noop = () => {};
    const router = {beforeEach: noop, afterEach: noop};
    const {authorRoute, seriesRoute} = await loadClientModule('share/bookActions.js', {utils: {}, t: noop, readerStorage: {}});
    const {legacyCatalog} = await loadClientModule('router.js', {
        createRouter: () => router, createWebHashHistory: noop, window: {addEventListener: noop}, document: {addEventListener: noop}, authorRoute, seriesRoute,
    });
    const name = 'AC/DC? #1 100%';
    assert.deepStrictEqual(JSON.parse(JSON.stringify(legacyCatalog({path: '/author', query: {author: `=${name}`}}))), {path: `/author/${encodeURIComponent(name)}`, query: {}});
    assert.strictEqual(legacyCatalog({path: '/series', query: {series: `=${name}`}}).path, `/series/${encodeURIComponent(name)}`);
    assert.strictEqual(legacyCatalog({path: '/author', query: {author: 'Tolstoy'}}).path, '/search');
}

// В сборку попадают только используемые иконки Line Awesome и стили используемых компонентов Quasar
// (build/css-subset-loader.js): иконка из кода не должна пропасть, а имя иконки - собираться на лету.
async function testCssSubsetKeepsUsedIconsAndComponents() {
    const subset = require('../build/css-subset-loader');
    const icons = subset.usedIcons();
    const css = await fs.readFile(require.resolve('@quasar/extras/line-awesome/line-awesome.css'), 'utf8');
    const kept = subset.lineAwesomeSubset(css, icons);
    for (const icon of ['la-check', 'la-times-circle', 'la-caret-down', 'la-spinner'])
        assert.ok(icons.has(icon), icon);
    for (const icon of icons) {
        if (css.includes(`.${icon}:before`))
            assert.ok(kept.includes(`.${icon}:before`), `${icon} is missing from the icon subset`);
        else
            assert.ok(new RegExp(`\\.${icon}[\\s{,]`).test(css), `${icon} is not a Line Awesome icon or class`);
    }
    assert.ok(!kept.includes('.la-500px:before'));
    assert.ok(kept.includes('.la.la-trash:before'));

    const clientDir = path.resolve(__dirname, '../client');
    const files = [];
    const walk = async(dir) => {
        for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory())
                await walk(fullPath);
            else if (/\.(vue|js)$/.test(entry.name))
                files.push(fullPath);
        }
    };
    await walk(clientDir);
    for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        assert.ok(!/la-\$\{|['"`]la-['"`]\s*\+/.test(text), `${path.relative(clientDir, file)}: icon name built at runtime`);
    }

    const quasarJs = await fs.readFile(path.join(clientDir, 'quasar.js'), 'utf8');
    for (const name of quasarJs.match(/\bQ[A-Z]\w+/g)) {
        const cssClass = name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
        assert.ok(!subset.unusedQuasarComponents.includes(cssClass), `${name} is registered, but its styles are cut by css-subset-loader`);
    }
    const quasarCss = subset.quasarSubset(await fs.readFile(require.resolve('quasar/dist/quasar.css'), 'utf8'));
    assert.ok(!quasarCss.includes('.q-date__'));
    for (const cssClass of ['.q-btn', '.q-btn-group', '.q-field', '.q-select', '.q-item', '.q-menu', '.q-dialog', '.q-notification', '.q-toggle', '.q-textarea'])
        assert.ok(quasarCss.includes(cssClass), cssClass);
}

// Браузер загружает словарь только выбранного языка: клиент берёт движок без словарей,
// а сервер (shared/i18n.js) - все языки из shared/locales.
async function testClientLoadsOnlySelectedLocale() {
    const engine = require('../shared/i18nEngine');
    const i18n = require('../shared/i18n');
    const files = (await fs.readdir(path.resolve(__dirname, '../shared/locales'))).map(name => path.basename(name, '.json'));
    assert.deepStrictEqual([...i18n.supportedLangs].sort(), files.sort());
    assert.deepStrictEqual(Object.keys(i18n.locales).sort(), files.sort());
    assert.strictEqual(engine, i18n);
    const client = await fs.readFile(path.resolve(__dirname, '../client/share/i18n.js'), 'utf8');
    assert.match(client, /from '\.\.\/\.\.\/shared\/i18nEngine\.js'/);
    assert.match(client, /import\(`\.\.\/\.\.\/shared\/locales\/\$\{lang\}\.json`\)/);
    assert.doesNotMatch(client, /shared\/i18n(\.js)?'/);
}

// Значок обновления: CalVer-версии сравниваются по числам, dev-сборка (метка после "+")
// не видит свой же релиз новым, а установки 1.x видят CalVer-релиз новее.
async function testReleaseVersionsCompareCalVer() {
    const {compareReleaseVersions} = require('../shared/release');
    assert.strictEqual(compareReleaseVersions('v26.10.10', '26.10.9'), 1);
    assert.strictEqual(compareReleaseVersions('v26.9.3', '26.10.0'), -1);
    assert.strictEqual(compareReleaseVersions('v26.10.0', '26.10.0+dev.b95beaa'), 0);
    assert.strictEqual(compareReleaseVersions('v26.10.1', '26.10.0+dev.b95beaa'), 1);
    assert.strictEqual(compareReleaseVersions('v26.10.0', '1.1.0-beta.1'), 1);
    assert.strictEqual(compareReleaseVersions('v26.10.0', '1.1.1-dev'), 1);
}

// Блокировка окна «сервер занят»: второй get() ждёт ret() первого; после errAll() и ret() она свободна для следующего
async function testLockQueueHandsOverAndFrees() {
    const LockQueue = require('../shared/LockQueue');
    const lock = new LockQueue(1);
    const order = [];
    await lock.get();
    const second = lock.get().then(() => order.push('second'));
    await assert.rejects(lock.get(), /too long/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(order, [], 'the second caller waits while the lock is held');
    lock.ret();
    await second;
    assert.deepStrictEqual(order, ['second']);

    const rejected = lock.get();
    lock.errAll();
    await assert.rejects(rejected, /rejected/);
    lock.ret();
    assert.strictEqual(lock.freed, true);
    await lock.get();
    assert.strictEqual(lock.freed, false);
}

module.exports = [testServiceWorkerCachesOnlyAppShellNavigation, testServiceWorkerCachesOnlyBuildFiles,
    testBookLanguagesDefaultToAll, testLockQueueHandsOverAndFrees,
    testApiConnectionMapsErrors, testApiRequestRefreshesCsrfTokenOnce, testApiDropsOutOfOrderConfig, testLibraryPagesDropPreviousProfileStates,
    testOmniboxClearResetsSearch, testConnectionErrorsAndReconnectDelay, testOnlyIdempotentRequestsAreRetried,
    testStorePersistsOnlySettings, testCssSubsetKeepsUsedIconsAndComponents, testClientLoadsOnlySelectedLocale,
    testLegacyCatalogEncodesExactNames, testReleaseVersionsCompareCalVer];
