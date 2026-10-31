// Папка с книгами без INPX (источник scan: true): сервер сам строит INPX по файлам .fb2 и .epub в
// <dataDir>/scan/<id>.inpx, дальше это обычная библиотека с INPX. Книга отдаётся как файл на диске
// (LibraryAssets.extractBook): FOLDER - каталог файла относительно папки библиотеки, FILE и EXT - его имя.
// build - сам генератор, идёт в потоке FolderScanThread; syncAll - запуск из основного потока.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const yazl = require('yazl');

const libraryFs = require('../LibraryFs');
const {writeFileAtomic} = require('../FilePersistence');
const {parseFb2Description, utf8Prefix, epubMetadata, plainText} = require('../BookMetadata');
const FolderScanThread = require('./FolderScanThread');

function log(...args) {
    return new (require('../AppLogger'))().log(...args);
}

const structure = 'AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER';
//другая версия - строки кеша разбираются заново
const cacheVersion = 1;
const bookExts = ['.fb2', '.epub'];
//папки ресурсов библиотеки в её корне
const assetDirs = ['covers', 'images', 'etc'];
const headSize = 256*1024;
const maxHeadSize = 4*1024*1024;
//постоянное время записей: байты INPX меняются только вместе с содержимым
const zipTime = new Date(Date.UTC(2000, 0, 1));
const progressInterval = 5*1000;

//значение поля INPX: одна строка без разделителей
function field(value) {
    return String(value ?? '').replace(/[\x00-\x1f\s]+/g, ' ').trim();// eslint-disable-line no-control-regex
}

//часть имени автора или жанр: ещё и без разделителей списков INPX
function listPart(value) {
    return field(String(value ?? '').replace(/[,:]/g, ' '));
}

//Last,First,Middle: на автора
function authorsField(authors) {
    return authors
        .map(author => [author.last, author.first, author.middle].map(listPart))
        .filter(parts => parts.some(Boolean))
        .map(parts => `${parts.join(',')}:`)
        .join('');
}

//числовой libid: rebuildCoverCacheForBook читает его через parseInt; у name.fb2 и name.epub он общий - одна книга в двух форматах
function libidOf(relPath) {
    const withoutExt = relPath.substring(0, relPath.length - path.posix.extname(relPath).length);
    return String(parseInt(crypto.createHash('sha1').update(withoutExt).digest('hex').substring(0, 12), 16));
}

//Голова fb2 до </description>: 256 КиБ, при необходимости до 4 МиБ
async function fb2Head(file, size) {
    let data = await libraryFs.readRange(file, 0, Math.min(size, headSize));
    while (!data.includes('</description>') && data.length < Math.min(size, maxHeadSize)) {
        const more = await libraryFs.readRange(file, data.length, Math.min(size, maxHeadSize, data.length*4) - data.length);
        if (!more.length)
            break;
        data = Buffer.concat([data, more]);
    }
    return utf8Prefix(data);
}

async function fb2Info(file, size) {
    const parser = parseFb2Description(await fb2Head(file, size));
    const titleInfo = parser && parser.$$('/description/title-info/');
    if (!titleInfo || !titleInfo.count)
        return null;
    const info = parser.bookInfo().titleInfo || {};
    const authors = titleInfo.$$array('author').map(node => {
        const author = {last: plainText(node.text('/last-name')), first: plainText(node.text('/first-name')), middle: plainText(node.text('/middle-name'))};
        //как Fb2Parser: без имени - псевдоним
        if (!author.last && !author.first && !author.middle)
            author.last = plainText(node.text('/nickname'));
        return author;
    });
    const sequence = (info.sequence || [])[0] || {};
    return {
        authors,
        genres: (info.genre || []).map(plainText),
        title: plainText(info.bookTitle),
        series: plainText(sequence.name),
        serno: sequence.num,
        lang: plainText(info.lang),
        keywords: plainText(info.keywords),
    };
}

async function epubInfo(file) {
    const meta = await epubMetadata(file);
    if (!meta.title && !(meta.authors || []).length)
        return null;
    return {
        //имя целиком на месте фамилии: InpxParser всё равно склеивает части через пробел
        authors: (meta.authors || []).map(name => ({last: name})),
        genres: [],
        title: meta.title,
        series: meta.series,
        serno: meta.seriesIndex,
        lang: meta.language,
        keywords: (meta.tags || []).join(','),
    };
}

//Файлы книг под libDir: относительный путь (через /) и запись каталога. Скрытые записи и папки ресурсов в корне пропускаются.
//Ошибка чтения каталога прерывает сканирование: недоступная папка оставляет прежний INPX
async function* walkBooks(libDir) {
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const dir = (rel ? libraryFs.join(libDir, ...rel.split('/')) : libDir);
        for (const entry of await libraryFs.readdir(dir, {withFileTypes: true})) {
            const name = entry.name;
            if (name.startsWith('.') || (!rel && assetDirs.includes(name.toLowerCase())))
                continue;
            const relPath = (rel ? `${rel}/${name}` : name);
            if (entry.isDirectory())
                stack.push(relPath);
            else if (bookExts.includes(path.extname(name).toLowerCase()))
                yield relPath;
        }
    }
}

