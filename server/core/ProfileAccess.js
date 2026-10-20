const {parseBasicAuth} = require('./opds/Auth');
const {timingSafeStringEqual: equal} = require('./Security');
const {t} = require('./i18n');

const bootstrapActions = new Set(['test', 'get-config', 'get-worker-state', 'login-user-profile', 'logout-user-profile']);
// With guest access on, a visitor without a profile runs only these: the catalog, book pages, downloads and the shared
// discovery shelves. They run without a profile (userId ''), so a passwordless profile cannot be borrowed.
const guestActions = new Set([
    'test', 'get-config', 'get-worker-state', 'get-author-book-list', 'get-author-info', 'get-series-book-list', 'get-genre-tree',
    'get-discovery-shelves', 'get-book-link', 'get-author-aliases', 'catalog-names', 'catalog-search', 'catalog-suggest',
    'get-book', 'get-book-info',
    //пустой ответ: страницы каталога просят их в фоне, окно входа здесь не нужно
    'get-book-states', 'get-reading-lists', 'record-discovery-events',
]);
// OPDS pages that belong to a profile: a guest gets the Basic challenge, so the client can sign in.
const opdsProfilePaths = ['/reading-lists', '/reading-profiles', '/reading-progress'];

function denied(message = 'need_profile_login', status = 401) {
    const error = new Error(message);
    error.status = status;
    return error;
}

class ProfileAccess {
    constructor(config, worker, security) {
        this.config = config;
        this.worker = worker;
        this.security = security;
    }

    get guestWeb() {
        return this.config.guestAccess === true;
    }

    get guestOpds() {
        return !!(this.config.opds && this.config.opds.guestAccess === true);
    }

    get bindingEnabled() {
        return this.config.proxyBindProfile === true && String(this.config.authMode || '').trim().toLowerCase() === 'proxy';
    }

    clearBinding(session) {
        if (!session || !session.proxyProfileUserId)
            return;
        this.worker.closeProfileSession(session.profileAccessToken);
        delete session.profileAccessToken;
        delete session.proxyProfileUserId;
        delete session.proxyProfileLogin;
    }

    async resolve(req, token = '') {
        let session = this.security && this.security.getSession(req);
        if (this.bindingEnabled) {
            const auth = this.security.verifyRequiredAuth(req);
            if (!auth.ok)
                throw denied(auth.message, auth.status);
            const login = this.worker.readingListStore.normalizeLogin(this.security.getProxyAuthUser(req));
            const data = await this.worker.readingListStore.load();
            const user = data.users.find(item => item.login && item.login === login);
            if (user) {
                session = this.security.ensureSession(req);
                if (session.proxyProfileUserId !== user.id || session.proxyProfileLogin !== login)
                    this.clearBinding(session);
                if (this.worker.getProfileSessionUser(session.profileAccessToken) !== user.id) {
                    session.profileAccessToken = this.worker.createProfileSession(user.id);
                    session.proxyProfileUserId = user.id;
                    session.proxyProfileLogin = login;
                }
                return {user, token: session.profileAccessToken, bound: true};
            }
        }
        // A removed/renamed SSO profile must not leave an old authenticated token.
        this.clearBinding(session);
        //токен из запроса после перезапуска сервера устарел: тогда профиль - по сессии из cookie
        const sessionToken = (session && session.profileAccessToken) || '';
        const accessToken = (token && this.worker.getProfileSessionUser(token) ? token : sessionToken);
        const id = this.worker.getProfileSessionUser(accessToken);
        if (!id)
            return null;
        const data = await this.worker.readingListStore.load();
        const user = data.users.find(item => item.id === id);
        return user ? {user, token: accessToken, bound: false} : null;
    }

    assertProfile(identity, requested = '') {
        if (!requested || requested === identity.user.id || requested === identity.user.login)
            return;
        throw denied(identity.bound ? t('errors.profileBoundToProxy') : 'need_profile_login', identity.bound ? 403 : 401);
    }

