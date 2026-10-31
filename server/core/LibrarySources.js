const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const libraryFs = require('./LibraryFs');

function stableId(value, fallback = 'source') {
    const base = String(value || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 40);

    if (base)
        return base;

    return `${fallback}-${crypto.createHash('sha1').update(String(value || '')).digest('hex').substring(0, 8)}`;
}

function parseSourcesFromString(value = '') {
    const raw = String(value || '').trim();
    if (!raw)
        return [];

    if (raw[0] === '[' || raw[0] === '{') {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
    }

    return raw
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)
        .map((item, index) => {
            const parts = item.split('|').map(part => part.trim());
            if (parts.length >= 4) {
                return {
                    id: parts[0],
                    name: parts[1],
                    inpx: parts[2],
                    libDir: parts[3],
                };
            }

            if (parts.length >= 3) {
                return {
                    name: parts[0],
                    inpx: parts[1],
                    libDir: parts[2],
                };
            }

            return {
                id: `source-${index + 1}`,
                inpx: parts[0],
                libDir: parts[1] || '',
            };
        })
        //слово scan вместо INPX - папка с книгами без INPX
        .map(({inpx, ...item}) => (inpx.toLowerCase() === 'scan' ? Object.assign(item, {scan: true}) : Object.assign(item, {inpx})));
}

function sourcesFromEnv() {
    return parseSourcesFromString(process.env.INPX_LIBRARY_SOURCES || process.env.LIBRARY_SOURCES || '');
}

//s3://... - не путь на диске: path.resolve превратил бы его в <cwd>/s3:/...
function resolvePath(p) {
    return (libraryFs.isS3(p) ? p.replace(/\/+$/, '') : path.resolve(p));
}

async function findSingleInpx(libDir) {
    const inpxFiles = (await libraryFs.readdir(libDir, {withFileTypes: true}))
        .filter(entry => !entry.isDirectory() && path.extname(entry.name).toLowerCase() === '.inpx')
        .map(entry => libraryFs.join(libDir, entry.name));

    if (inpxFiles.length === 1)
        return inpxFiles[0];

    if (inpxFiles.length > 1)
        throw new Error(`Found more than one .inpx files: \n${inpxFiles.join('\n')}`);

    throw new Error(`No .inpx files found here: ${libDir}`);
}

function getConfiguredSources(config = {}) {
    const envSources = sourcesFromEnv();
    if (envSources.length)
        return envSources;

    if (Array.isArray(config.librarySources) && config.librarySources.length)
        return config.librarySources;

    return [];
}

// A remote library has no folder of its own: an empty one keeps local file lookups
// (reviews, author info, covers archives) from falling back to another library.
function normalizeRemoteSource(source, index, dataDir) {
    const remote = source.remote;
    const id = stableId(source.id || source.name || remote.source, `source-${index + 1}`);
    const inpx = path.join(dataDir, 'remote', `${id}.inpx`);
    return {
        id,
        name: String(source.name || '').trim() || String(remote.source || '') || id,
        inpx,
        inpxFile: inpx,
        libDir: path.join(dataDir, 'remote', id),
        enabled: source.enabled !== false,
        remote: {url: String(remote.url || '').trim(), source: String(remote.source || '').trim(), token: String(remote.token || '')},
    };
}

// Папка с книгами без INPX: INPX строит сервер (scan/FolderScan.js) в <dataDir>/scan/<id>.inpx.
function normalizeScanSource(source, index, dataDir) {
    const rawLibDir = String(source.libDir || source.libraryDir || '').trim();
    const libDir = rawLibDir ? resolvePath(rawLibDir) : '';
    const id = stableId(source.id || source.name || path.basename(libDir), `source-${index + 1}`);
    const inpx = path.join(dataDir, 'scan', `${id}.inpx`);
    return {
        id,
        name: String(source.name || '').trim() || path.basename(libDir) || id,
        inpx,
        inpxFile: inpx,
        libDir,
        enabled: source.enabled !== false,
        scan: true,
    };
}

async function normalizeSource(source, index, options = {}) {
    if (source.remote && typeof(source.remote) === 'object')
        return normalizeRemoteSource(source, index, options.dataDir);
    const requireExists = options.requireExists !== false;
    if (source.scan) {
        const normalized = normalizeScanSource(source, index, options.dataDir);
        if (!normalized.libDir)
            throw new Error(`Library source #${index + 1}: libDir is empty`);
        if (requireExists && !await libraryFs.pathExists(normalized.libDir))
            throw new Error(`Library source #${index + 1}: directory "${normalized.libDir}" not exists`);
        return normalized;
    }
    const rawInpx = String(source.inpx || source.inpxFile || '').trim();
    const rawLibDir = String(source.libDir || source.libraryDir || '').trim();
    const inpx = rawInpx ? resolvePath(rawInpx) : '';
    const libDir = rawLibDir ? resolvePath(rawLibDir) : (inpx ? path.dirname(inpx) : '');

    if (!libDir)
        throw new Error(`Library source #${index + 1}: libDir is empty`);

    if (requireExists && !await libraryFs.pathExists(libDir))
        throw new Error(`Library source #${index + 1}: directory "${libDir}" not exists`);

    const resolvedInpx = inpx || await findSingleInpx(libDir);
    if (requireExists && !await libraryFs.pathExists(resolvedInpx))
        throw new Error(`Library source #${index + 1}: file "${resolvedInpx}" not found`);

    const id = stableId(source.id || source.name || path.basename(resolvedInpx, path.extname(resolvedInpx)), `source-${index + 1}`);
    const name = String(source.name || '').trim() || path.basename(resolvedInpx, path.extname(resolvedInpx)) || id;

    return {
        id,
        name,
        inpx: resolvedInpx,
        inpxFile: resolvedInpx,
        libDir,
        enabled: source.enabled !== false,
    };
}

