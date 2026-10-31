const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const FolderScan = require('../server/core/scan/FolderScan');
const FolderScanThread = require('../server/core/scan/FolderScanThread');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');
const day = name => new Date(`${name}T12:00:00Z`);

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-folder-scan-'));
    try {
        return await task(dir);
    } finally {
        await fs.remove(dir);
    }
}

async function zipBuffer(entries) {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(entries))
        zip.addBuffer(Buffer.from(data), name, {compress: name !== 'mimetype'});
    zip.end();
    const chunks = [];
    for await (const chunk of zip.outputStream)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}

function fb2(titleInfo, body = '<body><section><p>Текст</p></section></body>') {
    return '<?xml version="1.0" encoding="utf-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">'
        + `<description><title-info>${titleInfo}</title-info></description>${body}</FictionBook>`;
}

function epub(metadata) {
    return zipBuffer({
        mimetype: 'application/epub+zip',
        'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>'
            + '<rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/book.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            + `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">${metadata}</metadata>`
            + '<manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
        'OEBPS/c.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text</p></body></html>',
    });
}

//Папка книг: fb2 с описанием и обложкой и epub с тем же именем в корне, fb2 без описания и epub 3 во вложенных папках;
//скрытые файлы и папки, covers в корне и не книги пропускаются
async function writeFixture(libDir) {
    const files = {
        'x.fb2': fb2('<genre>sf_space</genre><genre>adventure</genre>'
            + '<author><first-name>Иван</first-name><middle-name>Иванович</middle-name><last-name>Иванов</last-name></author>'
            + '<author><nickname>Петров, Пётр</nickname></author><book-title>Звёздный путь &amp; Co</book-title>'
            + '<keywords>космос, путешествия</keywords><lang>ru</lang><sequence name="Космос" number="2"/>'
            + '<coverpage><image l:href="#cover.png"/></coverpage>',
        `<body><section><p>Текст</p></section></body><binary id="cover.png" content-type="image/png">${png.toString('base64')}</binary>`),
        'x.epub': await epub('<dc:title>Звёздный путь</dc:title><dc:creator opf:role="aut">Иван Иванов</dc:creator><dc:language>ru</dc:language>'
            + '<dc:subject>space</dc:subject><dc:subject>travel</dc:subject>'
            + '<meta name="calibre:series" content="Космос"/><meta name="calibre:series_index" content="2.0"/>'),
        'sub/broken.fb2': '<?xml version="1.0" encoding="utf-8"?><FictionBook><body><p>no description</p></body></FictionBook>',
        'sub/deeper/e3.epub': await epub('<dc:title>Third</dc:title><dc:creator>Jane Doe</dc:creator><dc:language>en</dc:language>'
            + '<meta property="belongs-to-collection" id="c1">Saga</meta><meta refines="#c1" property="group-position">3</meta>'),
        '.hidden.fb2': fb2('<book-title>Hidden</book-title>'),
        '.git/y.fb2': fb2('<book-title>Hidden dir</book-title>'),
        'covers/c.fb2': fb2('<book-title>Asset dir</book-title>'),
        'notes.txt': 'not a book',
    };
    for (const [name, data] of Object.entries(files)) {
        const file = path.join(libDir, name);
        await fs.outputFile(file, data);
        await fs.utimes(file, day('2024-05-06'), day('2024-05-06'));
    }
    return files;
}

const libid = relPath => String(parseInt(crypto.createHash('sha1').update(relPath).digest('hex').substring(0, 12), 16));
const size = (files, name) => String(Buffer.byteLength(files[name]));

function expectedLines(files, dates = {}) {
    const date = name => dates[name] || '2024-05-06';
    return [
        ['', '', 'broken', '', '', 'broken', size(files, 'sub/broken.fb2'), libid('sub/broken'), '0', 'fb2', date('sub/broken.fb2'), '', '0', '', 'sub'],
        ['Jane Doe,,:', '', 'Third', 'Saga', '3', 'e3', size(files, 'sub/deeper/e3.epub'), libid('sub/deeper/e3'), '0', 'epub', date('sub/deeper/e3.epub'), 'en', '0', '', 'sub/deeper'],
        ['Иван Иванов,,:', '', 'Звёздный путь', 'Космос', '2', 'x', size(files, 'x.epub'), libid('x'), '0', 'epub', date('x.epub'), 'ru', '0', 'space,travel', '.'],
        ['Иванов,Иван,Иванович:Петров Пётр,,:', 'sf_space:adventure:', 'Звёздный путь & Co', 'Космос', '2', 'x', size(files, 'x.fb2'), libid('x'), '0', 'fb2',
            date('x.fb2'), 'ru', '0', 'космос, путешествия', '.'],
    ].map(fields => `${fields.join('\x04')}\x04`);
}

