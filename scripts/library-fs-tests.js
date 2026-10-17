const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {Readable} = require('stream');

const libraryFs = require('../server/core/LibraryFs');
const {parse, isS3} = require('../server/core/S3Fs');

//S3 в памяти: команды SDK по имени класса, листинг страницами по 2 ключа, чтобы проверить продолжение
function fakeS3(objects) {
    const calls = [];
    const notFound = () => Object.assign(new Error('UnknownError'), {name: 'NotFound', $metadata: {httpStatusCode: 404}});
    const body = buf => Object.assign(Readable.from([buf]), {transformToByteArray: async() => new Uint8Array(buf)});
    const client = {
        calls,
        async send(command) {
            const name = command.constructor.name;
            const input = command.input;
            calls.push(name);
            if (input.Bucket === 'denied')
                throw Object.assign(new Error('Access Denied'), {name: 'AccessDenied', $metadata: {httpStatusCode: 403}});
            const bucket = objects[input.Bucket];
            if (!bucket)
                throw Object.assign(new Error('no bucket'), {name: 'NoSuchBucket', $metadata: {httpStatusCode: 404}});
            if (name === 'ListObjectsV2Command') {
                const prefix = input.Prefix || '';
                const items = new Set();
                for (const key of Object.keys(bucket).sort()) {
                    if (!key.startsWith(prefix))
                        continue;
                    const rest = key.substring(prefix.length);
                    const slash = rest.indexOf('/');
                    items.add(slash >= 0 ? `D${prefix}${rest.substring(0, slash + 1)}` : `F${key}`);
                }
                const all = [...items];
                const start = Number(input.ContinuationToken || 0);
                const page = all.slice(start, start + 2);
                return {
                    CommonPrefixes: page.filter(i => i[0] === 'D').map(i => ({Prefix: i.substring(1)})),
                    Contents: page.filter(i => i[0] === 'F').map(i => ({Key: i.substring(1), Size: bucket[i.substring(1)].length,
                        LastModified: new Date('2026-01-02T03:04:05Z'), ETag: `"${crypto.createHash('md5').update(bucket[i.substring(1)]).digest('hex')}"`})),
                    IsTruncated: start + 2 < all.length,
                    NextContinuationToken: String(start + 2),
                };
            }
            const data = bucket[input.Key];
            if (!data)
                throw notFound();
            if (name === 'HeadObjectCommand')
                return {ContentLength: data.length, ETag: '"etag"'};
            if (name === 'GetObjectCommand') {
                if (!input.Range)
                    return {Body: body(data)};
                const [from, to] = input.Range.replace('bytes=', '').split('-').map(Number);
                if (from >= data.length)
                    throw Object.assign(new Error('range'), {name: 'InvalidRange', $metadata: {httpStatusCode: 416}});
                return {Body: body(data.subarray(from, to + 1))};
            }
            throw new Error(`unexpected ${name}`);
        },
    };
    return client;
}

function useFakeS3(objects) {
    const client = fakeS3(objects);
    libraryFs.s3.client = client;
    libraryFs.clearCache();
    return client;
}

const library = () => ({
    lib: {
        'flibusta/fb2-000001.zip': Buffer.from('0123456789'),
        'flibusta/fb2-000002.zip': Buffer.from('abc'),
        'flibusta/covers/1.zip': Buffer.from('cover'),
        'flibusta/etc/reviews/2026.zip': Buffer.from('rev'),
        'flibusta/a.fb2': Buffer.from('<FictionBook/>'),
    },
    other: {'inpx/lib.inpx': Buffer.from('inpx-data')},
});

function testS3PathForms() {
    assert.deepStrictEqual(parse('s3://lib/flibusta/a.zip'), {bucket: 'lib', key: 'flibusta/a.zip'});
    assert.deepStrictEqual(parse('s3://lib/flibusta/'), {bucket: 'lib', key: 'flibusta'});
    assert.deepStrictEqual(parse('s3://lib'), {bucket: 'lib', key: ''});
    assert.strictEqual(isS3('S3://lib/x'), true);
    for (const local of ['/library', 'C:\\library', 's3', 's3data/x', 'ss3://lib/x', 's3:/lib/x', 's3:\\lib\\x', '', null])
        assert.strictEqual(isS3(local), false, String(local));
    assert.throws(() => parse('s3://'), /Bad S3 path/);
}

