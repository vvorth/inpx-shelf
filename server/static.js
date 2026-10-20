const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');
const {pipeline} = require('stream/promises');

const express = require('express');
const utils = require('./core/utils');
const bookConverter = require('./core/BookConverter');
const externalTools = require('./core/ExternalTools');
const kosync = require('./core/Kosync');

const log = new (require('./core/AppLogger'))().log;//singleton
const {t, getLang} = require('./core/i18n');
const {escapeHtml} = require('../shared/safeHtml');
const runtimeWarnings = new Set();

function logRuntimeWarningOnce(message) {
    if (!message || runtimeWarnings.has(message))
        return;

    runtimeWarnings.add(message);
    log(LM_ERR, message);
}

function getBookDownloadMimeType(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    switch (ext) {
    case '.fb2':
        return 'application/x-fictionbook+xml; charset=utf-8';
    case '.epub':
        return 'application/epub+zip';
    case '.zip':
        return 'application/zip';
    case '.pdf':
        return 'application/pdf';
    case '.txt':
        return 'text/plain; charset=utf-8';
    case '.rtf':
        return 'application/rtf';
    case '.mobi':
        return 'application/x-mobipocket-ebook';
    case '.azw':
    case '.azw3':
        return 'application/vnd.amazon.ebook';
    case '.doc':
        return 'application/msword';
    case '.docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
        return null;
    }
}

function generateZip(zipFile, dataFile, dataFileInZip) {
    const zip = new yazl.ZipFile();
    const complete = pipeline(zip.outputStream, fs.createWriteStream(zipFile));
    zip.on('error', error => zip.outputStream.destroy(error));
    zip.addFile(dataFile, dataFileInZip);
    zip.end();
    return complete;
}

function imageCacheExt(contentType = '') {
    if (contentType === 'image/png')
        return '.png';
    if (contentType === 'image/jpeg')
        return '.jpg';
    if (contentType === 'image/gif')
        return '.gif';
    return '';
}

async function sendCachedCover(res, cacheDir, cacheKey) {
    for (const item of [
        {ext: '.png', type: 'image/png'},
        {ext: '.jpg', type: 'image/jpeg'},
        {ext: '.gif', type: 'image/gif'},
    ]) {
        const cacheFile = `${cacheDir}/${cacheKey}${item.ext}`;
        if (!await fs.pathExists(cacheFile))
            continue;

        await fs.utimes(cacheFile, new Date(), new Date());
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(item.type);
        res.sendFile(cacheFile);
        return true;
    }

    return false;
}

async function writeCachedCover(cacheDir, cacheKey, cover) {
    const ext = imageCacheExt(cover.contentType);
    if (!ext)
        return;

    await fs.ensureDir(cacheDir);
    //обложка отдаётся как immutable: под своим именем - только целиком записанный файл
    await utils.prepareCachedFile(`${cacheDir}/${cacheKey}${ext}`, file => fs.writeFile(file, cover.data));
}

//Обложка из кеша или из файлов библиотеки; её же отдаёт API удалённой библиотеки (RemoteAccess)
async function sendBookCover(res, config, webWorker, book) {
    try {
        const cacheDir = config.coverDir || `${config.publicFilesDir}/cover`;
        const cacheKey = require('./core/BookAssets').coverCacheKey(book);
        if (await sendCachedCover(res, cacheDir, cacheKey))
            return;
        const cover = await webWorker.getBookCover(book);
        if (!cover) {
            res.sendStatus(404);
            return;
        }
        await writeCachedCover(cacheDir, cacheKey, cover);
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(cover.contentType).send(cover.data);
    } catch (error) {
        if (externalTools.isMissingToolError(error)) {
            logRuntimeWarningOnce(error.message);
            res.status(503).type('text/plain; charset=utf-8').send(error.message);
        } else {
            res.sendStatus(404);
        }
    }
}

//Статика приложения сжата заранее (createWebApp): готовый .br или .gz рядом с файлом отдаётся, если браузер его принимает.
//Книги и обложки идут другими маршрутами
const {compressibleFile} = require('./createWebApp');
const precompressedEncodings = [['br', '.br'], ['gzip', '.gz']];