//источники библиотек поверх config.json: LIBDIR, INPX и параметры командной строки (при запуске и после восстановления из бэкапа)
async function resolveLibrarySources(config, argv = {}) {
    if (!argv['lib-dir'] && process.env.LIBDIR)
        config.libDir = process.env.LIBDIR;
    if (!argv.inpx && process.env.INPX)
        config.inpx = process.env.INPX;
    if (argv['library-sources'])
        config.librarySources = parseSourcesFromString(argv['library-sources']);

    let sources = getConfiguredSources(config);
    if (!sources.length) {
        let libDir = argv['lib-dir'] || config.libDir || config.execDir;
        if (!await libraryFs.pathExists(libDir))
            throw new Error(`Directory "${libDir}" not exists`);

        libDir = resolvePath(libDir);
        const inpx = argv.inpx || config.inpx || await findSingleInpx(libDir);
        sources = [{
            id: 'main',
            name: 'Main library',
            inpx,
            libDir,
            enabled: true,
        }];
    }

    //выключенные источники остаются в config.librarySources: иначе следующее сохранение настроек сотрёт их из config.json
    const result = [];
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source)
            continue;

        if (source.enabled === false) {
            let normalized;
            try {
                normalized = await normalizeSource(source, i, {requireExists: false, dataDir: config.dataDir});
            } catch (e) {
                const inpx = String(source.inpx || source.inpxFile || '').trim();
                normalized = {
                    id: stableId(source.id || source.name || `source-${i + 1}`, `source-${i + 1}`),
                    name: String(source.name || '').trim() || `source-${i + 1}`,
                    inpx,
                    inpxFile: inpx,
                    libDir: String(source.libDir || source.libraryDir || '').trim(),
                };
                if (source.scan)
                    normalized.scan = true;
            }
            result.push(Object.assign(normalized, {enabled: false}));
            continue;
        }

        result.push(await normalizeSource(source, i, {dataDir: config.dataDir}));
    }

    const enabled = result.filter(source => source.enabled !== false);
    if (!enabled.length)
        throw new Error('No enabled INPX library sources configured');

    config.librarySources = result;
    for (const source of result.filter(item => item.remote))
        await fs.ensureDir(source.libDir);
    for (const source of result.filter(item => item.scan && item.inpxFile))
        await fs.ensureDir(path.dirname(source.inpxFile));
    //папка по умолчанию - локальной библиотеки
    const first = enabled.find(source => !source.remote) || enabled[0];
    config.libDir = first.libDir;
    config.inpx = first.inpx;
    config.inpxFile = first.inpxFile;

    return enabled;
}

//Все настроенные библиотеки, и выключенные: индекс строится по всем, выключенные только скрываются
function getAllLibrarySources(config = {}) {
    const sources = Array.isArray(config.librarySources) ? config.librarySources.filter(Boolean) : [];
    if (sources.length)
        return sources.map((source, index) => ({
            id: stableId(source.id || source.name || source.inpx || `source-${index + 1}`, `source-${index + 1}`),
            name: String(source.name || source.id || `Source ${index + 1}`).trim(),
            inpx: source.inpx || source.inpxFile,
            inpxFile: source.inpxFile || source.inpx,
            libDir: source.libDir || config.libDir,
            enabled: source.enabled !== false,
            remote: source.remote || null,
            ...(source.scan ? {scan: true} : {}),
        }));

    return [{
        id: 'main',
        name: 'Main library',
        inpx: config.inpxFile || config.inpx,
        inpxFile: config.inpxFile || config.inpx,
        libDir: config.libDir,
        enabled: true,
    }];
}

//Папка библиотеки по ключу из текущих настроек: записи книг уходят клиенту, путей сервера в них нет
function getSourceLibDir(config = {}, sourceId = '') {
    const source = getAllLibrarySources(config).find(item => item.id === sourceId);
    return (source && source.libDir) || config.libDir || '';
}

function getEnabledLibrarySources(config = {}) {
    return getAllLibrarySources(config).filter(source => source.enabled !== false);
}

//Библиотеки для индекса: включённые и выключенные, чей INPX на месте (выключенная на отключённом диске пропускается)
async function getIndexedLibrarySources(config = {}) {
    const result = [];
    for (const source of getAllLibrarySources(config)) {
        const inpx = source.inpxFile || source.inpx;
        //удалённая библиотека, чей INPX ещё не скачан, и папка, чей INPX ещё не построен, в индекс пока не входят
        if ((source.enabled !== false && !source.remote && !source.scan) || (inpx && await libraryFs.pathExists(inpx)))
            result.push(source);
    }
    return result;
}

module.exports = {
    normalizeRemoteSource,
    normalizeScanSource,
    parseSourcesFromString,
    resolveLibrarySources,
    getEnabledLibrarySources,
    getAllLibrarySources,
    getSourceLibDir,
    getIndexedLibrarySources,
};
