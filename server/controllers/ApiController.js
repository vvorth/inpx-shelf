const _ = require('lodash');

const WebWorker = require('../core/WebWorker');//singleton
const log = new (require('../core/AppLogger'))().log;//singleton
const utils = require('../core/utils');
const runtimeMetrics = require('../core/RuntimeMetrics');
const RequestLimits = require('../core/RequestLimits');
const i18n = require('../core/i18n');
const profilePassword = require('../core/ProfilePassword');
const apiRoutes = require('../../shared/apiRoutes');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const cleanPeriod = 1*60*1000;//1 минута
//клиент (сессия браузера) считается онлайн, если делал запрос за последние 5 минут
const onlinePeriod = 5*60*1000;
const maxOnlineClients = 10000;
const maxSessionRequests = 8;
const maxServerRequests = 64;
const maxUrlLength = 8*1024;
//ненужное тело запроса дочитывается до этого размера, дальше соединение закрывается
const maxDiscardedBody = 64*1024*1024;
//заполняются сервером (ProfileAccess): тело запроса их не задаёт
const reservedParams = ['action', 'userId', 'profileAccessToken', 'csrfToken', 'uiLang', 'guest', 'profileBoundId', 'profileLoginRequired'];
//ошибки в коде сервера, а не в запросе: 500, подробности - в журнал
const programmingErrors = [TypeError, ReferenceError, RangeError, SyntaxError];

const httpError = (status, message) => Object.assign(new Error(message), {status});
//профиль в ответе - без хешей паролей и границы его сессий
const publicUser = ({user}) => ({user: _.omit(user, ['passwordHash', 'opdsPasswordHash', 'kosyncKeyHash', 'sessionsValidAfter'])});

//действия, которые только передают параметры в WebWorker (проверки доступа - в самом WebWorker)
const workerActions = {
    'get-author-info': (w, r) => w.getAuthorInfo(r.authorId, r.author),
    'get-series-book-list': (w, r) => w.getSeriesBookList(r.series, r.query),
    'get-genre-tree': w => w.getGenreTree(),
    'update-discovery-preferences': (w, r) => w.updateDiscoveryPreferences(r.userId, r.profileAccessToken, r.preferences || {}),
    'update-shared-discovery-config': (w, r) => w.updateSharedDiscoveryConfig(r.userId, r.profileAccessToken, r.discovery || {}),
    'update-admin-integrations': (w, r) => w.updateAdminIntegrationConfig(r.userId, r.profileAccessToken, r.integrations || {}),
    'test-admin-integration': (w, r) => w.testAdminIntegrationConfig(r.userId, r.profileAccessToken, r.kind),
    'update-admin-opds': (w, r) => w.updateAdminOpdsConfig(r.userId, r.profileAccessToken, r.opds || {}),
    'update-admin-guest-access': (w, r) => w.updateAdminGuestAccess(r.userId, r.profileAccessToken, r.guestAccess === true),
    'get-admin-dashboard': (w, r) => w.getAdminDashboard(r.userId, r.profileAccessToken),
    'get-admin-dashboard-metrics': (w, r) => w.getAdminDashboardMetrics(r.userId, r.profileAccessToken),
    'get-admin-events': (w, r) => w.getAdminEvents(r.userId, r.profileAccessToken, r.options || {}),
    'update-admin-event-log': (w, r) => w.updateAdminEventLog(r.userId, r.profileAccessToken, r.options || {}),
    'add-admin-test-event': (w, r) => w.addAdminTestEvent(r.userId, r.profileAccessToken, r.level),
    'update-admin-library-sources': (w, r) => w.updateAdminLibrarySources(r.userId, r.profileAccessToken, r.sources || []),
    'admin-diagnose-library-source': (w, r) => w.diagnoseLibrarySource(r.userId, r.profileAccessToken, r.source || {}),
    'get-remote-access': (w, r) => w.getRemoteAccess(r.userId, r.profileAccessToken),
    'create-remote-access': (w, r) => w.createRemoteAccess(r.userId, r.profileAccessToken, r.access || {}),
    'update-remote-access': (w, r) => w.updateRemoteAccess(r.userId, r.profileAccessToken, r.access || {}),
    'delete-remote-access': (w, r) => w.deleteRemoteAccess(r.userId, r.profileAccessToken, r.id),
    'admin-remote-library-sources': (w, r) => w.listRemoteLibrarySources(r.userId, r.profileAccessToken, r.remote || {}),
    'update-admin-cache': (w, r) => w.updateAdminCacheConfig(r.userId, r.profileAccessToken, r.cache || {}),
    'admin-clean-cache': (w, r) => w.runAdminCacheCleanKind(r.userId, r.profileAccessToken, r.kind || 'all'),
    'admin-clean-broken-covers': (w, r) => w.cleanBrokenCoverCache(r.userId, r.profileAccessToken),
    'admin-reindex': (w, r) => w.startAdminReindex(r.userId, r.profileAccessToken),
    'admin-accept-user-data-reset': (w, r) => w.acceptUserDataReset(r.userId, r.profileAccessToken),
    'export-admin-settings': (w, r) => w.exportAdminSettings(r.userId, r.profileAccessToken),
    'create-admin-backup': (w, r) => w.createAdminBackup(r.userId, r.profileAccessToken, r.scope),
    'update-book-metadata': (w, r) => w.updateBookMetadata(r.userId, r.profileAccessToken, r.bookUid, r.metadata),
};

