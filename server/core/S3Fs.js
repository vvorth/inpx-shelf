const crypto = require('crypto');
const fs = require('fs-extra');
const {pipeline} = require('stream/promises');

//Библиотека в S3: путь s3://bucket/prefix. Библиотека только читается, поэтому листинги кешируются
//до clearCache (периодическая проверка INPX) или перезапуска. Клиент один на все бакеты: ключи и endpoint
//берутся из стандартных переменных AWS (AWS_REGION, AWS_ENDPOINT_URL_S3, роль задачи Fargate).
//shortcut: бакеты разных провайдеров или с разными ключами не поддерживаются; при необходимости - настройки на URI.

function isS3(p) {
    return /^s3:\/\//i.test(String(p || ''));
}

//Только s3://bucket/key: пути S3 собираются через libraryFs.join, path.join их портит
function parse(uri) {
    const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/i.exec(String(uri || ''));
    if (!m)
        throw new Error(`Bad S3 path: ${uri}`);
    const key = String(m[2] || '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return {bucket: m[1], key};
}

function fsError(code, message) {
    return Object.assign(new Error(message), {code});
}

function fileStat(entry) {
    return {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        mtime: new Date(entry.mtimeMs),
        etag: entry.etag,
        isFile: () => true,
        isDirectory: () => false,
    };
}

function dirStat() {
    return {size: 0, mtimeMs: 0, mtime: new Date(0), etag: '', isFile: () => false, isDirectory: () => true};
}

function createClient() {
    const {S3Client} = require('@aws-sdk/client-s3');
    return new S3Client({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
        followRegionRedirects: true,
        //свой endpoint (MinIO, SeaweedFS...): адрес bucket.localhost не резолвится, нужен путь endpoint/bucket/key
        forcePathStyle: !!(process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL),
    });
}

class S3Fs {
    constructor(client = null) {
        this.client = client;
        this.listings = new Map();//`bucket/prefix` -> Promise<{dirs: Set, files: Map}>
    }

    clearCache() {
        this.listings.clear();
    }

    async send(commandName, input, uri) {
        if (!this.client)
            this.client = createClient();
        const sdk = require('@aws-sdk/client-s3');
        try {
            return await this.client.send(new sdk[commandName](input));
        } catch (e) {
            //у HEAD нет тела ответа, и SDK пишет NotFound: UnknownError - причина только в коде HTTP
            const status = e && e.$metadata && e.$metadata.httpStatusCode;
            if (status === 404 || (e && ['NoSuchKey', 'NoSuchBucket', 'NotFound'].includes(e.name)))
                throw fsError('ENOENT', `ENOENT: not found in S3: ${uri}`);
            if (status === 403 || (e && e.name === 'AccessDenied'))
                throw fsError('EACCES', `EACCES: access denied in S3: ${uri}`);
            throw new Error(`S3: ${uri}: ${(e && (e.name || e.message)) || e}`);
        }
    }

    //Содержимое "каталога": подкаталоги и файлы с размером, временем и ETag
    list(uri) {
        const {bucket, key} = parse(uri);
        const id = `${bucket}/${key}`;
        if (!this.listings.has(id)) {
            const promise = (async() => {
                const prefix = (key ? `${key}/` : '');
                const dirs = new Set();
                const files = new Map();
                let token;
                do {
                    const res = await this.send('ListObjectsV2Command',
                        {Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token}, uri);
                    for (const p of res.CommonPrefixes || [])
                        dirs.add(p.Prefix.substring(prefix.length).replace(/\/$/, ''));
                    for (const o of res.Contents || []) {
                        const name = o.Key.substring(prefix.length);
                        if (name)
                            files.set(name, {size: Number(o.Size || 0), mtimeMs: new Date(o.LastModified || 0).getTime(), etag: String(o.ETag || '')});
                    }
                    token = (res.IsTruncated ? res.NextContinuationToken : undefined);
                } while (token);
                return {dirs, files};
            })();
            this.listings.set(id, promise);
            promise.catch(() => this.listings.delete(id));
        }
        return this.listings.get(id);
    }

    //Файл ищется в листинге родителя: один LIST на каталог вместо HEAD на каждый файл
    async stat(uri) {
        const {bucket, key} = parse(uri);
        if (!key) {
            await this.list(uri);//бакета нет - ENOENT
            return dirStat();
        }
        const slash = key.lastIndexOf('/');
        const parent = `s3://${bucket}/${key.substring(0, slash + 1)}`;
        const name = key.substring(slash + 1);
        const listing = await this.list(parent);
        if (listing.files.has(name))
            return fileStat(listing.files.get(name));
        if (listing.dirs.has(name))
            return dirStat();
        throw fsError('ENOENT', `ENOENT: not found in S3: ${uri}`);
    }

    async pathExists(uri) {
        try {
            await this.stat(uri);
            return true;
        } catch (e) {
            //как fs.pathExists: нет доступа - значит, не существует
            if (e.code === 'ENOENT' || e.code === 'EACCES')
                return false;
            throw e;
        }
    }

    async readdir(uri, options = {}) {
        if (!(await this.stat(uri)).isDirectory())
            throw fsError('ENOTDIR', `ENOTDIR: not a directory in S3: ${uri}`);
        const {dirs, files} = await this.list(uri);
        const names = [...dirs, ...files.keys()].sort();
        if (!options.withFileTypes)
            return names;
        return names.map(name => ({name, isDirectory: () => dirs.has(name), isFile: () => !dirs.has(name)}));
    }

    async contentHash(uri) {
        const stat = await this.stat(uri);
        return `${stat.etag}:${stat.size}`;
    }

    async head(uri) {
        const {bucket, key} = parse(uri);
        const res = await this.send('HeadObjectCommand', {Bucket: bucket, Key: key}, uri);
        return {size: Number(res.ContentLength || 0), etag: String(res.ETag || '')};
    }

    //length байт с offset; конец объекта обрезает ответ, как read() у файла
    async readRange(uri, offset, length) {
        if (length <= 0)
            return Buffer.alloc(0);
        const {bucket, key} = parse(uri);
        try {
            const res = await this.send('GetObjectCommand', {Bucket: bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}`}, uri);
            return Buffer.from(await res.Body.transformToByteArray());
        } catch (e) {
            if (/InvalidRange/.test(e.message))//offset за концом объекта
                return Buffer.alloc(0);
            throw e;
        }
    }

    async readFile(uri) {
        const {bucket, key} = parse(uri);
        const res = await this.send('GetObjectCommand', {Bucket: bucket, Key: key}, uri);
        return Buffer.from(await res.Body.transformToByteArray());
    }

    //хеш потока объекта: без копии в памяти или на диске
    async sha256(uri) {
        const {bucket, key} = parse(uri);
        const res = await this.send('GetObjectCommand', {Bucket: bucket, Key: key}, uri);
        const hash = crypto.createHash('sha256');
        await pipeline(res.Body, hash);
        return hash.digest('hex');
    }

    async copyToLocal(uri, outFile) {
        const {bucket, key} = parse(uri);
        const res = await this.send('GetObjectCommand', {Bucket: bucket, Key: key}, uri);
        await pipeline(res.Body, fs.createWriteStream(outFile));
    }
}

module.exports = {S3Fs, isS3, parse};
