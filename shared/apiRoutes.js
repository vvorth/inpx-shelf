//Таблица HTTP API (<root>/api/...): сервер строит по ней маршрутизатор, клиент - адреса запросов.
//Чтение - GET с типизированными параметрами в query (json - объект или массив одним параметром).
//Изменения - на ресурсах: POST создаёт, PATCH дополняет, PUT заменяет, DELETE удаляет (без тела); команды -
//POST <ресурс>/<глагол>. Тело POST/PUT/PATCH - JSON-объект, загрузки файлов - POST с телом-файлом и параметрами в query.

//[действие, путь, параметры query]
const reads = [
    ['test', 'ping'],
    ['get-config', 'config'],
    ['get-worker-state', 'worker-state/:workerId'],
    ['get-genre-tree', 'genres'],
    ['get-author-book-list', 'author/books', {author: 'string', authorId: 'int', query: 'json'}],
    ['get-author-info', 'author/info', {author: 'string', authorId: 'int'}],
    ['get-author-aliases', 'author/aliases', {author: 'string'}],
    ['get-series-book-list', 'series/books', {series: 'string', query: 'json'}],
    ['catalog-search', 'catalog/search', {q: 'string', filters: 'json', sort: 'string', offset: 'int', limit: 'int',
        hideCopies: 'bool', showDeleted: 'bool', facets: 'bool'}],
    ['catalog-suggest', 'catalog/suggest', {q: 'string'}],
    ['catalog-names', 'catalog/names', {kind: 'string', q: 'string', offset: 'int', limit: 'int'}],
    ['get-book', 'books/:bookUid'],
    ['get-book-info', 'books/:bookUid/info', {fetchRemote: 'bool'}],
    ['get-book-link', 'books/:bookUid/link'],
    ['get-reader-state', 'books/:bookUid/reader-state'],
    ['get-discovery-shelves', 'discovery/shelves', {section: 'string', forceRefresh: 'bool', personalLimit: 'int',
        personalSimilarLimit: 'int', personalSimilarEnabled: 'bool', newestLimit: 'int', popularLimit: 'int',
        externalLimit: 'int', externalSource: 'string', externalName: 'string', externalTtlMinutes: 'int',
        externalBrowseUrl: 'string', externalLanguages: 'json'}],
    ['get-reading-lists', 'reading-lists', {bookUid: 'string', options: 'json'}],
    ['export-reading-lists', 'reading-lists/export'],
    ['get-reading-list', 'reading-lists/:listId', {options: 'json'}],
    ['get-reading-now', 'me/reading-now', {hidden: 'bool'}],
    ['get-user-reading-library', 'me/library', {options: 'json'}],
    ['get-reading-stats', 'me/reading-stats'],
    ['get-user-profiles', 'profiles'],
    ['get-kobo-devices', 'kobo-devices'],
    ['get-remote-access', 'admin/remote-access'],
    ['get-admin-dashboard', 'admin/dashboard'],
    ['get-admin-dashboard-metrics', 'admin/dashboard/metrics'],
    ['get-admin-events', 'admin/events', {options: 'json'}],
    ['admin-author-names-status', 'admin/author-names/:table'],
    ['export-admin-settings', 'admin/settings/export'],
];

//[действие, путь, параметры query]
const uploads = [
    ['import-admin-settings', 'admin/settings/import'],
    ['import-admin-backup', 'admin/backups/restore', {scope: 'string'}],
    ['import-reading-lists', 'me/import'],
];

