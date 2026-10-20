const {t} = require('./i18n');
const MiB = 1024*1024;
function bounded(value, fallback, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
}
function limits(config = {}) {
    return {
        message: bounded(config.apiMessageLimitMb, 1, 16)*MiB,
        import: bounded(config.importLimitMb, 16, 64)*MiB,
        // Backups come over HTTP straight to disk (see uploadLimit); only the unpacked files are held in memory.
        backup: bounded(config.backupUploadLimitMb, 256, 2048)*MiB,
        expanded: bounded(config.backupExpandedLimitMb, 512, 2048)*MiB,
    };
}
// Files go as upload request bodies, checked for access before they are read: the JSON body limit (message), which anyone
// can reach before signing in, does not grow with them.
function uploadLimit(action, config) {
    const value = limits(config);
    return {'import-admin-backup': value.backup, 'import-reading-lists': value.import, 'import-admin-settings': value.import}[action] || 0;
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
module.exports = {limits, uploadLimit, checkImport};
