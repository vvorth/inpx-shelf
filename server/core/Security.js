const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const sessionLifetime = require('./SessionLifetime');

// Cookie names keep the pre-rename inpx-web prefix so existing sessions survive the update.
const sessionCookieName = 'inpx_web_session';
const secretFileName = 'session-secret';
const defaultLoginWindowMs = 15*60*1000;
const defaultLoginMaxAttempts = 8;
const maxLoginAttemptKeys = 10000;
//per-login throttle: after accountFreeFailures failures each next attempt waits twice as long, up to accountMaxDelayMs
const accountFreeFailures = 5;
const accountMaxDelayMs = 5*60*1000;
const accountFailureWindowMs = 60*60*1000;
//updatedAt вошедшей сессии пишется на диск не чаще раза в минуту: тайм-аут простоя - дни
const sessionTouchMs = 60*1000;

function parseIpv4(value = '') {
    const normalized = String(value || '').trim()
        .replace(/^::ffff:/i, '')
        .replace(/^::1$/, '127.0.0.1');
    const parts = normalized.split('.');
    if (parts.length !== 4)
        return null;

    let result = 0;
    for (const part of parts) {
        if (!/^\d+$/.test(part))
            return null;

        const n = Number(part);
        if (n < 0 || n > 255)
            return null;

        result = (result << 8) + n;
    }

    return result >>> 0;
}

function parseCidr(value = '') {
    const raw = String(value || '').trim();
    if (!raw)
        return null;

    const [ip, bitsRaw] = raw.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    const base = parseIpv4(ip);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
        return null;

    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return {base: (base & mask) >>> 0, mask};
}

