const path = require('path');
const fs = require('fs-extra');
const iconv = require('iconv-lite');
const archivePool = require('./archive/ArchivePool');
const libraryFs = require('./LibraryFs');

//Архивы библиотеки читает 7-Zip (WebAssembly) в отдельных потоках: zip любого метода сжатия, 7z и др.
class ZipReader {
    constructor() {
        this.archiveFile = '';
        this.archiveType = '';
        this.zipEntries = undefined;
    }

    checkState() {
        if (!this.archiveFile)
            throw new Error('Archive closed');
    }

    async open(zipFile, zipEntries = true) {
        if (this.archiveFile)
            throw new Error('Archive file is already open');

        // FLibrary stores recompressed EPUB containers with an .epub name;
        // extracted books also have extensionless temporary names.
        const signature = await libraryFs.readRange(zipFile, 0, 6);
        const is7z = signature.equals(Buffer.from('377abcaf271c', 'hex')) || path.extname(zipFile).toLowerCase() === '.7z';

        if (zipEntries) {
            const entries = await archivePool.call('list', zipFile);
            this.zipEntries = Object.fromEntries(entries.map((entry, index) => [index, entry]));
        }
        this.archiveFile = zipFile;
        this.archiveType = (is7z ? '7z' : 'zip');
    }

    get entries() {
        this.checkState();

        return this.zipEntries;
    }

    //Имя записи в cp866 без флага UTF-8 7-Zip в WebAssembly хранит байтами как есть, и имя в аргументе (UTF-8) с ним
    //не совпадает. Байты cp866 передаются без шаблонов: распаковывается только запись с точно таким именем.
    async extractCp866(entryFilePath) {
        if (this.archiveType !== 'zip' || /^[\x20-\x7e]*$/.test(entryFilePath))
            return null;

        const found = Object.values(await archivePool.call('extract', this.archiveFile, [], iconv.encode(entryFilePath, 'cp866')));
        return (found.length === 1 ? found[0] : null);
    }

    async extractToBuf(entryFilePath) {
        this.checkState();

        const data = (await archivePool.call('extract', this.archiveFile, [entryFilePath]))[entryFilePath]
            || await this.extractCp866(entryFilePath);
        if (!data)
            throw new Error(`Entry not found: ${entryFilePath}`);
        return Buffer.from(data);
    }

    //Несколько записей одним вызовом 7-Zip (solid-блок распаковывается один раз): {имя: Buffer}, ненайденных нет
    async extractMany(names) {
        this.checkState();

        const found = await archivePool.call('extract', this.archiveFile, names);
        return Object.fromEntries(Object.entries(found).map(([name, data]) => [name, Buffer.from(data.buffer, data.byteOffset, data.length)]));
    }

    async extractToFile(entryFilePath, outputFile) {
        this.checkState();

        if (await archivePool.call('extractToFile', this.archiveFile, entryFilePath, outputFile))
            return;
        const data = await this.extractCp866(entryFilePath);
        if (!data)
            throw new Error(`Entry not found: ${entryFilePath}`);
        await fs.writeFile(outputFile, data);
    }

    async extractAllToDir(outputDir) {
        this.checkState();

        await archivePool.call('extractAll', this.archiveFile, outputDir);
    }

    async close() {
        this.archiveFile = '';
        this.archiveType = '';
        this.zipEntries = undefined;
    }
}

module.exports = ZipReader;
