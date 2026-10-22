const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {pipeline} = require('stream/promises');
const yazl = require('yazl');
const iconv = require('iconv-lite');
const {sevenZipArchive} = require('./seven-zip-fixture');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=', 'base64');
const review = {name: 'Reader', time: '2026-09-15 12:00:00', text: 'First review'};

async function temporary(task) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-metadata-test-'));
    try { await task(dir); } finally { await fs.remove(dir); }
}

async function archive(file, entries, sevenZip = false) {
    await fs.ensureDir(path.dirname(file));
    if (sevenZip)
        return await sevenZipArchive(file, entries);
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(file));
    for (const [name, value] of Object.entries(entries))
        zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), name);
    zip.end();
    await done;
}

function worker(config) {
    const value = Object.create(require('../server/core/WebWorker').prototype);
    value.config = config;
    value.resetLibraryAssetCaches();
    return value;
}

async function testLibraryReviewsAndRatingsAreOptionalAndSourceScoped() {
    await temporary(async dir => {
        const libDir = path.join(dir, 'first', 'books');
        const otherDir = path.join(dir, 'second', 'books');
        await fs.ensureDir(libDir);
        await fs.ensureDir(otherDir);
        const value = worker({libDir: otherDir, librarySources: [{id: 'first', libDir}, {id: 'second', libDir: otherDir}]});
        const book = {folder: 'f.fb2-887686-891322.zip', file: '887700', ext: 'fb2', sourceId: 'first'};
        assert.deepStrictEqual(await value.getBookReviews(book), []);
        assert.strictEqual(await value.getBookLibraryRating(book), null);
        await archive(path.join(dir, 'first', 'reviews', '202609.7z'), {
            'f.fb2-887686-891322.7z#887700.fb2': JSON.stringify([review]),
        }, true);
        await archive(path.join(libDir, 'reviews', '202610.zip'), {
            'f.fb2-887686-891322.zip#887700.fb2': JSON.stringify([review, {...review, text: 'New<br/>review'}]),
        });
        await archive(path.join(dir, 'first', 'etc', 'reviews', 'additional.zip'), {
            'books.json': JSON.stringify([
                {folder: book.folder, file: '887700.fb2', sum: 13, count: 3},
                {folder: book.folder, file: 'invalid.fb2', sum: 99, count: 1},
            ]),
        });
        await archive(path.join(dir, 'second', 'reviews', '202609.zip'), {
            'f.fb2-887686-891322.zip#887700.fb2': JSON.stringify([{...review, text: 'Other source'}]),
        });
        assert.deepStrictEqual(await value.getBookReviews(book), [review, {...review, text: 'New\nreview'}]);
        assert.deepStrictEqual(await value.getBookLibraryRating(book), {value: 13 / 3, count: 3});
        assert.strictEqual(await value.getBookLibraryRating({...book, file: 'invalid'}), null);
        assert.deepStrictEqual(await value.getBookReviews({...book, sourceId: 'second'}), [{...review, text: 'Other source'}]);
        assert.strictEqual(await value.getBookLibraryRating({...book, sourceId: 'second'}), null);
    });
}

async function testBookInfoRefreshesChangedReviewsWithoutReparsingBook() {
    await temporary(async dir => {
        const config = {libDir: path.join(dir, 'library'), bookDir: path.join(dir, 'cache'), branch: 'test'};
        await fs.ensureDir(config.libDir);
        await fs.ensureDir(config.bookDir);
        const book = {id: 1, _uid: 'fixture', folder: 'collection.zip', file: '12345', ext: 'fb2'};
        let parses = 0;
        const make = () => {
            const value = worker(config);
            value.checkMyState = () => true;
            value.catalogSearch = {getBooksByUids: async() => [book]};
            value.getBookLink = async() => ({link: '/book/hash', downFileName: 'fixture.fb2'});
            value.readingListStore = {getMetadataOverrides: async() => ({})};
            value.fb2Helper = {getDescAndCover: async() => {
                parses++;
                const parser = new (require('../server/core/fb2/Fb2Parser'))();
                parser.fromString('<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description><body><section><p>Text</p></section></body></FictionBook>');
                return {fb2: parser};
            }};
            return value;
        };
        const value = make();
        assert.deepStrictEqual((await value.getBookInfo('fixture')).bookInfo.reviews, []);
        const monthly = path.join(config.libDir, 'reviews', '202609.zip');
        const additional = path.join(config.libDir, 'etc', 'reviews', 'additional.zip');
        await archive(monthly, {'collection.zip#12345.fb2': JSON.stringify([review])});
        await archive(additional, {'books.json': JSON.stringify([{folder: 'collection.zip', file: '12345.fb2', sum: 9, count: 2}])});
        const first = (await value.getBookInfo('fixture')).bookInfo;
        assert.deepStrictEqual(first.reviews, [review]);
        assert.deepStrictEqual(first.libraryRating, {value: 4.5, count: 2});
        const disk = await fs.readJson(path.join(config.bookDir, 'hash.i.json'));
        delete disk.reviewSignature; // Cache written by versions before this fix.
        disk.reviews = [{...review, text: 'Stale cache'}];
        await fs.writeJson(path.join(config.bookDir, 'hash.i.json'), disk);
        assert.deepStrictEqual((await value.getBookInfo('fixture')).bookInfo.reviews, [review]);
        await archive(monthly, {'collection.zip#12345.fb2': JSON.stringify([{...review, text: 'Edited review'}])});
        // Restart with the same disk cache; archive changes must still be detected.
        const restarted = make();
        assert.deepStrictEqual((await restarted.getBookInfo('fixture')).bookInfo.reviews, [{...review, text: 'Edited review'}]);
        await archive(additional, {'books.json': 'not json'});
        assert.strictEqual((await restarted.getBookInfo('fixture')).bookInfo.libraryRating, null);
        await fs.remove(monthly);
        await fs.remove(additional);
        const empty = (await restarted.getBookInfo('fixture')).bookInfo;
        assert.deepStrictEqual(empty.reviews, []);
        assert.strictEqual(empty.libraryRating, null);
        assert.strictEqual(parses, 1, 'Review changes must preserve cached FB2 parsing');
    });
}

