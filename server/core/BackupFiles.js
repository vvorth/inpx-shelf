const path = require('path');
const {t} = require('./i18n');

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Data files that travel in backups and imports. Full restore, the author names import and the profile import
// check what they read here, so a file's rules are written once.
const files = {
    'config.json': {path: config => config.configFile},
    'secret.key': {path: config => path.join(config.dataDir, 'secret.key'), binary: true},
    'reading-lists.json': {
        check: data => Array.isArray(data.users) && Array.isArray(data.lists),
        error: 'errors.backupReadingListsInvalid',
    },
    'kobo-sync.json': {
        check: data => Array.isArray(data.devices) && (data.states === undefined || isObject(data.states)),
        error: 'errors.backupKoboInvalid',
    },
    'author-names.json': {check: data => Array.isArray(data.entries)},
    'work-titles.json': {check: data => Array.isArray(data.entries)},
};

function filePath(config, name) {
    const file = files[name];
    return (file.path ? file.path(config) : path.join(config.dataDir, name));
}

// name -> path of every file a restore may write
function targets(config) {
    return Object.fromEntries(Object.keys(files).map(name => [name, filePath(config, name)]));
}

// A file's content (Buffer, string or already parsed JSON) checked against its rules; JSON comes back parsed.
function parse(name, data) {
    const file = files[name];
    if (!file)
        throw new Error(t('errors.backupUnknownFile'));
    if (file.binary)
        return data;
    let parsed = data;
    if (Buffer.isBuffer(data) || typeof data === 'string') {
        try {
            parsed = JSON.parse(data.toString('utf8'));
        } catch (e) {
            parsed = null;
        }
    }
    if (!isObject(parsed) || (file.check && !file.check(parsed)))
        throw new Error(t(file.error || 'errors.backupFileInvalid', {name}));
    return parsed;
}

module.exports = {names: Object.keys(files), filePath, targets, parse};
