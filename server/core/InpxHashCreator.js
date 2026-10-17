const fs = require('fs-extra');

const utils = require('./utils');
const libraryFs = require('./LibraryFs');
const {getIndexedLibrarySources} = require('./LibrarySources');

class InpxHashCreator {
    constructor(config) {
        this.config = config;
        this.sourceHashes = new Map();
    }

    async getHash() {
        const config = this.config;

        let inpxFilterHash = '';
        if (await fs.pathExists(config.inpxFilterFile))
            inpxFilterHash = await utils.getFileHash(config.inpxFilterFile, 'sha256', 'hex');

        //в хеш входят только ключ библиотеки и содержимое INPX (в S3 - его ETag и размер): включение, название и папка пересборки не требуют
        const sourceHashes = [];
        const byId = new Map();
        for (const source of await getIndexedLibrarySources(config)) {
            const inpxFile = source.inpxFile || source.inpx;
            const hash = await libraryFs.contentHash(inpxFile);
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