// Кеш описания книги (.i.json): без текста книги, испорченный файл пересобирается, первая сборка одна на всех
async function testBookInfoCacheKeepsDescriptionOnlyAndSurvivesTruncation() {
    await temporary(async dir => {
        const config = {libDir: dir, bookDir: path.join(dir, 'book'), publicFilesDir: dir, bookPathStatic: '/book', branch: 'test'};
        await fs.ensureDir(config.bookDir);
        const fb2 = '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description>' +
            '<title-info><book-title>Fixture</book-title><annotation><p>Annotation text</p></annotation>' +
            '<coverpage><image l:href="#cover.png"/></coverpage></title-info></description>' +
            '<body><section><title><p>Chapter one</p></title><p>SECRET BODY TEXT</p></section></body>' +
            `<binary id="cover.png" content-type="image/png">${png.toString('base64')}</binary>` +
            '<binary id="pic.png" content-type="image/png">UElD</binary></FictionBook>';
        await fs.writeFile(path.join(config.bookDir, 'hash'), require('zlib').gzipSync(fb2));
        const book = {id: 1, _uid: 'fixture', folder: 'c.zip', file: '1', ext: 'fb2'};
        const value = worker(config);
        value.checkMyState = () => true;
        value.catalogSearch = {getBooksByUids: async() => [book]};
        value.getBookLink = async() => ({link: '/book/hash', downFileName: 'fixture.fb2'});
        value.readingListStore = {getMetadataOverrides: async() => ({})};
        value.fb2Helper = new (require('../server/core/fb2/Fb2Helper'))();
        let parses = 0;
        const getDescAndCover = value.fb2Helper.getDescAndCover.bind(value.fb2Helper);
        value.fb2Helper.getDescAndCover = async file => { parses++; return getDescAndCover(file); };

        const views = await Promise.all([value.getBookInfo('fixture'), value.getBookInfo('fixture')]);
        assert.strictEqual(parses, 1, 'concurrent first views parse the book once');
        const infoFile = path.join(config.bookDir, 'hash.i.json');
        const disk = await fs.readFile(infoFile, 'utf8');
        assert.ok(!disk.includes('SECRET BODY TEXT'), 'book text is not cached');
        assert.ok(!disk.includes(png.toString('base64')), 'cover binary is served as a file, not cached');
        for (const {bookInfo} of views) {
            assert.deepStrictEqual(bookInfo.contents, [{title: 'Chapter one', level: 0}]);
            assert.strictEqual(bookInfo.cover, '/book/hash.png');
            const parser = new (require('../server/core/fb2/Fb2Parser'))(bookInfo.fb2);
            assert.strictEqual(parser.bookInfo().titleInfo.annotationHtml, '<p>Annotation text</p>');
            assert.deepStrictEqual(parser.$$array('/binary').map(node => node.attrs().id), ['pic.png']);
        }
        assert.ok(await fs.pathExists(path.join(dir, 'book', 'hash.png')));

        await fs.writeFile(infoFile, disk.slice(0, 20));
        const rebuilt = (await value.getBookInfo('fixture')).bookInfo;
        assert.strictEqual(parses, 2, 'a truncated cache file is rebuilt');
        assert.deepStrictEqual(rebuilt.contents, [{title: 'Chapter one', level: 0}]);
        assert.deepStrictEqual(JSON.parse(await fs.readFile(infoFile, 'utf8')).contents, rebuilt.contents);
        assert.deepStrictEqual((await fs.readdir(config.bookDir)).sort(), ['hash', 'hash.i.json', 'hash.png']);
    });
}