//[действие, метод, путь]
const writes = [
    ['login-user-profile', 'POST', 'session'],
    ['logout-user-profile', 'DELETE', 'session'],
    ['create-user-profile', 'POST', 'profiles'],
    ['update-user-profile', 'PATCH', 'profiles/:targetUserId'],
    ['delete-user-profile', 'DELETE', 'profiles/:targetUserId'],
    //пароль, выбранный читателем, или новый сгенерированный: один POST на оба случая
    ['set-opds-password', 'POST', 'me/opds-password'],
    ['create-kosync-password', 'POST', 'me/kosync-password'],

    ['update-reader-progress', 'PATCH', 'books/:bookUid/progress'],
    ['delete-reader-progress', 'DELETE', 'books/:bookUid/progress'],
    ['clear-reader-progress', 'DELETE', 'me/progress'],
    ['mark-book-read', 'PUT', 'books/:bookUid/read'],
    ['unmark-book-read', 'DELETE', 'books/:bookUid/read'],
    ['mark-reader-books-read', 'POST', 'me/read-marks'],
    ['mark-series-read', 'POST', 'series/read-marks'],
    ['forget-books', 'POST', 'me/forget'],
    ['add-reader-bookmark', 'POST', 'books/:bookUid/bookmarks'],
    ['delete-reader-bookmark', 'DELETE', 'books/:bookUid/bookmarks/:bookmarkId'],
    ['update-reader-preferences', 'PATCH', 'me/reader-preferences'],
    //сотни uid не помещаются в адрес: чтение через POST
    ['get-book-states', 'POST', 'me/book-states'],

    ['create-reading-list', 'POST', 'reading-lists'],
    ['update-reading-list', 'PATCH', 'reading-lists/:listId'],
    ['delete-reading-list', 'DELETE', 'reading-lists/:listId'],
    ['add-reading-list-book', 'PUT', 'reading-lists/:listId/books/:bookUid'],
    ['remove-reading-list-book', 'DELETE', 'reading-lists/:listId/books/:bookUid'],
    ['add-series-to-reading-list', 'POST', 'reading-lists/:listId/series'],
    ['replace-listed-book', 'POST', 'books/:bookUid/replace'],

    ['update-discovery-preferences', 'PATCH', 'me/discovery-preferences'],
    ['record-discovery-events', 'POST', 'me/discovery-events'],
    ['update-shared-discovery-config', 'PATCH', 'admin/discovery'],

    ['create-kobo-device', 'POST', 'kobo-devices'],
    ['update-kobo-device', 'PATCH', 'kobo-devices/:deviceId'],
    ['delete-kobo-device', 'DELETE', 'kobo-devices/:deviceId'],
    ['regenerate-kobo-device-token', 'POST', 'kobo-devices/:deviceId/token'],
    ['reset-kobo-device', 'POST', 'kobo-devices/:deviceId/reset'],
    ['refresh-kobo-device', 'POST', 'kobo-devices/:deviceId/refresh'],

    ['send-book-email', 'POST', 'books/:bookUid/send-email'],
    ['send-book-telegram', 'POST', 'books/:bookUid/send-telegram'],
    ['update-book-metadata', 'PATCH', 'books/:bookUid/metadata'],
    ['admin-rebuild-cover', 'POST', 'books/:bookUid/cover/rebuild'],

    ['update-admin-integrations', 'PATCH', 'admin/integrations'],
    ['test-admin-integration', 'POST', 'admin/integrations/:kind/test'],
    ['update-admin-opds', 'PATCH', 'admin/opds'],
    ['update-admin-guest-access', 'PUT', 'admin/guest-access'],
    ['update-admin-event-log', 'PUT', 'admin/event-log'],
    ['update-admin-cache', 'PATCH', 'admin/cache'],
    ['update-admin-library-sources', 'PUT', 'admin/library-sources'],

    ['add-admin-test-event', 'POST', 'admin/events'],
    ['admin-clean-cache', 'POST', 'admin/cache/clean'],
    ['admin-clean-broken-covers', 'POST', 'admin/cache/clean-broken-covers'],
    ['admin-reindex', 'POST', 'admin/reindex'],
    ['admin-accept-user-data-reset', 'POST', 'admin/user-data/accept-reset'],
    ['admin-author-names-update', 'POST', 'admin/author-names/:table/update'],
    //чтение с токеном в теле: POST
    ['admin-diagnose-library-source', 'POST', 'admin/library-sources/diagnose'],
    ['admin-remote-library-sources', 'POST', 'admin/remote-libraries/sources'],
    ['create-admin-backup', 'POST', 'admin/backups'],

    ['create-remote-access', 'POST', 'admin/remote-access'],
    ['update-remote-access', 'PATCH', 'admin/remote-access/:id'],
    ['delete-remote-access', 'DELETE', 'admin/remote-access/:id'],
];

//тело запроса - JSON-объект; у GET и DELETE тела нет
const bodyMethods = ['POST', 'PUT', 'PATCH'];
//повтор после обрыва связи ничего не меняет дважды
const retrySafeMethods = ['GET', 'PUT', 'DELETE'];