async function readInpx(file, id) {
    const ZipReader = require('../server/core/ZipReader');
    const reader = new ZipReader();
    await reader.open(file);
    try {
        const text = async name => (await reader.extractToBuf(name)).toString('utf8');
        return {inp: await text(`${id}.inp`), structure: await text('structure.info'), collection: await text('collection.info')};
    } finally {
        await reader.close();
    }
}

async function fileState(file) {
    const stat = await fs.stat(file);
    return [stat.ino, stat.mtimeMs, (await fs.readFile(file)).toString('base64')];
}

//Генератор: строки INPX по файлам (детерминированно), общий libid у x.fb2 и x.epub; без изменений ничего не пишется,
//изменённый файл разбирается заново один, удалённый пропадает из INPX
async function testFolderScanBuildsInpx() {
    await temporary(async(dir) => {
        const libDir = path.join(dir, 'books');
        const dataDir = path.join(dir, 'data');
        const files = await writeFixture(libDir);
        const source = {id: 'books', name: 'My books', libDir, inpxFile: path.join(dataDir, 'scan', 'books.inpx')};
        const logs = [];
        const build = () => FolderScan.build(source, dataDir, (level, text) => logs.push([level, text]));

        assert.deepStrictEqual(await build(), {changed: true, books: 4, skipped: 0, parsed: 4});
        const inpx = await readInpx(source.inpxFile, 'books');
        assert.strictEqual(inpx.inp, expectedLines(files).map(line => `${line}\n`).join(''));
        assert.strictEqual(inpx.structure, 'AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER');
        assert.strictEqual(inpx.collection, 'My books\ninpx-shelf scan\n');
        assert.deepStrictEqual(logs, [['warn', 'Folder scan books: no metadata in sub/broken.fb2, listed under its file name']]);

        //записи, как их читает сборка каталога
        const InpxParser = require('../server/core/InpxParser');
        const records = [];
        await new InpxParser().parse(source.inpxFile, null, async chunk => records.push(...chunk));
        assert.deepStrictEqual(records.map(rec => [rec.folder, rec.file, rec.ext, rec.author, rec.genre, rec.serno]), [
            ['sub', 'broken', 'fb2', '', '', 0],
            ['sub/deeper', 'e3', 'epub', 'Jane Doe', '', 3],
            ['.', 'x', 'epub', 'Иван Иванов', '', 2],
            ['.', 'x', 'fb2', 'Иванов Иван Иванович,Петров Пётр', 'sf_space,adventure', 2],
        ]);
        assert.strictEqual(records[2].libid, records[3].libid, 'one book in two formats');

        const cacheFile = path.join(dataDir, 'scan', 'books.json');
        const before = [await fileState(source.inpxFile), await fileState(cacheFile)];
        logs.length = 0;
        assert.deepStrictEqual(await build(), {changed: false, books: 4, skipped: 0, parsed: 0});
        assert.deepStrictEqual([await fileState(source.inpxFile), await fileState(cacheFile)], before, 'nothing is written');
        assert.deepStrictEqual(logs, [], 'cached lines are not parsed again');

        await fs.utimes(path.join(libDir, 'x.epub'), day('2024-05-07'), day('2024-05-07'));
        assert.deepStrictEqual(await build(), {changed: true, books: 4, skipped: 0, parsed: 1});
        assert.strictEqual((await readInpx(source.inpxFile, 'books')).inp,
            expectedLines(files, {'x.epub': '2024-05-07'}).map(line => `${line}\n`).join(''));

        await fs.remove(path.join(libDir, 'sub', 'broken.fb2'));
        assert.deepStrictEqual(await build(), {changed: true, books: 3, skipped: 0, parsed: 0});
        assert.strictEqual((await readInpx(source.inpxFile, 'books')).inp,
            expectedLines(files, {'x.epub': '2024-05-07'}).slice(1).map(line => `${line}\n`).join(''));
    });
}