// Адрес обложки в .i.json содержит server.root, файл лежит в bookDir: под корнем кеш тоже действует
async function testBookInfoCacheHoldsUnderRootPath() {
    await temporary(async dir => {
        const config = {libDir: dir, bookDir: path.join(dir, 'book'), publicFilesDir: dir, rootPathStatic: '/shelf',
            bookPathStatic: '/shelf/book', branch: 'test'};
        await fs.ensureDir(config.bookDir);
        const fb2 = '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description>' +
            '<title-info><book-title>Fixture</book-title><coverpage><image l:href="#cover.png"/></coverpage></title-info></description>' +
            `<body><section><p>Text</p></section></body><binary id="cover.png" content-type="image/png">${png.toString('base64')}</binary></FictionBook>`;
        await fs.writeFile(path.join(config.bookDir, 'hash'), fb2);
        const book = {id: 1, _uid: 'fixture', folder: 'c.zip', file: '1', ext: 'fb2'};
        const value = worker(config);
        value.checkMyState = () => true;
        value.catalogSearch = {getBooksByUids: async() => [book]};
        value.getBookLink = async() => ({link: '/shelf/book/hash', downFileName: 'fixture.fb2'});
        value.readingListStore = {getMetadataOverrides: async() => ({})};
        value.fb2Helper = new (require('../server/core/fb2/Fb2Helper'))();
        let parses = 0;
        const getDescAndCover = value.fb2Helper.getDescAndCover.bind(value.fb2Helper);
        value.fb2Helper.getDescAndCover = async file => { parses++; return getDescAndCover(file); };

        assert.strictEqual((await value.getBookInfo('fixture')).bookInfo.cover, '/shelf/book/hash.png');
        const infoFile = path.join(config.bookDir, 'hash.i.json');
        const written = await fs.readFile(infoFile, 'utf8');
        assert.strictEqual((await value.getBookInfo('fixture')).bookInfo.cover, '/shelf/book/hash.png');
        assert.strictEqual(parses, 1, 'the second view reads the cache');
        assert.strictEqual(await fs.readFile(infoFile, 'utf8'), written);
        await fs.remove(path.join(config.bookDir, 'hash.png'));
        await value.getBookInfo('fixture');
        assert.strictEqual(parses, 2, 'a missing cover file is restored');
        assert.ok(await fs.pathExists(path.join(config.bookDir, 'hash.png')));
    });
}

// Первые просмотры разных книг разбирают FB2 в главном потоке не все сразу, а в пределах лимита
async function testBookInfoParsesAreLimited() {
    await temporary(async dir => {
        const config = {libDir: dir, bookDir: path.join(dir, 'book'), publicFilesDir: dir, bookPathStatic: '/book', branch: 'test'};
        await fs.ensureDir(config.bookDir);
        const books = {a: {id: 1, _uid: 'a', folder: 'c.zip', file: '1', ext: 'fb2'}, b: {id: 2, _uid: 'b', folder: 'c.zip', file: '2', ext: 'fb2'}};
        const value = worker(config);
        value.checkMyState = () => true;
        value.catalogSearch = {getBooksByUids: async([uid]) => [books[uid]]};
        value.getBookLink = async uid => ({link: `/book/hash-${uid}`, downFileName: `${uid}.fb2`});
        value.readingListStore = {getMetadataOverrides: async() => ({})};
        value.bookInfoParses = require('../server/core/utils').limiter(1);
        const order = [];
        value.fb2Helper = {getDescAndCover: async file => {
            const name = path.basename(file);
            order.push(`start ${name}`);
            await new Promise(resolve => setTimeout(resolve, 20));
            order.push(`end ${name}`);
            const parser = new (require('../server/core/fb2/Fb2Parser'))();
            parser.fromString('<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description></FictionBook>');
            return {fb2: parser};
        }};
        await Promise.all([value.getBookInfo('a'), value.getBookInfo('b')]);
        //по одному: вторая книга начинается после конца первой; какая из них успела первой, не важно
        const [first, second] = (order[0] === 'start hash-a' ? ['hash-a', 'hash-b'] : ['hash-b', 'hash-a']);
        assert.deepStrictEqual(order, [`start ${first}`, `end ${first}`, `start ${second}`, `end ${second}`]);
    });
}

