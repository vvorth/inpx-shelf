const fs = require('fs-extra');
const path = require('path');
const utils = require('./utils');
const {S3Fs, isS3} = require('./S3Fs');

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

module.exports = {
    isS3,
    s3,
    //path.join свернул бы s3:// в s3:/ (а в Windows заменил бы / на \): S3Fs поймёт, но в настройках и журнале некрасиво
    join: (dir, ...names) => (isS3(dir) ? [String(dir).replace(/\/+$/, ''), ...names].join('/') : path.join(dir, ...names)),
    pathExists: p => (isS3(p) ? s3.pathExists(p) : fs.pathExists(p)),
    stat: p => (isS3(p) ? s3.stat(p) : fs.stat(p)),
    readdir: (p, options = {}) => (isS3(p) ? s3.readdir(p, options) : fs.readdir(p, options)),
    readFile: async(p, encoding) => (isS3(p) ? (encoding ? (await s3.readFile(p)).toString(encoding) : s3.readFile(p)) : fs.readFile(p, encoding)),
    readRange: (p, offset, length) => (isS3(p) ? s3.readRange(p, offset, length) : readLocalRange(p, offset, length)),
    copyToLocal: (p, outFile) => (isS3(p) ? s3.copyToLocal(p, outFile) : fs.copy(p, outFile)),
    sha256: p => (isS3(p) ? s3.sha256(p) : utils.getFileHash(p, 'sha256', 'hex')),
    //признак изменения файла: ETag и размер для S3, SHA-256 содержимого для диска
    contentHash: p => (isS3(p) ? s3.contentHash(p) : utils.getFileHash(p, 'sha256', 'hex')),
    //листинги S3 перечитываются после проверки INPX: библиотеку могли обновить
    clearCache: () => s3.clearCache(),
};
