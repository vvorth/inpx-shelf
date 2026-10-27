const fs = require('fs-extra');

const asyncExit = new (require('./AsyncExit'))();
const log = new (require('./AppLogger'))().log;//singleton
const utils = require('./utils');
const {t, msg} = require('./i18n');
const {
    cleanDirNextAlignedDelay, parseCleanDirCron, cleanDirSchedule, cleanDirNextScheduledDelay,
    cleanDirMaxSize, cleanDirTargetRatio, cleanDirTargetSize,
} = require('./CacheSchedule');

// Очистка кешей книг и обложек: по расписанию, после подготовки книги и по кнопке админа.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
    effectiveBookCacheSize() {
        const bookCacheSize = cleanDirMaxSize(this.config.bookCacheSize);
        if (bookCacheSize !== null)
            return bookCacheSize;

        return cleanDirMaxSize(this.config.maxFilesDirSize);
    },

    cacheCleanTargetRatio() {
        return cleanDirTargetRatio(this.config.cacheCleanTargetRatio);
    },

    cacheCleanNextScheduledDelay(now = new Date()) {
        try {
            return cleanDirNextScheduledDelay(this.config, now);
        } catch(e) {
            log(LM_ERR, `cacheCleanSchedule: ${e.message}`);
            return cleanDirNextAlignedDelay(this.config, now);
        }
    },

    cacheCleanNextRunAt(now = new Date()) {
        const delay = this.cacheCleanNextScheduledDelay(now);
        if (delay === null)
            return '';

        return new Date(now.getTime() + delay).toISOString();
    },

    cacheDirConfig(kind = 'all') {
        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        const targetRatio = this.cacheCleanTargetRatio();
        const result = [];
        const bookMaxSize = this.effectiveBookCacheSize();
        if ((normalizedKind === 'all' || normalizedKind === 'book') && bookMaxSize !== null && bookMaxSize > 0) {
            result.push({
                id: 'book',
                title: t('settings.admin.bookCache'),
                dir: this.config.bookDir,
                maxSize: bookMaxSize,
                targetRatio,
            });
        }

        const coverMaxSize = cleanDirMaxSize(this.config.coverCacheSize);
        if ((normalizedKind === 'all' || normalizedKind === 'cover') && coverMaxSize !== null && coverMaxSize > 0) {
            result.push({
                id: 'cover',
                title: t('settings.admin.coverCache'),
                dir: this.config.coverDir || `${this.config.publicFilesDir}/cover`,
                maxSize: coverMaxSize,
                targetRatio,
            });
        }

        return result;
    },

    async runCacheClean(reason = 'manual', options = {}) {
        if (this.cacheCleanRunning)
            return {skipped: true, reason: 'already-running'};

        this.cacheCleanRunning = true;
        try {
            const result = [];
            for (const config of this.cacheDirConfig(options.kind || 'all')) {
                try {
                    result.push(await this.cleanDir(Object.assign({}, config, {
                        forceTarget: options.forceTarget === true,
                    })));
                } catch(e) {
                    log(LM_ERR, e.stack || e.message);
                    result.push({
                        id: config.id || '',
                        title: config.title || '',
                        dir: config.dir,
                        error: e.message,
                    });
                }
            }

            if (reason)
                this.addAdminEvent('info', 'cache', msg('admin.cacheCleaned', {reason}), {result});

            return {cleaned: result};
        } finally {
            this.cacheCleanRunning = false;
        }
    },

    scheduleCacheClean(reason = 'deferred', delay = 10*60*1000) {
        //очистка включена интервалом или cron-расписанием: при одном расписании интервал равен 0
        if (this.cacheCleanTimer || this.cacheCleanNextScheduledDelay() === null)
            return;

        this.cacheCleanTimer = setTimeout(async() => {
            this.cacheCleanTimer = null;
            try {
                await this.runCacheClean(reason);
            } catch(e) {
                log(LM_ERR, e.stack || e.message);
            }
        }, Math.max(60*1000, delay));
    },

    async runAdminCacheCleanKind(userId = '', profileAccessToken = '', kind = 'all') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalizedKind = String(kind || 'all').trim().toLowerCase();
        if (!['all', 'book', 'cover'].includes(normalizedKind))
            throw new Error(t('errors.unknownCache'));

        return await this.runCacheClean(msg('admin.cleanReasonManual'), {
            kind: normalizedKind,
            forceTarget: true,
        });
    },

    normalizeAdminCachePatch(patch = {}) {
        const normalized = {};
        const mb = 1024*1024;

        const sizeFromMb = (value, fallback) => {
            const mbValue = parseFloat(value);
            if (!Number.isFinite(mbValue))
                return fallback;

            return Math.round(Math.max(1, mbValue) * mb);
        };

        if (utils.hasProp(patch, 'bookCacheSizeMb')) {
            const current = this.effectiveBookCacheSize() || 2048*mb;
            normalized.bookCacheSize = sizeFromMb(patch.bookCacheSizeMb, current);
            normalized.maxFilesDirSize = normalized.bookCacheSize;
        }

        if (utils.hasProp(patch, 'coverCacheSizeMb')) {
            const current = cleanDirMaxSize(this.config.coverCacheSize) || 512*mb;
            normalized.coverCacheSize = sizeFromMb(patch.coverCacheSizeMb, current);
        }

        if (utils.hasProp(patch, 'cacheCleanIntervalMinutes')) {
            const minutes = parseFloat(patch.cacheCleanIntervalMinutes);
            if (Number.isFinite(minutes))
                normalized.cacheCleanInterval = Math.max(0, Math.round(minutes));
        }

        if (utils.hasProp(patch, 'cacheCleanSchedule')) {
            const schedule = String(patch.cacheCleanSchedule || '').trim();
            if (schedule)
                parseCleanDirCron(schedule);

            normalized.cacheCleanSchedule = schedule;
        }

        if (utils.hasProp(patch, 'cacheCleanTargetPercent')) {
            const percent = parseFloat(patch.cacheCleanTargetPercent);
            if (Number.isFinite(percent))
                normalized.cacheCleanTargetRatio = Math.max(0.1, Math.min(1, percent / 100));
        }

        return normalized;
    },

    async updateAdminCacheConfig(userId = '', profileAccessToken = '', patch = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminCachePatch(patch || {});
        if (Object.keys(normalized).length)
            await this.saveRuntimeConfigPatch(normalized);

        this.addAdminEvent('info', 'settings', msg('admin.cacheRotationUpdated'), normalized);
        return {
            cache: {
                bookCacheSize: this.effectiveBookCacheSize(),
                coverCacheSize: cleanDirMaxSize(this.config.coverCacheSize),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio: this.cacheCleanTargetRatio(),
                fromEnv: this.adminEnvKeys('cache'),
            },
        };
    },

    async cleanDir(config) {
        const {dir} = config;
        const maxSize = cleanDirMaxSize(config.maxSize);
        const targetRatio = cleanDirTargetRatio(config.targetRatio);
        const targetSize = (maxSize === null ? null : cleanDirTargetSize(maxSize, config.targetSize, targetRatio));
        const result = {
            id: config.id || '',
            title: config.title || '',
            dir,
            maxSize,
            targetSize,
            targetRatio,
            forceTarget: config.forceTarget === true,
            exists: false,
            found: 0,
            removed: 0,
            size: 0,
            after: 0,
            overLimit: false,
        };
        if (!dir || maxSize === null)
            return result;

        if (!await fs.pathExists(dir))
            return result;

        result.exists = true;
        const list = await fs.readdir(dir);

        let size = 0;
        let files = [];
        //формируем список
        for (const filename of list) {
            const filePath = `${dir}/${filename}`;
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;//файл удалён во время обхода или битая ссылка
            }
            if (!stat.isDirectory()) {
                size += stat.size;
                files.push({name: filePath, stat});
            }
        }

        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        const initialSize = size;
        result.found = files.length;
        result.size = initialSize;
        result.overLimit = initialSize > maxSize;
        let i = 0;
        //удаляем
        while ((result.overLimit || result.forceTarget) && i < files.length && size > targetSize) {
            const file = files[i];
            const oldFile = file.name;
            try {
                await fs.remove(oldFile);
            } catch (e) {
                log(LM_ERR, `clean dir ${dir}, remove ${oldFile}: ${e.message}`);
            }
            size -= file.stat.size;
            i++;
        }

        if (i) {
            log(LM_WARN, `clean dir ${dir}, maxSize=${maxSize}, targetSize=${targetSize}, found ${files.length} files, total size=${initialSize}, after=${size}`);
            log(LM_WARN, `removed ${i} files`);
        }

        result.removed = i;
        result.after = size;
        return result;
    },

    async periodicCleanDir() {
        try {
            for (const config of this.cacheDirConfig())
                await fs.ensureDir(config.dir);
        } catch (e) {
            log(LM_FATAL, e.message);
            asyncExit.exit(1);
            return;
        }

        while (1) {// eslint-disable-line no-constant-condition
            try {
                const delay = this.cacheCleanNextScheduledDelay();
                if (delay === null) {
                    await utils.sleep(60*1000);
                } else if (delay <= 1000) {
                    await this.runCacheClean(msg('admin.cleanReasonScheduled'));

                    await utils.sleep(60*1000);
                } else {
                    await utils.sleep(Math.min(delay, 60*1000));//интервал проверки не чаще 1 минуты
                }
            } catch (e) {
                //сбой одной очистки не должен останавливать сервер
                log(LM_ERR, `periodicCleanDir: ${e.stack || e.message}`);
                await utils.sleep(60*1000);
            }
        }
    },
};
