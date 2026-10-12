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

module.exports = {log, rootPath, syncTokenHeader, busyConversionCodes};
