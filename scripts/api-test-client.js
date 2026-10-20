// HTTP API в тестах: клиент с cookie и CSRF-токеном, как Api.vue, и сервер с ApiController в порядке server/index.js.
const http = require('http');
const express = require('express');
const apiRoutes = require('../shared/apiRoutes');

//заголовки без учёта регистра; null убирает заголовок
function mergeHeaders(...sets) {
    const result = {};
    for (const set of sets) {
        for (const [name, value] of Object.entries(set || {}))
            result[name.toLowerCase()] = value;
    }
    for (const [name, value] of Object.entries(result)) {
        if (value === null || value === undefined)
            delete result[name];
    }
    return result;
}

class ApiTestClient {
    // base - адрес корня приложения (`http://host:port<root>`); headers - заголовки каждого запроса, cookie из них идёт в банку
    constructor(base, {headers = {}, csrfToken = ''} = {}) {
        this.base = String(base).replace(/\/?$/, '/');
        this.jar = new Map();
        this.csrfToken = csrfToken;
        const all = mergeHeaders(headers);
        if (all.cookie)
            this.cookie = all.cookie;
        delete all.cookie;
        this.headers = all;
    }

    //клиент с готовой сессией браузера: cookie и её CSRF-токен
    static forSession(base, security, session = security.ensureSession({headers: {}}), headers = {}) {
        const client = new ApiTestClient(base, {headers, csrfToken: session.csrfToken});
        client.cookie = `inpx_web_session=${security.packSessionId(session.id)}`;
        return client;
    }

    get cookie() {
        return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    set cookie(header) {
        this.jar.clear();
        for (const part of String(header || '').split(';')) {
            const index = part.indexOf('=');
            if (index > 0)
                this.jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
        }
    }

    storeCookies(response) {
        for (const line of response.headers.getSetCookie()) {
            const [pair, ...attributes] = line.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            if (!value || attributes.some(item => /^\s*max-age=0\s*$/i.test(item)))
                this.jar.delete(name);
            else
                this.jar.set(name, value);
        }
    }

    // url - относительно корня приложения ('api/ping'); ответ: {status, headers, body (JSON или текст), text}
    async request(method, url, {headers = {}, body} = {}) {
        const all = mergeHeaders({'x-inpx-api': '1', 'x-ui-lang': 'ru'}, this.headers, (this.jar.size ? {cookie: this.cookie} : {}), headers);
        const stream = !!(body && typeof body.pipe === 'function');
        const response = await fetch(new URL(String(url).replace(/^\//, ''), this.base), {method, headers: all, body,
            redirect: 'manual', ...(stream ? {duplex: 'half'} : {})});
        this.storeCookies(response);
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            json = undefined;
        }
        return {status: response.status, headers: response.headers, body: (json === undefined ? text : json), text};
    }

    async csrf() {
        if (!this.csrfToken)
            this.csrfToken = (await this.request('GET', 'api/config')).body.csrfToken || '';
        return this.csrfToken;
    }

    // Запрос действия по shared/apiRoutes.js. userId и profileToken - заголовки X-User-Id и X-Profile-Token;
    // csrfToken: не задан - токен сессии (GET api/config), null - без заголовка; body - тело загрузки файла
    async call(action, params = {}, {headers = {}, userId, profileToken, csrfToken, body} = {}) {
        const route = apiRoutes.routeFor(action);
        const encoded = apiRoutes.encode(action, params);
        const query = apiRoutes.queryString(encoded.query);
        const own = {};
        if (userId !== undefined)
            own['x-user-id'] = userId;
        if (profileToken !== undefined)
            own['x-profile-token'] = profileToken;
        if (encoded.method === 'POST') {
            own['content-type'] = (route.upload ? 'application/octet-stream' : 'application/json');
            const token = (csrfToken === undefined ? await this.csrf() : csrfToken);
            if (token !== null)
                own['x-csrf-token'] = token;
        }
        return this.request(encoded.method, `api/${encoded.path}${query ? `?${query}` : ''}`, {
            headers: mergeHeaders(own, headers),
            body: (encoded.method !== 'POST' ? undefined : (route.upload ? body : JSON.stringify(encoded.body))),
        });
    }
}

//Параметры, с которыми действие доходит до обработчика: ids пути и ничего лишнего в query
const sampleUid = require('crypto').createHash('sha256').update('sample book').digest('base64');
function sampleParams(action) {
    const route = apiRoutes.routeFor(action);
    const ids = Object.fromEntries(route.segments.filter(segment => segment[0] === ':')
        .map(segment => [segment.slice(1), (segment === ':bookUid' ? sampleUid : 'x')]));
    return (route.method === 'GET' || route.upload ? ids : {listId: 'x', bookUid: sampleUid, name: 'n'});
}

//WebWorker - синглтон с фоновыми задачами, поэтому контроллер создаётся без конструктора: счётчики запросов - как в
//конструкторе ApiController, остальные поля задаёт тест (config, security, profileAccess, webWorker, workerState, заглушки обработчиков)
function apiController(fields) {
    const ApiController = require('../server/controllers/ApiController');
    return Object.assign(Object.create(ApiController.prototype), {activeRequests: 0, clientRequests: new Map(),
        onlineClients: new Map(), largeRequestActive: false, uploadActive: false}, fields);
}

//<root>/api за security.apiGuard(), как в server/index.js
function mountApi(app, {config, security, controller}) {
    const root = String(config.rootPathStatic || '').replace(/\/$/, '');
    if (security)
        app.use(`${root}/api`, security.apiGuard(), controller.router());
    else
        app.use(`${root}/api`, controller.router());
}

//Приложение в порядке server/index.js: заголовки и сессия, обязательный вход, свои маршруты теста (routes),
//health, /api, ещё маршруты (after) - например статика
function apiApp({config, security, controller, worker = controller.webWorker, routes, after, health = true}) {
    const app = express();
    if (security) {
        app.use(security.middleware());
        app.use(security.requiredAuthMiddleware());
    }
    if (routes)
        routes(app);
    if (health)
        require('../server/core/HealthRoutes')(app, config, worker, security, controller);
    mountApi(app, {config, security, controller});
    if (after)
        after(app);
    return app;
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {server, base, close: async() => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }};
}