//Через настоящий поток: ход и предупреждения приходят строками журнала; syncAll не падает на недоступной папке,
//её прежний INPX остаётся, поток после синхронизации закрыт
async function testFolderScanThreadAndSyncAll() {
    await temporary(async(dir) => {
        const libDir = path.join(dir, 'books');
        const dataDir = path.join(dir, 'data');
        const files = await writeFixture(libDir);
        const source = {id: 'books', name: 'My books', libDir, inpxFile: path.join(dataDir, 'scan', 'books.inpx'), scan: true, enabled: true};

        const thread = new FolderScanThread();
        const logs = [];
        thread.onLog = (level, text) => logs.push([level, text]);
        try {
            assert.deepStrictEqual(await thread.call('build', source, dataDir), {changed: true, books: 4, skipped: 0, parsed: 4});
            assert.deepStrictEqual(logs.map(item => item[0]), ['warn']);
            await assert.rejects(thread.call('remove', source), /Action not found/);
        } finally {
            await thread.terminate();
        }
        assert.strictEqual((await readInpx(source.inpxFile, 'books')).inp, expectedLines(files).map(line => `${line}\n`).join(''));

        const terminate = FolderScanThread.prototype.terminate;
        let threads = 0;
        FolderScanThread.prototype.terminate = function() {
            threads++;
            return terminate.call(this);
        };
        try {
            const before = await fileState(source.inpxFile);
            const missing = Object.assign({}, source, {id: 'gone', libDir: path.join(dir, 'missing'), inpxFile: path.join(dataDir, 'scan', 'gone.inpx')});
            const config = {dataDir, librarySources: [missing, source, Object.assign({}, source, {id: 'off', enabled: false}), {id: 'inpx', inpx: 'x.inpx'}]};
            const scan = new FolderScan(config);
            await Promise.all([scan.syncAll(), scan.syncAll()]);
            assert.strictEqual(threads, 2, 'one thread per sync, closed after it');
            assert.deepStrictEqual(await fileState(source.inpxFile), before);
            assert.strictEqual(await fs.pathExists(missing.inpxFile), false);
            assert.strictEqual(await fs.pathExists(path.join(dataDir, 'scan', 'off.inpx')), false, 'a disabled folder is not scanned');

            await new FolderScan({dataDir, librarySources: [{id: 'inpx', inpx: 'x.inpx'}]}).syncAll();
            assert.strictEqual(threads, 2, 'no thread without folder sources');
        } finally {
            FolderScanThread.prototype.terminate = terminate;
        }
    });
}

