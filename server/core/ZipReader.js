const path = require('path');
const fs = require('fs-extra');
const iconv = require('iconv-lite');
const archivePool = require('./archive/ArchivePool');

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
        const handle = await fs.promises.open(zipFile, 'r');
        const signature = Buffer.alloc(6);
        try {
            await handle.read(signature, 0, signature.length, 0);
        } finally {
            await handle.close();
        }
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

    //Имя записи в cp866 без флага UTF-8 7-Zip в WebAssembly читает как UTF-8: каждый неверный байт - символ U+FFFD,
    //и такое имя в аргументе не совпадает. Ищем запись шаблоном с ? на месте этих символов; из подошедших записей
    //берём ту, чьё имя совпало целиком, или единственную.
    async extractCp866(entryFilePath) {
        if (this.archiveType !== 'zip' || /^[\x20-\x7e]*$/.test(entryFilePath))
            return null;

        const name = new TextDecoder().decode(iconv.encode(entryFilePath, 'cp866'));
        const found = await archivePool.call('extract', this.archiveFile, [], name.replace(/[\uFFFD*]/g, '?'));
        const names = Object.keys(found);
        return found[name] || (names.length === 1 ? found[names[0]] : null);
    }

    async extractToBuf(entryFilePath) {
        this.checkState();

        const data = (await archivePool.call('extract', this.archiveFile, [entryFilePath]))[entryFilePath]
            || await this.extractCp866(entryFilePath);
        if (!data)
            throw new Error(`Entry not found: ${entryFilePath}`);
        return Buffer.from(data);
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
