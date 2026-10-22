// Remote library: a library source served by another inpx-shelf over its /remote/ API (RemoteAccess).
// A source entry in librarySources has `remote: {url, source, token}`. Its INPX is kept in
// <dataDir>/remote/<id>.inpx and re-checked with If-None-Match; books and covers are fetched by uid.
const fs = require('fs-extra');
const path = require('path');
const {Readable, Transform} = require('stream');
const {pipeline} = require('stream/promises');
const utils = require('./utils');
const {uidToPath} = require('./RemoteAccess');
const {t} = require('./i18n');

function log(...args) {
    return new (require('./AppLogger'))().log(...args);
}

const maxCoverSize = 5*1024*1024;
const maxListingSize = 1024*1024;
//Запуск сервера ждёт ответ удалённого хоста не дольше этого (тело INPX качается без такого лимита)
const startupConnectTimeout = 15*1000;

class RemoteLib {
    constructor(config) {
        this.config = config;
    }

    sourcesUrl(remote) {
        return `${String(remote.url || '').trim().replace(/\/+$/, '')}/remote/sources`;
    }

    // connectTimeout (ms) - how long to wait for the response headers; the body is bounded only by the overall timeout.
    async request(remote, part = '', headers = {}, connectTimeout = 0) {
        const url = `${this.sourcesUrl(remote)}${part}`;
        const signals = [AbortSignal.timeout(5*60*1000)];
        const connect = new AbortController();
        const timer = (connectTimeout ? setTimeout(() => connect.abort(new Error('no response in time')), connectTimeout) : null);
        if (timer)
            signals.push(connect.signal);
        let response;
        try {
            //redirect: error - токен не уходит по перенаправлению на другой адрес
            response = await fetch(url, {
                headers: Object.assign({authorization: `Bearer ${remote.token || ''}`}, headers),
                redirect: 'error',
                signal: AbortSignal.any(signals),
            });
        } catch (e) {
            throw Object.assign(new Error(t('errors.remoteLibraryUnavailable', {error: (e.cause && e.cause.message) || e.message})), {cause: e});
        } finally {
            clearTimeout(timer);
        }
        if (response.status === 404) {
            await response.body?.cancel();
            throw Object.assign(new Error(t('errors.fileNotFound')), {status: 404});
        }
        if (!response.ok && response.status !== 304) {
            await response.body?.cancel();
            throw new Error(t('errors.remoteLibraryUnavailable', {error: `HTTP ${response.status}`}));
        }
        return response;
    }

    // The body goes to a temp file first: a broken transfer leaves no half-written file behind.
    async saveBody(response, file) {
        const limit = (Number(this.config.maxPayloadSize) || 500)*1024*1024;
        const tmpFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;
        let size = 0;
        try {
            await pipeline(Readable.fromWeb(response.body), new Transform({
                transform(chunk, encoding, done) {
                    size += chunk.length;
                    done(size > limit ? new Error(t('errors.fileTooLarge')) : null, chunk);
                },
            }), fs.createWriteStream(tmpFile));
            await fs.move(tmpFile, file, {overwrite: true});
        } catch (e) {
            await fs.remove(tmpFile);
            throw e;
        }
    }

    // A small answer (listing, cover) is read into memory: over the limit it is dropped, the rest of the body is not read.
    async readLimited(response, limit) {
        if (Number(response.headers.get('content-length')) > limit) {
            await response.body?.cancel();
            throw new Error(t('errors.fileTooLarge'));
        }
        const chunks = [];
        let size = 0;
        //выход из цикла по throw отменяет поток
        for await (const chunk of response.body || []) {
            size += chunk.length;
            if (size > limit)
                throw new Error(t('errors.fileTooLarge'));
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async listSources(remote) {
        const response = await this.request(remote);
        const data = JSON.parse((await this.readLimited(response, maxListingSize)).toString('utf8'));
        return (Array.isArray(data.sources) ? data.sources : []).map(item => ({id: String(item.id || ''), name: String(item.name || '')}));
    }

    // true - the INPX changed. The ETag is kept next to the file.
    async syncInpx(source, connectTimeout = 0) {
        const etagFile = `${source.inpxFile}.etag`;
        const etag = (await fs.pathExists(source.inpxFile) && await fs.pathExists(etagFile) ? (await fs.readFile(etagFile, 'utf8')).trim() : '');
        const response = await this.request(source.remote, `/${encodeURIComponent(source.remote.source)}/inpx`, (etag ? {'if-none-match': etag} : {}), connectTimeout);
        if (response.status === 304)
            return false;
        await fs.ensureDir(path.dirname(source.inpxFile));
        await this.saveBody(response, source.inpxFile);
        await fs.writeFile(etagFile, response.headers.get('etag') || '');
        return true;
    }

    // The main server may be down: its last INPX stays, the other libraries keep working.
    // startup: a host that does not answer must not hold the server back, the periodic check catches up later.
    async syncAll({startup = false} = {}) {
        for (const source of (this.config.librarySources || []).filter(item => item && item.remote && item.enabled !== false)) {
            try {
                if (await this.syncInpx(source, startup ? startupConnectTimeout : 0))
                    log(`Remote library ${source.id}: INPX downloaded`);
            } catch (e) {
                log(LM_ERR, `Remote library ${source.id}: ${e.message}`);
            }
        }
    }

    // Prepared book in its own format, into a temp file.
    async downloadBook(remote, bookUid) {
        const response = await this.request(remote, `/${encodeURIComponent(remote.source)}/books/${uidToPath(bookUid)}`);
        const file = `${this.config.tempDir}/${utils.randomHexString(30)}`;
        await this.saveBody(response, file);
        return file;
    }

    async getCover(remote, bookUid) {
        try {
            const response = await this.request(remote, `/${encodeURIComponent(remote.source)}/covers/${uidToPath(bookUid)}`);
            const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
            if (!/^image\//.test(contentType)) {
                await response.body?.cancel();
                throw new Error(t('errors.remoteLibraryUnavailable', {error: `unexpected content type ${contentType || '-'}`}));
            }
            const data = await this.readLimited(response, maxCoverSize);
            return (data.length ? {data, contentType} : null);
        } catch (e) {
            if (e.status === 404)
                return null;
            throw e;
        }
    }
}

module.exports = RemoteLib;
