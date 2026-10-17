//Архивы из S3 через 7-Zip: отдельный процесс, потому что потоки архивов получают переменные окружения
//(адрес S3) при создании. S3 - HTTP-сервер в этом же процессе: HEAD и GET с Range из временного каталога.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const {sevenZipArchive} = require('./seven-zip-fixture');

function writeZip(file, entries) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        for (const [name, data] of Object.entries(entries))
            zip.addBuffer(Buffer.from(data), name);
        zip.end();
        zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

const xmlEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

//ListObjectsV2 с Delimiter=/: одна страница, для тестовых каталогов хватает
async function listXml(root, bucket, params) {
    const prefix = params.get('prefix') || '';
    const dir = path.join(root, bucket, prefix);
    //как S3: префикс-файл (archive.7z/) - пустой листинг; Windows не замечает / в конце, поэтому stat
    const isDir = await fs.stat(dir).then(stat => stat.isDirectory(), () => false);
    const items = (isDir && (!prefix || prefix.endsWith('/'))) ? await fs.readdir(dir, {withFileTypes: true}) : [];
    const contents = [];
    const prefixes = [];
    for (const item of items) {
        if (item.isDirectory()) {
            prefixes.push(`<CommonPrefixes><Prefix>${xmlEscape(prefix + item.name)}/</Prefix></CommonPrefixes>`);
        } else {
            const stat = await fs.stat(path.join(dir, item.name));
            contents.push(`<Contents><Key>${xmlEscape(prefix + item.name)}</Key><Size>${stat.size}</Size>`
                + `<LastModified>${stat.mtime.toISOString()}</LastModified><ETag>"${stat.size}-${stat.mtimeMs}"</ETag></Contents>`);
        }
    }
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>`
        + `<KeyCount>${contents.length + prefixes.length}</KeyCount><IsTruncated>false</IsTruncated>${contents.join('')}${prefixes.join('')}</ListBucketResult>`;
}

function startS3(root) {
    const requests = [];
    const server = http.createServer(async(req, res) => {
        const key = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
        requests.push(`${req.method} ${key} ${req.headers.range || ''}`.trim());
        const file = path.join(root, key);
        if (req.method === 'GET' && new URL(req.url, 'http://x').searchParams.get('list-type') === '2') {
            res.writeHead(200, {'Content-Type': 'application/xml'});
            res.end(await listXml(root, key, new URL(req.url, 'http://x').searchParams));
            return;
        }
        //подпись читается, а блоки внутри 7-Zip - нет
        if (key.endsWith('broken.zip') && req.method === 'GET' && req.headers.range !== 'bytes=0-5') {
            res.writeHead(500, {'Content-Type': 'application/xml'});
            res.end('<Error><Code>InternalError</Code><Message>boom</Message></Error>');
            return;
        }
        if (!key.includes('/') || !await fs.pathExists(file)) {
            res.writeHead(404, {'Content-Type': 'application/xml'});
            res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>no</Message></Error>');
            return;
        }
        const data = await fs.readFile(file);
        const headers = {'ETag': `"${crypto.createHash('md5').update(data).digest('hex')}"`, 'Last-Modified': new Date().toUTCString(), 'Accept-Ranges': 'bytes'};
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (range) {
            const start = Number(range[1]);
            const end = Math.min(Number(range[2]), data.length - 1);
            const part = data.subarray(start, end + 1);
            res.writeHead(206, Object.assign(headers, {'Content-Length': part.length, 'Content-Range': `bytes ${start}-${end}/${data.length}`}));
            res.end(part);
            return;
        }
        res.writeHead(200, Object.assign(headers, {'Content-Length': data.length}));
        res.end(req.method === 'HEAD' ? undefined : data);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, requests})));
}

function randomText(seed, size) {
    let text = '';
    let n = seed;
    while (text.length < size) {
        n = (n*1103515245 + 12345) % 2147483648;
        text += `${n.toString(36)} `;
    }
    return text.substring(0, size);
}

(async() => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-archive-'));
    const {server, requests} = await startS3(dir);
    process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${server.address().port}`;
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    require('../server/core/Logger');
    await new (require('../server/core/AppLogger'))().init({loggingEnabled: false, name: 's3-archive-tests'});
    const ZipReader = require('../server/core/ZipReader');
    const {blockSize} = require('../server/core/archive/S3File');
    try {
        //книги крупнее блока: запись читается из нескольких блоков одним запросом
        const books = {};
        for (let i = 1; i <= 40; i++)
            books[`${i}.fb2`] = randomText(i, 30*1024 + i*1000);
        books['big.fb2'] = randomText(999, 3*blockSize);
        await fs.ensureDir(path.join(dir, 'lib/flibusta'));
        await writeZip(path.join(dir, 'lib/flibusta/fb2-000001.zip'), books);
        await sevenZipArchive(path.join(dir, 'lib/solid/fb2-000002.7z'), books, ['-t7z', '-ms=on']);
        await fs.copy(path.join(dir, 'lib/flibusta/fb2-000001.zip'), path.join(dir, 'lib/flibusta/broken.zip'));

        const zip = new ZipReader();
        await zip.open('s3://lib/flibusta/fb2-000001.zip');
        assert.strictEqual(Object.keys(zip.entries).length, 41);
        assert.strictEqual(zip.archiveType, 'zip');
        assert.strictEqual((await zip.extractToBuf('7.fb2')).toString(), books['7.fb2']);
        assert.strictEqual((await zip.extractToBuf('big.fb2')).toString(), books['big.fb2']);

        //повторное чтение: только HEAD, блоки из кеша
        const before = requests.length;
        assert.strictEqual((await zip.extractToBuf('7.fb2')).toString(), books['7.fb2']);
        assert.deepStrictEqual(requests.slice(before).map(r => r.split(' ')[0]), ['HEAD']);

        const out = path.join(dir, 'out.fb2');
        await zip.extractToFile('12.fb2', out);
        assert.strictEqual(await fs.readFile(out, 'utf8'), books['12.fb2']);
        await assert.rejects(zip.extractToBuf('nope.fb2'), /Entry not found/);
        await zip.close();

        //solid 7z
        const solid = new ZipReader();
        await solid.open('s3://lib/solid/fb2-000002.7z');
        assert.strictEqual(solid.archiveType, '7z');
        assert.strictEqual((await solid.extractToBuf('33.fb2')).toString(), books['33.fb2']);
        await solid.close();

        //нет объекта - ENOENT в тексте, как у файла (по нему WebWorker отвечает 404)
        await assert.rejects(new ZipReader().open('s3://lib/flibusta/missing.zip'), /ENOENT: not found in S3: s3:\/\/lib\/flibusta\/missing\.zip/);
        //ошибка S3 посреди чтения доходит до вызывающего, а не «архив повреждён»
        await assert.rejects(new ZipReader().open('s3://lib/flibusta/broken.zip'), /S3: s3:\/\/lib\/flibusta\/broken\.zip: InternalError/);

        //импорт INPX прямо из S3
        const row = ['Булгаков,Михаил,Афанасьевич:', 'prose_classic:', 'Мастер и Маргарита', '', '', '7', '1000', '7', '0', 'fb2', '2020-01-01', 'ru', '', ''].join('\x04');
        await fs.ensureDir(path.join(dir, 'lib/inpx'));
        await writeZip(path.join(dir, 'lib/inpx/lib.inpx'), {'collection.info': 'Test', 'fb2-000001.inp': `${row}\r\n`});
        const InpxParser = require('../server/core/InpxParser');
        const parsed = [];
        await new InpxParser().parse('s3://lib/inpx/lib.inpx', null, async(chunk) => { parsed.push(...chunk); });
        assert.deepStrictEqual(parsed.map(book => [book.title, book.folder]), [['Мастер и Маргарита', 'fb2-000001.zip']]);

        //Библиотека fLibrary в S3: книга в books/ под другим расширением, обложка в covers/, отзывы в etc/reviews,
        //проверка источника в администрировании
        const libDir = 's3://lib/flib';
        const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
        await sevenZipArchive(path.join(dir, 'lib/flib/books/fb2-000010.7z'), {'10.fb2': books['10.fb2']});
        await fs.ensureDir(path.join(dir, 'lib/flib/covers'));
        await writeZip(path.join(dir, 'lib/flib/covers/fb2-000010.zip'), {'10': png});
        await fs.ensureDir(path.join(dir, 'lib/flib/etc/reviews'));
        await writeZip(path.join(dir, 'lib/flib/etc/reviews/2026.zip'),
            {'fb2-000010.zip#10.fb2': JSON.stringify([{name: 'reader', time: '2026-01-01', text: 'good'}])});
        await writeZip(path.join(dir, 'lib/flib/flib.inpx'), {'collection.info': 'Test'});

        const tempDir = path.join(dir, 'tmp');
        await fs.ensureDir(tempDir);
        const worker = Object.assign({config: {libDir, tempDir, librarySources: []}},
            require('../server/core/LibraryAssets'), require('../server/core/AdminService'));
        const extracted = await worker.extractBook('fb2-000010.zip', '10.fb2', libDir);
        assert.strictEqual(await fs.readFile(extracted, 'utf8'), books['10.fb2']);
        await fs.remove(extracted);
        const cover = await worker.getFblibraryCover(10, libDir, 'fb2-000010.zip');
        assert.ok(cover && cover.data.equals(png), 'cover from covers/');
        const book = {folder: 'fb2-000010.zip', file: '10', ext: 'fb2', sourceLibDir: libDir};
        assert.deepStrictEqual(await worker.getBookReviews(book), [{name: 'reader', time: '2026-01-01', text: 'good'}]);
        const diagnostics = await worker.getLibrarySourceDiagnostics({libDir, inpx: `${libDir}/flib.inpx`});
        assert.deepStrictEqual(Object.assign({}, diagnostics, {foundInpx: diagnostics.foundInpx.length}), {
            inpxExists: true, libDirExists: true, foundInpx: 1, archiveCount: 3, archiveCountTruncated: false,
            hasCovers: true, hasEtc: true, hasImages: false,
        });
        await assert.rejects(worker.extractBook('fb2-999999.zip', '1.fb2', libDir), /ENOENT|archive not found/);

        console.log('s3-archive-tests: ok');
    } finally {
        server.close();
        await fs.remove(dir);
    }
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
