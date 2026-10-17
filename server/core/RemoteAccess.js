// HTTP API for another inpx-shelf server (remote library): <root>/remote/...
// Access: `Authorization: Bearer <token>`. Tokens are an admin list in config.remoteAccess
// ({id, name, hash, sources}); only the SHA-256 of a token is stored. A token sees only its sources.
//   GET sources                    - sources of the token
//   GET sources/<id>/inpx          - raw INPX; ETag is its content hash taken when the DB was built
//   GET sources/<id>/books/<uid>   - prepared book file (as served for download, original format)
//   GET sources/<id>/covers/<uid>  - cover image
// <uid> is the book _uid (base64 SHA-256 of its INPX line) as base64url without padding:
// a "/" in a path segment does not survive every reverse proxy.
// Manual metadata edits stay on this server: the INPX is sent as is.
const crypto = require('crypto');
const fs = require('fs-extra');
const express = require('express');
const {pipeline} = require('stream/promises');
const libraryFs = require('./LibraryFs');
const {getEnabledLibrarySources} = require('./LibrarySources');

function log(...args) {
    return new (require('./AppLogger'))().log(...args);
}

function rootPath(config) {
    return `${String(config.rootPathStatic || '').replace(/\/$/, '')}/remote`;
}

function hashToken(token = '') {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function uidToPath(uid = '') {
    return String(uid).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function uidFromPath(value = '') {
    return `${String(value).replace(/-/g, '+').replace(/_/g, '/')}=`;
}

function isRemoteRequest(req, config) {
    const pathname = String(req.path || '');
    const root = rootPath(config);
    return pathname === root || pathname.startsWith(`${root}/`);
}

function tokens(config) {
    return (Array.isArray(config.remoteAccess) ? config.remoteAccess : []);
}

function findToken(config, token = '') {
    if (!token)
        return null;
    const hash = Buffer.from(hashToken(token), 'hex');
    return tokens(config).find(item => /^[a-f0-9]{64}$/.test(item.hash || '')
        && crypto.timingSafeEqual(Buffer.from(item.hash, 'hex'), hash)) || null;
}

// Local sources only: a remote source of this server is not shared further.
function sharedSources(config) {
    return getEnabledLibrarySources(config).filter(source => !source.remote);
}

function init(app, config, worker, security) {
    const router = express.Router();
    const handle = fn => (req, res, next) => fn(req, res, next).catch(next);

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try {
            security.checkLoginRate(req, 'remote');
        } catch (e) {
            if (e.code !== 'INPX_LOGIN_RATE_LIMIT')
                return next(e);
            res.set('Retry-After', String(e.retryAfter));
            return res.sendStatus(429);
        }
        const access = findToken(config, security.bearerToken(req));
        security.recordLoginAttempt(req, !!access, 'remote');
        if (!access) {
            res.set('WWW-Authenticate', 'Bearer');
            return res.sendStatus(401);
        }
        req.remoteAccess = access;
        next();
    });

    const allowed = req => new Set(Array.isArray(req.remoteAccess.sources) ? req.remoteAccess.sources : []);

    router.get('/sources', (req, res) => {
        const ids = allowed(req);
        res.json({sources: sharedSources(config).filter(source => ids.has(source.id)).map(source => ({id: source.id, name: source.name}))});
    });

    router.param('sourceId', (req, res, next, id) => {
        const source = (allowed(req).has(id) ? sharedSources(config).find(item => item.id === id) : null);
        if (!source)
            return res.sendStatus(404);
        req.remoteSource = source;
        next();
    });

    router.get('/sources/:sourceId/inpx', handle(async(req, res) => {
        const source = req.remoteSource;
        const hash = worker.inpxHashCreator.sourceHashes.get(source.id);
        const etag = (hash ? `"${hash}"` : '');
        if (etag) {
            res.set('ETag', etag);
            if (String(req.get('if-none-match') || '').split(',').map(item => item.trim()).includes(etag))
                return res.sendStatus(304);
        }
        res.type('application/octet-stream');
        if (libraryFs.isS3(source.inpxFile))
            return await pipeline(await libraryFs.createReadStream(source.inpxFile), res);
        res.sendFile(source.inpxFile, {dotfiles: 'allow'});
    }));

    // A uid of a book that also is in an earlier library belongs to that library in the DB:
    // the same INPX line names the same folder and file, they are taken from the requested library.
    const findBook = async(req) => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.uid))
            return null;
        req.bookUid = uidFromPath(req.params.uid);
        //и книга выключенной библиотеки: при сборке её строка могла достаться ей, а не запрошенной
        const book = (await worker.getBookRecordsByUids([req.bookUid], true)).get(req.bookUid);
        if (!book || book.sourceId === req.remoteSource.id)
            return book || null;
        return Object.assign({}, book, {sourceId: req.remoteSource.id, sourceName: req.remoteSource.name, sourceLibDir: req.remoteSource.libDir});
    };

    router.get('/sources/:sourceId/books/:uid', handle(async(req, res) => {
        if (!await findBook(req))
            return res.sendStatus(404);
        const {link} = await worker.getBookLink(req.bookUid, req.remoteSource.id);
        const file = `${config.bookDir}/${require('path').basename(link)}`;
        await fs.utimes(file, new Date(), new Date()).catch(() => {});
        //в кеше книга уже сжата gzip: отдаётся как есть
        res.set('Content-Encoding', 'gzip');
        res.type('application/octet-stream');
        res.sendFile(file, {dotfiles: 'allow'});
    }));

    router.get('/sources/:sourceId/covers/:uid', handle(async(req, res) => {
        const book = await findBook(req);
        if (!book)
            return res.sendStatus(404);
        await require('../static').sendBookCover(res, config, worker, book);
    }));

    // eslint-disable-next-line no-unused-vars
    router.use((err, req, res, next) => {
        //обрыв посреди ответа: заголовки уже ушли, соединение просто закрывается
        if (res.headersSent) {
            log(LM_ERR, `Remote API: ${req.method} ${req.originalUrl}: ${err.message}`);
            return res.destroy();
        }
        const status = (err.status === 404 || String(err.message).includes('ENOENT') ? 404 : 500);
        if (status === 500)
            log(LM_ERR, `Remote API: ${req.method} ${req.originalUrl}: ${err.message}`);
        res.sendStatus(status);
    });

    app.use(rootPath(config), router);
}

module.exports = {init, isRemoteRequest, uidToPath, uidFromPath, hashToken, newToken, findToken, sharedSources, rootPath};