const intPattern = /^-?\d{1,15}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
//_uid - base64 от SHA-256 (InpxParser): в пути - base64url без "=", "/" в сегменте пути ломают некоторые прокси
const pathParamTypes = {
    bookUid: {
        pattern: /^[A-Za-z0-9_-]{43}$/,
        toPath: value => (/^[A-Za-z0-9+/]{43}=$/.test(value) ? value.replace(/\+/g, '-').replace(/\//g, '_').slice(0, 43) : ''),
        fromPath: value => `${value.replace(/-/g, '+').replace(/_/g, '/')}=`,
    },
};
const pathParamType = name => pathParamTypes[name] || {pattern: idPattern, toPath: value => value, fromPath: value => value};

const routes = [
    ...reads.map(([action, path, params = {}]) => ({action, method: 'GET', path, params})),
    ...uploads.map(([action, path, params = {}]) => ({action, method: 'POST', path, params, upload: true})),
    ...writes.map(([action, method, path]) => ({action, method, path, params: {}})),
];
for (const route of routes) {
    route.segments = route.path.split('/');
    //при совпадении нескольких маршрутов побеждает тот, у кого раньше статический сегмент
    route.rank = route.segments.map(segment => (segment[0] === ':' ? '1' : '0')).join('');
}
const byAction = new Map(routes.map(route => [route.action, route]));

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const badRequest = message => Object.assign(new Error(message), {status: 400});

function routeFor(action) {
    return byAction.get(action);
}

function isRead(action) {
    const route = routeFor(action);
    return !!route && route.method === 'GET';
}

function isRetrySafe(action) {
    const route = routeFor(action);
    return !!route && retrySafeMethods.includes(route.method);
}

function hasJsonBody(route) {
    return bodyMethods.includes(route.method) && !route.upload;
}

function encodeValue(type, name, value) {
    if (type === 'json' && value && typeof value === 'object')
        return JSON.stringify(value);
    if (type === 'bool' && typeof value === 'boolean')
        return String(value);
    if (type === 'int' && ['number', 'string'].includes(typeof value) && intPattern.test(String(value)))
        return String(value);
    if (type === 'string' && typeof value !== 'object')
        return String(value);
    throw badRequest(`Bad parameter ${name}: ${type} expected`);
}

//params запроса -> {method, path, query, body}; path - относительно api/
function encode(action, params = {}) {
    const route = routeFor(action);
    if (!route)
        throw new Error(`Action not found: ${action}`);
    const rest = Object.assign({}, params);
    const path = route.segments.map(segment => {
        if (segment[0] !== ':')
            return segment;
        const name = segment.slice(1);
        const value = pathParamType(name).toPath(String(rest[name] === undefined || rest[name] === null ? '' : rest[name]));
        if (!pathParamType(name).pattern.test(value))
            throw badRequest(`Bad parameter ${name}`);
        delete rest[name];
        return encodeURIComponent(value);
    }).join('/');

    if (hasJsonBody(route))
        return {method: route.method, path, query: {}, body: rest};

    const query = {};
    for (const [name, value] of Object.entries(rest)) {
        if (!has(route.params, name))
            throw new Error(`Unknown parameter ${name} for ${action}`);
        if (value !== undefined && value !== null)
            query[name] = encodeValue(route.params[name], name, value);
    }
    return {method: route.method, path, query, body: undefined};
}

function queryString(query = {}) {
    return new URLSearchParams(query).toString();
}

//метод и путь относительно api/ -> {route, pathParams}, {allow} (путь есть с другим методом) или null
function match(method, pathname) {
    const segments = String(pathname || '').replace(/^\//, '').split('/');
    let found = null;
    const allow = new Set();
    for (const route of routes) {
        if (route.segments.length !== segments.length)
            continue;
        const pathParams = {};
        const ok = route.segments.every((segment, i) => {
            if (segment[0] !== ':')
                return segment === segments[i];
            const name = segment.slice(1);
            let value;
            try {
                value = decodeURIComponent(segments[i]);
            } catch (e) {
                return false;
            }
            if (!pathParamType(name).pattern.test(value))
                return false;
            pathParams[name] = pathParamType(name).fromPath(value);
            return true;
        });
        if (!ok)
            continue;
        if (route.method !== method)
            allow.add(route.method);
        else if (!found || route.rank < found.route.rank)
            found = {route, pathParams};
    }
    return found || (allow.size ? {allow: [...allow]} : null);
}

function decodeValue(type, name, value) {
    if (typeof value !== 'string')
        throw badRequest(`Bad parameter ${name}`);
    if (type === 'string')
        return value;
    if (type === 'int' && intPattern.test(value))
        return Number(value);
    if (type === 'bool' && (value === 'true' || value === 'false'))
        return value === 'true';
    if (type === 'json') {
        let result;
        try {
            result = JSON.parse(value);
        } catch (e) {
            result = null;
        }
        if (result && typeof result === 'object')
            return result;
    }
    throw badRequest(`Bad parameter ${name}: ${type} expected`);
}

//параметры обработчика: query по типам маршрута, тело POST/PUT/PATCH (JSON-объект) и параметры пути
function decode(route, pathParams = {}, query = {}, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw badRequest('JSON object expected');
    const result = {...body};
    for (const [name, value] of Object.entries(query || {})) {
        if (!has(route.params, name))
            throw badRequest(`Unknown parameter ${name}`);
        result[name] = decodeValue(route.params[name], name, value);
    }
    return Object.assign(result, pathParams);
}

module.exports = {routes, routeFor, isRead, isRetrySafe, hasJsonBody, encode, queryString, match, decode};
