const path = require('path');
const {t} = require('./i18n');

const DJXL_DOWNLOAD_URL = 'https://github.com/libjxl/libjxl/releases/latest';
const DWEBP_DOWNLOAD_URL = 'https://developers.google.com/speed/webp/docs/precompiled';

function bundledBinDir() {
    if (!process.pkg)
        return '';

    return path.join(path.dirname(process.execPath), 'bin');
}

function resolveBundledPath(fileName) {
    const binDir = bundledBinDir();
    if (!binDir)
        return '';

    return path.join(binDir, fileName);
}

function normalizeConfiguredToolPaths(value) {
    if (!value)
        return [];

    const values = Array.isArray(value) ? value : [value];
    return values
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function configuredToolCandidates(converterPaths = {}, keys = []) {
    if (!converterPaths || typeof converterPaths !== 'object')
        return [];

    const result = [];
    for (const key of keys)
        result.push(...normalizeConfiguredToolPaths(converterPaths[key]));

    return Array.from(new Set(result));
}

function currentConverterPaths() {
    try {
        const ConfigManager = require('../config');
        const configManager = new ConfigManager();
        return (configManager.config && configManager.config.converterPaths) || {};
    } catch (err) {
        return {};
    }
}

function resolveConverterPaths(converterPaths = null) {
    return converterPaths || currentConverterPaths();
}

function djxlCommandCandidates(converterPaths = null) {
    const configured = configuredToolCandidates(resolveConverterPaths(converterPaths), ['djxl', 'jxl']);
    const local = [
        process.platform === 'win32' ? resolveBundledPath('djxl.exe') : '',
        resolveBundledPath('djxl'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        'djxl',
        'djxl.exe',
    ] : [
        'djxl',
    ]);

    return [...configured, ...local, ...system];
}

function dwebpCommandCandidates(converterPaths = null) {
    const configured = configuredToolCandidates(resolveConverterPaths(converterPaths), ['dwebp', 'webp']);
    const local = [
        process.platform === 'win32' ? resolveBundledPath('dwebp.exe') : '',
        resolveBundledPath('dwebp'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        'dwebp',
        'dwebp.exe',
    ] : [
        'dwebp',
    ]);

    return [...configured, ...local, ...system];
}

function missingDjxlMessage() {
    if (process.platform === 'win32') {
        return t('errors.missingDjxlWindows', {url: DJXL_DOWNLOAD_URL});
    }

    return t('errors.missingDjxl', {url: DJXL_DOWNLOAD_URL});
}

function missingDwebpMessage() {
    if (process.platform === 'win32') {
        return t('errors.missingDwebpWindows', {url: DWEBP_DOWNLOAD_URL});
    }

    return t('errors.missingDwebp', {url: DWEBP_DOWNLOAD_URL});
}

function createMissingToolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isMissingToolError(error, code = '') {
    if (!error)
        return false;

    return code ? error.code === code : /^INPX_MISSING_/.test(String(error.code || ''));
}

module.exports = {
    bundledBinDir,
    configuredToolCandidates,
    resolveConverterPaths,
    djxlCommandCandidates,
    dwebpCommandCandidates,
    missingDjxlMessage,
    missingDwebpMessage,
    createMissingToolError,
    isMissingToolError,
};