//Библиотека из папки целиком: первая загрузка строит INPX и каталог, книга находится, скачивается, отдаёт обложку;
//новый файл подхватывают шаги периодической проверки INPX
async function testFolderScanLibraryEndToEnd() {
    await temporary(async(dir) => {
        const WebWorker = require('../server/core/WebWorker');
        const RemoteLib = require('../server/core/RemoteLib');
        const InpxHashCreator = require('../server/core/InpxHashCreator');
        const CatalogSearch = require('../server/core/search/CatalogSearch');
        const Fb2Helper = require('../server/core/fb2/Fb2Helper');
        const libraryFs = require('../server/core/LibraryFs');
        const {resolveLibrarySources} = require('../server/core/LibrarySources');

        const libDir = path.join(dir, 'books');
        const dataDir = path.join(dir, 'data');
        const tempDir = path.join(dir, 'tmp');
        const files = await writeFixture(libDir);
        await fs.ensureDir(tempDir);
        const config = {dataDir, tempDir, dbVersion: 'test', inpxFilterFile: path.join(dataDir, 'filter.json'),
            librarySources: [{id: 'books', name: 'My books', scan: true, libDir}]};
        await resolveLibrarySources(config);
        assert.strictEqual(config.libDir, libDir);

        const worker = Object.assign(Object.create(WebWorker.prototype), {
            config,
            remoteLib: new RemoteLib(config),
            folderScan: new FolderScan(config),
            inpxHashCreator: new InpxHashCreator(config),
            readingListStore: {getMetadataOverrides: async() => ({})},
            fb2Helper: new Fb2Helper(),
            logServerStats: () => {},
            trySyncListedBooks: async() => {},
        });
        worker.resetLibraryAssetCaches();
        worker.catalogSearch = new CatalogSearch(config, worker);
        try {
            await worker.loadOrCreateDbOnce();
            const {books} = await worker.catalogSearch.search({q: 'путь'});
            assert.deepStrictEqual(books.map(book => book.ext).sort(), ['epub', 'fb2']);
            const book = books.find(item => item.ext === 'fb2');
            assert.strictEqual(book.title, 'Звёздный путь & Co');

            const file = await worker.extractBook(book.folder, `${book.file}.${book.ext}`, worker.bookLibDir(book));
            assert.strictEqual(await fs.readFile(file, 'utf8'), files['x.fb2']);
            await fs.remove(file);
            const cover = await worker.getBookCover(book);
            assert.strictEqual(cover.contentType, 'image/png');
            assert.ok(cover.data.equals(png));
            const [nested] = (await worker.catalogSearch.search({q: 'third'})).books;
            const nestedFile = await worker.extractBook(nested.folder, `${nested.file}.${nested.ext}`, worker.bookLibDir(nested));
            assert.ok((await fs.readFile(nestedFile)).equals(files['sub/deeper/e3.epub']));
            await fs.remove(nestedFile);

            await fs.outputFile(path.join(libDir, 'sub', 'new.fb2'), fb2('<book-title>Новая книга</book-title>'));
            //шаги periodicCheckInpx
            await worker.remoteLib.syncAll();
            libraryFs.clearCache();
            await worker.folderScan.syncAll();
            const newHash = await worker.inpxHashCreator.getHash();
            assert.notStrictEqual(newHash, String((await worker.dbConfig()).buildHash || ''));
            await worker.recreateDb();
            assert.strictEqual(String((await worker.dbConfig()).buildHash || ''), newHash);
            assert.deepStrictEqual((await worker.catalogSearch.search({q: 'новая'})).books.map(item => [item.title, item.folder]), [['Новая книга', 'sub']]);
        } finally {
            await worker.catalogSearch.close();
        }
    });
}