async function testS3ListingStatAndCache() {
    const client = useFakeS3(library());
    const root = 's3://lib/flibusta';

    assert.deepStrictEqual(await libraryFs.readdir(root), ['a.fb2', 'covers', 'etc', 'fb2-000001.zip', 'fb2-000002.zip']);
    const typed = await libraryFs.readdir(`${root}/`, {withFileTypes: true});
    assert.deepStrictEqual(typed.filter(e => e.isDirectory()).map(e => e.name), ['covers', 'etc']);
    assert.deepStrictEqual(typed.filter(e => e.isFile()).map(e => e.name), ['a.fb2', 'fb2-000001.zip', 'fb2-000002.zip']);
    assert.deepStrictEqual(await libraryFs.readdir(libraryFs.join(root, 'etc', 'reviews')), ['2026.zip']);

    const stat = await libraryFs.stat(libraryFs.join(root, 'fb2-000001.zip'));
    assert.strictEqual(stat.isFile(), true);
    assert.strictEqual(stat.size, 10);
    assert.strictEqual(stat.mtimeMs, Date.parse('2026-01-02T03:04:05Z'));
    assert.strictEqual((await libraryFs.stat(`${root}/covers`)).isDirectory(), true);
    assert.strictEqual((await libraryFs.stat('s3://lib')).isDirectory(), true);

    assert.strictEqual(await libraryFs.pathExists(`${root}/fb2-000002.zip`), true);
    assert.strictEqual(await libraryFs.pathExists(`${root}/images`), false);
    assert.strictEqual(await libraryFs.pathExists('s3://nobucket/x'), false);
    await assert.rejects(libraryFs.stat(`${root}/missing.zip`), e => e.code === 'ENOENT' && e.message.includes('missing.zip'));
    await assert.rejects(libraryFs.readdir(`${root}/images`), {code: 'ENOENT'});
    await assert.rejects(libraryFs.readdir(`${root}/a.fb2`), {code: 'ENOTDIR'});
    await assert.rejects(libraryFs.stat('s3://denied/x'), e => e.code === 'EACCES' && e.message.includes('s3://denied'));
    assert.strictEqual(await libraryFs.pathExists('s3://denied/x'), false, 'like fs.pathExists');

    //один LIST на каталог: файлы того же каталога и сам каталог - из кеша
    const before = client.calls.length;
    await libraryFs.stat(`${root}/fb2-000001.zip`);
    await libraryFs.stat(`${root}/fb2-000002.zip`);
    await libraryFs.readdir(root);
    assert.strictEqual(client.calls.length, before);
}

async function testS3ReadsAndContentHash() {
    const objects = library();
    const client = useFakeS3(objects);
    const zip = 's3://lib/flibusta/fb2-000001.zip';

    assert.strictEqual((await libraryFs.readRange(zip, 2, 3)).toString(), '234');
    assert.strictEqual((await libraryFs.readRange(zip, 8, 10)).toString(), '89');
    assert.strictEqual((await libraryFs.readRange(zip, 50, 4)).length, 0);
    assert.strictEqual((await libraryFs.readRange(zip, 0, 0)).length, 0);
    assert.strictEqual(await libraryFs.readFile('s3://other/inpx/lib.inpx', 'utf8'), 'inpx-data');
    assert.ok(Buffer.isBuffer(await libraryFs.readFile(zip)));
    await assert.rejects(libraryFs.readFile('s3://lib/flibusta/nope.zip'), {code: 'ENOENT'});

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-fs-'));
    try {
        await libraryFs.copyToLocal('s3://lib/flibusta/a.fb2', path.join(dir, 'a.fb2'));
        assert.strictEqual(await fs.readFile(path.join(dir, 'a.fb2'), 'utf8'), '<FictionBook/>');
    } finally {
        await fs.remove(dir);
    }

    //ETag из листинга: замена объекта видна после clearCache, до него - кеш без запросов
    const inpx = 's3://other/inpx/lib.inpx';
    const first = await libraryFs.contentHash(inpx);
    assert.match(first, /^"[0-9a-f]{32}":9$/);
    objects.other['inpx/lib.inpx'] = Buffer.from('inpx-data-2');
    const calls = client.calls.length;
    assert.strictEqual(await libraryFs.contentHash(inpx), first);
    assert.strictEqual(client.calls.length, calls);
    libraryFs.clearCache();
    assert.notStrictEqual(await libraryFs.contentHash(inpx), first);
}

