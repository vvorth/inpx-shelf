const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const apiRoutes = require('../shared/apiRoutes');

//в этом uid есть и "+", и "/"
const uid = crypto.createHash('sha256').update('line5').digest('base64');

//запрос клиента до обработчика сервера: encode -> адрес -> match -> decode
function roundtrip(action, params) {
    const {method, path: routePath, query, body} = apiRoutes.encode(action, params);
    const url = new URL(`http://host/api/${routePath}?${apiRoutes.queryString(query)}`);
    const found = apiRoutes.match(method, url.pathname.slice('/api/'.length));
    assert.ok(found && found.route, `${action}: route not matched`);
    assert.strictEqual(found.route.action, action);
    return apiRoutes.decode(found.route, found.pathParams, Object.fromEntries(url.searchParams), body);
}

function assertBadRequest(fn) {
    assert.throws(fn, error => error.status === 400);
}

function testApiRoutesCoverControllerActions() {
    //обработчик действия - вызов из workerActions или метод контроллера с именем действия в camelCase (ApiController.dispatch)
    const source = fs.readFileSync(path.join(__dirname, '../server/controllers/ApiController.js'), 'utf8');
    const workerActions = [...source.matchAll(/^ {4}'([a-z0-9-]+)': /gm)].map(m => m[1]);
    const ApiController = require('../server/controllers/ApiController');
    const method = action => ApiController.prototype[action.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase())];
    const actions = apiRoutes.routes.map(route => route.action);
    assert.ok(actions.length > 80 && workerActions.length > 20);
    assert.deepStrictEqual(workerActions.filter(action => !actions.includes(action)), []);
    assert.deepStrictEqual(workerActions.filter(action => method(action)), [], 'One handler per action');
    assert.deepStrictEqual(actions.filter(action => !workerActions.includes(action) && typeof method(action) !== 'function'), []);
    assert.strictEqual(new Set(actions).size, actions.length);

    //два маршрута одного метода с одинаковой формой пути неразличимы
    const shapes = apiRoutes.routes.map(route => `${route.method} ${route.segments.map(s => (s[0] === ':' ? ':' : s)).join('/')}`);
    assert.strictEqual(new Set(shapes).size, shapes.length);
    for (const route of apiRoutes.routes) {
        assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));
        //путь называет ресурс, а не действие
        assert.notStrictEqual(route.path, route.action, route.action);
        if (route.upload)
            assert.strictEqual(route.method, 'POST');
        assert.strictEqual(apiRoutes.isRead(route.action), route.method === 'GET');
        assert.strictEqual(apiRoutes.hasJsonBody(route), ['POST', 'PUT', 'PATCH'].includes(route.method) && !route.upload, route.action);
        assert.ok(Object.values(route.params).every(type => ['string', 'int', 'bool', 'json'].includes(type)), route.action);
    }
    assert.deepStrictEqual(apiRoutes.routes.filter(route => route.upload).map(route => route.action).sort(),
        ['import-admin-backup', 'import-admin-settings', 'import-reading-lists']);
    assert.strictEqual(apiRoutes.isRead('get-book-states'), false);
    assert.strictEqual(apiRoutes.routeFor('nope'), undefined);
}