// IPv6 client gets a whole /64: one address per request would bypass the per-IP login limit.
function loginAddress(value = '') {
    const address = String(value || '').replace(/^\[|\]$/g, '').split('%')[0];
    if (!require('net').isIPv6(address) || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address))
        return value;
    const [head, tail = ''] = address.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = (address.includes('::') && tail ? tail.split(':') : []);
    const groups = left.concat(Array(Math.max(0, 8 - left.length - right.length)).fill('0'), right);
    return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function timingSafeStringEqual(a = '', b = '') {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function logSecurityWarning(message = '') {
    try {
        new (require('./AppLogger'))().log(LM_WARN, message);
    } catch (e) {
        // Security checks must keep working even before the app logger is initialized.
    }
}

class Security {
    constructor(config) {
        this.config = config;
        this.sessions = new Map();
        this.loginAttempts = new Map();
        this.lastLoginAttemptSweep = 0;
        this.loginAttemptTotals = new Map();
        this.accountFailures = new Map();
        this.secret = '';
        this.trustedProxyRanges = (config.trustedProxyCidrs || [])
            .map(parseCidr)
            .filter(Boolean);
    }

    async init() {
        const secretFile = path.join(this.config.dataDir, secretFileName);
        if (await fs.pathExists(secretFile)) {
            this.secret = String(await fs.readFile(secretFile, 'utf8')).trim();
        }

        if (!this.secret) {
            this.secret = crypto.randomBytes(48).toString('hex');
            await require('./FilePersistence').writeFileAtomic(secretFile, this.secret);
        }
    }

    sign(value) {
        return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
    }

    randomToken(bytes = 32) {
        return crypto.randomBytes(bytes).toString('hex');
    }

    cookieOptions(req) {
        const root = this.config.rootPathStatic || '/';
        const secure = this.isSecureRequest(req);
        return [
            'HttpOnly',
            'SameSite=Lax',
            `Path=${root || '/'}`,
            'Max-Age=2592000',
            ...(secure ? ['Secure'] : []),
        ].join('; ');
    }

    parseCookies(header = '') {
        const result = {};
        for (const part of String(header || '').split(';')) {
            const idx = part.indexOf('=');
            if (idx < 0)
                continue;

            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (key) {
                try {
                    result[key] = decodeURIComponent(value);
                } catch (e) {
                    // Ignore malformed cookies instead of failing the request.
                }
            }
        }
        return result;
    }

    packSessionId(sessionId) {
        return `${sessionId}.${this.sign(sessionId)}`;
    }

    unpackSessionId(raw = '') {
        const [sessionId, signature] = String(raw || '').split('.');
        if (!sessionId || !signature)
            return '';

        const expected = this.sign(sessionId);
        if (!timingSafeStringEqual(signature, expected)) {
            return '';
        }

        return sessionId;
    }

    getSession(req) {
        const cookies = this.parseCookies(req.headers.cookie || '');
        const sessionId = req.securitySession ? req.securitySession.id
            : this.unpackSessionId(cookies[sessionCookieName] || '');
        const session = this.sessions.get(sessionId) || this.restoreSession(sessionId);
        if (sessionLifetime.expired(session)) {
            this.sessions.delete(sessionId);
            if (this.profiles && sessionId)
                this.profiles.stateStore.deleteWebSession(this.sessionHash(sessionId));
            delete req.securitySession;
            return null;
        }
        session.updatedAt = Date.now();
        if (session.updatedAt - (session.persistedAt || 0) > sessionTouchMs)
            this.persistSession(session);
        req.securitySession = session;
        return session;
    }

    //Сессии вошедших в профиль переживают перезапуск: worker - профили и state.sqlite (WebWorker)
    attachProfiles(worker) {
        this.profiles = worker;
        worker.stateStore.purgeWebSessions(Date.now() - sessionLifetime.maxAgeMs, Date.now() - sessionLifetime.idleMs);
    }

    sessionHash(sessionId) {
        return crypto.createHash('sha256').update(String(sessionId)).digest('hex');
    }

    //SSO-привязка восстанавливается сама по заголовку прокси, анонимные сессии на диск не пишутся
    persistSession(session) {
        if (!this.profiles)
            return;
        const userId = (session.proxyProfileUserId ? '' : this.profiles.getProfileSessionUser(session.profileAccessToken));
        const idHash = this.sessionHash(session.id);
        if (userId)
            this.profiles.stateStore.putWebSession(idHash, {userId, csrfToken: session.csrfToken, createdAt: session.createdAt, updatedAt: session.updatedAt});
        else if (session.persistedAt)
            this.profiles.stateStore.deleteWebSession(idHash);
        session.persistedAt = (userId ? Date.now() : 0);
    }

    restoreSession(sessionId) {
        const row = (this.profiles && sessionId ? this.profiles.stateStore.getWebSession(this.sessionHash(sessionId)) : null);
        if (!row)
            return null;
        sessionLifetime.makeRoom(this.sessions);
        //токен профиля - новый, но срок жизни считается от прежнего входа
        const session = {id: sessionId, csrfToken: row.csrfToken, createdAt: row.createdAt, updatedAt: row.updatedAt, persistedAt: Date.now(),
            profileAccessToken: this.profiles.createProfileSession(row.userId, row.createdAt)};
        this.sessions.set(sessionId, session);
        return session;
    }

    ensureSession(req, res = null) {
        let session = this.getSession(req);

        if (!session) {
            sessionLifetime.makeRoom(this.sessions);
            const sessionId = this.randomToken(24);
            session = {
                id: sessionId,
                csrfToken: this.randomToken(32),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.sessions.set(sessionId, session);
        } else {
            session.updatedAt = Date.now();
        }

        req.securitySession = session;

        if (res)
            res.setHeader('Set-Cookie', this.sessionCookie(req, session));

        return session;
    }

    sessionCookie(req, session) {
        return `${sessionCookieName}=${encodeURIComponent(this.packSessionId(session.id))}; ${this.cookieOptions(req)}`;
    }

    //Вход и выход: сессия переезжает на новый id, и cookie со старым id, в том числе подброшенная до входа
    //(session fixation), входа не видит. Новую cookie браузер получает в ответе на этот же запрос
    rotateSession(req, res) {
        const session = req.securitySession;
        if (!session)
            return null;
        const now = Date.now();
        if (this.sessions.get(session.id) === session)
            this.sessions.delete(session.id);
        else
            sessionLifetime.makeRoom(this.sessions);
        if (this.profiles && session.persistedAt)
            this.profiles.stateStore.deleteWebSession(this.sessionHash(session.id));
        session.id = this.randomToken(24);
        session.createdAt = now;
        session.updatedAt = now;
        session.persistedAt = 0;
        this.sessions.set(session.id, session);
        this.persistSession(session);
        res.setHeader('Set-Cookie', this.sessionCookie(req, session));
        return session;
    }

    //Запросы <root>/api. Заголовок X-Inpx-Api не задать ни переходом, ни <img>/<form> с чужого сайта, а fetch с ним
    //с чужого сайта требует CORS preflight, на который сервер не отвечает; Sec-Fetch-Site и Origin, если есть, - свой сайт.
    //Cookie сессии, которой сервер не знает (перезапуск), заменяется новой в ответе: иначе книги и обложки по HTTP
    //шли бы со старой cookie без входа
    apiGuard() {
        return (req, res, next) => {
            const fetchSite = this.headerFirstValue(req, 'sec-fetch-site').toLowerCase();
            const sameOrigin = this.sameOriginCheck(req);
            let reason = '';
            if (String(req.headers['x-inpx-api'] || '') !== '1')
                reason = 'no X-Inpx-Api header';
            else if (fetchSite && !['same-origin', 'none'].includes(fetchSite))
                reason = `sec-fetch-site=${fetchSite}`;
            else if (!sameOrigin.ok)
                reason = `origin mismatch, origin=${sameOrigin.origin || '-'}, expected=${sameOrigin.expectedOrigins.join(',') || '-'}, host=${this.requestHost(req) || '-'}, x-forwarded-host=${this.headerFirstValue(req, 'x-forwarded-host') || '-'}, x-forwarded-proto=${this.headerFirstValue(req, 'x-forwarded-proto') || '-'}`;
            if (reason) {
                logSecurityWarning(`API forbidden: ${reason}, remote=${this.clientIp(req) || '-'}`);
                res.set('Cache-Control', 'no-store');
                return res.status(403).json({error: 'Forbidden'});
            }
            if (!req.securitySession)
                this.ensureSession(req, res);
            next();
        };
    }

    isSecureRequest(req) {
        return !!(req.secure || this.requestProto(req) === 'https' || this.forwardedProto(req) === 'https');
    }

    //Приложение не встраивается в чужие фреймы (clickjacking). Скрипты и стили CSP не ограничивает:
    //Quasar и читалка используют встроенные стили и data:-изображения.
    applySecurityHeaders(req, res) {
        const csp = ["frame-ancestors 'none'"];
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        if (this.isSecureRequest(req)) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            csp.push('upgrade-insecure-requests');
        }
        res.setHeader('Content-Security-Policy', csp.join('; '));
    }

    middleware() {
        return (req, res, next) => {
            this.applySecurityHeaders(req, res);
            // Only a document navigation needs a new browser session. Polling and
            // public assets must not allocate a session on every cookie-less hit.
            const pathname = String(req.path || '/');
            const root = String(this.config.rootPathStatic || '').replace(/\/$/, '');
            const documentRequest = pathname === `${root}/` || pathname === root
                || String(req.headers.accept || '').includes('text/html');
            if (!this.isHealthPath(req) && !this.isMetricsPath(req) && documentRequest)
                this.ensureSession(req, res);
            else
                this.getSession(req);
            next();
        };
    }

    requiredAuthMiddleware() {
        return (req, res, next) => {
            const result = this.verifyRequiredAuth(req);
            if (result.ok) {
                next();
                return;
            }

            res.status(result.status || 401).send(result.message || 'Authentication required');
        };
    }

    isHealthPath(req) {
        const pathname = String((req && req.path) || '').replace(/\/+$/, '') || '/';
        return ['/health', '/ready', '/api/index-status'].includes(pathname);
    }

    isMetricsPath(req) {
        const pathname = String((req && req.path) || '').replace(/\/+$/, '') || '/';
        const metricsPath = String(this.config.metricsPath || '/metrics').replace(/\/+$/, '') || '/metrics';
        return pathname === metricsPath;
    }

    isTrustedProxy(req) {
        if (!this.config.trustProxy)
            return false;

        const address = req && req.socket ? req.socket.remoteAddress : '';
        return this.isTrustedProxyAddress(address);
    }

    isTrustedProxyAddress(address = '') {
        const ip = parseIpv4(address);
        if (ip === null)
            return false;

        return this.trustedProxyRanges.some(range => (ip & range.mask) >>> 0 === range.base);
    }

    forwardedHeader(req, name = '') {
        if (!this.isTrustedProxy(req))
            return '';

        return this.headerFirstValue(req, name);
    }

    headerFirstValue(req, name = '') {
        return String(req.headers[String(name || '').toLowerCase()] || '').split(',')[0].trim();
    }

    forwardedProto(req) {
        return this.forwardedHeader(req, 'x-forwarded-proto');
    }

    forwardedHost(req) {
        return this.forwardedHeader(req, 'x-forwarded-host');
    }

    requestHost(req) {
        return this.headerFirstValue(req, 'host');
    }

    requestProto(req) {
        return (req.socket && req.socket.encrypted ? 'https' : 'http');
    }

    getProxyAuthUser(req) {
        if (!this.isTrustedProxy(req))
            return '';

        const headerName = String(this.config.proxyAuthHeader || 'Remote-User').trim().toLowerCase();
        return String(req.headers[headerName] || '').trim();
    }

    bearerToken(req) {
        const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        return match ? match[1].trim() : '';
    }

    //только заголовок: токен в ?token= оседает в журналах прокси и истории браузера
    hasValidMetricsToken(req) {
        const expected = String(this.config.metricsToken || '').trim();
        const supplied = this.bearerToken(req);
        return !!(expected && supplied && timingSafeStringEqual(supplied, expected));
    }

    isMetricsAuthExempt(req) {
        return !!(this.config.metricsEnabled && this.isMetricsPath(req) && this.hasValidMetricsToken(req));
    }

    verifyRequiredAuth(req) {
        // A Kobo device token grants access only to that device's /kobo/<token>/ routes.
        if (require('./kobo').isAuthorizedRequest(req, this.config))
            return {ok: true};
        // KOReader progress sync checks the profile's KOReader key itself, on its own routes only.
        if (require('./Kosync').isKosyncRequest(req, this.config))
            return {ok: true};
        // The remote library API checks its bearer token itself.
        if (require('./RemoteAccess').isRemoteRequest(req, this.config))
            return {ok: true};
        const mode = String(this.config.authMode || 'local').trim().toLowerCase();
        if (!this.config.requireAuth && !(mode === 'proxy' && this.config.proxyBindProfile))
            return {ok: true};

        if (this.config.authExemptHealth !== false && this.isHealthPath(req))
            return {ok: true};

        if (this.isMetricsAuthExempt(req))
            return {ok: true};

        if (mode === 'none')
            return {ok: true};

        if (mode === 'proxy') {
            const user = this.getProxyAuthUser(req);
            if (user)
                return {ok: true, user};

            return this.isTrustedProxy(req)
                ? {ok: false, status: 401, message: 'Proxy authentication required'}
                : {ok: false, status: 403, message: 'Direct access is forbidden'};
        }

        return {ok: true};
    }

    normalizeOrigin(value = '') {
        try {
            return new URL(String(value || '').trim()).origin;
        } catch (e) {
            return '';
        }
    }

    sameOriginCheck(req) {
        const origin = String(req.headers.origin || '').trim();
        if (!origin)
            return {ok: true, origin: '', expectedOrigins: []};

        const normalizedOrigin = this.normalizeOrigin(origin);
        if (!normalizedOrigin)
            return {ok: false, origin, expectedOrigins: []};

        // X-Forwarded-* is taken from any client here: it only widens what the Origin may match.
        const hosts = [
            this.headerFirstValue(req, 'x-forwarded-host'),
            this.requestHost(req),
        ].filter(Boolean);
        const protos = [
            this.headerFirstValue(req, 'x-forwarded-proto'),
            this.requestProto(req),
        ].filter(Boolean);

        const expectedOrigins = Array.from(new Set(
            hosts.flatMap(host => protos.map(proto => this.normalizeOrigin(`${proto}://${host}`)))
                .filter(Boolean)
        ));

        return {
            ok: expectedOrigins.includes(normalizedOrigin),
            origin: normalizedOrigin,
            expectedOrigins,
        };
    }

    getCsrfToken(req) {
        const session = this.ensureSession(req);
        return session.csrfToken;
    }

    hasValidCsrf(req, token = '') {
        const session = this.ensureSession(req);
        const supplied = String(token || '').trim();
        if (!supplied || supplied.length !== session.csrfToken.length)
            return false;

        return timingSafeStringEqual(supplied, session.csrfToken);
    }

    clientIp(req) {
        // Proxies append the address they saw ($proxy_add_x_forwarded_for), so the first entries
        // are whatever the client sent. Take the rightmost one that is not a trusted proxy.
        const chain = (this.isTrustedProxy(req) ? String(req.headers['x-forwarded-for'] || '') : '')
            .split(',').map(item => item.trim()).filter(Boolean);
        while (chain.length > 1 && this.isTrustedProxyAddress(chain[chain.length - 1]))
            chain.pop();
        return chain.pop() || (req.socket && req.socket.remoteAddress) || '';
    }

    normalizeLoginKind(kind = 'profile') {
        const normalized = String(kind || 'profile').trim().toLowerCase();
        return ['profile', 'opds', 'kobo', 'kosync', 'remote'].includes(normalized) ? normalized : 'profile';
    }

    loginAttemptKey(req, kind) {
        // One counter per kind: a success of one kind must not clear the failures of another.
        return `${this.normalizeLoginKind(kind)}:${loginAddress(this.clientIp(req)) || 'unknown'}`;
    }

    incrementLoginMetric(kind = 'profile', result = 'failure') {
        const key = `${this.normalizeLoginKind(kind)}\t${String(result || 'failure').toLowerCase()}`;
        this.loginAttemptTotals.set(key, (this.loginAttemptTotals.get(key) || 0) + 1);
    }

    pruneLoginAttempts(now = Date.now()) {
        if (now - this.lastLoginAttemptSweep < 60000 && this.loginAttempts.size < maxLoginAttemptKeys)
            return;
        for (const [key, rec] of this.loginAttempts) {
            if (now > rec.resetAt)
                this.loginAttempts.delete(key);
        }
        this.lastLoginAttemptSweep = now;
    }

    checkLoginRate(req, kind = 'profile') {
        if (this.config.loginRateLimitEnabled === false)
            return;

        const ip = this.loginAttemptKey(req, kind);
        const now = Date.now();
        this.pruneLoginAttempts(now);
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const maxAttempts = Math.max(1, Number(this.config.loginRateLimitMaxAttempts || defaultLoginMaxAttempts));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};

        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }

        if (rec.count >= maxAttempts) {
            this.incrementLoginMetric(kind, 'blocked');
            throw Object.assign(new Error('Too many login attempts. Try again later.'), {
                code: 'INPX_LOGIN_RATE_LIMIT', retryAfter: Math.max(1, Math.ceil((rec.resetAt - now)/1000)),
            });
        }
    }

    recordLoginAttempt(req, success = false, kind = 'profile') {
        const ip = this.loginAttemptKey(req, kind);
        this.incrementLoginMetric(kind, success ? 'success' : 'failure');
        if (this.config.loginRateLimitEnabled === false)
            return;

        // Logging in to a known profile must not erase failures against other profiles (the admin's among them).
        if (success)
            return;

        const now = Date.now();
        this.pruneLoginAttempts(now);
        //таблица полна: вытесняем самую старую запись, а не отказываем всем новым адресам
        if (!this.loginAttempts.has(ip) && this.loginAttempts.size >= maxLoginAttemptKeys)
            this.loginAttempts.delete(this.loginAttempts.keys().next().value);
        const windowMs = Math.max(60*1000, Number(this.config.loginRateLimitWindowMs || defaultLoginWindowMs));
        const rec = this.loginAttempts.get(ip) || {count: 0, resetAt: now + windowMs};
        if (now > rec.resetAt) {
            rec.count = 0;
            rec.resetAt = now + windowMs;
        }
        rec.count++;
        //порядок в Map - по последней неудаче: вытесняются давно не ошибавшиеся адреса
        this.loginAttempts.delete(ip);
        this.loginAttempts.set(ip, rec);
    }

    //Перебор пароля одного логина с многих адресов: лимит по IP его не видит. Логин не блокируется,
    //а замедляется: после accountFreeFailures неудач каждая следующая попытка ждёт вдвое дольше, до 5 минут
    accountKey(kind, login) {
        return `${this.normalizeLoginKind(kind)}\t${String(login || '').trim().toLowerCase()}`;
    }

    checkAccountRate(kind, login, now = Date.now()) {
        if (this.config.loginRateLimitEnabled === false)
            return;
        const rec = this.accountFailures.get(this.accountKey(kind, login));
        if (rec && rec.nextAt > now) {
            this.incrementLoginMetric(kind, 'blocked');
            throw Object.assign(new Error('Too many login attempts. Try again later.'), {
                code: 'INPX_LOGIN_RATE_LIMIT', retryAfter: Math.max(1, Math.ceil((rec.nextAt - now)/1000)),
            });
        }
    }

    recordAccountAttempt(kind, login, success, now = Date.now()) {
        if (this.config.loginRateLimitEnabled === false)
            return;
        const key = this.accountKey(kind, login);
        if (success) {
            this.accountFailures.delete(key);
            return;
        }
        const previous = this.accountFailures.get(key);
        const count = (previous && now - previous.lastAt < accountFailureWindowMs ? previous.count : 0) + 1;
        const delay = (count > accountFreeFailures ? Math.min(accountMaxDelayMs, 1000*2**(count - accountFreeFailures)) : 0);
        //порядок в Map - по последней неудаче: при переполнении уходят давно не ошибавшиеся логины
        this.accountFailures.delete(key);
        if (this.accountFailures.size >= maxLoginAttemptKeys)
            this.accountFailures.delete(this.accountFailures.keys().next().value);
        this.accountFailures.set(key, {count, lastAt: now, nextAt: now + delay});
    }

    getLoginMetrics() {
        const now = Date.now();
        let activeFailedAttempts = 0;
        let rateLimitedIps = 0;
        const maxAttempts = Math.max(1, Number(this.config.loginRateLimitMaxAttempts || defaultLoginMaxAttempts));

        for (const [ip, rec] of this.loginAttempts.entries()) {
            if (!rec || now > rec.resetAt) {
                this.loginAttempts.delete(ip);
                continue;
            }

            activeFailedAttempts += rec.count || 0;
            if ((rec.count || 0) >= maxAttempts)
                rateLimitedIps++;
        }

        const attempts = [];
        for (const kind of ['profile', 'opds', 'kobo', 'kosync', 'remote']) {
            for (const result of ['success', 'failure', 'blocked']) {
                attempts.push({
                    labels: {kind, result},
                    value: this.loginAttemptTotals.get(`${kind}\t${result}`) || 0,
                });
            }
        }

        return {
            enabled: this.config.loginRateLimitEnabled !== false,
            attempts,
            activeFailedAttempts,
            rateLimitedIps,
        };
    }
}

module.exports = Security;
module.exports.timingSafeStringEqual = timingSafeStringEqual;