//ответ Express для прямых вызовов Security (rotateSession): запоминает заголовки
function fakeResponse() {
    const headers = {};
    const response = {
        headers,
        setHeader: (name, value) => { headers[name.toLowerCase()] = value; return response; },
        getHeader: name => headers[name.toLowerCase()],
        removeHeader: name => { delete headers[name.toLowerCase()]; },
        set: (name, value) => response.setHeader(name, value),
        get: name => response.getHeader(name),
        append: (name, value) => {
            const previous = headers[name.toLowerCase()];
            return response.setHeader(name, previous === undefined ? value : [].concat(previous, value));
        },
    };
    return response;
}

// POST с телом из bodySize байт по сырому сокету: тело отправляется целиком, как браузер с крупным файлом.
// Ответ: {status, writeError} - writeError, если сервер закрыл соединение, не дочитав тело (Windows теряет при этом и ответ)
function rawPost(base, path, headers, bodySize) {
    const net = require('net');
    const {hostname, port} = new URL(base);
    return new Promise((resolve) => {
        const socket = net.connect(Number(port), hostname);
        let response = '';
        let writeError = null;
        let written = false;
        const done = () => {
            if (!written)
                return;
            const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
            socket.destroy();
            resolve({status: match ? Number(match[1]) : 0, writeError});
        };
        socket.on('data', chunk => {
            response += chunk.toString('latin1');
            if (response.includes('\r\n\r\n'))
                done();
        });
        socket.on('error', error => {
            writeError = writeError || error;
            written = true;
            done();
        });
        socket.on('close', () => {
            written = true;
            done();
        });
        const head = Object.entries(Object.assign({Host: `${hostname}:${port}`, 'Content-Length': String(bodySize)}, headers))
            .map(([name, value]) => `${name}: ${value}`).join('\r\n');
        socket.write(`POST ${path} HTTP/1.1\r\n${head}\r\n\r\n`);
        socket.write(Buffer.alloc(bodySize, 0x20), (error) => {
            writeError = writeError || error || null;
            written = true;
            done();
        });
    });
}

module.exports = {ApiTestClient, rawPost, apiController, mountApi, apiApp, listen, fakeResponse, sampleParams, sampleUid};
