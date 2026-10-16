const fs = require('fs-extra');

const utils = require('./utils');
const libraryFs = require('./LibraryFs');
const {getIndexedLibrarySources} = require('./LibrarySources');

class InpxHashCreator {
    constructor(config) {
        this.config = config;
    }

    async getHash() {
        const config = this.config;

        let inpxFilterHash = '';
        if (await fs.pathExists(config.inpxFilterFile))
            inpxFilterHash = await utils.getFileHash(config.inpxFilterFile, 'sha256', 'hex');

        //в хеш входят только ключ библиотеки и содержимое INPX (в S3 - его ETag и размер): включение, название и папка пересборки не требуют
        const sourceHashes = [];
        for (const source of await getIndexedLibrarySources(config)) {
            const inpxFile = source.inpxFile || source.inpx;
            sourceHashes.push([
                source.id,
                await libraryFs.contentHash(inpxFile),
            ].join(':'));
        }

        const joinedHash = this.config.dbVersion + inpxFilterHash + sourceHashes.join('|');

        return utils.getBufHash(joinedHash, 'sha256', 'hex');
    }

    //SHA-256 содержимого и для S3: с ним сравнивает свой файл удалённая библиотека (RemoteLib)
    async getInpxFileHash() {
        return (
            await libraryFs.pathExists(this.config.inpxFile) ?
            utils.getBufHash(await libraryFs.readFile(this.config.inpxFile), 'sha256', 'hex') :
            ''
        );
    }
}

module.exports = InpxHashCreator;
