const fs = require('fs-extra');

const utils = require('./utils');
const libraryFs = require('./LibraryFs');
const {getIndexedLibrarySources} = require('./LibrarySources');

class InpxHashCreator {
    constructor(config) {
        this.config = config;
        this.sourceHashes = new Map();
        //SHA-256 локальных файлов по пути: {size, mtimeMs, hash}
        this.fileHashes = new Map();
    }

    //Хеш содержимого файла. Локальный перечитывается, только если изменились размер или время изменения:
    //админка спрашивает состояние библиотек при каждом открытии. В S3 - ETag, файл не читается
    async contentHash(file) {
        if (libraryFs.isS3(file))
            return await libraryFs.contentHash(file);
        const stat = await fs.stat(file);
        const known = this.fileHashes.get(file);
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs)
            return known.hash;
        const hash = await utils.getFileHash(file, 'sha256', 'hex');
        this.fileHashes.set(file, {size: stat.size, mtimeMs: stat.mtimeMs, hash});
        return hash;
    }

    async getHash() {
        const config = this.config;

        let inpxFilterHash = '';
        if (await fs.pathExists(config.inpxFilterFile))
            inpxFilterHash = await this.contentHash(config.inpxFilterFile);

        //в хеш входят только ключ библиотеки и содержимое INPX (в S3 - его ETag и размер): включение, название и папка пересборки не требуют
        const sourceHashes = [];
        const byId = new Map();
        for (const source of await getIndexedLibrarySources(config)) {
            const inpxFile = source.inpxFile || source.inpx;
            const hash = await this.contentHash(inpxFile);
            byId.set(source.id, hash);
            sourceHashes.push([source.id, hash].join(':'));
        }
        //ETag INPX для API удалённой библиотеки: считается вместе с хешем БД, а не на каждый запрос
        this.sourceHashes = byId;

        const joinedHash = this.config.dbVersion + inpxFilterHash + sourceHashes.join('|');

        return utils.getBufHash(joinedHash, 'sha256', 'hex');
    }
}

module.exports = InpxHashCreator;
