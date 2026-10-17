function parseBasicAuth(header = '') {
    const match = String(header).match(/^Basic\s+(.+)$/i);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const splitAt = decoded.indexOf(':');
    return splitAt < 0 ? null : {user: decoded.slice(0, splitAt), password: decoded.slice(splitAt + 1)};
}

// Кто смотрит ленту: профиль, вошедший по Basic (свой пароль OPDS), по SSO-привязке
// или в веб-интерфейсе (cookie сессии). Общий логин opds.user - не профиль.
async function resolveViewer(req, worker, security) {
    const users = [req.profileAccessIdentity && req.profileAccessIdentity.user].filter(Boolean);
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

module.exports = {parseBasicAuth, resolveViewer, canSeeProfile};
