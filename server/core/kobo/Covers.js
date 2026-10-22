const fs = require('fs-extra');

const {coverCacheKey} = require('../BookAssets');
const imageUtils = require('../ImageUtils');
const {writeFileAtomic} = require('../FilePersistence');
const {log, ownEntry} = require('./common');

const koboImageUrl = 'https://cdn.kobo.com/book-images';
const coverMaxSide = 3000;
const coverDefaultQuality = 85;
const coverCacheTypes = [['.jpg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif']];

// Covers in the sizes the device asks for. Mixed into KoboService.prototype: `this` is the service.
module.exports = {
    async cover(req, res, device) {
        const row = ownEntry(device.books, req.params.uuid);
        const book = row && await this.worker.getBookRecordByUid(row.bookUid);
        if (!book) {
            if (device.storeProxy && /^[0-9a-f-]{36}$/i.test(req.params.uuid)) {
                const {uuid, width, height} = req.params;
                return res.redirect(307, `${koboImageUrl}/${uuid}/${encodeURIComponent(width)}/${encodeURIComponent(height)}/false/image.jpg`);
            }
            return res.sendStatus(404);
        }

        const cacheDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const key = coverCacheKey(book);
        const size = this.coverSize(req.params);
        const resizedFile = size && `${cacheDir}/${key}-kobo-${size.width}x${size.height}-q${size.quality}.jpg`;
        if (resizedFile && await this.sendCoverFile(res, resizedFile, 'image/jpeg'))
            return;

        const cover = await this.sourceCover(book, cacheDir, key);
        if (!cover)
            return res.sendStatus(404);
        let reply = cover;
        if (size) {
            // One at a time: pure-JS decoding holds the event loop, and repeated requests find the file made.
            const run = this.coverQueue.then(async() => {
                if (await fs.pathExists(resizedFile))
                    return {contentType: 'image/jpeg', data: await fs.readFile(resizedFile)};
                // null: already a JPEG that fits, cached under the sized name as well.
                const data = imageUtils.fitToJpeg(cover.data, size.width, size.height, size.quality) || cover.data;
                // sendCoverFile serves any file it finds: never a half-written one.
                await writeFileAtomic(resizedFile, data);
                return {contentType: 'image/jpeg', data};
            });
            this.coverQueue = run.catch(() => {});
            try {
                reply = await run;
            } catch (error) {
                log(LM_WARN, `Kobo: cover of ${row.bookUid} served at its original size: ${error.message}`);
            }
        }
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(reply.contentType).send(reply.data);
    },

    // The size a cover URL asks for; null (send the original) when it isn't a usable one.
    coverSize(params) {
        const width = parseInt(params.width, 10);
        const height = parseInt(params.height, 10);
        if (!(width > 0 && height > 0))
            return null;
        const quality = parseInt(params.quality, 10);
        return {
            width: Math.min(width, coverMaxSide),
            height: Math.min(height, coverMaxSide),
            quality: (quality > 0 && quality <= 100 ? Math.max(quality, 30) : coverDefaultQuality),
        };
    },

    async sendCoverFile(res, file, type) {
        if (!await fs.pathExists(file))
            return false;
        await fs.utimes(file, new Date(), new Date());
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type(type).sendFile(file);
        return true;
    },

    // The book's cover from the shared cover cache (the one /cover/by-uid fills), made and cached if missing.
    async sourceCover(book, cacheDir, key) {
        for (const [ext, contentType] of coverCacheTypes) {
            const file = `${cacheDir}/${key}${ext}`;
            if (await fs.pathExists(file))
                return {contentType, data: await fs.readFile(file)};
        }
        const cover = await this.worker.getBookCover(book);
        if (cover)
            await require('../../static').writeCachedCover(cacheDir, key, cover);
        return cover;
    },
};
