// Shared by the Kobo service and its mixins.

// Resolved lazily: Security requires the Kobo module before the logger may be initialized.
function log(...args) {
    return new (require('../AppLogger'))().log(...args);
}

function rootPath(config) {
    return `${String(config.rootPathStatic || '').replace(/\/$/, '')}/kobo`;
}

const syncTokenHeader = 'x-kobo-synctoken';
const busyConversionCodes = new Set(['INPX_CONVERSION_QUEUE_FULL', 'INPX_CONVERSION_QUEUE_TIMEOUT']);

// Book and collection ids are UUIDs: ours (v5), the ones the device makes (v4) and the store's.
const koboIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKoboId(value) {
    return typeof(value) === 'string' && koboIdPattern.test(value);
}

// Maps keyed by ids from the device or a file have no prototype: `__proto__` there is an ordinary key.
function idMap(source = {}) {
    return Object.assign(Object.create(null), source);
}

// Only the map's own entry: never Object.prototype or one of its methods.
function ownEntry(map, key) {
    return (map && Object.hasOwn(map, key) ? map[key] : null);
}

module.exports = {log, rootPath, syncTokenHeader, busyConversionCodes, isKoboId, idMap, ownEntry};
