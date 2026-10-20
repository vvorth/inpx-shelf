const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const {pipeline} = require('stream/promises');
const {t} = require('./i18n');
const pendingCacheFiles = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function processLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function versionText(config) {
    return `${config.name} v${config.version}, Node.js ${process.version}, ${process.platform}`;
}

async function findFiles(callback, dir, recursive = true) {
    if (!(callback && dir))
        return;

    const files = await fs.readdir(dir, { withFileTypes: true });

    for (const file of files) {
        const found = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            if (recursive)
                await findFiles(callback, found);
        } else {
            await callback(found);
        }
    }
}

async function touchFile(filename) {
    await fs.utimes(filename, Date.now()/1000, Date.now()/1000);
}

function hasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

function freeMemory() {
    if (global.gc) {
        global.gc();
    }
}

function getFileHash(filename, hashName, enc) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(hashName);
        const rs = fs.createReadStream(filename);
        rs.on('error', reject);
        rs.on('data', chunk => hash.update(chunk));
        rs.on('end', () => resolve(hash.digest(enc)));
    });
}

function getBufHash(buf, hashName, enc) {
    const hash = crypto.createHash(hashName);
    hash.update(buf);
    return hash.digest(enc);
}

function randomHexString(len) {
    return crypto.randomBytes(len).toString('hex')
}

//async
function gzipFile(inputFile, outputFile, level = 1) {
    return new Promise((resolve, reject) => {
        const gzip = zlib.createGzip({level});
        const input = fs.createReadStream(inputFile);
        const output = fs.createWriteStream(outputFile);

        input.on('error', reject)
            .pipe(gzip).on('error', reject)
            .pipe(output).on('error', reject)
            .on('finish', (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function gunzipFile(inputFile, outputFile) {
    return pipeline(fs.createReadStream(inputFile), zlib.createGunzip(), fs.createWriteStream(outputFile));
}

function prepareCachedFile(outputFile, writer, expectedSize = 0) {
    const key = path.resolve(outputFile);
    if (!pendingCacheFiles.has(key)) {
        const prepare = async() => {
            const valid = async file => {
                try {
                    const stat = await fs.stat(file);
                    return stat.isFile() && stat.size > 0 && (!(expectedSize > 0) || stat.size === expectedSize);
                } catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    return false;
                }
            };
            if (await valid(outputFile))
                return false;
            const temporaryFile = `${outputFile}.cache-tmp-${randomHexString(12)}`;
            try {
                await writer(temporaryFile);
                if (!await valid(temporaryFile))
                    throw new Error(t('errors.preparedFileInvalid'));
                // Only the completed file becomes visible to downloads.
                await fs.rename(temporaryFile, outputFile);
                return true;
            } finally {
                await fs.remove(temporaryFile);
            }
        };
        pendingCacheFiles.set(key, prepare().finally(() => pendingCacheFiles.delete(key)));
    }
    return pendingCacheFiles.get(key);
}

function ensureGunzipFile(inputFile, outputFile, expectedSize = 0) {
    return prepareCachedFile(outputFile, temporaryFile => gunzipFile(inputFile, temporaryFile), expectedSize);
}

function gzipBuffer(buf) {
    return new Promise((resolve, reject) => {
        zlib.gzip(buf, {level: 1}, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
}

// Сжатая книга не должна распаковаться больше этого (защита от gzip-бомбы).
const maxGunzipBytes = 256*1024*1024;

function gunzipBuffer(buf, maxOutputLength = maxGunzipBytes) {
    return new Promise((resolve, reject) => {
        zlib.gunzip(buf, {maxOutputLength}, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
}

function makeValidFileName(fileName, repl = '_') {
    let f = fileName.replace(/[\x00\\/:*"<>|]/g, repl); // eslint-disable-line no-control-regex
    f = f.trim();
    while (f.length && (f[f.length - 1] == '.' || f[f.length - 1] == '_')) {
        f = f.substring(0, f.length - 1);
    }

    if (f)
        return f;
    else
        throw new Error('Invalid filename');
}

function makeValidFileNameOrEmpty(fileName) {
    try {
        return makeValidFileName(fileName);
    } catch(e) {
        return '';
    }
}


function cutString(data, len = 500) {
    try {
        if (!data)
            return '';

        if (typeof(data) !== 'string')
            data = JSON.stringify(data);

        return `${data.substring(0, len)}${data.length > len ? ' ...' : ''}`;
    } catch (e) {
        return '';
    }
}

// A "~" search runs the user's pattern against every value in the index, and JS regular expressions
// have no timeout: "(.*.*)*q" never finishes on an 18-character title, ".*.*.*q" takes ms per title.
// Allow at most one variable quantifier (*, +, {n,m}), no repeated groups and no back-references.
function checkSearchRegExp(pattern = '') {
    const value = String(pattern);
    // "?" is a quantifier too: ".?" repeated before ".{n}" backtracks exponentially.
    // Group prefixes "(?:" and lazy modifiers ("*?") add no choice and are not counted.
    const quantifiers = value.replace(/\\./g, '').replace(/\(\?/g, '(').replace(/([*+?}])\?/g, '$1');
    const variable = (quantifiers.match(/[*+?]|\{\d*,\d*\}/g) || []).length;
    if (value.length > 100 || variable > 1 || /\)[*+?{]/.test(value) || /\\[1-9]|\\k</.test(value))
        throw new Error(t('errors.regexTooComplex'));
    return new RegExp(value, 'i');
}

module.exports = {
    checkSearchRegExp,
    sleep,
    processLoop,
    versionText,
    findFiles,
    touchFile,
    hasProp,
    freeMemory,
    getFileHash,
    getBufHash,
    randomHexString,
    gzipFile,
    gunzipFile,
    prepareCachedFile,
    ensureGunzipFile,
    gzipBuffer,
    gunzipBuffer,
    makeValidFileName,
    makeValidFileNameOrEmpty,
    cutString,
};
