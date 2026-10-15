const {timingSafeStringEqual: equal} = require('../Security');

function parseBasicAuth(header = '') {
    const match = String(header).match(/^Basic\s+(.+)$/i);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const splitAt = decoded.indexOf(':');
    return splitAt < 0 ? null : {user: decoded.slice(0, splitAt), password: decoded.slice(splitAt + 1)};
}

module.exports = function opdsAuth(config, verifyPassword, security) {
    return async(req, res, next) => {
        try {
            if (req.opdsAuthorized)
                return next();
            const credentials = parseBasicAuth(req.headers.authorization);
            const attempted = !!req.headers.authorization;
            const scopedUser = String((req.query && req.query.user) || '').trim();
            if (!config.opds.password && !scopedUser)
                return next();
            if (attempted)
                security.checkLoginRate(req, 'opds');
            let authorized;
            if (config.opds.password) {
                if (!config.opds.user)
                    throw new Error('User must not be empty if password set');
                authorized = !!credentials && equal(credentials.user, config.opds.user) && equal(credentials.password, config.opds.password);
            } else {
                const auth = await verifyPassword(scopedUser, credentials ? credentials.user : '', credentials ? credentials.password : '');
                // Other requests can consume the failure budget while the profile
                // store is being read. Do not reveal more guesses from that batch.
                if (attempted)
                    security.checkLoginRate(req, 'opds');
                if (!auth.user || auth.user.opdsAuthEnabled !== true)
                    return next();
                authorized = auth.authorized;
                if (authorized)
                    req.opdsProfileUser = auth.user;
            }
            if (attempted)
                security.recordLoginAttempt(req, authorized, 'opds');
            if (!authorized) {
                res.set('WWW-Authenticate', 'Basic realm="inpx-shelf OPDS", charset="UTF-8"');
                res.set('Cache-Control', 'no-store');
                return res.status(401).send('Authentication required');
            }
            req.opdsAuthorized = true;
            next();
        } catch (error) {
            if (error.code === 'INPX_LOGIN_RATE_LIMIT') {
                res.set('Retry-After', String(error.retryAfter));
                res.set('Cache-Control', 'no-store');
                return res.status(429).send('Too many login attempts. Try again later.');
            }
            next(error);
        }
    };
};

// Кто смотрит ленту: профиль, вошедший по Basic (свои учётные данные с opdsAuthEnabled), по SSO-привязке
// или в веб-интерфейсе (cookie сессии). Общий логин opds.user - не профиль.
async function resolveViewer(req, worker, security) {
    const users = [req.opdsProfileUser, req.profileAccessIdentity && req.profileAccessIdentity.user].filter(Boolean);
    const session = security && security.getSession(req);
    const sessionUserId = (session && session.profileAccessToken ? worker.getProfileSessionUser(session.profileAccessToken) : '');
    if (sessionUserId) {
        const user = (await worker.readingListStore.load()).users.find(item => item.id === sessionUserId);
        if (user)
            users.push(user);
    }
    return {ids: new Set(users.map(user => user.id)), admin: users.some(user => user.isAdmin)};
}

// Профиль с паролем (история чтения, списки) показывается в OPDS только ему самому и администратору
function canSeeProfile(req, userId, hasPassword) {
    const viewer = req.opdsViewer;
    return !hasPassword || !!(viewer && (viewer.admin || viewer.ids.has(userId)));
}

module.exports.parseBasicAuth = parseBasicAuth;
module.exports.resolveViewer = resolveViewer;
module.exports.canSeeProfile = canSeeProfile;