//Настройки: слово scan в строке источников (переменная окружения, --library-sources), JSON, нормализация и диагностика;
//выключенная папка, которой нет на диске, не мешает запуску; включённая - ошибка, как у обычной библиотеки
async function testFolderScanSourceConfig() {
    await temporary(async(dir) => {
        const {parseSourcesFromString, resolveLibrarySources, getAllLibrarySources, getIndexedLibrarySources} = require('../server/core/LibrarySources');
        assert.deepStrictEqual(parseSourcesFromString('My books|scan|/library/books'), [{name: 'My books', libDir: '/library/books', scan: true}]);
        assert.deepStrictEqual(parseSourcesFromString('books|My books|SCAN|/library/books;main|Main|/lib/a.inpx|/lib'), [
            {id: 'books', name: 'My books', libDir: '/library/books', scan: true},
            {id: 'main', name: 'Main', libDir: '/lib', inpx: '/lib/a.inpx'},
        ]);
        assert.deepStrictEqual(parseSourcesFromString('{"scan": true, "libDir": "/library/books"}'), [{scan: true, libDir: '/library/books'}]);

        const libDir = path.join(dir, 'books');
        const dataDir = path.join(dir, 'data');
        await fs.ensureDir(libDir);
        await fs.outputFile(path.join(libDir, 'a', 'b.fb2'), 'x');
        await fs.outputFile(path.join(libDir, 'c.epub'), 'x');
        await fs.outputFile(path.join(libDir, 'd.zip'), 'x');
        const env = process.env.INPX_LIBRARY_SOURCES;
        let config;
        try {
            //переменная окружения важнее config.json; включённая папка, которой нет на диске, - ошибка
            process.env.INPX_LIBRARY_SOURCES = `books|My books|scan|${libDir};gone|Gone|scan|${path.join(dir, 'missing')}`;
            await assert.rejects(resolveLibrarySources({dataDir, librarySources: []}), /missing.*not exists/);
            process.env.INPX_LIBRARY_SOURCES = `books|My books|scan|${libDir}`;
            config = {dataDir, librarySources: [{id: 'other', inpx: 'ignored.inpx'}]};
            await resolveLibrarySources(config);
        } finally {
            if (env === undefined)
                delete process.env.INPX_LIBRARY_SOURCES;
            else
                process.env.INPX_LIBRARY_SOURCES = env;
        }
        const inpx = path.join(dataDir, 'scan', 'books.inpx');
        assert.deepStrictEqual(config.librarySources, [{id: 'books', name: 'My books', inpx, inpxFile: inpx, libDir, enabled: true, scan: true}]);
        assert.ok(await fs.pathExists(path.join(dataDir, 'scan')), 'the folder of generated INPX files');

        //выключенная папка без каталога на диске - как выключенная обычная библиотека
        config = {dataDir, librarySources: [{name: 'Books', scan: true, libDir}, {id: 'off', scan: true, libDir: path.join(dir, 'missing'), enabled: false}]};
        await resolveLibrarySources(config, {});
        assert.deepStrictEqual(config.librarySources.map(item => [item.id, item.enabled, item.scan, item.inpxFile]),
            [['books', true, true, inpx], ['off', false, true, path.join(dataDir, 'scan', 'off.inpx')]]);
        assert.deepStrictEqual(getAllLibrarySources(config).map(item => item.scan), [true, true]);
        assert.deepStrictEqual(await getIndexedLibrarySources(config), [], 'no generated INPX yet - not indexed');
        await fs.writeFile(inpx, 'x');
        assert.deepStrictEqual((await getIndexedLibrarySources(config)).map(item => item.id), ['books']);
        await assert.rejects(resolveLibrarySources({dataDir, librarySources: [{scan: true, libDir: path.join(dir, 'missing')}]}), /not exists/);
        await resolveLibrarySources(config, {'library-sources': `cli|CLI|scan|${libDir}`});
        assert.deepStrictEqual(config.librarySources.map(item => [item.id, item.scan, item.libDir]), [['cli', true, libDir]]);

        //админка: строка папки без INPX, диагностика и строка панели
        const WebWorker = require('../server/core/WebWorker');
        const worker = Object.assign(Object.create(WebWorker.prototype), {config: {dataDir, librarySources: []}});
        assert.deepStrictEqual(worker.normalizeAdminLibrarySources([{id: 'books', name: 'My books', libDir, scan: true, enabled: true}, {scan: true, name: 'Empty'}]),
            [{id: 'books', name: 'My books', inpx, inpxFile: inpx, libDir, enabled: true, scan: true}]);
        assert.deepStrictEqual(await worker.getLibrarySourceDiagnostics({id: 'books', libDir, scan: true}),
            {libDirExists: true, bookFileCount: 2, bookFileCountTruncated: false, inpxExists: true});
        assert.deepStrictEqual(await worker.getLibrarySourceDiagnostics({id: 'other', libDir: path.join(dir, 'missing'), scan: true}),
            {libDirExists: false, bookFileCount: 0, bookFileCountTruncated: false, inpxExists: false});
        assert.deepStrictEqual(await worker.countArchives(libDir, 1, ['.fb2', '.epub']), {count: 1, truncated: true});
    });
}

//Расширение в INPX строчное, на диске - BOOK.FB2: файл находится без учёта регистра
async function testFolderScanUpperCaseExtension() {
    await temporary(async(dir) => {
        const libDir = path.join(dir, 'books');
        await fs.outputFile(path.join(libDir, 'Upper.FB2'), fb2('<book-title>Upper case</book-title><lang>en</lang>'));
        const source = {id: 'books', name: 'Books', libDir, inpxFile: path.join(dir, 'scan', 'books.inpx')};
        await FolderScan.build(source, dir);
        const InpxParser = require('../server/core/InpxParser');
        const records = [];
        await new InpxParser().parse(source.inpxFile, null, async chunk => records.push(...chunk));
        assert.deepStrictEqual(records.map(rec => [rec.title, rec.folder, rec.file, rec.ext]), [['Upper case', '.', 'Upper', 'fb2']]);
        const worker = Object.assign({config: {libDir, tempDir: dir, librarySources: []}}, require('../server/core/LibraryAssets'));
        const file = await worker.extractBook(records[0].folder, `${records[0].file}.${records[0].ext}`, libDir);
        assert.strictEqual(await fs.readFile(file, 'utf8'), await fs.readFile(path.join(libDir, 'Upper.FB2'), 'utf8'));
        await assert.rejects(worker.extractBook(records[0].folder, 'missing.fb2', libDir));
    });
}

module.exports = [
    testFolderScanBuildsInpx,
    testFolderScanUpperCaseExtension,
    testFolderScanThreadAndSyncAll,
    testFolderScanLibraryEndToEnd,
    testFolderScanSourceConfig,
];