    async prepareRequest(req, httpRequest) {
        delete req.profileBoundId;
        delete req.profileLoginRequired;
        // Anonymous access is not configurable: every action except the login bootstrap needs a profile.
        const identity = await this.resolve(httpRequest, req.profileAccessToken);
        if (identity) {
            if (!['get-config', 'get-user-profiles', 'logout-user-profile'].includes(req.action))
                this.assertProfile(identity, String(req.userId || '').trim());
            if (identity.bound && req.action === 'login-user-profile')
                throw denied(t('errors.profileBoundToProxy'), 403);
            if (identity.bound && req.action === 'update-user-profile' && req.targetUserId === identity.user.id
                && req.profile && Object.hasOwn(req.profile, 'login')
                && this.worker.readingListStore.normalizeLogin(req.profile.login) !== identity.user.login)
                throw denied(t('errors.profileLoginBoundToProxy'), 403);
            req.userId = identity.user.id;
            req.profileAccessToken = identity.token;
            req.profileBoundId = identity.bound ? identity.user.id : '';
        }
        const guest = !identity && this.guestWeb && guestActions.has(req.action);
        if (!identity && !guest && !bootstrapActions.has(req.action))
            throw denied();
        if (guest) {
            req.guest = true;
            req.userId = '';
            req.profileAccessToken = '';
        }
        req.profileLoginRequired = !identity && !guest;
    }

    filterProfiles(users, req) {
        if (req.profileBoundId) {
            const current = users.find(user => user.id === req.profileBoundId);
            return (current && current.isAdmin ? users : users.filter(user => user.id === req.profileBoundId))
                .map(user => user.id === req.profileBoundId ? {...user, requiresLogin: false} : user);
        }
        return users;
    }

    async basicIdentity(req) {
        const credentials = parseBasicAuth(req.headers.authorization);
        if (!credentials || !this.config.opds || !this.config.opds.enabled)
            return null;
        this.security.checkLoginRate(req, 'opds');
        this.security.checkAccountRate('opds', credentials.user);
        let identity = null;
        if (this.config.opds.password) {
            if (this.config.opds.user && equal(credentials.user, this.config.opds.user) && equal(credentials.password, this.config.opds.password))
                identity = {opds: true};
        } else {
            const data = await this.worker.readingListStore.load();
            const login = this.worker.readingListStore.normalizeLogin(credentials.user);
            const user = data.users.find(item => item.login === login && item.opdsEnabled !== false && item.opdsPasswordHash);
            if (await this.worker.readingListStore.verifyUserPassword(user ? user.id : '', credentials.password, 'opdsPasswordHash') && user)
                identity = {user, opds: true, bound: true};
            //пока шла проверка, параллельные запросы могли исчерпать лимит: ответа на эту попытку они не получают
            this.security.checkLoginRate(req, 'opds');
        }
        this.security.recordLoginAttempt(req, !!identity, 'opds');
        this.security.recordAccountAttempt('opds', credentials.user, !!identity);
        return identity;
    }

    // A guest has no credentials at all: wrong Basic credentials stay a 401, and a guest never names a profile (?user=).
    guestAllowed(req, opds) {
        if (req.headers.authorization || String((req.query && req.query.user) || '').trim())
            return false;
        if (opds) {
            const root = String(this.config.opdsRoot || (this.config.opds && this.config.opds.root) || '/opds').replace(/\/+$/, '');
            const path = String(req.originalUrl || '').split('?')[0];
            return this.guestOpds && !opdsProfilePaths.some(item => path === root + item || path.startsWith(`${root}${item}/`));
        }
        return this.guestWeb || this.guestOpds;
    }

    // opds: the OPDS feed; guest: books and covers, open to guests when web or OPDS guest access is on.
    httpGuard({opds = false, guest = false} = {}) {
        return async(req, res, next) => {
            try {
                const identity = (await this.resolve(req)) || (await this.basicIdentity(req));
                if (!identity && guest && this.guestAllowed(req, opds)) {
                    req.guestAccess = true;
                    return next();
                }
                if (!identity) {
                    res.set('WWW-Authenticate', 'Basic realm="inpx-shelf OPDS", charset="UTF-8"');
                    throw denied('Authentication required');
                }
                if (identity.user) {
                    this.assertProfile(identity, String((req.query && req.query.user) || '').trim());
                    req.profileAccessIdentity = identity;
                    if (opds) {
                        req.query.user = identity.user.id;
                        req.opdsAuthorized = true;
                    }
                } else if (identity.opds) {
                    req.opdsAuthorized = true;
                }
                next();
            } catch (error) {
                res.set('Cache-Control', 'no-store');
                if (error.code === 'INPX_LOGIN_RATE_LIMIT') {
                    res.set('Retry-After', String(error.retryAfter));
                    return res.status(429).send('Too many login attempts. Try again later.');
                }
                if (error.status)
                    return res.status(error.status).send(error.message);
                next(error);
            }
        };
    }
}

module.exports = ProfileAccess;