function precompressedStatic(publicDir) {
    const root = path.resolve(publicDir) + path.sep;
    return async(req, res, next) => {
        const pathname = (req.path.endsWith('/') ? `${req.path}index.html` : req.path);
        if ((req.method !== 'GET' && req.method !== 'HEAD') || !compressibleFile.test(pathname))
            return next();

        res.vary('Accept-Encoding');
        let file = '';
        try {
            file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
        } catch (e) {
            return next();
        }
        if (!file.startsWith(root))
            return next();

        for (const [encoding, ext] of precompressedEncodings) {
            if (req.acceptsEncodings(encoding) !== encoding || !await fs.pathExists(file + ext))
                continue;
            //express.static отдаёт сжатый файл со своими ETag, 304 и Range; тип - исходного файла
            res.set('Content-Encoding', encoding);
            res.type(path.extname(pathname));
            req.url = pathname + ext;
            break;
        }
        next();
    };
}

function normalizeWebAppBasePath(rootPathStatic = '') {
    const root = String(rootPathStatic || '').trim().replace(/^\/+|\/+$/g, '');
    return root ? `/${root}/` : '/';
}

function jsString(value) {
    return JSON.stringify(String(value)).replace(/</g, '\\u003c');
}

function appResetPage(rootPathStatic = '') {
    const basePath = JSON.stringify(normalizeWebAppBasePath(rootPathStatic)).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="${escapeHtml(getLang())}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(t('reset.pageTitle'))}</title>
  <style>
    body{margin:0;background:#f4ede2;color:#2d2925;font:16px/1.5 system-ui,sans-serif}
    main{box-sizing:border-box;max-width:560px;margin:12vh auto;padding:24px}
    h1{font-size:24px;margin:0 0 12px}a{color:#8f5725;font-weight:600}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(t('reset.heading'))}</h1>
    <p id="status">${escapeHtml(t('reset.status'))}</p>
    <noscript>${escapeHtml(t('reset.noScript'))} <a href="./">${escapeHtml(t('reset.backToApp'))}</a></noscript>
  </main>
  <script>
  (() => {
    'use strict';
    const BASE_PATH = ${basePath};
    const RECOVERY_KEY_PREFIX = 'inpx-web-build-reload:';

    async function clearKnownCaches() {
      if (!('caches' in window)) return;
      const keys = await window.caches.keys();
      await Promise.allSettled(keys
        .filter((key) => key.startsWith('inpx-web-'))
        .map((key) => window.caches.delete(key)));
    }

    async function unregisterScopedWorkers() {
      if (!('serviceWorker' in navigator)) return;
      const currentScope = new URL(BASE_PATH, window.location.origin).href;
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.allSettled(registrations
        .filter((registration) => registration.scope === currentScope)
        .map((registration) => registration.unregister()));
    }

    function clearRecoveryMarkers() {
      try {
        const keys = [];
        for (let i = 0; i < window.sessionStorage.length; i += 1)
          keys.push(window.sessionStorage.key(i));
        keys.filter((key) => key && key.startsWith(RECOVERY_KEY_PREFIX))
          .forEach((key) => window.sessionStorage.removeItem(key));
      } catch (e) {
        // Preserve all user storage and continue when sessionStorage is unavailable.
      }
    }

    function returnTarget() {
      const requested = new URLSearchParams(window.location.search).get('return') || BASE_PATH;
      let target;
      try {
        target = new URL(requested, window.location.origin);
      } catch (e) {
        target = new URL(BASE_PATH, window.location.origin);
      }

      const baseRoot = BASE_PATH === '/' ? '/' : BASE_PATH.slice(0, -1);
      const insideBase = BASE_PATH === '/'
        || target.pathname === baseRoot
        || target.pathname.startsWith(BASE_PATH);
      if (
        target.origin !== window.location.origin
        || target.username
        || target.password
        || !insideBase
        || target.pathname === BASE_PATH + 'app-reset'
      ) target = new URL(BASE_PATH, window.location.origin);

      for (const key of ['clearAppCache', 'appBuild', 'appReloadAttempt', 'appReloadAt', 'appCacheReset'])
        target.searchParams.delete(key);

      const hashQueryIndex = target.hash.indexOf('?');
      if (hashQueryIndex >= 0) {
        const hashPath = target.hash.substring(0, hashQueryIndex);
        const hashParams = new URLSearchParams(target.hash.substring(hashQueryIndex + 1));
        hashParams.delete('clearAppCache');
        const nextHashQuery = hashParams.toString();
        target.hash = hashPath + (nextHashQuery ? '?' + nextHashQuery : '');
      }

      target.searchParams.set('appCacheReset', Date.now().toString());
      return target;
    }

    async function reset() {
      const target = returnTarget();
      await Promise.allSettled([
        clearKnownCaches(),
        unregisterScopedWorkers(),
      ]);
      clearRecoveryMarkers();
      window.location.replace(target.toString());
    }

    reset().catch(() => {
      const status = document.getElementById('status');
      status.textContent = ${jsString(t('reset.failed'))};
      const link = document.createElement('a');
      link.href = BASE_PATH;
      link.textContent = ${jsString(t('reset.backToApp'))};
      status.append(document.createElement('br'), link);
    });
  })();
  </script>
</body>
</html>`;
}

module.exports = (app, config, webWorker = null, security = null) => {
    /*
    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;
    */
    const webAppBasePath = normalizeWebAppBasePath(config.rootPathStatic);
    const webAppRoutePrefix = (webAppBasePath === '/' ? '' : webAppBasePath.slice(0, -1));
    if (webWorker && security) {
        const profileAccess = new (require('./core/ProfileAccess'))(config, webWorker, security);
        app.use([config.bookPathStatic, `${webAppRoutePrefix}/cover`], profileAccess.httpGuard({guest: true}));
        app.use(`${webAppRoutePrefix}/admin-backups`, profileAccess.httpGuard());
    }
    app.get(`${webAppRoutePrefix}/app-reset`, (req, res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.type('html').send(appResetPage(config.rootPathStatic));
    });

    app.get(`${config.rootPathStatic || ''}/cover/by-uid`, async(req, res) => {
        try {
            const book = await webWorker.getBookRecordByUid(String(req.query.uid || '').trim());
            if (!book) {
                res.sendStatus(404);
                return;
            }
            await sendBookCover(res, config, webWorker, book);
        } catch (error) {
            res.sendStatus(404);
        }
    });

    // Older versions put secrets under the public book directory. Block those
    // paths before every book handler, including express.static and encoded URLs.
    app.use(config.bookPathStatic, (req, res, next) => {
        let pathname;
        try {
            pathname = path.posix.normalize('/' + decodeURIComponent(req.path).replace(/\\/g, '/')).toLowerCase();
        } catch (e) {
            return res.sendStatus(400);
        }
        if (pathname === '/backup' || pathname.startsWith('/backup/'))
            return res.sendStatus(403);
        //описание файла кэша (.d.json) хранит папку библиотеки на сервере
        if (pathname.endsWith('.d.json'))
            return res.sendStatus(404);
        next();
    });

    app.get(`${webAppRoutePrefix}/admin-backups/:fileName`, async(req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const identity = req.profileAccessIdentity;
        const token = identity && identity.token;
        const userId = token && webWorker && webWorker.getProfileSessionUser(token);
        if (!userId)
            return res.sendStatus(401);
        try {
            await webWorker.requireAdmin(userId, token);
        } catch (e) {
            return res.sendStatus(403);
        }
        const fileName = path.basename(String(req.params.fileName || '').trim());
        if (!fileName || fileName !== req.params.fileName || path.extname(fileName).toLowerCase() !== '.zip') {
            res.sendStatus(404);
            return;
        }

        try {
            const backupFile = path.join(config.dataDir, 'backups', fileName);
            if (!await fs.pathExists(backupFile))
                return res.sendStatus(404);
            res.download(backupFile, fileName);
        } catch (error) {
            next(error);
        }
    });

    app.get(`${config.bookPathStatic}/by-uid`, async(req, res) => {
        if (!webWorker) {
            res.sendStatus(404);
            return;
        }

        try {
            const bookUid = String(req.query.uid || '').trim();
            const fileType = String(req.query.format || '').trim().toLowerCase();
            const zip = String(req.query.zip || '') === '1';

            if (!bookUid) {
                res.sendStatus(404);
                return;
            }

            if (fileType && !/^[a-z0-9_-]+$/.test(fileType)) {
                res.sendStatus(400);
                return;
            }

            const {link} = await webWorker.getBookLink(bookUid);
            let href = link;

            if (fileType)
                href += `/${fileType}`;
            else if (zip)
                href += '/zip';

            res.redirect(302, href);
        } catch(e) {
            log(LM_ERR, `book by uid error: ${e.message}`);
            //пути сервера из ошибок 7z и файловой системы остаются в журнале
            const status = (e.status === 404 ? 404 : 500);
            res.status(status).type('text/plain; charset=utf-8').send(status === 404 ? e.message : t('errors.bookPrepareFailed'));
        }
    });

    app.use([`${config.bookPathStatic}/:fileName/:fileType/:downloadName`, `${config.bookPathStatic}/:fileName/:fileType`, `${config.bookPathStatic}/:fileName`], async(req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
        }

        try {
            const fileName = req.params.fileName;
            const fileType = req.params.fileType;

            // Cache names are hex hashes; anything else (an encoded "..") must never reach fs.remove below.
            if (/^[0-9a-f]+$/i.test(fileName)) {//восстановление файлов {hash}.raw, {hash}.zip
                let bookFile = `${config.bookDir}/${fileName}`;
                const bookFileDesc = `${bookFile}.d.json`;

                //восстановим из json-файла описания
                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    await utils.touchFile(bookFile);
                    await utils.touchFile(bookFileDesc);

                    const desc = await fs.readJson(bookFileDesc);
                    let downFileName = desc.downFileName;
                    let gzipped = true;

                    if (!req.acceptsEncodings('gzip') || fileType) {
                        const rawFile = `${bookFile}.raw`;
                        //не принимает gzip, тогда распакуем
                        await utils.ensureGunzipFile(bookFile, rawFile, desc.size);

                        gzipped = false;

                        if (fileType === undefined || fileType === 'raw') {
                            bookFile = rawFile;
                        } else if (fileType === 'zip') {
                            //создаем zip-файл
                            // Older ZIP caches may contain an incomplete download.
                            bookFile += '.download-v2.zip';
                            await utils.prepareCachedFile(bookFile, outputFile => generateZip(outputFile, rawFile, downFileName));
                            downFileName += '.zip';
                        } else if (bookConverter.canConvertTo(fileType)) {
                            const prepared = await bookConverter.prepareConvertedFile({
                                inputFile: rawFile,
                                cacheBasePath: bookFile,
                                format: fileType,
                                sourceFileName: downFileName,
                                downFileName,
                                config,
                            });
                            bookFile = prepared.filePath;
                            downFileName = prepared.downloadName;
                        } else {
                            throw new Error(`Unsupported file type: ${fileType}`);
                        }
                    }

                    //отдача файла
                    if (gzipped)
                        res.set('Content-Encoding', 'gzip');
                    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downFileName)}`);
                    const mimeType = getBookDownloadMimeType(downFileName);
                    if (mimeType)
                        res.set('Content-Type', mimeType);
                    res.sendFile(bookFile);

                    //KOReader узнаёт книгу по хешу файла: запомним, какой книге он принадлежит
                    if (config.kosyncEnabled && webWorker && req.method === 'GET') {
                        const rawFile = `${config.bookDir}/${fileName}.raw`;
                        (gzipped ? utils.ensureGunzipFile(bookFile, rawFile, desc.size) : Promise.resolve())
                            .then(() => kosync.rememberFile(webWorker, (gzipped ? rawFile : bookFile), webWorker.stateStore.getBookFileUid(fileName)))
                            .catch(e => log(LM_WARN, `KOReader sync: ${e.message}`));
                    }
                    return;
                } else {
                    await fs.remove(bookFile);
                    await fs.remove(bookFileDesc);
                }
            }
        } catch(e) {
            log(LM_ERR, e.message);
            if (bookConverter.canConvertTo(req.params.fileType)) {
                //текст конвертера с путями сервера остаётся в журнале; пользователю - только понятные причины
                const known = String(e.code || '').startsWith('INPX_CONVERSION_');
                res.status(500).send(known ? e.message : t('errors.conversionFailed'));
                return;
            }
            //express.static ниже отдал бы сжатый кеш как книгу
            if (/^[0-9a-f]+$/i.test(req.params.fileName))
                return res.sendStatus(500);
        }

        return next();
    });

    //иначе просто отдаем запрошенный файл из /public-files
    app.use(config.bookPathStatic, express.static(config.bookDir));

    //статика файлов WebApp
    const webAppStaticOptions = {
        setHeaders(res, filePath) {
            const fileName = path.basename(filePath).toLowerCase().replace(/\.(br|gz)$/, '');
            if (['index.html', 'sw.js', 'manifest.webmanifest', 'reader.webmanifest', 'build-id.txt', 'version.txt'].includes(fileName)) {
                res.set('Cache-Control', 'no-store');
                return;
            }

            if (/\.[a-f0-9]{8,}\.(js|css|woff2?|ttf|eot)$/i.test(fileName))
                res.set('Cache-Control', 'public, max-age=2592000, immutable');
        },
    };

    app.use(config.rootPathStatic, precompressedStatic(config.publicDir), express.static(config.publicDir, webAppStaticOptions));
};

module.exports.writeCachedCover = writeCachedCover;
module.exports.sendBookCover = sendBookCover;
