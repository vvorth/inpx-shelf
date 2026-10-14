const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const utils = require('./utils');

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
        });
}

function sourcesFromEnv() {
    return parseSourcesFromString(process.env.INPX_LIBRARY_SOURCES || process.env.LIBRARY_SOURCES || '');
}

async function findSingleInpx(libDir) {
    const inpxFiles = [];
    await utils.findFiles((file) => {
        if (path.extname(file).toLowerCase() === '.inpx')
            inpxFiles.push(file);
    }, libDir, false);

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

async function normalizeSource(source, index, options = {}) {
    const requireExists = options.requireExists !== false;
    const rawInpx = String(source.inpx || source.inpxFile || '').trim();
    const rawLibDir = String(source.libDir || source.libraryDir || '').trim();
    const inpx = rawInpx ? path.resolve(rawInpx) : '';
    const libDir = rawLibDir ? path.resolve(rawLibDir) : (inpx ? path.dirname(inpx) : '');

    if (!libDir)
        throw new Error(`Library source #${index + 1}: libDir is empty`);

    if (requireExists && !await fs.pathExists(libDir))
        throw new Error(`Library source #${index + 1}: directory "${libDir}" not exists`);

    const resolvedInpx = inpx || await findSingleInpx(libDir);
    if (requireExists && !await fs.pathExists(resolvedInpx))
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

async function resolveLibrarySources(config, argv = {}) {
    if (config.remoteLib) {
        config.librarySources = [{
            id: 'remote',
            name: 'Remote library',
            inpx: config.inpxFile,
            inpxFile: config.inpxFile,
            libDir: config.libDir || config.dataDir,
            enabled: true,
            remote: true,
        }];
        return config.librarySources;
    }

    let sources = getConfiguredSources(config);
    if (!sources.length) {
        let libDir = argv['lib-dir'] || config.libDir || config.execDir;
        if (!await fs.pathExists(libDir))
            throw new Error(`Directory "${libDir}" not exists`);

        libDir = path.resolve(libDir);
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
                normalized = await normalizeSource(source, i, {requireExists: false});
            } catch (e) {
                const inpx = String(source.inpx || source.inpxFile || '').trim();
                normalized = {
                    id: stableId(source.id || source.name || `source-${i + 1}`, `source-${i + 1}`),
                    name: String(source.name || '').trim() || `source-${i + 1}`,
                    inpx,
                    inpxFile: inpx,
                    libDir: String(source.libDir || source.libraryDir || '').trim(),
                };
            }
            result.push(Object.assign(normalized, {enabled: false}));
            continue;
        }

        result.push(await normalizeSource(source, i));
    }

    const enabled = result.filter(source => source.enabled !== false);
    if (!enabled.length)
        throw new Error('No enabled INPX library sources configured');

    config.librarySources = result;
    config.libDir = enabled[0].libDir;
    config.inpx = enabled[0].inpx;
    config.inpxFile = enabled[0].inpxFile;

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
            remote: !!source.remote,
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

function getEnabledLibrarySources(config = {}) {
    return getAllLibrarySources(config).filter(source => source.enabled !== false);
}

//Библиотеки для индекса: включённые и выключенные, чей INPX на месте (выключенная на отключённом диске пропускается)
async function getIndexedLibrarySources(config = {}) {
    const result = [];
    for (const source of getAllLibrarySources(config)) {
        const inpx = source.inpxFile || source.inpx;
        if (source.enabled !== false || (inpx && await fs.pathExists(inpx)))
            result.push(source);
    }
    return result;
}

module.exports = {
    parseSourcesFromString,
    resolveLibrarySources,
    getEnabledLibrarySources,
    getAllLibrarySources,
    getIndexedLibrarySources,
};
