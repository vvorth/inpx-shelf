const {t} = require('./i18n');
const MiB = 1024*1024;
// The reader already accepts a 4 MiB background image, encoded as base64.
const preferencesLimit = 6*MiB;
function bounded(value, fallback, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
}
function limits(config = {}) {
    return {
        message: bounded(config.wsMessageLimitMb, 1, 16)*MiB,
        import: bounded(config.importLimitMb, 16, 64)*MiB,
        // Backups come over HTTP straight to disk (see uploadLimit); only the unpacked files are held in memory.
        backup: bounded(config.backupUploadLimitMb, 256, 2048)*MiB,
        expanded: bounded(config.backupExpandedLimitMb, 512, 2048)*MiB,
    };
}
// Files are uploaded over HTTP by signed-in users, not sent as WebSocket messages that anyone can send before signing in.
function uploadLimit(action, config) {
    const value = limits(config);
    return {'import-admin-backup': value.backup, 'import-reading-lists': value.import, 'import-admin-settings': value.import}[action] || 0;
}
function transportLimit(config) {
    return Math.max(preferencesLimit, limits(config).message);
}
function checkRequest(req, bytes, config) {
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.action !== 'string')
        throw new Error(t('errors.wsInvalidRequest'));
    const value = limits(config);
    let maximum = value.message;
    if (req.action === 'update-reader-preferences' || req.action === 'update-user-profile')
        maximum = Math.max(maximum, preferencesLimit);
    if (bytes > maximum)
        throw new Error(t('errors.requestTooLarge'));
}
function checkImport(payload, config) {
    if (Buffer.byteLength(JSON.stringify(payload) || '') > limits(config).import)
        throw new Error(t('errors.importTooLarge'));
    if (payload && Array.isArray(payload.lists)) {
        if (payload.lists.length > 1000)
            throw new Error(t('errors.importTooManyLists'));
        let books = 0;
        for (const list of payload.lists) {
            books += Array.isArray(list && list.books) ? list.books.length : 0;
            if (books > 100000)
                throw new Error(t('errors.importTooManyBooks'));
        }
    }
}
module.exports = {limits, uploadLimit, transportLimit, checkRequest, checkImport};