async function testReindexReloadsAuthorAndArchiveCaches() {
    await temporary(async dir => {
        const config = {...require('../server/config/base'), dataDir: path.join(dir, 'data'),
            libDir: path.join(dir, 'library'), inpxFile: path.join(dir, 'library', 'fixture.inpx'),
            bookDir: path.join(dir, 'cache'), publicFilesDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'), inpxFilterFile: path.join(dir, 'absent-filter.json'),
            rootPathStatic: '', bookPathStatic: '/book', publicDir: path.join(dir, 'public'),
            coverDir: path.join(dir, 'covers'), queryCacheEnabled: false};
        await Promise.all([config.dataDir, config.libDir, config.bookDir, config.publicFilesDir, config.tempDir].map(file => fs.ensureDir(file)));
        const row = id => ['Fixture,Author:', 'sf:', `Book ${id}`, '', '0', String(id), '100', String(id), '0', 'fb2', '2026-10-05', 'en', '0', ''].join('\x04');
        const inpx = async(ids) => archive(config.inpxFile, {'collection.info': 'Metadata regression',
            'version.info': '20261005', 'collection.inp': ids.map(row).join('\n') + '\n'});
        await inpx([60000]);
        const name = 'Fixture Author';
        const key = crypto.createHash('md5').update(name.toLowerCase()).digest('hex');
        const authors = path.join(config.libDir, 'etc', 'authors', '202609.zip');
        await archive(authors, {[key]: '<p>Old author biography</p>'});
        await archive(path.join(config.libDir, 'covers', '60000-60000.zip'), {'60000': png});
        const value = worker(config);
        value.setMyState = state => { value.myState = state; };
        value.logServerStats = () => {};
        value.remoteLib = {syncAll: async() => {}};
        value.inpxHashCreator = new (require('../server/core/InpxHashCreator'))(config);
        value.readingListStore = {getMetadataOverrides: async() => ({})};
        value.catalogSearch = new (require('../server/core/search/CatalogSearch'))(config, value);
        value.stateStore = new (require('../server/core/StateStore'))(config);
        try {
            await value.loadOrCreateDb();
            assert.strictEqual(value.myState, 'normal');
            assert.strictEqual((await value.getAuthorInfo(null, name)).authorInfo.text, 'Old author biography');
            assert.strictEqual((await value.getFblibraryArchives('covers', 70000)).length, 0);
            await archive(authors, {[key]: '<p>Updated author biography</p>'});
            await archive(path.join(config.libDir, 'covers', '70000-70000.zip'), {'70000': png});
            await inpx([60000, 70000, 80000]);
            await value.recreateDb();
            assert.strictEqual(value.myState, 'normal');
            assert.strictEqual((await value.dbConfig()).stats.bookCount, 3);
            assert.strictEqual((await value.getAuthorInfo(null, name)).authorInfo.text, 'Updated author biography');
            assert.strictEqual((await value.getFblibraryArchives('covers', 70000)).length, 1);
        } finally {
            await value.closeDb();
        }
    });
}

// Books come out of zips packed with any 7-Zip method (LibFlib uses PPMd) and under cp866 names without the UTF-8 flag;
// a book that cannot be extracted reports the cause, not a generic "not found".
async function testBooksExtractFromPpmdZipsAndCp866Names() {
    await temporary(async dir => {
        const libDir = path.join(dir, 'lib');
        await sevenZipArchive(path.join(libDir, 'lib.flib', 'fb2-104215-113436.zip'), {'111761.fb2': 'ppmd book'}, ['-tzip', '-mm=PPMd']);
        const value = worker({libDir, tempDir: dir});
        const file = await value.extractBook('fb2-104215-113436.zip', '111761.fb2', libDir);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'ppmd book');
        await assert.rejects(value.extractBook('fb2-104215-113436.zip', '1.fb2', libDir), /fb2-104215-113436\.zip: 1\.fb2: Entry not found/);

        // yazl writes a non-ASCII name as UTF-8: write an ASCII placeholder and put the cp866 bytes in its place
        const name = iconv.encode('книга.fb2', 'cp866');
        const placeholder = 'x'.repeat(name.length - 4) + '.fb2';
        await archive(path.join(libDir, 'cp866.zip'), {[placeholder]: 'cp866 book'});
        const bytes = await fs.readFile(path.join(libDir, 'cp866.zip'));
        for (let at = bytes.indexOf(placeholder); at >= 0; at = bytes.indexOf(placeholder, at + 1))
            name.copy(bytes, at);
        await fs.writeFile(path.join(libDir, 'cp866.zip'), bytes);
        assert.strictEqual(await fs.readFile(await value.extractBook('cp866.zip', 'книга.fb2', libDir), 'utf8'), 'cp866 book');
    });
}

module.exports = [testLibraryReviewsAndRatingsAreOptionalAndSourceScoped,
    testBookInfoRefreshesChangedReviewsWithoutReparsingBook, testReindexReloadsAuthorAndArchiveCaches,
    testBooksExtractFromPpmdZipsAndCp866Names, testBookInfoCacheKeepsDescriptionOnlyAndSurvivesTruncation,
    testBookInfoCacheHoldsUnderRootPath, testBookInfoParsesAreLimited];