//Строка INPX файла книги; без описания - название по имени файла
async function bookLine(source, relPath, stat, onLog) {
    const libDir = source.libDir;
    const ext = path.posix.extname(relPath);
    const file = path.posix.basename(relPath, ext);
    const fullPath = libraryFs.join(libDir, ...relPath.split('/'));
    let meta;
    try {
        meta = (ext.toLowerCase() === '.fb2' ? await fb2Info(fullPath, stat.size) : await epubInfo(fullPath));
    } catch (e) {
        meta = null;
    }
    if (!meta) {
        onLog('warn', `Folder scan ${source.id}: no metadata in ${relPath}, listed under its file name`);
        meta = {authors: [], genres: []};
    }
    const serno = parseInt(meta.serno, 10);
    return [
        authorsField(meta.authors),
        meta.genres.map(listPart).filter(Boolean).map(genre => `${genre}:`).join(''),
        field(meta.title) || file,
        field(meta.series),
        (serno > 0 ? String(serno) : ''),
        file,
        String(stat.size),
        libidOf(relPath),
        '0',
        ext.substring(1).toLowerCase(),
        new Date(stat.mtimeMs).toISOString().substring(0, 10),
        field(meta.lang),
        '0',
        field(meta.keywords),
        //корень - ".": пустой FOLDER InpxParser заменил бы на <имя inp>.zip
        path.posix.dirname(relPath),
    ].join('\x04') + '\x04';
}

async function zipBuffer(files) {
    const zip = new yazl.ZipFile();
    for (const [name, text] of files)
        zip.addBuffer(Buffer.from(text), name, {mtime: zipTime});
    zip.end();
    const chunks = [];
    for await (const chunk of zip.outputStream)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}

//Строит или обновляет INPX папки source ({id, name, libDir, inpxFile}). Кеш <dataDir>/scan/<id>.json:
//{files: {relPath: {size, mtimeMs, line}}} - разбираются только новые и изменённые файлы.
//onLog(level, text) - ход (не чаще раза в 5 секунд) и файлы без описания.
//Ответ: {changed, books, skipped, parsed}; skipped - файлы, не попавшие в INPX (путь не годится для INPX, файл пропал)
async function build(source, dataDir, onLog = () => {}) {
    const libDir = source.libDir;
    const scanDir = path.join(dataDir, 'scan');
    const inpxFile = source.inpxFile || source.inpx || path.join(scanDir, `${source.id}.inpx`);
    const cacheFile = path.join(scanDir, `${source.id}.json`);
    const cacheText = await fs.readFile(cacheFile, 'utf8').catch(() => '');
    let cache;
    try {
        cache = JSON.parse(cacheText) || {};
    } catch (e) {
        cache = {};
    }
    const known = (cache.version === cacheVersion && cache.libDir === libDir && cache.files) || {};

    const found = new Map();
    let skipped = 0;
    let parsed = 0;
    let lastProgress = Date.now();
    for await (const relPath of walkBooks(libDir)) {
        if (Date.now() - lastProgress >= progressInterval) {
            lastProgress = Date.now();
            onLog('info', `Folder scan ${source.id}: ${found.size} files`);
        }
        //имя с переводом строки или разделителем полей строкой INPX не записать
        if (/[\x00-\x1f]/.test(relPath) || !libraryFs.isSafeRelativePath(relPath)) {// eslint-disable-line no-control-regex
            skipped++;
            continue;
        }
        let stat;
        try {
            stat = await libraryFs.stat(libraryFs.join(libDir, ...relPath.split('/')));
        } catch (e) {
            skipped++;
            continue;
        }
        const old = known[relPath];
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) {
            found.set(relPath, old);
            continue;
        }
        found.set(relPath, {size: stat.size, mtimeMs: stat.mtimeMs, line: await bookLine(source, relPath, stat, onLog)});
        parsed++;
    }

    //порядок строк и записей кеша - по пути: тот же набор файлов даёт те же байты
    const files = {};
    for (const relPath of [...found.keys()].sort())
        files[relPath] = found.get(relPath);
    const inp = Object.values(files).map(item => `${item.line}\n`).join('');
    const collection = `${source.name || source.id}\ninpx-shelf scan\n`;
    const digest = crypto.createHash('sha256').update(`${collection}\0${inp}`).digest('hex');

    const changed = !(cache.digest === digest && await fs.pathExists(inpxFile));
    if (changed) {
        const version = new Date().toISOString().substring(0, 10).replace(/-/g, '');
        await writeFileAtomic(inpxFile, await zipBuffer([
            ['collection.info', collection],
            ['structure.info', structure],
            ['version.info', version],
            [`${source.id}.inp`, inp],
        ]));
    }
    const newCacheText = JSON.stringify({version: cacheVersion, libDir, digest, files});
    if (newCacheText !== cacheText)
        await writeFileAtomic(cacheFile, newCacheText);

    return {changed, books: found.size, skipped, parsed};
}

//Синхронизация всех включённых папок - там же, где RemoteLib.syncAll. Поток создаётся на одну синхронизацию
//и закрывается после неё; синхронизации идут по одной. Ошибка папки только в журнал: остаётся её прежний INPX
class FolderScan {
    constructor(config) {
        this.config = config;
        this.queue = Promise.resolve();
    }

    syncAll() {
        const run = this.queue.then(() => this.syncAllOnce());
        this.queue = run.catch(() => {});
        return run;
    }

    async syncAllOnce() {
        const sources = (this.config.librarySources || []).filter(item => item && item.scan && item.enabled !== false);
        if (!sources.length)
            return;

        let thread = null;
        try {
            thread = new FolderScanThread();
            thread.onLog = (level, text) => log((level === 'warn' ? LM_WARN : LM_INFO), text);
            for (const source of sources) {
                try {
                    const result = await thread.call('build', source, this.config.dataDir);
                    if (result.changed)
                        log(`Folder scan ${source.id}: INPX updated, ${result.books} books`);
                } catch (e) {
                    log(LM_ERR, `Folder scan ${source.id}: ${e.message}`);
                }
            }
        } catch (e) {
            log(LM_ERR, `Folder scan: ${e.message}`);
        } finally {
            if (thread)
                await thread.terminate();
        }
    }
}

FolderScan.build = build;

module.exports = FolderScan;
