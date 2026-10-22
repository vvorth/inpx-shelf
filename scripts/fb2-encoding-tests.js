const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const iconv = require('iconv-lite');
const Fb2Helper = require('../server/core/fb2/Fb2Helper');
const Fb2Parser = require('../server/core/fb2/Fb2Parser');
const ZipReader = require('../server/core/ZipReader');
const utils = require('../server/core/utils');

function document(encoding, title = 'Проверка кодировки', body = 'Русский текст: ёж, съешь ещё этих мягких булок.') {
    return `<?xml version="1.0" encoding="${encoding}"?><FictionBook><description><title-info><genre>sf</genre><author><last-name>Тестов</last-name><first-name>Автор</first-name></author><book-title>${title}</book-title><annotation><p>${body}</p></annotation><lang>ru</lang></title-info></description><body><section><p>${body}</p></section></body></FictionBook>`;
}

async function testFb2XmlEncodingDeclarationsAndByteOrder() {
    const helper = new Fb2Helper();
    for (const encoding of ['windows-1251', 'koi8-r', 'cp866', 'utf-8', 'utf-16le', 'utf-16be']) {
        for (const addBOM of [false, true]) {
            const output = helper.checkEncoding(iconv.encode(document(encoding), encoding, {addBOM}));
            const text = output.toString('utf8');
            assert.ok(text.includes('encoding="utf-8"'), encoding);
            assert.ok(text.includes('Проверка кодировки'), encoding);
            assert.ok(text.includes('Русский текст: ёж'), encoding);
            assert.ok(!text.includes('\uFFFD') && !text.includes('\u0000'), encoding);
            assert.ok(helper.checkEncoding(output).equals(output), 'Normalization must be idempotent');
        }
    }
    const latin = 'Grüße déjà vu — Español';
    const text = document('windows-1252', latin, latin);
    assert.ok(helper.checkEncoding(iconv.encode(text, 'windows-1252')).toString().includes(latin), 'XML encoding must take priority over language heuristics');
    const retainedDeclaration = Buffer.from(document('windows-1251'));
    assert.ok(helper.checkEncoding(retainedDeclaration).toString().includes('Русский текст'), 'UTF-8 bytes with a retained legacy declaration must not be decoded twice');
    const noDeclaration = iconv.encode(document('windows-1251').replace(/^<\?xml.*?\?>/, ''), 'windows-1251');
    assert.ok(helper.checkEncoding(noDeclaration).toString().includes('Русский текст'));
}

async function testFb2DownloadsNormalizeEncodingAndRepairLegacyCache() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-fb2-encoding-'));
    let server;
    try {
        const source = path.join(dir, 'source');
        const bookDir = path.join(dir, 'book');
        const tempDir = path.join(dir, 'tmp');
        await Promise.all([source, bookDir, tempDir].map(value => fs.ensureDir(value)));
        const original = iconv.encode(document('windows-1251'), 'windows-1251');
        await fs.writeFile(path.join(source, '123.fb2'), original);
        const record = {_uid: 'encoding-fixture', author: 'Тестов Автор', title: 'Проверка кодировки', file: '123',
            ext: 'fb2', folder: ''};
        const config = {libDir: source, bookDir, tempDir, publicFilesDir: dir, publicDir: dir, bookPathStatic: '/book', rootPathStatic: ''};
        const worker = Object.create(require('../server/core/WebWorker').prototype);
        worker.config = config; worker.fb2Helper = new Fb2Helper(); worker.checkMyState = () => {}; worker.scheduleCacheClean = () => {};
        worker.getFblibraryImages = async() => []; worker.getFblibraryCover = async() => null;
        let fileHash = {hash: 'old-broken'};
        worker.catalogSearch = {getBooksByUids: async() => [record]};
        worker.stateStore = {getBookFiles: () => [fileHash], putBookFile: (row) => {fileHash = row;}};
        await fs.writeFile(path.join(bookDir, 'old-broken'), await utils.gzipBuffer(Buffer.from('старые кракозябры')));
        await fs.writeJson(path.join(bookDir, 'old-broken.d.json'), {assetVersion: 'fblibrary-assets-v5'});
        const app = require('express')();
        require('../server/static')(app, config, worker);
        server = require('http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(`${base}/book/by-uid?uid=encoding-fixture&format=raw`);
        assert.strictEqual(response.status, 200);
        const raw = Buffer.from(await response.arrayBuffer());
        assert.ok(require('buffer').isUtf8(raw));
        assert.ok(raw.toString().includes('encoding="utf-8"'));
        assert.ok(raw.toString().includes('Русский текст: ёж'));
        assert.notStrictEqual(fileHash.hash, 'old-broken');
        const parser = new Fb2Parser(); parser.fromString(raw.toString(), {lowerCase: true});
        assert.strictEqual(parser.bookInfo().titleInfo.bookTitle, record.title);
        const descriptor = await fs.readJson(path.join(bookDir, `${fileHash.hash}.d.json`));
        assert.strictEqual(descriptor.assetVersion, 'fb2-encoding-v6');
        assert.strictEqual(descriptor.size, raw.length);
        const zip = await fetch(`${base}/book/by-uid?uid=encoding-fixture&zip=1`);
        const file = path.join(dir, 'download.zip'); await fs.writeFile(file, Buffer.from(await zip.arrayBuffer()));
        const reader = new ZipReader();
        try {
            await reader.open(file); const name = Object.values(reader.entries)[0].name;
            assert.ok((await reader.extractToBuf(name)).equals(raw));
        } finally {await reader.close();}
        const prepared = await worker.getPreparedBookFile(record._uid, 'fb2');
        assert.ok((await fs.readFile(prepared.rawFile)).equals(raw));
        assert.ok((await fs.readFile(path.join(source, '123.fb2'))).equals(original), 'The library source must not be modified');
        assert.deepStrictEqual(await fs.readdir(tempDir), []);
        await fs.writeFile(path.join(source, '124.fb2'), iconv.encode(document('unsupported-test-charset'), 'windows-1251'));
        await assert.rejects(worker.restoreBook('unsupported-encoding', '', '124.fb2', '124.fb2', source), /Неподдерживаемая кодировка FB2/);
        assert.deepStrictEqual(await fs.readdir(tempDir), [], 'A failed normalization must not leave an extracted book');
    } finally {
        if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
        await fs.remove(dir);
    }
}