// The request body to `file`; stops reading at `limit` bytes (the caller answers 413).
function receiveFile(req, file, limit) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file, {mode: 0o600});
        let size = 0;
        const fail = (error) => {
            req.pause();
            req.removeAllListeners('data');
            req.removeAllListeners('end');
            out.destroy();
            reject(error);
        };
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit)
                return fail(httpError(413, i18n.t('errors.requestTooLarge')));
            if (!out.write(chunk)) {
                req.pause();
                out.once('drain', () => req.resume());
            }
        });
        req.on('end', () => out.end());
        req.on('error', fail);
        out.on('error', fail);
        out.on('finish', resolve);
    });
}

// The request body in memory, up to `limit` bytes (413 over it).
function receiveBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const done = (error) => {
            req.removeListener('data', onData);
            req.removeListener('end', onEnd);
            req.removeListener('error', onError);
            req.removeListener('close', onError);
            if (error) {
                req.pause();
                reject(error);
            } else {
                resolve(Buffer.concat(chunks, size));
            }
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > limit)
                return done(httpError(413, i18n.t('errors.requestTooLarge')));
            chunks.push(chunk);
        };
        const onEnd = () => done();
        const onError = () => done(httpError(400, i18n.t('errors.apiInvalidRequest')));
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        //обрыв соединения до конца тела
        req.on('close', onError);
    });
}

// The rest of a request body that will not be used (refused before reading, or over the limit), read and dropped after
// the reply: closing the connection while the client still sends makes it lose the reply too (always on Windows).
// Over `max` bytes the connection is closed.
function discardBody(req, max) {
    let size = 0;
    req.removeAllListeners('data');
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max)
            req.destroy();
    });
    req.on('error', () => {});
    req.resume();
}

//пароли и токены не попадают в журнал запросов
const hideSecrets = (key, value) => (/pass|token|secret/i.test(key) && value ? '***' : value);

const contentType = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const header = (req, name) => String(req.headers[name] || '').trim();

// Query string -> {name: value}; a repeated name is a bad request, not an array.
function parseQuery(raw) {
    const query = {};
    for (const [name, value] of new URLSearchParams(raw)) {
        if (Object.hasOwn(query, name))
            throw httpError(400, `Repeated parameter ${name}`);
        query[name] = value;
    }
    return query;
}

class ApiController {
    constructor(config, security = null) {
        this.config = config;
        this.isDevelopment = (config.branch == 'development');
        this.security = security;

        this.webWorker = new WebWorker(config);
        this.profileAccess = security ? new (require('../core/ProfileAccess'))(config, this.webWorker, security) : null;

        this.activeRequests = 0;
        //активные запросы и последняя активность по клиенту: sid сессии или IP
        this.clientRequests = new Map();
        this.onlineClients = new Map();
        this.largeRequestActive = false;
        this.uploadActive = false;

        this.periodicClean();//no await
    }

    async periodicClean() {
        while (1) {//eslint-disable-line no-constant-condition
            try {
                //onlineClients упорядочен по последнему запросу: устаревшие - в начале
                const now = Date.now();
                for (const [key, client] of this.onlineClients) {
                    if (now - client.at <= onlinePeriod)
                        break;
                    this.onlineClients.delete(key);
                }
            } catch(e) {
                log(LM_ERR, `ApiController.periodicClean error: ${e.message}`);
            }

            await utils.sleep(cleanPeriod);
        }
    }

    // Express router for <root>/api: every route comes from shared/apiRoutes.js.
    router() {
        const router = require('express').Router();
        router.use((req, res, next) => {
            const lang = i18n.resolveRequestLang(this.config, req, header(req, 'x-ui-lang'));
            i18n.run(lang, () => this.handle(req, res)).catch(next);
        });
        return router;
    }

    clientKey(req) {
        return (req.securitySession ? `sid:${req.securitySession.sid}` : `ip:${this.security ? this.security.clientIp(req) : (req.socket && req.socket.remoteAddress) || ''}`);
    }

    touchClient(key, userId) {
        this.onlineClients.delete(key);
        this.onlineClients.set(key, {at: Date.now(), userId});
        if (this.onlineClients.size > maxOnlineClients)
            this.onlineClients.delete(this.onlineClients.keys().next().value);
    }

    // The JSON reply; a body not read to the end is dropped (discardBody).
    reply(req, res, status, body) {
        if (res.headersSent)
            return;
        if (!req.complete)
            discardBody(req, maxDiscardedBody);
        res.set('Cache-Control', 'no-store');
        res.status(status).json(body);
    }

