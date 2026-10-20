function parseBasicAuth(header = '') {
    const match = String(header).match(/^Basic\s+(.+)$/i);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const splitAt = decoded.indexOf(':');
    return splitAt < 0 ? null : {user: decoded.slice(0, splitAt), password: decoded.slice(splitAt + 1)};
}

// Кто смотрит ленту: профиль, вошедший по Basic (свой пароль OPDS), по SSO-привязке
// или в веб-интерфейсе (cookie сессии) - его находит ProfileAccess.httpGuard. Общий логин opds.user - не профиль.
function resolveViewer(req) {
    const user = req.profileAccessIdentity && req.profileAccessIdentity.user;
    return {ids: new Set(user ? [user.id] : []), admin: !!(user && user.isAdmin)};
}

// Профиль с паролем (история чтения, списки) показывается в OPDS только ему самому и администратору
function canSeeProfile(req, userId, hasPassword) {
    const viewer = req.opdsViewer;
    return !hasPassword || !!(viewer && (viewer.admin || viewer.ids.has(userId)));
}

module.exports = {parseBasicAuth, resolveViewer, canSeeProfile};
