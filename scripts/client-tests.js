const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const vm = require('vm');

// Запускает client/assets/sw.js в песочнице и возвращает ключи, которые попали в кэш после навигации.
async function runServiceWorkerNavigation(pathname, contentType, status = 200) {
    const source = await fs.readFile(path.resolve(__dirname, '../client/assets/sw.js'), 'utf8');
    const listeners = {};
    const cached = [];
    const response = {
        ok: status >= 200 && status < 300,
        headers: {get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null)},
        clone() { return this; },
    };
    const self = {
        registration: {scope: 'http://host/'},
        location: {origin: 'http://host'},
        addEventListener: (type, fn) => { listeners[type] = fn; },
    };
    const caches = {open: async() => ({put: async(key) => { cached.push(key); }})};
    vm.runInNewContext(source, {self, caches, URL, Request: function(request) { return request; }, fetch: async() => response});

    let responded;
    listeners.fetch({request: {method: 'GET', mode: 'navigate', url: `http://host${pathname}`}, respondWith: (p) => { responded = p; }});
    assert.strictEqual(await responded, response);
    await new Promise(resolve => setImmediate(resolve));
    return cached;
}

// Скачивание книги или резервной копии (в ней secret.key) — тоже навигация: оно не должно оседать в кэше как index.html.
async function testServiceWorkerCachesOnlyAppShellNavigation() {
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html; charset=utf-8'), ['/index.html']);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/admin-backups/backup.zip', 'application/zip'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/book/1.fb2', 'application/octet-stream'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/app-reset', 'text/html'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html', 503), []);
}

// Пароль доступа клиент хэширует сам (по http нет crypto.subtle), сервер сравнивает hex: результат должен совпадать с Node.
async function testClientSha256MatchesNode() {
    const {sha256Hex} = require('../shared/sha256');
    const crypto = require('crypto');
    assert.strictEqual(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const value of ['', 'пароль', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'p\u{1F600}'.repeat(300)])
        assert.strictEqual(sha256Hex(value), crypto.createHash('sha256').update(value, 'utf8').digest('hex'), `length ${value.length}`);
}

// Загружает ES-модуль клиента (client/share/*.js) в песочнице: импорты заменяются заглушками из imports.
async function loadClientModule(file, imports = {}) {
    let source = await fs.readFile(path.resolve(__dirname, '../client', file), 'utf8');
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
    const progress = {bookUid: 'uid', progress: {percent: 0.5}};
    assert.strictEqual((await call('update-reader-progress', progress, {headers: {'X-CSRF-Token': 'csrf'}})).ok, true);
    sent = requests.pop();
    assert.strictEqual(sent.method, 'POST');
    assert.match(sent.url, /(^|\/)api\/update-reader-progress$/);
    assert.match(String(sent.headers.get('content-type')), /^application\/json/);
    assert.strictEqual(sent.headers.get('x-csrf-token'), 'csrf');
    assert.strictEqual(sent.headers.get('x-inpx-api'), '1');
    assert.deepStrictEqual(JSON.parse(sent.body), progress);

    //файл - тело запроса, скалярные параметры - в адресе
    await call('import-admin-backup', {scope: 'all'}, {body: 'FILE'});
    sent = requests.pop();
    assert.strictEqual(sent.method, 'POST');
    assert.match(sent.url, /(^|\/)api\/import-admin-backup\?scope=all$/);
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

// После ошибки связи повторяется только GET: изменение могло дойти до сервера, повтор выполнил бы его дважды.
// Список действий не ведётся отдельно - правило задаёт метод маршрута.
async function testOnlyReadOnlyRequestsAreRetried() {
    const apiRoutes = require('../shared/apiRoutes');
    const clientSource = await fs.readFile(path.resolve(__dirname, '../client/share/connection.js'), 'utf8');
    assert.doesNotMatch(clientSource, /retrySafeActions/);
    const {canRetryRequest} = await loadClientModule('share/connection.js', Object.assign({apiRoutes}, apiRoutes));
    for (const error of ['errors.apiConnectFailed', 'errors.apiNoResponse', 'errors.apiBadResponse']) {
        for (const route of apiRoutes.routes)
            assert.strictEqual(canRetryRequest(route.action, new Error(error)), route.method === 'GET', `${route.action} after ${error}`);
    }
    assert.ok(canRetryRequest('catalog-search', new Error('errors.apiNoResponse')));
    for (const action of ['get-book-states', 'update-reading-list-book', 'login-user-profile', 'import-reading-lists'])
        assert.ok(!canRetryRequest(action, new Error('errors.apiConnectFailed')), action);
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
    await loadClientModule('store/index.js', {VuexPersistence, createStore: value => value, root: {}, process: {env: {}}});
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

module.exports = [testServiceWorkerCachesOnlyAppShellNavigation, testClientSha256MatchesNode, testBookLanguagesDefaultToAll,
    testApiConnectionMapsErrors, testConnectionErrorsAndReconnectDelay, testOnlyReadOnlyRequestsAreRetried,
    testStorePersistsOnlySettings, testCssSubsetKeepsUsedIconsAndComponents, testClientLoadsOnlySelectedLocale,
    testReleaseVersionsCompareCalVer];
