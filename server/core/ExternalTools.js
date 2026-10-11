const fs = require('fs-extra');
const path = require('path');
const {t} = require('./i18n');

const SEVEN_ZIP_DOWNLOAD_URL = 'https://www.7-zip.org/download.html';
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

function sevenZipCommandCandidates(converterPaths = null) {
    const configured = configuredToolCandidates(resolveConverterPaths(converterPaths), ['sevenZip', 'sevenzip', '7z', '7za']);
    const local = [
        resolveBundledPath('7z.exe'),
        resolveBundledPath('7za.exe'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        '7z',
        '7za',
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    ] : [
        '7z',
        '7za',
    ]);

    return [...configured, ...local, ...system];
}

function toolCandidatesFromDirs(extraDirs = [], fileNames = []) {
    const result = [];
    for (const dir of (Array.isArray(extraDirs) ? extraDirs : [])) {
        const baseDir = String(dir || '').trim();
        if (!baseDir)
            continue;

        for (const fileName of fileNames)
            result.push(path.join(baseDir, fileName));
    }

    return result;
}

function djxlCommandCandidates(extraDirs = [], converterPaths = null) {
    const configured = configuredToolCandidates(resolveConverterPaths(converterPaths), ['djxl', 'jxl']);
    const extra = toolCandidatesFromDirs(extraDirs, process.platform === 'win32' ? ['djxl.exe', 'djxl'] : ['djxl']);
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

    return [...configured, ...extra, ...local, ...system];
}

function dwebpCommandCandidates(extraDirs = [], converterPaths = null) {
    const configured = configuredToolCandidates(resolveConverterPaths(converterPaths), ['dwebp', 'webp']);
    const extra = toolCandidatesFromDirs(extraDirs, process.platform === 'win32' ? ['dwebp.exe', 'dwebp'] : ['dwebp']);
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

    return [...configured, ...extra, ...local, ...system];
}

function missingSevenZipMessage() {
    if (process.platform === 'win32') {
        return t('errors.missingSevenZipWindows', {url: SEVEN_ZIP_DOWNLOAD_URL});
    }

    return t('errors.missingSevenZip', {url: SEVEN_ZIP_DOWNLOAD_URL});
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

async function pathExistsSafe(filePath) {
    try {
        return Boolean(filePath) && await fs.pathExists(filePath);
    } catch (err) {
        return false;
    }
}

module.exports = {
    SEVEN_ZIP_DOWNLOAD_URL,
    DJXL_DOWNLOAD_URL,
    DWEBP_DOWNLOAD_URL,
    bundledBinDir,
    configuredToolCandidates,
    currentConverterPaths,
    resolveConverterPaths,
    sevenZipCommandCandidates,
    djxlCommandCandidates,
    dwebpCommandCandidates,
    missingSevenZipMessage,
    missingDjxlMessage,
    missingDwebpMessage,
    createMissingToolError,
    isMissingToolError,
    pathExistsSafe,
};
