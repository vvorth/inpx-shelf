const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const iconv = require('iconv-lite');

const ZipReader = require('./ZipReader');
const imageUtils = require('./ImageUtils');
const externalTools = require('./ExternalTools');
const libraryReviews = require('./LibraryReviews');
const log = new (require('./AppLogger'))().log;//singleton
const utils = require('./utils');
const {getEnabledLibrarySources} = require('./LibrarySources');
const {stripHtml, normalizeAuthorText} = require('./HtmlText');

function decodeArchiveText(data) {
    let text = iconv.decode(data, 'utf8');
    if (text.includes('\uFFFD'))
        text = iconv.decode(data, 'win1251');

    return text;
}

function flibraryAuthorHash(author) {
    return crypto.createHash('md5')
        .update((author || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase().trim(), 'utf8')
        .digest('hex');
}

function getAuthorArchiveEntryHash(entryName = '') {
    const normalized = String(entryName || '').replace(/\\/g, '/');
    const baseName = path.basename(normalized, path.extname(normalized)).toLowerCase();
    return /^[a-f0-9]{32}$/.test(baseName) ? baseName : '';
}

//Архив может лежать под другим расширением: .zip вместо .7z и наоборот
function archiveNameCandidates(file = '') {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.zip')
        return [file, `${file.substring(0, file.length - 4)}.7z`];
    if (ext === '.7z')
        return [file, `${file.substring(0, file.length - 3)}.zip`];
    return [file];
}

//Каталог ресурсов библиотеки (covers, images, etc/authors...): внутри каталога библиотеки или рядом с ним
function libraryAssetDirCandidates(subDir = '', libDir = '') {
    const normalizedSubDir = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const normalizedLibDir = String(libDir || '').replace(/\\/g, '/').replace(/\/+$/g, '');
    return [
        `${normalizedLibDir}/${normalizedSubDir}`,
        `${path.dirname(normalizedLibDir)}/${normalizedSubDir}`,
    ];
}

// Файлы библиотеки: книги из архивов, обложки и иллюстрации fb2/epub, справки об авторах, отзывы и оценки.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
    async extractBook(libFolder, libFile, sourceLibDir = '') {
        const outFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;

        libFolder = libFolder.replace(/\\/g, '/').replace(/\/\//g, '/');
        const libDir = sourceLibDir || this.config.libDir;

        const file = libFile;
        const resolveFolder = async() => {
            const folder = `${libDir}/${libFolder}`;

            return await this.resolveLibraryArchivePath(folder, libDir);
        };

        const folder = await resolveFolder();
        
        const fullPath = `${folder}/${file}`;

        if (!file || await fs.pathExists(fullPath)) {// файл есть на диске
            
            await fs.copy(fullPath, outFile);
            return outFile;
        } else {// файл в zip-архиве
            if (!await fs.pathExists(folder))
                throw new Error(`archive not found: ${folder}`);

            const zipReader = new ZipReader();
            await zipReader.open(folder, false);

            try {
                await fs.remove(outFile);
                await zipReader.extractToFile(file, outFile);
                return outFile;
            } catch(e) {
                //причина в ошибке: записи нет в архиве, архив повреждён, метод сжатия не поддерживается
                await fs.remove(outFile);
                throw new Error(`${folder}: ${file}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }
    },

    async resolveLibraryArchivePath(folder = '', libDir = '') {
        for (const candidate of archiveNameCandidates(folder)) {
            const resolved = await this.resolveExistingPath(candidate);
            if (resolved)
                return resolved;
        }

        const baseName = path.basename(folder);
        const relativeFolder = String(folder || '').startsWith(`${libDir}/`)
            ? String(folder || '').substring(String(libDir || '').length + 1)
            : baseName;
        const directRoots = [
            libDir,
            `${libDir}/fb2`,
            `${libDir}/books`,
            `${libDir}/archives`,
        ].filter(Boolean);

        for (const root of directRoots) {
            for (const name of Array.from(new Set([relativeFolder, baseName]))) {
                const resolved = await this.resolveArchiveNameInDir(root, name);
                if (resolved)
                    return resolved;
            }
        }

        const scanned = new Set(directRoots.map(item => path.resolve(item)));
        try {
            if (libDir && await fs.pathExists(libDir)) {
                const entries = await fs.readdir(libDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;

                    const dir = path.join(libDir, entry.name);
                    const key = path.resolve(dir);
                    if (scanned.has(key))
                        continue;

                    scanned.add(key);
                    const resolved = await this.resolveArchiveNameInDir(dir, baseName);
                    if (resolved)
                        return resolved;
                }
            }
        } catch(e) {
            // keep the original missing archive error
        }

        return folder;
    },

    async resolveArchiveNameInDir(dir = '', name = '') {
        for (const item of archiveNameCandidates(path.join(dir, name))) {
            const resolved = await this.resolveExistingPath(item);
            if (resolved)
                return resolved;
        }

        return '';
    },

    async resolveExistingPath(filePath = '') {
        if (!filePath)
            return '';
        if (await fs.pathExists(filePath))
            return filePath;

        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath).toLowerCase();
        if (!dir || !baseName || !await fs.pathExists(dir))
            return '';

        try {
            const entries = await fs.readdir(dir);
            const match = entries.find(item => item.toLowerCase() === baseName);
            return match ? path.join(dir, match) : '';
        } catch(e) {
            return '';
        }
    },

    async resolveLibraryAssetDir(subDir = '', sourceLibDir = '') {
        const candidates = libraryAssetDirCandidates(subDir, sourceLibDir || this.config.libDir);

        for (const dir of Array.from(new Set(candidates))) {
            if (await fs.pathExists(dir))
                return dir;
        }

        return candidates[0];
    },

    async resolveLibraryAssetDirs(subDir = '', sourceLibDir = '') {
        const candidates = libraryAssetDirCandidates(subDir, sourceLibDir || this.config.libDir)
            .filter(item => item && !item.startsWith('./'));

        const result = [];
        const seen = new Set();
        for (const dir of candidates) {
            const key = path.resolve(dir).toLowerCase();
            if (seen.has(key))
                continue;

            seen.add(key);
            if (await fs.pathExists(dir))
                result.push(dir);
        }

        return result;
    },

    async ensureFblibraryArchives(subDir, sourceLibDir = '') {
        if (!this.fblibraryArchives)
            this.fblibraryArchives = {};

        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;

        //пустой список тоже запоминается до переиндексации: иначе каждая обложка заново читает каталоги
        if (!this.fblibraryArchives[cacheKey]) {
            const result = [];
            const dir = await this.resolveLibraryAssetDir(subDir, libDir);

            if (await fs.pathExists(dir)) {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const match = file.match(/(\d{4,})-(\d{4,})\.(zip|7z)$/i);
                    if (!match)
                        continue;

                    result.push({
                        file: `${dir}/${file}`,
                        from: parseInt(match[1], 10),
                        to: parseInt(match[2], 10),
                    });
                }
            }

            result.sort((a, b) => a.from - b.from);
            this.fblibraryArchives[cacheKey] = result;
        }
    },

    async getFblibraryArchives(subDir, libid, sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const cacheKey = `${libDir}::${subDir}`;
        await this.ensureFblibraryArchives(subDir, libDir);

        return this.fblibraryArchives[cacheKey]
            .filter(item => libid >= item.from && libid <= item.to)
            .sort((a, b) => {
                const aspan = a.to - a.from;
                const bspan = b.to - b.from;
                if (aspan !== bspan)
                    return aspan - bspan;

                return a.from - b.from;
            });
    },

    async getFblibraryImages(libid, sourceLibDir = '', libFolder = '') {
        const archives = libFolder ? await this.getBookAssetArchives('images', libFolder, sourceLibDir)
            : await this.getFblibraryArchives('images', libid, sourceLibDir);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const prefix = `${libid}/`;
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(prefix))
                    .map(entry => entry.name)
                    .sort((a, b) => {
                        const ai = parseInt(a.substring(prefix.length), 10);
                        const bi = parseInt(b.substring(prefix.length), 10);
                        return ai - bi;
                    });

                const result = [];
                for (const entryName of entryNames) {
                    const id = entryName.substring(prefix.length);
                    if (!id)
                        continue;

                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        result.push(Object.assign({id}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.config.converterPaths)));
                    } catch(e) {
                        log(LM_ERR, `image ${entryName}: ${e.message}`);
                    }
                }

                if (result.length)
                    return result;
            } finally {
                await zipReader.close();
            }
        }

        return [];
    },

    async getFblibraryCover(libid, sourceLibDir = '', libFolder = '') {
        const archives = libFolder ? await this.getBookAssetArchives('covers', libFolder, sourceLibDir)
            : await this.getFblibraryArchives('covers', libid, sourceLibDir);
        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            try {
                const data = await zipReader.extractToBuf(String(libid));
                return Object.assign({id: '0'}, await imageUtils.normalizeForFb2(data, this.config.tempDir, this.config.converterPaths));
            } catch(e) {
                if (externalTools.isMissingToolError(e))
                    throw e;
                // try next matching archive
            } finally {
                await zipReader.close();
            }
        }

        return null;
    },

    async getBookAssetArchives(subDir, libFolder, sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        //как fblibraryArchives: архивы (и их отсутствие) помнятся до сброса кешей ресурсов библиотеки
        const cacheKey = `${libDir}::${subDir}::${libFolder}`;
        if (!this.bookAssetArchives)
            this.bookAssetArchives = new Map();
        if (this.bookAssetArchives.has(cacheKey))
            return this.bookAssetArchives.get(cacheKey);

        const bookArchive = await this.resolveLibraryArchivePath(`${libDir}/${libFolder}`, libDir);
        const baseName = path.basename(bookArchive, path.extname(bookArchive));
        const dirs = Array.from(new Set([
            path.join(path.dirname(bookArchive), subDir),
            ...await this.resolveLibraryAssetDirs(subDir, libDir),
        ]));
        const exact = [];
        for (const dir of dirs) {
            if (!await fs.pathExists(dir))
                continue;
            for (const name of await fs.readdir(dir)) {
                if (['.zip', '.7z'].includes(path.extname(name).toLowerCase())
                    && path.basename(name, path.extname(name)).toLowerCase() === baseName.toLowerCase())
                    exact.push({file: path.join(dir, name)});
            }
        }
        const result = exact
            .filter((archive, index, all) => all.findIndex(item => item.file === archive.file) === index);
        this.bookAssetArchives.set(cacheKey, result);
        return result;
    },

    async getBookCover(book) {
        const fileId = path.basename(String(book.file || ''), path.extname(String(book.file || '')));
        const cover = book.folder ? await this.getFblibraryCover(fileId, book.sourceLibDir, book.folder) : null;
        if (cover || String(book.ext).toLowerCase() !== 'fb2')
            return cover;

        // Embedded covers must come from this book, never another archive
        // that happens to contain the same numeric filename.
        const file = await this.extractBook(book.folder, `${book.file}.${book.ext}`, book.sourceLibDir);
        try {
            const {cover: embedded} = await this.fb2Helper.getDescAndCover(file);
            return embedded ? await imageUtils.normalizeForFb2(embedded, this.config.tempDir, this.config.converterPaths) : null;
        } finally {
            await fs.remove(file);
        }
    },

    async getEpubImage(libid, num, fileName, libFolder, sourceLibDir = '', archiveCache = new Map(), readerCache = null) {
        const subDir = num === -1 ? 'covers' : 'images';
        if (!archiveCache.has(subDir))
            archiveCache.set(subDir, await this.getBookAssetArchives(subDir, libFolder, sourceLibDir));
        for (const archive of archiveCache.get(subDir)) {
            const cachedReader = readerCache && readerCache.get(archive.file);
            const reader = cachedReader || new ZipReader(this.config);
            let data;
            try {
                if (!cachedReader) {
                    await reader.open(archive.file, false);
                    if (readerCache)
                        readerCache.set(archive.file, reader);
                }
                data = await reader.extractToBuf(num === -1 ? String(libid) : `${libid}/${num}`);
            } catch (error) {
                if (externalTools.isMissingToolError(error))
                    throw error;
                log(LM_WARN, `EPUB image ${archive.file}: ${error.message}`);
            } finally {
                if (!readerCache || !readerCache.has(archive.file))
                    await reader.close();
            }
            if (data && data.length)
                return await imageUtils.normalizeForEpub(data, fileName, this.config.tempDir, this.config.converterPaths);
        }
        return null;
    },

    //Индекс справок и портретов авторов строится один раз на поколение ресурсов библиотеки:
    //параллельные запросы ждут одно построение, после ошибки следующий запрос строит заново
    ensureAuthorInfoArchives() {
        if (!this.authorInfoIndex) {
            const index = this.buildAuthorInfoIndex();
            this.authorInfoIndex = index;
            index.catch(() => {
                if (this.authorInfoIndex === index)
                    this.authorInfoIndex = null;
            });
        }
        return this.authorInfoIndex;
    },

    async buildAuthorInfoIndex() {
        const authorInfoArchives = [];
        const authorPictureArchives = [];
        const authorToArchive = new Map();

        const sources = getEnabledLibrarySources(this.config);
        const scannedAuthorDirs = new Set();

        for (const source of sources) {
            const authorDirs = [
                ...await this.resolveLibraryAssetDirs('etc/authors', source.libDir),
                ...await this.resolveLibraryAssetDirs('authors', source.libDir),
            ];
            for (const authorsDir of authorDirs) {
                const dirKey = path.resolve(authorsDir).toLowerCase();
                if (scannedAuthorDirs.has(dirKey))
                    continue;

                scannedAuthorDirs.add(dirKey);

                const files = await fs.readdir(authorsDir);
                for (const file of files) {
                    if (!/^\d+\.(7z|zip)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    authorInfoArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${authorsDir}/${file}`,
                    });
                }

                const picturesDir = `${authorsDir}/pictures`;
                if (!await fs.pathExists(picturesDir))
                    continue;

                const pictureFiles = await fs.readdir(picturesDir);
                for (const file of pictureFiles) {
                    if (!/^\d+\.(zip|7z)$/i.test(file))
                        continue;

                    const id = path.basename(file, path.extname(file));
                    authorPictureArchives.push({
                        id,
                        sourceId: source.id || '',
                        sourceLibDir: source.libDir || '',
                        file: `${picturesDir}/${file}`,
                    });
                }
            }
        }

        const bySourceAndId = (a, b) => {
            const sourceCompare = String(a.sourceId || '').localeCompare(String(b.sourceId || ''));
            if (sourceCompare)
                return sourceCompare;

            return parseInt(a.id, 10) - parseInt(b.id, 10);
        };

        authorInfoArchives.sort(bySourceAndId);
        authorPictureArchives.sort(bySourceAndId);

        for (const archive of authorInfoArchives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                for (const entry of Object.values(zipReader.entries)) {
                    const name = (entry.name || '').replace(/\\/g, '/');
                    if (!name || entry.isDirectory)
                        continue;

                    const hash = getAuthorArchiveEntryHash(name);
                    if (!hash)
                        continue;

                    if (!authorToArchive.has(hash))
                        authorToArchive.set(hash, []);

                    authorToArchive.get(hash).push({
                        archive,
                        entryName: name,
                    });
                }
            } finally {
                await zipReader.close();
            }
        }

        return {authorInfoArchives, authorPictureArchives, authorToArchive};
    },

    async getAuthorPictureByKey(authorKey, archiveId = '', sourceId = '') {
        const {authorPictureArchives} = await this.ensureAuthorInfoArchives();

        const archives = [];
        if (archiveId) {
            const exactArchive = authorPictureArchives.find(item => item.id === String(archiveId) && (!sourceId || item.sourceId === sourceId));
            if (exactArchive)
                archives.push(exactArchive);
        }

        archives.push(...authorPictureArchives.filter(item => {
            if (archives.includes(item))
                return false;

            return sourceId && item.sourceId === sourceId;
        }));
        archives.push(...authorPictureArchives.filter(item => !archives.includes(item)));

        for (const archive of archives) {
            const zipReader = new ZipReader();
            await zipReader.open(archive.file);

            try {
                const entryNames = Object.values(zipReader.entries)
                    .map(entry => Object.assign({}, entry, {name: entry.name.replace(/\\/g, '/')}))
                    .filter(entry => !entry.isDirectory && entry.name.startsWith(`${authorKey}/`))
                    .map(entry => entry.name)
                    .sort();

                for (const entryName of entryNames) {
                    try {
                        const data = await zipReader.extractToBuf(entryName);
                        const image = await imageUtils.normalizeForFb2(data, this.config.tempDir, this.config.converterPaths);
                        return `data:${image.contentType};base64,${image.data.toString('base64')}`;
                    } catch(e) {
                        log(LM_WARN, `author picture ${entryName}: ${e.message}`);
                    }
                }
            } finally {
                await zipReader.close();
            }
        }

        return '';
    },

    async findAuthorInfo(author) {
        const {authorToArchive} = await this.ensureAuthorInfoArchives();

        const hashed = flibraryAuthorHash(author);
        const matches = authorToArchive.get(hashed) || [];
        if (!hashed || !matches.length)
            return null;

        for (const match of matches) {
            const archive = match.archive;
            const entryName = match.entryName || hashed;
            const zipReader = new ZipReader();
            await zipReader.open(archive.file, false);

            let html = '';
            try {
                html = decodeArchiveText(await zipReader.extractToBuf(entryName));
            } catch(e) {
                log(LM_WARN, `author info ${archive.file}:${entryName}: ${e.message}`);
                continue;
            } finally {
                await zipReader.close();
            }

            return {
                key: hashed,
                html,
                text: stripHtml(html),
                photo: await this.getAuthorPictureByKey(hashed, archive.id, archive.sourceId),
            };
        }

        return null;
    },

    async getAuthorInfo(authorId, author) {
        //авторы ищутся по имени: id авторов прежней БД больше не используются
        const authorName = author || '';

        const normalized = normalizeAuthorText(authorName);
        if (!normalized)
            return {authorInfo: null};

        const cacheKey = flibraryAuthorHash(authorName);
        if (this.authorInfoCache.has(cacheKey))
            return {authorInfo: this.authorInfoCache.get(cacheKey)};

        const authorInfo = await this.findAuthorInfo(authorName);
        if (this.authorInfoCache.size >= 1000)
            this.authorInfoCache.delete(this.authorInfoCache.keys().next().value);
        this.authorInfoCache.set(cacheKey, authorInfo);
        return {authorInfo};
    },

    async injectFblibraryImages(bookFile, libid, sourceLibDir = '', libFolder = '') {
        const images = await this.getFblibraryImages(libid, sourceLibDir, libFolder);
        const cover = await this.getFblibraryCover(libid, sourceLibDir, libFolder);
        if (!images.length && !cover)
            return false;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        let text = data.toString();

        if (!/<FictionBook[\s>]/i.test(text) || !/<\/FictionBook>\s*$/i.test(text))
            return false;

        const existingBinaryIds = new Set();
        for (const match of text.matchAll(/<binary\b[^>]*\bid=(['"])(.*?)\1/gi))
            existingBinaryIds.add(match[2]);

        let coverHrefId = '';
        const coverHrefMatch = text.match(/<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?([^"']+)["'][^>]*\/?>[\s\S]*?<\/coverpage>/i);
        if (coverHrefMatch)
            coverHrefId = String(coverHrefMatch[1] || '').trim();

        const binaries = [];
        const effectiveCover = (cover && coverHrefId && !existingBinaryIds.has(coverHrefId))
            ? Object.assign({}, cover, {id: coverHrefId})
            : cover;
        const assets = (effectiveCover && !images.some(image => image.id === effectiveCover.id) ? [effectiveCover, ...images] : images);
        for (const image of assets) {
            if (existingBinaryIds.has(image.id))
                continue;

            const base64 = image.data.toString('base64');
            binaries.push(`<binary id="${image.id}" content-type="${image.contentType}">${base64}</binary>`);
        }

        let coverLinked = false;
        if (effectiveCover) {
            coverLinked = /<coverpage\b[\s\S]*?<image\b[^>]*?(?:l:href|xlink:href|href)=["']#?[^"']+["'][^>]*\/?>[\s\S]*?<\/coverpage>/i.test(text);
            if (!coverLinked) {
                const titleInfoRe = /<title-info\b[^>]*>/i;
                const titleInfoMatch = text.match(titleInfoRe);
                if (titleInfoMatch) {
                    const hrefAttr = 'xlink:href';
                    const coverpage = `\n<coverpage><image ${hrefAttr}="#${effectiveCover.id}"/></coverpage>`;
                    const insertAt = titleInfoMatch.index + titleInfoMatch[0].length;
                    text = `${text.slice(0, insertAt)}${coverpage}${text.slice(insertAt)}`;
                    coverLinked = true;
                }
            }
        }

        if (!binaries.length && !coverLinked)
            return false;

        text = text.replace(/<\/FictionBook>\s*$/i, `\n${binaries.join('\n')}\n</FictionBook>`);
        await fs.writeFile(bookFile, text);

        return (binaries.length > 0 || coverLinked);
    },

    async shouldInjectFblibraryImages(bookFile, libFolder = '') {
        if (path.extname(String(libFolder || '')).toLowerCase() === '.7z')
            return true;

        let data = await fs.readFile(bookFile);
        data = this.fb2Helper.checkEncoding(data);
        const text = data.toString();

        return !/<binary\b/i.test(text);
    },

    async getReviewArchiveState(sourceLibDir = '') {
        const libDir = sourceLibDir || this.config.libDir;
        const dirs = [
            ...await this.resolveLibraryAssetDirs('reviews', libDir),
            ...await this.resolveLibraryAssetDirs('etc/reviews', libDir),
        ];
        const state = await libraryReviews.snapshot(dirs);
        // Include the source even when no review directories exist.
        state.signature = utils.getBufHash(`${libDir}:${state.signature}`, 'sha256', 'hex');
        if (!this.reviewArchiveStates)
            this.reviewArchiveStates = new Map();
        const cached = this.reviewArchiveStates.get(libDir);
        if (cached && cached.signature === state.signature)
            return cached;
        this.reviewArchiveStates.set(libDir, state);
        return state;
    },

    async ensureReviewIndex(sourceLibDir = '', state = null) {
        state = state || await this.getReviewArchiveState(sourceLibDir);
        if (!state.indexPromise)
            state.indexPromise = this.createReviewIndex(state.archives);
        return state.indexPromise;
    },

    async createReviewIndex(archives) {
        const reviewToArchives = new Map();

        for (const archive of archives) {
            if (archive.id.toLowerCase() === 'additional')
                continue;
            const zipReader = new ZipReader(this.config);
            try {
                await zipReader.open(archive.file);
                for (const item of Object.values(zipReader.entries || {})) {
                    const entryName = String(item.name || '').replace(/\\/g, '/');
                    if (!entryName || item.isDirectory)
                        continue;

                    const key = libraryReviews.normalizeEntryKey(entryName);
                    if (!key) continue;
                    const list = reviewToArchives.get(key) || [];
                    list.push({archive: archive.file, entryName});
                    reviewToArchives.set(key, list);
                }
            } catch(e) {
                log(LM_WARN, `review archive ${archive.file}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return reviewToArchives;
    },

    async getBookReviews(book, state = null) {
        const entryKey = libraryReviews.entryKey(book.folder, `${book.file}.${book.ext}`);
        const reviewIndex = await this.ensureReviewIndex(book.sourceLibDir, state);
        const matches = reviewIndex.get(entryKey) || [];
        const reviews = [];
        const seen = new Set();

        for (const match of matches) {
            const zipReader = new ZipReader(this.config);
            try {
                await zipReader.open(match.archive, false);
                const raw = await zipReader.extractToBuf(match.entryName);
                const parsed = JSON.parse(decodeArchiveText(raw));
                if (!Array.isArray(parsed))
                    continue;

                for (const item of parsed) {
                    if (!item || typeof(item) !== 'object')
                        continue;

                    const review = {
                        name: String(item.name || '').trim(),
                        time: String(item.time || '').trim(),
                        text: String(item.text || '').replace(/<br\s*\/?>/gi, '\n').trim(),
                    };
                    const key = JSON.stringify(review);
                    if (!seen.has(key)) {
                        seen.add(key);
                        reviews.push(review);
                    }
                }
            } catch(e) {
                log(LM_WARN, `review entry ${match.archive}:${match.entryName}: ${e.message}`);
            } finally {
                await zipReader.close();
            }
        }

        return reviews;
    },

    async getBookLibraryRating(book, state = null) {
        state = state || await this.getReviewArchiveState(book.sourceLibDir);
        if (!state.ratingsPromise)
            state.ratingsPromise = this.readLibraryRatings(state.archives);
        const ratings = await state.ratingsPromise;
        return ratings.get(libraryReviews.entryKey(book.folder, `${book.file}.${book.ext}`)) || null;
    },

    async readLibraryRatings(archives) {
        const ratings = new Map();
        for (const archive of archives.filter(item => item.id.toLowerCase() === 'additional')) {
            const reader = new ZipReader(this.config);
            try {
                await reader.open(archive.file, false);
                const rows = JSON.parse(decodeArchiveText(await reader.extractToBuf('books.json')));
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    if (!row || typeof row.folder !== 'string' || typeof row.file !== 'string'
                        || !Number.isFinite(row.sum) || !Number.isSafeInteger(row.count)
                        || row.count <= 0 || row.sum <= 0 || row.sum > row.count * 5)
                        continue;
                    const key = libraryReviews.entryKey(row.folder, row.file);
                    if (!ratings.has(key))
                        ratings.set(key, {value: row.sum / row.count, count: row.count});
                }
            } catch (error) {
                log(LM_WARN, `library ratings ${archive.file}: ${error.message}`);
            } finally {
                await reader.close();
            }
        }
        return ratings;
    },
};