function testApiRoutesRoundtrip() {
    //uid с "+" и "/" идёт в путь как base64url и возвращается как был
    const info = apiRoutes.encode('get-book-info', {bookUid: uid, fetchRemote: true});
    assert.strictEqual(info.method, 'GET');
    assert.ok(/^books\/[A-Za-z0-9_-]{43}\/info$/.test(info.path), info.path);
    assert.deepStrictEqual(info.query, {fetchRemote: 'true'});
    assert.deepStrictEqual(roundtrip('get-book-info', {bookUid: uid, fetchRemote: false}), {bookUid: uid, fetchRemote: false});
    assert.deepStrictEqual(roundtrip('get-reader-state', {bookUid: uid}), {bookUid: uid});

    const search = {q: 'a&b=c / д', filters: {lang: ['ru', 'en'], genre: 'sf'}, sort: 'date', offset: 40, limit: 20,
        hideCopies: true, showDeleted: false, facets: true};
    assert.deepStrictEqual(roundtrip('catalog-search', search), search);
    assert.deepStrictEqual(roundtrip('get-author-book-list', {authorId: 0, author: 'Толстой, Лев/Л.', query: {}}),
        {authorId: 0, author: 'Толстой, Лев/Л.', query: {}});
    assert.deepStrictEqual(roundtrip('get-discovery-shelves', {section: 'external', externalLanguages: ['ru'], externalLimit: 24}),
        {section: 'external', externalLanguages: ['ru'], externalLimit: 24});
    assert.deepStrictEqual(roundtrip('get-reading-list', {listId: '0123abcdef456789', options: {visibility: 'public'}}),
        {listId: '0123abcdef456789', options: {visibility: 'public'}});
    assert.deepStrictEqual(roundtrip('get-worker-state', {workerId: 'server_state'}), {workerId: 'server_state'});
    assert.deepStrictEqual(roundtrip('get-reading-lists', {bookUid: uid}), {bookUid: uid});
    //null и undefined не попадают в query
    assert.deepStrictEqual(apiRoutes.encode('catalog-names', {kind: 'author', q: null, offset: undefined}).query, {kind: 'author'});
    assert.strictEqual(apiRoutes.queryString({a: '1', b: 'x y'}), 'a=1&b=x+y');
}

function testApiRoutesMatch() {
    //статический сегмент сильнее параметра
    assert.strictEqual(apiRoutes.match('GET', 'reading-lists/export').route.action, 'export-reading-lists');
    assert.strictEqual(apiRoutes.match('GET', 'reading-lists/abc').route.action, 'get-reading-list');
    assert.strictEqual(apiRoutes.match('GET', '/admin/dashboard/metrics').route.action, 'get-admin-dashboard-metrics');
    //команда - POST, с CSRF-токеном, как любое изменение
    assert.strictEqual(apiRoutes.match('POST', 'admin/user-data/accept-reset').route.action, 'admin-accept-user-data-reset');
    assert.deepStrictEqual(apiRoutes.match('GET', 'admin/user-data/accept-reset'), {allow: ['POST']});
    assert.deepStrictEqual(apiRoutes.match('POST', 'ping'), {allow: ['GET']});
    assert.deepStrictEqual(apiRoutes.match('PUT', 'reading-lists/abc'), {allow: ['GET', 'PATCH', 'DELETE']});
    assert.deepStrictEqual(apiRoutes.match('GET', 'session'), {allow: ['POST', 'DELETE']});
    assert.strictEqual(apiRoutes.match('PATCH', 'reading-lists/abc').route.action, 'update-reading-list');
    assert.strictEqual(apiRoutes.match('DELETE', 'reading-lists/abc').route.action, 'delete-reading-list');
    assert.strictEqual(apiRoutes.match('POST', 'create-reading-list'), null, 'old action paths are gone');
    assert.strictEqual(apiRoutes.match('GET', 'nope'), null);
    assert.strictEqual(apiRoutes.match('GET', 'books'), null);
    assert.strictEqual(apiRoutes.match('GET', 'reading-lists/abc/'), null);
    //недопустимый id - как несуществующий путь
    assert.strictEqual(apiRoutes.match('GET', `books/${encodeURIComponent(uid)}`), null);
    assert.strictEqual(apiRoutes.match('GET', 'books/short'), null);
    assert.strictEqual(apiRoutes.match('GET', 'reading-lists/a%2Fb'), null);
    assert.strictEqual(apiRoutes.match('GET', 'reading-lists/%E0%A4%A'), null);
    assert.strictEqual(apiRoutes.match('GET', `reading-lists/${'a'.repeat(129)}`), null);
}

