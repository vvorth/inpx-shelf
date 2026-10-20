const path = require('path');
const fs = require('fs-extra');
const {pipeline} = require('stream/promises');
const yazl = require('yazl');
const ZipReader = require('./ZipReader');
const {t} = require('./i18n');

const imageIndexName = 'FLibraryImageIndex.json';
const mimetype = 'application/epub+zip';

function safeEntryName(value) {
    const name = String(value || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    // eslint-disable-next-line no-control-regex -- управляющие символы в имени записи запрещены намеренно
    if (!name || name.startsWith('/') || /[:\x00-\x1f]/.test(name)
        || name.split('/').some(part => part === '..'))
        throw new Error(t('errors.epubInvalidPath', {name}));
    const normalized = path.posix.normalize(name);
    if (normalized === '.' || normalized.endsWith('/'))
        throw new Error(t('errors.epubInvalidPath', {name}));
    return normalized;
}

function safeArchiveEntry(entry) {
    if (entry.isLink)
        throw new Error(t('errors.epubLink', {name: entry.name}));
    const rawName = entry.isDirectory ? entry.name.replace(/[\\/]+$/, '') : entry.name;
    return {sourceName: entry.name, name: safeEntryName(rawName), isDirectory: entry.isDirectory};
}

// loadImages([{num, name}]) returns image data in the same order: one call per book, so each image archive opens once.
async function restore(bookFile, config = {}, loadImages = async images => images.map(() => null)) {
    const reader = new ZipReader(config);
    let stagingDir = '';
    try {
        await reader.open(bookFile);
        const validated = Object.values(reader.entries).map(safeArchiveEntry);
        const entries = validated.filter(entry => !entry.isDirectory);
        const containers = entries.filter(entry => entry.name === 'META-INF/container.xml'
            || entry.name.endsWith('/META-INF/container.xml'));
        if (containers.length !== 1)
            throw new Error(t('errors.epubContainer'));
        const prefix = containers[0].name.slice(0, -'META-INF/container.xml'.length);
        const files = new Map();
        for (const entry of entries) {
            if (!entry.name.startsWith(prefix))
                continue;
            const name = entry.name.slice(prefix.length);
            if (files.has(name))
                throw new Error(t('errors.epubDuplicateFile', {name}));
            files.set(name, entry.sourceName);
        }
        // Heimdall stores this sidecar at the archive root while EPUB files
        // live under a book-id directory. Search the whole container.
        const indexes = entries.filter(entry => path.posix.basename(entry.name).toLowerCase() === imageIndexName.toLowerCase());
        const indexSources = new Set(indexes.map(entry => entry.sourceName));
        const indexNames = indexes.map(entry => entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name);
        if (reader.archiveType === 'zip' && !indexes.length)
            return false;
        if (indexes.length > 1)
            throw new Error(t('errors.epubMultipleImageIndexes'));

        stagingDir = await fs.mkdtemp(path.join(config.tempDir || path.dirname(bookFile), 'epub-'));
        // Container is unpacked by one 7-Zip run: a solid PPMd container is decompressed once,
        // and a zip one is not reopened for every file.
        const extractedDir = path.join(stagingDir, 'source');
        await fs.ensureDir(extractedDir);
        const seen = new Set();
        for (const entry of validated) {
            const key = entry.name.toLowerCase();
            if (seen.has(key))
                throw new Error(t('errors.epubDuplicatePath', {name: entry.name}));
            seen.add(key);
        }
        await reader.extractAllToDir(extractedDir);
        for (const entry of entries) {
            const stat = await fs.lstat(path.join(extractedDir, entry.name));
            if (!stat.isFile())
                throw new Error(t('errors.epubInvalidFile', {name: entry.name}));
        }
        const readEntry = async(name) => await fs.readFile(path.join(extractedDir, safeEntryName(name)));
        if (!files.has('mimetype') || (await readEntry(files.get('mimetype'))).toString().trim() !== mimetype)
            throw new Error(t('errors.epubMimetype'));

        let imageIndex = [];
        if (indexes.length) {
            try {
                imageIndex = JSON.parse((await readEntry(indexes[0].sourceName)).toString());
            } catch (error) {
                throw new Error(t('errors.epubInvalidImageIndex', {details: error.message}));
            }
            if (!Array.isArray(imageIndex))
                throw new Error(t('errors.epubImageIndexArray'));
        }
        const imageNames = new Set();
        const images = imageIndex.map(item => {
            if (!item || typeof item.id !== 'string' || !Number.isInteger(item.num) || item.num < -1)
                throw new Error(t('errors.epubImageIndexEntry'));
            let name = safeEntryName(item.id);
            if (prefix && name.startsWith(prefix))
                name = name.slice(prefix.length);
            if (imageNames.has(name) || ['mimetype', 'META-INF/container.xml', ...indexNames].includes(name))
                throw new Error(t('errors.epubInvalidImageName', {name}));
            imageNames.add(name);
            return {name, num: item.num};
        });

        const staged = new Map();
        for (const [name, sourceName] of files) {
            if (name === 'mimetype' || indexSources.has(sourceName))
                continue;
            staged.set(name, path.join(extractedDir, safeEntryName(sourceName)));
        }
        const needed = [];
        for (const image of images) {
            const existing = staged.get(image.name);
            if (!existing || !(await fs.stat(existing)).size)
                needed.push(image);
        }
        const loaded = needed.length ? await loadImages(needed) : [];
        for (const [index, image] of needed.entries()) {
            const data = loaded[index];
            if (!data || !data.length)
                throw new Error(t('errors.epubImageNotFound', {name: image.name, num: image.num}));
            const file = staged.get(image.name) || path.join(stagingDir, `entry-${staged.size}`);
            await fs.writeFile(file, data);
            staged.set(image.name, file);
        }

        const outputFile = path.join(stagingDir, 'restored.epub');
        const zip = new yazl.ZipFile();
        zip.on('error', error => zip.outputStream.destroy(error));
        const complete = pipeline(zip.outputStream, fs.createWriteStream(outputFile));
        const options = {mtime: new Date('2000-01-01T00:00:00Z')};
        zip.addBuffer(Buffer.from(mimetype), 'mimetype', {...options, compress: false});
        for (const name of [...staged.keys()].sort())
            zip.addFile(staged.get(name), name, options);
        zip.end();
        await complete;
        await reader.close();
        await fs.move(outputFile, bookFile, {overwrite: true});
        return true;
    } finally {
        await reader.close();
        if (stagingDir)
            await fs.remove(stagingDir);
    }
}

module.exports = {restore};