// A <binary> without attributes before the cover must not abort the cover search.
async function testFb2CoverAfterBinaryWithoutAttributes() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-fb2-cover-'));
    try {
        const file = path.join(dir, 'book.fb2');
        await fs.writeFile(file, '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink">'
            + '<description><title-info><coverpage><image l:href="#c.jpg"/></coverpage></title-info></description>'
            + '<body><p>x</p></body><binary>QUFB</binary><binary id="c.jpg" content-type="image/jpeg">QkJC</binary></FictionBook>');
        const result = await new Fb2Helper().getDescAndCover(file);
        assert.ok(result && result.fb2, 'Result must not be undefined');
        assert.strictEqual(result.cover.toString(), 'BBB');
        assert.strictEqual(result.coverExt, '.jpg');
    } finally {
        await fs.remove(dir);
    }
}

// The cover is found without the book tree: custom xlink prefix, last binary with the id wins, png type.
function testFb2CoverWithoutTree() {
    const helper = new Fb2Helper();
    const cover = body => helper.findCover('<?xml version="1.0"?><FictionBook xmlns:xl="http://www.w3.org/1999/xlink">'
        + `<description><title-info><coverpage>\n<image xl:href="#c"/></coverpage></title-info></description>${body}</FictionBook>`);
    let result = cover('<body/><binary id="c" content-type="image/jpeg">QUFB</binary><binary content-type="image/png" id="c">\nQkJC\n</BINARY>');
    assert.strictEqual(result.cover.toString(), 'BBB');
    assert.strictEqual(result.coverExt, '.png');
    result = cover('<binary id="other">QUFB</binary>');
    assert.deepStrictEqual(result, {cover: null, coverExt: ''});
    result = cover('<binary id="c" content-type="image/png"></binary>');
    assert.deepStrictEqual(result, {cover: null, coverExt: '.png'});
    assert.deepStrictEqual(helper.findCover('<FictionBook><description/><binary id="c">QUFB</binary></FictionBook>'), {cover: null, coverExt: ''});
}

// Normalized UTF-8 skips the decode/encode round trip; anything else is still rewritten.
async function testFb2NormalizedUtf8IsReturnedAsIs() {
    const helper = new Fb2Helper();
    const body = '<FictionBook><body><p>Ёж</p></body></FictionBook>';
    for (const text of [`<?xml version="1.0" encoding="utf-8"?>${body}`, body, `<?xml version="1.0"?>${body}`]) {
        const data = Buffer.from(text);
        assert.strictEqual(helper.checkEncoding(data), data, text);
    }
    for (const [input, expected] of [
        [`<?xml version="1.0" encoding="UTF-8"?>${body}`, `<?xml version="1.0" encoding="utf-8"?>${body}`],
        [`<?xml version="1.0" encoding='utf-8'?>${body}`, `<?xml version="1.0" encoding="utf-8"?>${body}`],
        [`\uFEFF  <?xml version="1.0" encoding="utf-8"?>${body}`, `<?xml version="1.0" encoding="utf-8"?>${body}`],
    ])
        assert.strictEqual(helper.checkEncoding(Buffer.from(input)).toString(), expected, input);
}

module.exports = [testFb2NormalizedUtf8IsReturnedAsIs, testFb2CoverAfterBinaryWithoutAttributes, testFb2CoverWithoutTree, testFb2XmlEncodingDeclarationsAndByteOrder, testFb2DownloadsNormalizeEncodingAndRepairLegacyCache];
