// Достаёт из архива один файл по имени, где бы он ни лежал: node build/extract-zip-file.js <archive> <fileName> <outputDir>.
// Нужен сборке Windows-утилит: Expand-Archive не читает Deflate64 (так сжат zip libjxl 0.12), 7-Zip из 7z-wasm - читает.
const path = require('path');
const sevenZip = require('../server/core/archive/SevenZipEngine');

(async() => {
    const [archive, fileName, outputDir] = process.argv.slice(2);
    if (!archive || !fileName || !outputDir)
        throw new Error('usage: extract-zip-file.js <archive> <fileName> <outputDir>');

    const entry = (await sevenZip.list(archive))
        .find(item => !item.isDirectory && path.posix.basename(item.name).toLowerCase() === fileName.toLowerCase());
    if (!entry)
        throw new Error(`${fileName} not found in ${archive}`);

    const outputFile = path.join(outputDir, fileName);
    if (!await sevenZip.extractToFile(archive, entry.name, outputFile))
        throw new Error(`cannot extract ${entry.name} from ${archive}`);
    console.log(`${entry.name} -> ${outputFile}`);
})().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