    errorStatus(e) {
        if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600)
            return e.status;
        if (!(e instanceof Error) || programmingErrors.some(type => e instanceof type))
            return 500;
        if (e.code === 'INPX_LOGIN_RATE_LIMIT' || e.message === 'too_many_requests')
            return 429;
        return {need_profile_login: 401, bad_csrf_token: 403, server_busy: 503}[e.message] || 400;
    }

    errorReply(res, e, params = {}) {
        const status = this.errorStatus(e);
        if (status === 429 || (status === 503 && e && e.retryAfter))
            res.set('Retry-After', String((e && e.retryAfter) || 1));
        if (status === 500) {
            log(LM_ERR, `API ${params.action || ''}: ${(e && e.stack) || e}`);
            return [status, {error: i18n.t('errors.serverErrorSeeLog')}];
        }
        return [status, {error: this.errorText(e, params)}];
    }

    async handle(req, res) {
        const [rawPath, rawQuery = ''] = String(req.url || '').split(/\?(.*)/s);
        if (String(req.originalUrl || req.url || '').length > maxUrlLength)
            return this.reply(req, res, 414, {error: 'URI Too Long'});
        const found = apiRoutes.match(req.method, rawPath);
        if (!found)
            return this.reply(req, res, 404, {error: 'Not found'});
        if (!found.route) {
            res.set('Allow', found.allow.join(', '));
            return this.reply(req, res, 405, {error: 'Method Not Allowed'});
        }
        const route = found.route;
        const messageLimit = RequestLimits.limits(this.config).message;
        const json = apiRoutes.hasJsonBody(route);
        //крупное тело в памяти - одно на сервер; без Content-Length размер заранее неизвестен
        const large = json && !(Number(req.headers['content-length']) <= messageLimit/2);

        const key = this.clientKey(req);
        const clientRequests = this.clientRequests.get(key) || 0;
        if (clientRequests >= maxSessionRequests || this.activeRequests >= maxServerRequests || (large && this.largeRequestActive)) {
            res.set('Retry-After', '1');
            return this.reply(req, res, 429, {error: 'too_many_requests'});
        }
        this.clientRequests.set(key, clientRequests + 1);
        this.activeRequests++;
        if (large)
            this.largeRequestActive = true;

        const startTime = Date.now();
        let params = {action: route.action};
        let userId = '';
        let metricToken = null;
        let metricOk = false;
        let status = 200;
        let result;
        try {
            const query = parseQuery(rawQuery);
            let body;
            if (json) {
                if (contentType(req) !== 'application/json')
                    throw httpError(415, 'application/json expected');
                if (Number(req.headers['content-length']) > messageLimit)
                    throw httpError(413, i18n.t('errors.requestTooLarge'));
                const raw = await receiveBody(req, messageLimit);
                try {
                    body = JSON.parse(raw.toString('utf8') || 'null');
                } catch (e) {
                    throw httpError(400, i18n.t('errors.apiInvalidRequest'));
                }
            } else if (route.upload) {
                if (contentType(req) !== 'application/octet-stream')
                    throw httpError(415, 'application/octet-stream expected');
                if (Number(req.headers['content-length']) > RequestLimits.uploadLimit(route.action, this.config))
                    throw httpError(413, i18n.t('errors.requestTooLarge'));
            }
            if (this.isDevelopment || this.config.logQueries)
                log(`API-IN:  ${req.method} ${rawPath} ${utils.cutString(JSON.stringify({query, body}, hideSecrets))}`);

            if (body && typeof body === 'object' && reservedParams.some(name => Object.hasOwn(body, name)))
                throw httpError(400, i18n.t('errors.apiInvalidRequest'));
            params = apiRoutes.decode(route, found.pathParams, query, body);
            params.action = route.action;

            //GET ничего не меняет и токена не требует, любой другой метод - с CSRF-токеном
            if (this.security && route.method !== 'GET' && !this.security.hasValidCsrf(req, header(req, 'x-csrf-token')))
                throw httpError(403, 'bad_csrf_token');

            if (this.profileAccess) {
                await this.profileAccess.prepareRequest(params, req);
                userId = (params.guest || params.profileLoginRequired ? '' : String(params.userId || ''));
            }

            metricToken = runtimeMetrics.beginAction(route.action);
            const ctx = {http: req, res, uploadFile: '', uploadCheck: false};
            if (route.upload)
                result = await this.runUpload(route, params, ctx);
            else
                result = await this.dispatch(route.action, params, ctx);
            if (result === undefined || result === null || typeof result !== 'object')
                result = {};
            metricOk = true;
        } catch (e) {
            [status, result] = this.errorReply(res, e, params);
        } finally {
            this.touchClient(key, userId);
            const left = (this.clientRequests.get(key) || 1) - 1;
            if (left)
                this.clientRequests.set(key, left);
            else
                this.clientRequests.delete(key);
            this.activeRequests--;
            if (large)
                this.largeRequestActive = false;
            runtimeMetrics.endAction(metricToken, metricOk);
        }

        if (this.isDevelopment || this.config.logQueries)
            log(`API-OUT: ${status} ${utils.cutString(JSON.stringify(result, hideSecrets))} ${Date.now() - startTime}ms`);
        this.reply(req, res, status, result);
    }

    // Upload: the handler first checks who asks without the body (ctx.uploadCheck: profile, role), and only then the body
    // is stored to a temp file under the action's limit and handed to the handler as ctx.uploadFile. The file never
    // comes from request parameters.
    async runUpload(route, params, ctx) {
        await this.dispatch(route.action, params, Object.assign({}, ctx, {uploadCheck: true}));
        if (this.uploadActive)
            throw new Error('server_busy');

        this.uploadActive = true;
        let folder = '';
        try {
            const tempRoot = this.config.tempDir || os.tmpdir();
            await fs.ensureDir(tempRoot);
            folder = await fs.mkdtemp(path.join(tempRoot, 'upload-'));
            const file = path.join(folder, 'upload');
            await receiveFile(ctx.http, file, RequestLimits.uploadLimit(route.action, this.config));
            return await this.dispatch(route.action, params, Object.assign({}, ctx, {uploadFile: file}));
        } finally {
            this.uploadActive = false;
            if (folder)
                await fs.remove(folder).catch(() => {});
        }
    }

    // Only actions of the route table reach here (apiRoutes.match): a WebWorker call from workerActions or the
    // controller method named after the action in camelCase (looked up on the instance: tests stub handlers there).
    async dispatch(action, req, ctx) {
        if (Object.hasOwn(workerActions, action))
            return workerActions[action](this.webWorker, req);
        const handler = this[action.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase())];
        if (typeof handler !== 'function')
            throw new Error(`Action not found: ${action}`);
        return handler.call(this, req, ctx);
    }

    async uploadAllowed(check) {
        await check();
        return {ok: true};
    }

    uploadedFile(ctx) {
        if (!ctx.uploadFile)
            throw httpError(400, i18n.t('errors.apiInvalidRequest'));
        return ctx.uploadFile;
    }

    async uploadedJson(ctx) {
        const file = this.uploadedFile(ctx);
        try {
            return JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (e) {
            throw new Error(i18n.t('errors.uploadInvalidJson'), {cause: e});
        }
    }

    //пути сервера (библиотека, данные, временные файлы) из ошибок архивов и файловой системы остаются в журнале
    errorText(e, req = {}) {
        const text = String((e && e.i18nKey ? i18n.t(e.i18nKey, e.i18nParams) : i18n.render(e && e.message)) || '');
        const sources = (Array.isArray(this.config.librarySources) ? this.config.librarySources : []).map(source => source && source.libDir);
        const dirs = [this.config.libDir, this.config.dataDir, this.config.tempDir, this.config.bookDir, this.config.execDir, os.tmpdir(), ...sources]
            .map(dir => String(dir || '')).filter(dir => dir.length > 1);
        if (!dirs.some(dir => text.includes(dir) || text.includes(dir.replace(/\\/g, '/'))))
            return text;
        log(LM_ERR, `API ${(req && req.action) || ''}: ${text}`);
        return i18n.t('errors.serverErrorSeeLog');
    }

    getOnlineMetrics() {
        const now = Date.now();
        const users = new Set();
        let clients = 0;
        let anonymousClients = 0;
        for (const client of this.onlineClients.values()) {
            if (now - client.at > onlinePeriod)
                continue;
            clients++;
            if (client.userId)
                users.add(client.userId);
            else
                anonymousClients++;
        }
        return {clients, users: users.size, anonymousClients};
    }

    //Actions ------------------------------------------------------------------
    async test() {
        return {message: `${this.config.name} project is awesome`};
    }

    async getConfig(req, ctx) {
        if (req.profileLoginRequired) {
            const config = _.pick(this.config, ['name', 'version', 'branch', 'dbVersion', 'rootPathStatic']);
            Object.assign(config, {profileLoginRequired: true, profileAuthorized: false, userProfiles: [],
                currentUserId: '', currentUserProfile: null});
            if (this.security)
                config.csrfToken = this.security.getCsrfToken(ctx.http);
            return config;
        }
        const config = _.pick(this.config, this.config.webConfigParams);
        config.profileLoginRequired = true;
        config.profileBoundId = req.profileBoundId || '';
        config.librarySources = (Array.isArray(this.config.librarySources) ? this.config.librarySources : []).map(source => ({
            id: source.id || '',
            name: source.name || source.id || '',
            enabled: source.enabled !== false,
            remote: !!source.remote,
        }));
        if (this.security)
            config.csrfToken = this.security.getCsrfToken(ctx.http);
        config.discovery = Object.assign(
            {},
            config.discovery || {},
            await this.webWorker.getSharedDiscoveryConfig(),
        );
        config.dbConfig = (this.webWorker.myState === 'normal' ? await this.webWorker.dbConfig() : {});
        config.catalogSearch = (this.webWorker.catalogSearch ? this.webWorker.catalogSearch.status() : {enabled: false, ready: false});
        if (this.webWorker.catalogSearch && config.catalogSearch.enabled) {
            const names = await this.webWorker.catalogSearch.authorNames.info();
            config.catalogSearch.authorNames = {ready: names.ready, updatedAt: names.updatedAt};
        }
        if (req.guest) {
            //гость: каталог без профиля; список профилей и данные администратора не отдаются
            Object.assign(config, {profileLoginRequired: false, guest: true, profileAuthorized: false, userProfiles: [],
                currentUserId: '', currentUserProfile: null, telegramShareEnabled: false, emailShareEnabled: false});
            config.opdsRoot = this.config.opdsRoot || ((this.config.opds && this.config.opds.root) ? this.config.opds.root : '/opds');
            return config;
        }
        const profiles = await this.webWorker.getUserProfiles(req.userId);
        const currentProfile = await this.webWorker.getCurrentUserProfile(req.userId, req.profileAccessToken);
        config.userProfiles = this.profileAccess ? this.profileAccess.filterProfiles(profiles.users, req) : profiles.users;
        config.currentUserId = currentProfile.currentUserId || profiles.currentUserId;
        config.currentUserProfile = currentProfile.currentUserProfile;
        config.profileAuthorized = currentProfile.profileAuthorized;
        config.opdsRoot = this.config.opdsRoot || ((this.config.opds && this.config.opds.root) ? this.config.opds.root : '/opds');

        const currentUser = currentProfile.currentUserProfile || null;
        //отправка книг - только из профиля с паролем (или SSO), см. requireProtectedProfile
        const deliveryAllowed = !!(currentUser && (currentUser.hasPassword || (req.profileBoundId && req.profileBoundId === currentUser.id)));
        config.telegramShareEnabled = !!(
            deliveryAllowed
            && this.config.telegramShareEnabled
            && this.config.telegramBotToken
            && currentUser
            && currentUser.telegramChatId
        );
        config.emailShareEnabled = !!(
            deliveryAllowed
            && this.config.emailShareEnabled
            && this.config.smtpHost
            && currentUser
            && (currentUser.emailTo || this.config.emailTo)
        );
        if (currentUser && currentUser.isAdmin && config.profileAuthorized) {
            config.adminIntegrations = this.webWorker.getAdminIntegrationConfig();
            config.adminOpds = this.webWorker.getAdminOpdsConfig();
            config.adminGuestAccess = this.webWorker.getAdminGuestAccess();
        }

        return config;
    }

    async getWorkerState(req) {
        //состояние есть только у сервера: workerId server_state
        const serverState = (this.webWorker && this.webWorker.serverState) || {};
        if (req.profileLoginRequired || req.guest) {
            const state = serverState;
            return {state: state.state || 'normal', serverMessage: state.state === 'normal' ? '' : i18n.t('server.preparingLibrary')};
        }
        if (!req.workerId)
            throw new Error(`key 'workerId' is empty`);

        const state = (req.workerId === 'server_state' ? serverState : null);
        //сообщения состояния хранятся как ключи/описания переводов и переводятся на языке запроса
        return (state ? Object.assign({}, state, {
            serverMessage: i18n.render(state.serverMessage),
            jobMessage: i18n.render(state.jobMessage),
        }) : {});
    }

    async getAuthorBookList(req) {
        //без authorId автор ищется по точному имени (страница автора)
        const author = (req.authorId ? undefined : String(req.author || '').trim());
        const result = await this.webWorker.getAuthorBookList(req.authorId, author, req.query);

        return result;
    }

    async getDiscoveryShelves(req) {
        //гостю - общие полки из кеша: без персональных, без перезагрузки и без настроек источника администратора
        if (req.guest)
            req = {action: req.action, section: 'external', externalLimit: req.externalLimit};
        const result = await this.webWorker.getDiscoveryShelvesV2({
            userId: req.userId,
            profileAccessToken: req.profileAccessToken,
            section: req.section,
            forceRefresh: req.forceRefresh === true,
            personalLimit: req.personalLimit,
            personalSimilarLimit: req.personalSimilarLimit,
            personalSimilarEnabled: req.personalSimilarEnabled,
            newestLimit: req.newestLimit,
            popularLimit: req.popularLimit,
            externalLimit: req.externalLimit,
            externalSource: req.externalSource,
            externalName: req.externalName,
            externalTtlMinutes: req.externalTtlMinutes,
            externalBrowseUrl: req.externalBrowseUrl,
            externalLanguages: req.externalLanguages,
        });

        return result;
    }

    async recordDiscoveryEvents(req) {
        if (req.guest)
            return {};
        const result = await this.webWorker.recordDiscoveryEvents(
            req.userId,
            req.profileAccessToken,
            req.events || [],
        );

        return result;
    }

    async adminRebuildCover(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.rebuildCoverCacheForBook(req.userId, req.profileAccessToken, req.bookUid);
        return result;
    }

    async getBookLink(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.getBookLink(req.bookUid);

        return result;
    }

    async getAuthorAliases(req) {
        this.webWorker.checkMyState();
        const aliases = await this.webWorker.catalogSearch.authorAliases(String(req.author || ''));
        return {aliases};
    }

    async adminAuthorNamesStatus(req) {
        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        return await this.webWorker.catalogSearch.wikidataStatus(req.table);
    }

    //req.table: 'author-names' (по умолчанию) или 'work-titles'
    async adminAuthorNamesUpdate(req) {
        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        this.webWorker.catalogSearch.startWikidataDownload(req.table);
        return await this.webWorker.catalogSearch.wikidataStatus(req.table);
    }

    async catalogNames(req) {
        this.webWorker.checkMyState();
        const result = await this.webWorker.catalogSearch.listNames({
            kind: (req.kind === 'series' ? 'series' : 'author'),
            q: String(req.q || ''),
            offset: req.offset,
            limit: req.limit,
        });
        return result;
    }

    async catalogSearch(req) {
        this.webWorker.checkMyState();
        const result = await this.webWorker.catalogSearch.search({
            q: String(req.q || ''),
            filters: req.filters || {},
            sort: req.sort,
            offset: req.offset,
            limit: req.limit,
            group: req.hideCopies === true,
            showDeleted: req.showDeleted === true,
            facets: req.facets !== false,
        });
        return result;
    }

    async catalogSuggest(req) {
        this.webWorker.checkMyState();
        const result = await this.webWorker.catalogSearch.suggest({q: String(req.q || '')});
        return result;
    }

    async getBook(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const result = await this.webWorker.getBook(req.bookUid);
        return result;
    }

    //Гостю и профилю без входа отвечаем пустым набором, а не need_profile_login: страницы каталога открыты всем
    async getBookStates(req) {
        if (req.guest)
            return this.webWorker.getUserBookStates(null, req.bookUids, []);
        const user = await this.webWorker.getAuthorizedUserOrNull(req.userId, req.profileAccessToken);
        const lists = (user ? await this.webWorker.readingListStore.getLists(user.id) : []);
        return this.webWorker.getUserBookStates(user, req.bookUids, lists);
    }

    async getBookInfo(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const result = await this.webWorker.getBookInfo(req.bookUid, {fetchRemote: req.fetchRemote === true});

        return result;
    }

    async getReadingLists(req) {
        if (req.guest)
            return {lists: []};
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReadingLists(user.id, req.bookUid, this.listOptions(req));
        return result;
    }

    //от клиента - только фильтр по видимости: прочие опции хранилища не для запросов
    listOptions(req) {
        return _.pick((req.options && typeof(req.options) === 'object' ? req.options : {}), ['visibility']);
    }

    async getReaderState(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReaderState(user.id, req.bookUid);
        return result;
    }

    async getUserReadingLibrary(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getUserReadingLibrary(user, req.options || {});
        return result;
    }

    async getReadingStats(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.getReadingStats(user);
    }

    async updateReaderProgress(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.updateReaderProgress(user.id, req.bookUid, req.progress || {});
        return result;
    }

    async deleteReaderProgress(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReaderProgress(user.id, req.bookUid);
        return result;
    }

    async forgetBooks(req) {
        if (!Array.isArray(req.bookUids) || req.bookUids.length > 5000)
            throw new Error('bookUids is invalid');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.forgetBooks(user.id, req.bookUids);
    }

    async clearReaderProgress(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.clearReaderProgress(user.id);
        return result;
    }

    async updateReaderPreferences(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.updateReaderPreferences(user.id, req.preferences || {});
        return result;
    }

    async addReaderBookmark(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.addReaderBookmark(user.id, req.bookUid, req.bookmark || {});
        return result;
    }

    async deleteReaderBookmark(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error('bookUid is empty');
        if (!utils.hasProp(req, 'bookmarkId'))
            throw new Error('bookmarkId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReaderBookmark(user.id, req.bookUid, req.bookmarkId);
        return result;
    }

    async getUserProfiles(req) {
        const result = await this.webWorker.getUserProfiles(req.userId);
        if (this.profileAccess)
            result.users = this.profileAccess.filterProfiles(result.users, req);
        return result;
    }

    async loginUserProfile(req, ctx) {
        if (this.security) {
            this.security.checkLoginRate(ctx.http, 'profile');
            this.security.checkAccountRate('profile', req.login);
        }

        try {
            const {userId, sessionsValidAfter} = await this.webWorker.loginUserProfile(req.login, req.password);
            if (this.security) {
                this.security.startSession(ctx.http, ctx.res, userId, sessionsValidAfter);
                this.security.recordLoginAttempt(ctx.http, true, 'profile');
                this.security.recordAccountAttempt('profile', req.login, true);
            }
            return {userId};
        } catch (e) {
            //занятая проверка паролей - не неудачный вход
            if (this.security && e.code !== profilePassword.busyCode) {
                this.security.recordLoginAttempt(ctx.http, false, 'profile');
                this.security.recordAccountAttempt('profile', req.login, false);
            }
            throw e;
        }
    }

    async logoutUserProfile(req, ctx) {
        //браузер получает новую анонимную сессию; копия прежней cookie действует до своих сроков
        if (this.security)
            this.security.startSession(ctx.http, ctx.res, '');
        return {success: true};
    }

    async createUserProfile(req) {
        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        const profile = Object.assign({}, req.profile || {});
        delete profile.passwordHash;
        if (profile.password && !String(profile.login || '').trim())
            throw new Error(i18n.t('errors.passwordNeedsLogin'));
        //без пароля профиль открывается только через SSO-привязку
        if (!(this.profileAccess && this.profileAccess.bindingEnabled) && !(profile.password && String(profile.login || '').trim()))
            throw new Error(i18n.t('errors.profileCredentialsRequired'));
        if (profile.password)
            profile.passwordHash = await this.webWorker.hashProfilePassword(profile.login, profile.password);
        delete profile.password;

        return publicUser(await this.webWorker.createUserProfile(profile));
    }

    async updateUserProfile(req, ctx) {
        if (!utils.hasProp(req, 'targetUserId'))
            throw new Error('targetUserId is empty');

        const store = this.webWorker.readingListStore;
        //только точный id: getUser нашёл бы профиль и по логину, а по неизвестному id - главного администратора
        if (!await store.hasUser(req.targetUserId))
            throw new Error(i18n.t('errors.userNotFound'));
        const target = await store.getUser(req.targetUserId);
        const current = await this.webWorker.getEffectiveUser(req.userId, req.profileAccessToken);
        const isOwnProfile = !!(current && current.id === target.id);
        if (isOwnProfile) {
            await this.webWorker.requireAuthorizedUser(target.id, req.profileAccessToken);
        } else {
            await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);
        }

        const profile = Object.assign({}, req.profile || {});
        delete profile.passwordHash;
        if (isOwnProfile && (profile.password || (utils.hasProp(profile, 'login') && store.normalizeLogin(profile.login) !== (target.login || ''))))
            await this.requireProtectedProfile(target, req);
        //свой пароль меняют, только зная текущий: открытая чужая сессия не должна отнимать профиль
        const deliveryChanged = ['emailTo', 'telegramChatId'].some(key => utils.hasProp(profile, key)
            && String(profile[key] || '').trim() !== String(target[key] || ''));
        if (isOwnProfile && deliveryChanged)
            await this.requireProtectedProfile(target, req, 'errors.deliveryNeedsPassword');
        if (isOwnProfile && target.passwordHash && profile.password) {
            if (this.security)
                this.security.checkLoginRate(ctx.http, 'profile');
            if (!await store.verifyUserPassword(target.id, String(profile.currentPassword || ''))) {
                if (this.security)
                    this.security.recordLoginAttempt(ctx.http, false, 'profile');
                throw new Error(i18n.t('errors.currentPasswordInvalid'));
            }
        }
        delete profile.currentPassword;
        const passwordLogin = String(profile.login || target.login || '').trim();
        if (profile.password && !passwordLogin)
            throw new Error(i18n.t('errors.passwordNeedsLogin'));
        if (profile.password)
            profile.passwordHash = await this.webWorker.hashProfilePassword(passwordLogin, profile.password);
        delete profile.password;
        //роль меняет только администратор и только у чужого профиля: себя случайно не разжаловать
        if (isOwnProfile)
            delete profile.isAdmin;

        return publicUser(await this.webWorker.updateUserProfile(target.id, profile));
    }

    //профиль, закреплённый за пользователем SSO, защищён прокси и без своего пароля
    async isProtectedProfile(user, req) {
        return !!(req.profileBoundId && req.profileBoundId === user.id) || await this.webWorker.isProtectedProfile(user, req.profileAccessToken);
    }

    async requireProtectedProfile(user, req, messageKey = 'errors.openProfileCredentialsAdminOnly') {
        if (!await this.isProtectedProfile(user, req))
            throw new Error(i18n.t(messageKey));
    }

    async deleteUserProfile(req) {
        if (!utils.hasProp(req, 'targetUserId'))
            throw new Error('targetUserId is empty');

        await this.webWorker.requireAdmin(req.userId, req.profileAccessToken);

        const result = await this.webWorker.deleteUserProfile(req.targetUserId);
        return result;
    }

    async getReadingNow(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.getReadingNow(user, req.hidden === true);
    }

    async getReadingList(req) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.getReadingList(user.id, req.listId, this.listOptions(req));
        return result;
    }

    async createReadingList(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.createReadingList(user.id, req.name, req.visibility);
        return result;
    }

    async updateReadingList(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.updateReadingList(user.id, req.listId, _.pick(req, ['name', 'visibility']));
    }

    async deleteReadingList(req) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.deleteReadingList(user.id, req.listId);
        return result;
    }

    async exportReadingLists(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.exportReadingLists(user.id);
        return result;
    }

    async importAdminSettings(req, ctx) {
        if (ctx.uploadCheck)
            return this.uploadAllowed(() => this.webWorker.requireAdmin(req.userId, req.profileAccessToken));
        const result = await this.webWorker.importAdminSettings(req.userId, req.profileAccessToken, await this.uploadedJson(ctx));
        return result;
    }

    async importAdminBackup(req, ctx) {
        if (ctx.uploadCheck)
            return this.uploadAllowed(() => this.webWorker.requireAdmin(req.userId, req.profileAccessToken));
        const result = await this.webWorker.importAdminBackup(req.userId, req.profileAccessToken, {file: this.uploadedFile(ctx)}, req.scope);
        return result;
    }

    async importReadingLists(req, ctx) {
        if (ctx.uploadCheck)
            return this.uploadAllowed(() => this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken));
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const data = await this.uploadedJson(ctx);
        //в открытый профиль из файла не переносятся устройства Kobo (их токены), адреса отправки, пароль OPDS и ключ KOReader
        //с его позициями: прямые маршруты к ним требуют защищённого профиля, см. requireProtectedProfile
        if (data && typeof(data) === 'object' && !await this.isProtectedProfile(user, req)) {
            delete data.kobo;
            if (data.user && typeof(data.user) === 'object') {
                for (const key of ['emailTo', 'telegramChatId', 'opdsPasswordHash', 'kosyncKeyHash', 'kosyncProgress'])
                    delete data.user[key];
            }
        }
        const result = await this.webWorker.importReadingLists(user.id, data);
        return result;
    }

    async addReadingListBook(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.updateReadingListBook(user.id, req.listId, req.bookUid, true);
    }

    async removeReadingListBook(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.updateReadingListBook(user.id, req.listId, req.bookUid, false);
    }

    async replaceListedBook(req) {
        if (!req.toUid)
            throw new Error('bookUid is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.replaceListedBook(user.id, req.bookUid, req.toUid);
    }

    async markBookRead(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.markReaderBooksRead(user.id, [req.bookUid], true);
    }

    async unmarkBookRead(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        return await this.webWorker.markReaderBooksRead(user.id, [req.bookUid], false);
    }

    async markReaderBooksRead(req) {
        if (!utils.hasProp(req, 'bookUids'))
            throw new Error('bookUids is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.markReaderBooksRead(user.id, req.bookUids, req.read);
        return result;
    }

    async markSeriesRead(req) {
        if (!utils.hasProp(req, 'series'))
            throw new Error('series is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.markSeriesRead(user.id, req.series, req.read);
        return result;
    }

    async addSeriesToReadingList(req) {
        if (!utils.hasProp(req, 'listId'))
            throw new Error('listId is empty');
        if (!utils.hasProp(req, 'series'))
            throw new Error('series is empty');

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        const result = await this.webWorker.addSeriesToReadingList(user.id, req.listId, req.series);
        return result;
    }

    async koboUser(req) {
        const kobo = this.webWorker.koboService;
        if (!kobo)
            throw new Error(i18n.t('errors.koboDisabled'));
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        // A device token reads the profile's lists: the shared "no profile" mode has no owner to bind it to.
        if (user.id === 'default' && !user.login && !user.passwordHash)
            throw new Error(i18n.t('errors.koboNeedsProfile'));
        return {kobo, user};
    }

    koboDeviceSettings(req) {
        const settings = (req.device && typeof(req.device) === 'object' ? req.device : {});
        return Object.fromEntries(['name', 'listIds', 'keepRemovedBooks', 'resendDeletedBooks', 'storeProxy']
            .filter(key => utils.hasProp(settings, key)).map(key => [key, settings[key]]));
    }

    async getKoboDevices(req) {
        const {kobo, user} = await this.koboUser(req);
        return await kobo.getDevices(user.id);
    }

    async createKoboDevice(req, ctx) {
        const {kobo, user} = await this.koboUser(req);
        await this.requireProtectedProfile(user, req);
        return await kobo.createDevice(user.id, this.koboDeviceSettings(req), ctx.http);
    }

    async updateKoboDevice(req) {
        const {kobo, user} = await this.koboUser(req);
        return await kobo.updateDevice(user.id, String(req.deviceId || ''), this.koboDeviceSettings(req));
    }

    async regenerateKoboDeviceToken(req, ctx) {
        const {kobo, user} = await this.koboUser(req);
        await this.requireProtectedProfile(user, req);
        return await kobo.regenerateToken(user.id, String(req.deviceId || ''), ctx.http);
    }

    async resetKoboDevice(req) {
        const {kobo, user} = await this.koboUser(req);
        return await kobo.store.resetDevice(user.id, String(req.deviceId || ''));
    }

    async refreshKoboDevice(req) {
        const {kobo, user} = await this.koboUser(req);
        return await kobo.refreshDevice(user.id, String(req.deviceId || ''));
    }

    async deleteKoboDevice(req) {
        const {kobo, user} = await this.koboUser(req);
        return await kobo.store.deleteDevice(user.id, String(req.deviceId || ''));
    }

    // OPDS password: generated and shown once, or chosen by the user (10+ characters). A new one replaces the old.
    async setOpdsPassword(req) {
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        if (user.opdsEnabled === false)
            throw new Error(i18n.t('errors.opdsOffForProfile'));
        await this.requireProtectedProfile(user, req);
        const chosen = String(req.password || '');
        const password = chosen || require('crypto').randomBytes(12).toString('base64url');
        await this.webWorker.readingListStore.setOpdsPassword(user.id, await this.webWorker.hashProfilePassword(user.login, password));
        return {username: user.login, password: (chosen ? '' : password)};
    }

    // The KOReader password is shown once; a new one replaces the old.
    async createKosyncPassword(req) {
        if (!this.config.kosyncEnabled)
            throw new Error(i18n.t('errors.kosyncDisabled'));
        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        // The shared "no profile" mode has no owner for the progress.
        if (user.id === 'default' && !user.login && !user.passwordHash)
            throw new Error(i18n.t('errors.kosyncNeedsProfile'));
        await this.requireProtectedProfile(user, req);
        const password = await this.webWorker.readingListStore.createKosyncPassword(user.id);
        return {username: user.login || user.id, password};
    }

    async sendBookTelegram(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        await this.requireProtectedProfile(user, req, 'errors.deliveryNeedsPassword');
        const result = await this.webWorker.sendBookToTelegram(req.bookUid, req.format, user.id);
        return result;
    }

    async sendBookEmail(req) {
        if (!utils.hasProp(req, 'bookUid'))
            throw new Error(`bookUid is empty`);

        const user = await this.webWorker.requireAuthorizedUser(req.userId, req.profileAccessToken);
        await this.requireProtectedProfile(user, req, 'errors.deliveryNeedsPassword');
        const result = await this.webWorker.sendBookToEmail(req.bookUid, req.format, user.id);
        return result;
    }

}

module.exports = ApiController;
