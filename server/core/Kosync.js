// Синхронизация прогресса KOReader (плагин «Progress sync», протокол koreader-sync-server).
// Вход: имя пользователя любое, пароль - выданный в профиле пароль KOReader (KOReader шлёт его md5).
// Книгу KOReader узнаёт по partial MD5 файла: хеш отданного файла запоминается в state.sqlite,
// и прогресс известной книги попадает в «Продолжить чтение». Прогресс остальных книг тоже хранится,
// чтобы синхронизировались устройства KOReader между собой.
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const {t} = require('./i18n');

function log(...args) {
    return new (require('./AppLogger'))().log(...args);
}

function rootPath(config) {
    return `${String(config.rootPathStatic || '').replace(/\/$/, '')}/kosync`;
}

const documentPattern = /^[0-9a-f]{32}$/i;

// Только точные маршруты протокола: путь с «..» не должен пройти мимо проверки входа к другим маршрутам.
function isKosyncRequest(req, config) {
    if (!config.kosyncEnabled)
        return false;
    const pathname = String(req.path || '');
    const root = rootPath(config);
    return pathname.startsWith(root) && /^\/(users\/(create|auth)|syncs\/progress(\/[0-9a-f]{32})?)$/i.test(pathname.slice(root.length));
}

// util.partialMD5 из KOReader: md5 по 1 КБ со смещений 0 и 1024·4^i (i = 0..10), до конца файла.
// В LuaJIT lshift(1024, -2) даёт 0, отсюда первое смещение.
async function partialMd5(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const md5 = crypto.createHash('md5');
        const sample = Buffer.alloc(1024);
        for (let i = -1; i <= 10; i++) {
            const {bytesRead} = await handle.read(sample, 0, sample.length, (i < 0 ? 0 : 1024 << (2*i)));
            if (!bytesRead)
                break;
            md5.update(sample.subarray(0, bytesRead));
        }
        return md5.digest('hex');
    } finally {
        await handle.close();
    }
}

// Файл книги ушёл к читателю: запомним, какой книге принадлежит его хеш. В фоне, скачивание не ждёт.
function rememberFile(worker, file, bookUid) {
    if (!worker || !worker.config.kosyncEnabled || !bookUid)
        return Promise.resolve();
    return partialMd5(file)
        .then(hash => worker.stateStore.putKosyncDocument(hash, bookUid))
        .catch(e => log(LM_WARN, `KOReader sync: cannot hash ${file}: ${e.message}`));
}

function sendJson(res, data, status = 200) {
    res.status(status).type('application/json').send(JSON.stringify(data));
}

function init(app, config, worker, security) {
    if (!config.kosyncEnabled)
        return;

    const store = worker.readingListStore;
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    const handle = fn => (req, res, next) => fn(req, res, next).catch(next);

    // Пароль выдаётся в профиле inpx-shelf.
    router.post('/users/create', (req, res) => sendJson(res, {code: 2005, message: t('kosync.registrationDisabled')}, 402));

    router.use(handle(async(req, res, next) => {
        try {
            security.checkLoginRate(req, 'kosync');
        } catch (e) {
            if (e.code !== 'INPX_LOGIN_RATE_LIMIT')
                throw e;
            res.set('Retry-After', String(e.retryAfter));
            return sendJson(res, {code: 2001, message: e.message}, 429);
        }
        const user = (req.get('x-auth-user') ? await store.findKosyncUser(req.get('x-auth-key')) : null);
        if (!user) {
            security.recordLoginAttempt(req, false, 'kosync');
            return sendJson(res, {code: 2001, message: t('kosync.unauthorized')}, 401);
        }
        req.kosyncUser = user;
        next();
    }));

    router.get('/users/auth', (req, res) => sendJson(res, {authorized: 'OK'}));

    router.get('/syncs/progress/:document', handle(async(req, res) => {
        const document = String(req.params.document).toLowerCase();
        const row = await store.getKosyncProgress(req.kosyncUser.id, document);
        if (!row)
            return sendJson(res, {});
        const {progress, percentage, device, device_id, timestamp} = row;
        sendJson(res, {document, progress, percentage, device, device_id, timestamp});
    }));

    // тело читается только после проверки входа: без пароля запрос не тратит разбор JSON
    router.put('/syncs/progress', express.json({type: () => true, limit: '64kb'}), handle(async(req, res) => {
        const body = (req.body && typeof(req.body) === 'object' ? req.body : {});
        const document = String(body.document || '').toLowerCase();
        if (!document)
            return sendJson(res, {code: 2004, message: 'Field \'document\' not provided.'}, 403);
        const percentage = Number(body.percentage);
        if (!documentPattern.test(document) || typeof(body.progress) !== 'string' || !Number.isFinite(percentage)
            || typeof(body.device) !== 'string' || typeof(body.device_id) !== 'string')
            return sendJson(res, {code: 2003, message: 'Invalid request'}, 403);

        const userId = req.kosyncUser.id;
        const previous = await store.getKosyncProgress(userId, document);
        const bookUid = (previous && previous.bookUid) || worker.stateStore.getKosyncDocument(document);
        const timestamp = Math.floor(Date.now()/1000);
        await store.putKosyncProgress(userId, document, {
            progress: body.progress.slice(0, 1024), percentage: Math.max(0, Math.min(1, percentage)),
            device: body.device.slice(0, 128), device_id: body.device_id.slice(0, 128), timestamp, bookUid,
        });
        if (bookUid) {
            await store.mergeDeviceProgress(userId, bookUid, percentage, new Date(timestamp*1000).toISOString())
                .catch(e => log(LM_WARN, `KOReader sync: cannot update reader progress of ${bookUid}: ${e.message}`));
        }
        sendJson(res, {document, timestamp});
    }));

    // eslint-disable-next-line no-unused-vars
    router.use((err, req, res, next) => {
        const status = (err.status >= 400 && err.status < 500 ? err.status : 500);
        if (status === 500)
            log(LM_ERR, `KOReader sync: ${req.method} ${req.originalUrl}: ${err.message}`);
        sendJson(res, {code: (status === 500 ? 2000 : 2003), message: (status === 500 ? 'Unknown server error.' : 'Invalid request')}, status);
    });

    app.use(rootPath(config), router);
    log(`KOReader sync enabled at ${rootPath(config)}`);
}

module.exports = {init, isKosyncRequest, partialMd5, rememberFile, rootPath};
