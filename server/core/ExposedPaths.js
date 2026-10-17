// Every HTTP path the server answers, with who may reach it. Logged on start.
// Keep in sync with the routes in index.js, static.js, HealthRoutes.js, opds/, kobo/, Kosync.js, RemoteAccess.js.
function exposedPaths(config) {
    const root = String(config.rootPathStatic || '').replace(/\/$/, '');
    const profile = 'profile login';
    const paths = [
        [`${root}/`, 'anonymous', 'web app shell and login page, no library data'],
        [`${root}/ (WebSocket)`, profile, 'anonymous: only the login bootstrap (get-config without data, login, logout)'],
        [`${root}/app-reset`, 'anonymous', 'static page that clears the browser cache'],
        [`${root}/session/rotate`, 'anonymous', 'needs a one-time token issued at login'],
        [`${root}/upload`, profile, ''],
        [`${config.bookPathStatic || `${root}/book`}/`, profile, 'or OPDS Basic credentials'],
        [`${root}/cover/`, profile, 'or OPDS Basic credentials'],
        [`${root}/admin-backups/`, profile, 'admin only'],
    ];
    if (config.opds && config.opds.enabled)
        paths.push([config.opds.root || '/opds', profile, 'or OPDS Basic credentials']);
    if (config.koboEnabled)
        paths.push([`${require('./kobo').rootPath(config)}/<device token>`, 'device token', 'own auth']);
    if (config.kosyncEnabled)
        paths.push([require('./Kosync').rootPath(config), 'KOReader key', 'own auth']);
    const remoteTokens = (Array.isArray(config.remoteAccess) ? config.remoteAccess.length : 0);
    paths.push([`${require('./RemoteAccess').rootPath(config)}/`, 'remote library token', `own auth (Bearer), ${remoteTokens ? `${remoteTokens} token(s)` : 'closed: no tokens'}`]);
    paths.push(
        ['/health', 'anonymous', 'status, version, uptime (Docker healthcheck)'],
        ['/ready', 'anonymous', 'index build state'],
        ['/api/index-status', 'anonymous', 'index build state; details for admin or metrics token'],
    );
    if (config.metricsEnabled)
        paths.push([config.metricsPath || '/metrics', 'metrics token', config.metricsToken ? '' : 'closed: metricsToken is not set']);
    return paths.map(([path, access, note]) => ({path, access, note}));
}

function exposedPathsText(config) {
    const paths = exposedPaths(config);
    const width = Math.max(...paths.map(item => item.path.length));
    const lines = paths.map(item => `  ${item.path.padEnd(width)}  ${item.access}${item.note ? ` - ${item.note}` : ''}`);
    //то же условие, что в Security.verifyRequiredAuth
    if (String(config.authMode || '').trim().toLowerCase() === 'proxy' && (config.requireAuth || config.proxyBindProfile))
        lines.push(`  proxy auth (${config.proxyAuthHeader || 'Remote-User'}) also guards every path except Kobo, KOReader sync, remote library API, metrics with token`
            + (config.authExemptHealth !== false ? ' and health checks' : ''));
    return `Exposed HTTP paths:\n${lines.join('\n')}`;
}

module.exports = {exposedPaths, exposedPathsText};