//Библиотека и INPX выбирают хранилище независимо: архивы в S3 и INPX на диске, и наоборот
async function testLocalAndS3PathsMix() {
    const client = useFakeS3(library());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-fs-'));
    try {
        const localInpx = path.join(dir, 'lib.inpx');
        await fs.writeFile(localInpx, 'local-inpx');
        await fs.ensureDir(path.join(dir, 'covers'));

        assert.strictEqual(await libraryFs.contentHash(localInpx), crypto.createHash('sha256').update('local-inpx').digest('hex'));
        assert.strictEqual((await libraryFs.readRange(localInpx, 6, 100)).toString(), 'inpx');
        assert.strictEqual(await libraryFs.readFile(localInpx, 'utf8'), 'local-inpx');
        assert.deepStrictEqual(await libraryFs.readdir(dir), ['covers', 'lib.inpx']);
        assert.strictEqual((await libraryFs.readdir(dir, {withFileTypes: true})).find(e => e.name === 'covers').isDirectory(), true);
        assert.strictEqual(await libraryFs.pathExists(path.join(dir, 'missing')), false);
        assert.strictEqual(client.calls.length, 0, 'local paths never reach S3');

        assert.strictEqual(await libraryFs.pathExists('s3://lib/flibusta/fb2-000001.zip'), true);
        assert.match(await libraryFs.contentHash('s3://other/inpx/lib.inpx'), /:9$/);
    } finally {
        await fs.remove(dir);
    }
}

function testLibraryFsJoin() {
    assert.strictEqual(libraryFs.join('s3://lib/flibusta/', 'covers', '1.zip'), 's3://lib/flibusta/covers/1.zip');
    assert.strictEqual(libraryFs.join('/library', 'covers'), path.join('/library', 'covers'));
}

//Источники и хеш INPX в S3: пути не портятся path.resolve, единственный INPX находится, замена INPX видна после clearCache
async function testLibrarySourcesAndInpxHashOnS3() {
    const objects = library();
    useFakeS3(objects);
    const {resolveLibrarySources} = require('../server/core/LibrarySources');
    const InpxHashCreator = require('../server/core/InpxHashCreator');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-fs-'));
    try {
        const config = {
            dbVersion: 'test',
            inpxFilterFile: path.join(dir, 'filter.json'),
            librarySources: [
                {name: 'Flibusta', inpx: 's3://other/inpx/lib.inpx', libDir: 's3://lib/flibusta'},
                {name: 'Found', libDir: 's3://other/inpx/'},
                {name: 'Local', inpx: path.join(dir, 'local.inpx'), libDir: 's3://lib/flibusta'},
            ],
        };
        await fs.writeFile(path.join(dir, 'local.inpx'), 'local');
        const sources = await resolveLibrarySources(config);
        assert.deepStrictEqual(sources.map(s => [s.inpx, s.libDir]), [
            ['s3://other/inpx/lib.inpx', 's3://lib/flibusta'],
            ['s3://other/inpx/lib.inpx', 's3://other/inpx'],
            [path.join(dir, 'local.inpx'), 's3://lib/flibusta'],
        ]);
        assert.strictEqual(config.inpxFile, 's3://other/inpx/lib.inpx');
        await assert.rejects(resolveLibrarySources({librarySources: [{libDir: 's3://lib/missing'}]}), /not exists/);

        const hasher = new InpxHashCreator(config);
        const hash = await hasher.getHash();
        // the per-library hashes are the INPX ETags of the remote library API
        assert.deepStrictEqual([...hasher.sourceHashes.keys()], sources.map(s => s.id));
        objects.other['inpx/lib.inpx'] = Buffer.from('changed');
        assert.strictEqual(await hasher.getHash(), hash, 'cached until clearCache');
        libraryFs.clearCache();
        assert.notStrictEqual(await hasher.getHash(), hash);
    } finally {
        await fs.remove(dir);
    }
}

module.exports = [testS3PathForms, testS3ListingStatAndCache, testS3ReadsAndContentHash, testLocalAndS3PathsMix,
    testLibraryFsJoin, testLibrarySourcesAndInpxHashOnS3];
