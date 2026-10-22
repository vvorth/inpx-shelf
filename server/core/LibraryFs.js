const fs = require('fs-extra');
const path = require('path');
const utils = require('./utils');
const {S3Fs, isS3, parse} = require('./S3Fs');

//Файлы библиотеки (INPX, архивы, covers/images/etc): путь s3://... читается из S3, остальные - с диска.
//Только для путей библиотеки: dataDir, tempDir и кеши всегда на диске и идут через fs.
const s3 = new S3Fs();

async function readLocalRange(file, offset, length) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const buf = Buffer.alloc(length);
        const {bytesRead} = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

//target внутри каталога base (или он сам). S3 не сворачивает .. в ключе, но прокси и S3-совместимые серверы могут:
//такой ключ отвергается
function insideDir(base, target) {
    if (String(target).includes('\0'))
        return false;
    if (isS3(base) || isS3(target)) {
        if (!isS3(base) || !isS3(target))
            return false;
        const dir = parse(base);
        const item = parse(target);
        return dir.bucket === item.bucket && !item.key.split(/[\\/]/).includes('..')
            && (!dir.key || item.key === dir.key || item.key.startsWith(`${dir.key}/`));
    }
    const relative = path.relative(path.resolve(base), path.resolve(target));
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

//Путь из INPX (folder, file) относителен каталогу библиотеки: без .., NUL и корня в начале
function isSafeRelativePath(value) {
    const text = String(value || '');
    return !text.includes('\0') && !/^([\\/]|[a-zA-Z]:)/.test(text) && !text.split(/[\\/]/).includes('..');
}

module.exports = {
    isS3,
    insideDir,
    isSafeRelativePath,
    s3,
    //path.join свернул бы s3:// в s3:/ (а в Windows заменил бы / на \): S3Fs поймёт, но в настройках и журнале некрасиво
    join: (dir, ...names) => (isS3(dir) ? [String(dir).replace(/\/+$/, ''), ...names].join('/') : path.join(dir, ...names)),
    pathExists: p => (isS3(p) ? s3.pathExists(p) : fs.pathExists(p)),
    stat: p => (isS3(p) ? s3.stat(p) : fs.stat(p)),
    readdir: (p, options = {}) => (isS3(p) ? s3.readdir(p, options) : fs.readdir(p, options)),
    readFile: async(p, encoding) => (isS3(p) ? (encoding ? (await s3.readFile(p)).toString(encoding) : s3.readFile(p)) : fs.readFile(p, encoding)),
    readRange: (p, offset, length) => (isS3(p) ? s3.readRange(p, offset, length) : readLocalRange(p, offset, length)),
    createReadStream: async p => (isS3(p) ? s3.createReadStream(p) : fs.createReadStream(p)),
    copyToLocal: (p, outFile) => (isS3(p) ? s3.copyToLocal(p, outFile) : fs.copy(p, outFile)),
    //признак изменения файла: ETag и размер для S3, SHA-256 содержимого для диска
    contentHash: p => (isS3(p) ? s3.contentHash(p) : utils.getFileHash(p, 'sha256', 'hex')),
    //листинги S3 перечитываются после проверки INPX: библиотеку могли обновить
    clearCache: () => s3.clearCache(),
};