function testApiRoutesRejectBadParams() {
    const route = apiRoutes.routeFor('catalog-search');
    assertBadRequest(() => apiRoutes.decode(route, {}, {limit: '1.5'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {limit: 'abc'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {hideCopies: '1'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {filters: '{bad'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {filters: '"text"'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {filters: 'null'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {q: ['a', 'b']}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {userId: 'x'}));
    assertBadRequest(() => apiRoutes.decode(route, {}, {__proto__: null, constructor: 'x'}));
    assertBadRequest(() => apiRoutes.decode(apiRoutes.routeFor('create-reading-list'), {}, {name: 'x'}, {}));
    assertBadRequest(() => apiRoutes.decode(apiRoutes.routeFor('create-reading-list'), {}, {}, ['x']));
    assertBadRequest(() => apiRoutes.decode(apiRoutes.routeFor('create-reading-list'), {}, {}, null));

    //ошибки клиента видны до отправки
    assert.throws(() => apiRoutes.encode('catalog-search', {profileAccessToken: 't'}), /Unknown parameter/);
    assert.throws(() => apiRoutes.encode('get-book', {}), /bookUid/);
    assert.throws(() => apiRoutes.encode('get-book', {bookUid: 'external:abc'}), /bookUid/);
    assert.throws(() => apiRoutes.encode('get-reading-list', {listId: 'a/b'}), /listId/);
    assertBadRequest(() => apiRoutes.encode('catalog-search', {limit: 2.5}));
    assertBadRequest(() => apiRoutes.encode('catalog-search', {hideCopies: 1}));
    assertBadRequest(() => apiRoutes.encode('catalog-search', {filters: 'x'}));
    assertBadRequest(() => apiRoutes.encode('catalog-search', {q: {}}));
    assert.throws(() => apiRoutes.encode('nope', {}), /Action not found/);
}

function testApiRoutesWritesAndUpload() {
    //параметры пути уходят из тела; остальное - тело PUT/PATCH/POST
    const put = apiRoutes.encode('add-reading-list-book', {listId: 'l1', bookUid: uid});
    assert.strictEqual(put.method, 'PUT');
    assert.ok(/^reading-lists\/l1\/books\/[A-Za-z0-9_-]{43}$/.test(put.path), put.path);
    assert.deepStrictEqual(put.body, {});
    assert.deepStrictEqual(roundtrip('add-reading-list-book', {listId: 'l1', bookUid: uid}), {listId: 'l1', bookUid: uid});
    assert.deepStrictEqual(roundtrip('update-reader-progress', {bookUid: uid, progress: {percent: 0.5}}), {bookUid: uid, progress: {percent: 0.5}});
    assert.deepStrictEqual(roundtrip('update-reading-list', {listId: 'l1', name: 'New'}), {listId: 'l1', name: 'New'});

    //DELETE - без тела: всё нужное в пути, лишний параметр - ошибка клиента
    const del = apiRoutes.encode('delete-reader-bookmark', {bookUid: uid, bookmarkId: 'b1'});
    assert.deepStrictEqual([del.method, del.body, del.query], ['DELETE', undefined, {}]);
    assert.deepStrictEqual(roundtrip('delete-reader-bookmark', {bookUid: uid, bookmarkId: 'b1'}), {bookUid: uid, bookmarkId: 'b1'});
    assert.throws(() => apiRoutes.encode('delete-reading-list', {listId: 'l1', name: 'x'}), /Unknown parameter/);

    const found = apiRoutes.match('POST', 'reading-lists');
    //__proto__ из JSON остаётся обычным полем
    const params = apiRoutes.decode(found.route, {}, {}, JSON.parse('{"__proto__": {"polluted": 1}}'));
    assert.strictEqual(params.polluted, undefined);

    const upload = apiRoutes.encode('import-admin-backup', {scope: 'author-names'});
    assert.deepStrictEqual(upload, {method: 'POST', path: 'admin/backups/restore', query: {scope: 'author-names'}, body: undefined});
    const uploadRoute = apiRoutes.match('POST', upload.path).route;
    assert.strictEqual(uploadRoute.upload, true);
    assert.deepStrictEqual(apiRoutes.decode(uploadRoute, {}, upload.query), {scope: 'author-names'});
    assert.throws(() => apiRoutes.encode('import-reading-lists', {scope: 'x'}), /Unknown parameter/);
}

module.exports = [
    testApiRoutesCoverControllerActions,
    testApiRoutesRoundtrip,
    testApiRoutesMatch,
    testApiRoutesRejectBadParams,
    testApiRoutesWritesAndUpload,
];
