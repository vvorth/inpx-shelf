const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');

const bookAssets = require('./BookAssets');
const runtimeMetrics = require('./RuntimeMetrics');
const log = new (require('./AppLogger'))().log;//singleton
const utils = require('./utils');
const libraryFs = require('./LibraryFs');
const ConfigManager = require('../config');
const {withFileTransaction} = require('./FilePersistence');
const {getEnabledLibrarySources, getAllLibrarySources, normalizeRemoteSource} = require('./LibrarySources');
const remoteAccess = require('./RemoteAccess');
const BookConverter = require('./BookConverter');
const i18n = require('./i18n');
const {t, msg} = i18n;
const {cleanDirSchedule, cleanDirMaxSize, cleanDirTargetSize} = require('./CacheSchedule');

//Имена переменных окружения для ключей, которые админка показывает закрытыми; задан ли ключ,
//решает ConfigManager.applyEnvOverrides - правила разбора только там
const ENV_VARS = {
    integrations: {
        telegramShareEnabled: ['TELEGRAM_BOT_TOKEN'],
        telegramBotToken: ['TELEGRAM_BOT_TOKEN'],
        telegramChatId: ['TELEGRAM_CHAT_ID'],
        telegramCaptionTemplate: ['TELEGRAM_CAPTION_TEMPLATE'],
        emailShareEnabled: ['SMTP_HOST'],
        smtpHost: ['SMTP_HOST'],
        smtpPort: ['SMTP_PORT'],
        smtpSecure: ['SMTP_SECURE'],
        smtpUser: ['SMTP_USER'],
        smtpPass: ['SMTP_PASS'],
        emailFrom: ['EMAIL_FROM', 'SMTP_USER'],
        emailTo: ['EMAIL_TO'],
    },
    opds: {
        lang: ['INPX_OPDS_LANG'],
    },
    cache: {
        bookCacheSize: ['INPX_BOOK_CACHE_SIZE', 'INPX_BOOK_CACHE_SIZE_MB'],
        coverCacheSize: ['INPX_COVER_CACHE_SIZE', 'INPX_COVER_CACHE_SIZE_MB'],
        cacheCleanInterval: ['INPX_CACHE_CLEAN_INTERVAL_MINUTES'],
        cacheCleanTargetRatio: ['INPX_CACHE_CLEAN_TARGET_RATIO'],
    },
    sync: {
        koboEnabled: ['INPX_KOBO_ENABLED'],
        koboPublicUrl: ['INPX_KOBO_PUBLIC_URL'],
        kosyncEnabled: ['INPX_KOSYNC_ENABLED'],
        conversionEnabled: ['INPX_ENABLE_CONVERSION'],
        conversionFormats: ['INPX_CONVERSION_FORMATS'],
    },
};

//Файлы каталога и его подкаталогов (на диске или в S3); каталоги, которые не прочитать, пропускаются
async function* walkFiles(dir) {
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let list;
        try {
            list = await libraryFs.readdir(current, {withFileTypes: true});
        } catch (e) {
            continue;
        }

        for (const entry of list) {
            const filePath = libraryFs.join(current, entry.name);
            if (entry.isDirectory())
                stack.push(filePath);
            else
                yield filePath;
        }
    }
}

// Панель администратора: показатели и журнал событий, источники библиотеки, обложки, переиндексация,
// настройки доставки, OPDS и общей витрины с записью в config.json.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
    //{ключ: переменная} для ключей группы, которые сейчас задаёт окружение
    adminEnvKeys(group) {
        const overrides = ConfigManager.applyEnvOverrides({});
        const values = (group === 'opds' ? overrides.opds || {} : overrides);
        const result = {};
        for (const [key, names] of Object.entries(ENV_VARS[group])) {
            if (utils.hasProp(values, key))
                result[key] = names.find(name => process.env[name]) || names[0];
        }
        return result;
    },

    async updateSharedDiscoveryConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const discovery = await this.readingListStore.updateSharedDiscoveryConfig(patch || {});
        this.sharedDiscoveryConfig = _.cloneDeep(discovery);
        return {discovery};
    },

    getAdminIntegrationConfig() {
        const hasTelegramToken = !!String(this.config.telegramBotToken || '').trim();
        const hasSmtpPassword = !!String(this.config.smtpPass || '').trim();

        return {
            telegramShareEnabled: !!this.config.telegramShareEnabled,
            telegramBotToken: hasTelegramToken ? '__KEEP__' : '',
            telegramBotTokenSet: hasTelegramToken,
            telegramChatId: String(this.config.telegramChatId || ''),
            telegramCaptionTemplate: String(this.config.telegramCaptionTemplate || '${AUTHOR} - ${TITLE}'),
            emailShareEnabled: !!this.config.emailShareEnabled,
            smtpHost: String(this.config.smtpHost || ''),
            smtpPort: parseInt(this.config.smtpPort, 10) || 587,
            smtpSecure: !!this.config.smtpSecure,
            smtpUser: String(this.config.smtpUser || ''),
            smtpPass: hasSmtpPassword ? '__KEEP__' : '',
            smtpPassSet: hasSmtpPassword,
            emailFrom: String(this.config.emailFrom || ''),
            emailTo: String(this.config.emailTo || ''),
            fromEnv: this.adminEnvKeys('integrations'),
        };
    },

    getAdminOpdsConfig() {
        const opds = this.config.opds || {};
        const hasPassword = !!String(opds.password || '').trim();
        return {
            enabled: opds.enabled !== false,
            root: String(opds.root || '/opds'),
            user: String(opds.user || ''),
            password: hasPassword ? '__KEEP__' : '',
            passwordSet: hasPassword,
            lang: String(opds.lang || ''),
            guestAccess: opds.guestAccess === true,
            //переменная окружения задаёт значение при каждом запуске: переключатель в админке закрыт
            guestAccessFromEnv: utils.hasProp(process.env, 'INPX_OPDS_GUEST_ACCESS'),
            fromEnv: this.adminEnvKeys('opds'),
        };
    },

    //синхронизация читалек и конвертация: включение Kobo и KOReader регистрирует маршруты при запуске
    getAdminSyncConfig() {
        return {
            koboEnabled: this.config.koboEnabled === true,
            koboPublicUrl: String(this.config.koboPublicUrl || ''),
            kosyncEnabled: this.config.kosyncEnabled === true,
            conversionEnabled: this.config.conversionEnabled !== false,
            conversionFormats: (Array.isArray(this.config.conversionFormats) ? this.config.conversionFormats : []),
            availableFormats: BookConverter.targetFormats,
            fromEnv: this.adminEnvKeys('sync'),
        };
    },

    normalizeAdminSyncPatch(patch = {}) {
        const normalized = {};
        for (const key of ['koboEnabled', 'kosyncEnabled', 'conversionEnabled']) {
            if (utils.hasProp(patch, key))
                normalized[key] = (patch[key] === true);
        }
        if (utils.hasProp(patch, 'koboPublicUrl')) {
            const value = String(patch.koboPublicUrl || '').trim().replace(/\/+$/, '');
            if (value) {
                let url = null;
                try {
                    url = new URL(value);
                } catch (e) {
                    //
                }
                //те же требования, что у KoboService.publicBase: иначе устройства получат негодную ссылку
                if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                    throw new Error(t('errors.koboPublicUrlInvalid'));
            }
            normalized.koboPublicUrl = value;
        }
        if (utils.hasProp(patch, 'conversionFormats')) {
            const list = (Array.isArray(patch.conversionFormats) ? patch.conversionFormats : String(patch.conversionFormats || '').split(','));
            normalized.conversionFormats = BookConverter.targetFormats.filter(format => list.map(item => String(item || '').trim().toLowerCase()).includes(format));
        }
        return normalized;
    },

    async updateAdminSyncConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminSyncPatch(patch || {});
        await this.saveRuntimeConfigPatch(normalized);
        this.addAdminEvent('info', 'settings', msg('admin.syncSettingsUpdated'));

        return {sync: this.getAdminSyncConfig()};
    },

    getAdminGuestAccess() {
        return {
            guestAccess: this.config.guestAccess === true,
            guestAccessFromEnv: utils.hasProp(process.env, 'INPX_GUEST_ACCESS'),
        };
    },

    renderAdminEvent(event = {}) {
        return Object.assign({}, event, {message: i18n.render(event.message)});
    },

    addAdminEvent(level = 'info', category = 'system', message = '', details = {}) {
        if (this.config.adminEventLogEnabled === false)
            return null;

        const maxEvents = Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300));
        const event = {
            id: `${Date.now()}-${utils.randomHexString(6)}`,
            time: new Date().toISOString(),
            level: String(level || 'info'),
            category: String(category || 'system'),
            //текст события - описание {key, params} (переводится при выдаче) или готовая строка (например, из лога)
            message: (message && typeof message === 'object' ? message : String(message || '')),
            details: details || {},
        };

        this.adminEvents.push(event);
        if (this.adminEvents.length > maxEvents)
            this.adminEvents.splice(0, this.adminEvents.length - maxEvents);

        return event;
    },

    async dirSize(dir = '', maxFiles = 20000) {
        const result = {path: dir, exists: false, size: 0, files: 0, truncated: false};
        if (!dir || !await fs.pathExists(dir))
            return result;

        result.exists = true;
        //путь к файлу (например, БД библиотеки) - его размер
        const own = await fs.stat(dir).catch(() => null);
        if (own && own.isFile())
            return Object.assign(result, {size: own.size, files: 1});

        for await (const filePath of walkFiles(dir)) {
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;
            }
            if (stat.isDirectory())
                continue;

            result.files++;
            result.size += stat.size;
            if (result.files >= maxFiles) {
                result.truncated = true;
                return result;
            }
        }

        return result;
    },

    async findFilesByExt(dir = '', exts = [], maxFiles = 200) {
        const result = [];
        const normalizedExts = new Set(exts.map(ext => String(ext || '').toLowerCase()));
        if (!dir || !await libraryFs.pathExists(dir))
            return result;

        for await (const filePath of walkFiles(dir)) {
            if (normalizedExts.has(path.extname(filePath).toLowerCase()))
                result.push(filePath);
            if (result.length >= maxFiles)
                break;
        }

        return result;
    },

    async countArchives(dir = '', maxFiles = 20000) {
        const result = {count: 0, truncated: false};
        if (!dir || !await libraryFs.pathExists(dir))
            return result;

        for await (const filePath of walkFiles(dir)) {
            if (['.zip', '.7z', '.fb2', '.epub'].includes(path.extname(filePath).toLowerCase()))
                result.count++;
            if (result.count >= maxFiles) {
                result.truncated = true;
                return result;
            }
        }

        return result;
    },

    async getLibrarySourceDiagnostics(source = {}) {
        const libDir = String(source.libDir || '').trim();
        const inpx = String(source.inpx || source.inpxFile || '').trim();
        const foundInpx = libDir ? await this.findFilesByExt(libDir, ['.inpx'], 20) : [];
        const archiveInfo = libDir ? await this.countArchives(libDir) : {count: 0, truncated: false};
        const exists = async(name) => !!(libDir && await libraryFs.pathExists(libraryFs.join(libDir, name)));

        return {
            inpxExists: !!inpx && await libraryFs.pathExists(inpx),
            libDirExists: !!libDir && await libraryFs.pathExists(libDir),
            foundInpx,
            archiveCount: archiveInfo.count,
            archiveCountTruncated: archiveInfo.truncated,
            hasCovers: await exists('covers'),
            hasEtc: await exists('etc'),
            hasImages: await exists('images'),
        };
    },

    async cleanBrokenCoverCacheFiles(dir = '') {
        const result = {dir, removed: 0, checked: 0};
        if (!dir || !await fs.pathExists(dir))
            return result;

        const allowed = new Set(['.png', '.jpg', '.gif']);
        const list = await fs.readdir(dir);
        for (const name of list) {
            const filePath = path.join(dir, name);
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch (e) {
                continue;
            }

            if (stat.isDirectory())
                continue;

            result.checked++;
            const broken = stat.size <= 0 || !allowed.has(path.extname(name).toLowerCase());
            if (!broken)
                continue;

            await fs.remove(filePath);
            result.removed++;
        }

        return result;
    },

    async buildAdminDashboardMetrics(index = null, dbConfig = null) {
        index = index || await this.getIndexStatus();
        dbConfig = dbConfig || (index.ready ? await this.dbConfig() : {});
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const coverSize = await this.dirSize(coverDir);
        const bookCacheSize = this.effectiveBookCacheSize();
        const coverCacheSize = cleanDirMaxSize(this.config.coverCacheSize);
        const cacheCleanTargetRatio = this.cacheCleanTargetRatio();
        const uptime = process.uptime();
        const cpuUsage = process.cpuUsage();
        const cpuTotalMicros = cpuUsage.user + cpuUsage.system;
        const cpuTotalSeconds = cpuTotalMicros / 1000000;
        const cpuNow = Date.now();
        const previousCpuSnapshot = this.adminCpuSnapshot || null;
        const cpuElapsedSeconds = previousCpuSnapshot ? Math.max(0, (cpuNow - previousCpuSnapshot.at) / 1000) : 0;
        const cpuCurrentPercent = (previousCpuSnapshot && cpuElapsedSeconds > 0)
            ? ((cpuTotalMicros - previousCpuSnapshot.totalMicros) / 1000000 / cpuElapsedSeconds) * 100
            : null;

        this.adminCpuSnapshot = {
            at: cpuNow,
            totalMicros: cpuTotalMicros,
        };

        return {
            generatedAt: new Date().toISOString(),
            uptime,
            memory: process.memoryUsage(),
            cpu: {
                userSeconds: cpuUsage.user / 1000000,
                systemSeconds: cpuUsage.system / 1000000,
                totalSeconds: cpuTotalSeconds,
                currentPercent: cpuCurrentPercent,
                averagePercent: uptime > 0 ? (cpuTotalSeconds / uptime) * 100 : 0,
            },
            runtime: runtimeMetrics.getSnapshot(),
            discovery: await this.readingListStore.getDiscoveryMetrics(),
            index,
            stats: (dbConfig && dbConfig.stats) || (index && index.stats) || {},
            paths: {
                dataDir: this.config.dataDir,
                db: this.catalogSearch.file,
                bookCache: this.config.bookDir,
                coverCache: coverDir,
                tempDir: this.config.tempDir,
            },
            sizes: {
                db: await this.dirSize(this.catalogSearch.file),
                bookCache: await this.dirSize(this.config.bookDir),
                coverCache: coverSize,
                tempDir: await this.dirSize(this.config.tempDir, 5000),
            },
            limits: {
                maxFilesDirSize: this.config.maxFilesDirSize,
                bookCacheSize,
                bookCacheTargetSize: (bookCacheSize === null ? null : cleanDirTargetSize(bookCacheSize, null, cacheCleanTargetRatio)),
                coverCacheSize,
                coverCacheTargetSize: (coverCacheSize === null ? null : cleanDirTargetSize(coverCacheSize, null, cacheCleanTargetRatio)),
                cacheCleanInterval: this.config.cacheCleanInterval,
                cacheCleanSchedule: cleanDirSchedule(this.config) || '',
                cacheCleanNextRunAt: this.cacheCleanNextRunAt(),
                cacheCleanServerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                cacheCleanTargetRatio,
                fromEnv: this.adminEnvKeys('cache'),
            },
        };
    },

    async getAdminDashboardMetrics(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        return await this.buildAdminDashboardMetrics();
    },

    async getAdminDashboard(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const index = await this.getIndexStatus();
        const dbConfig = (index.ready ? await this.dbConfig() : {});
        const metrics = await this.buildAdminDashboardMetrics(index, dbConfig);
        //все источники, включая выключенные: иначе выключенный пропадает из списка в админке
        const configured = (Array.isArray(this.config.librarySources) && this.config.librarySources.length ? this.config.librarySources : getEnabledLibrarySources(this.config));
        //удалённая библиотека: токен в админку не уходит, только признак, что он задан
        const sources = await Promise.all(configured.map(async(source) => (source.remote ? {
            id: source.id || '',
            name: source.name || '',
            enabled: source.enabled !== false,
            remote: {url: source.remote.url || '', source: source.remote.source || '', tokenSet: !!source.remote.token},
            inpxExists: !!source.inpxFile && await fs.pathExists(source.inpxFile),
        } : Object.assign({
            id: source.id || '',
            name: source.name || '',
            enabled: source.enabled !== false,
            inpx: source.inpx || source.inpxFile || '',
            libDir: source.libDir || '',
        }, await this.getLibrarySourceDiagnostics(source)))));
        const coverErrors = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse())
            .filter(event => {
                if (event.level !== 'error')
                    return false;

                const text = `${event.category || ''} ${i18n.render(event.message)}`.toLowerCase();
                return text.includes('cover') || text.includes('облож') || /\bimage\s+\S+:/i.test(text);//i18n-ignore: поиск по тексту лога
            })
            .slice(0, 8);
        const state = this.serverState || {};

        return Object.assign({}, metrics, {
            //файлы данных, которые не читаются: запись в них отклоняется до решения администратора
            userDataBlocked: [this.readingListStore.blockedState(), this.koboService && this.koboService.store.blockedState()].filter(Boolean),
            sources,
            covers: {
                dir: metrics.paths.coverCache,
                size: metrics.sizes.coverCache.size,
                files: metrics.sizes.coverCache.files,
                limit: metrics.limits.coverCacheSize,
                targetSize: metrics.limits.coverCacheTargetSize,
                latestErrors: coverErrors,
            },
            tasks: [
                {
                    id: 'index',
                    title: t('admin.taskIndexing'),
                    active: state.state === 'db_creating' || state.state === 'db_loading',
                    state: state.state,
                    message: i18n.render(state.jobMessage || state.serverMessage || ''),
                    progress: state.progress || 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => event.category === 'index' && event.level === 'error') || {}).message),
                    cancellable: false,
                },
                {
                    id: 'cache',
                    title: t('admin.taskCacheClean'),
                    active: false,
                    state: 'idle',
                    message: t('admin.taskCacheCleanMessage'),
                    progress: 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => event.category === 'cache' && event.level === 'error') || {}).message),
                    cancellable: false,
                },
                {
                    id: 'delivery',
                    title: t('admin.taskDelivery'),
                    active: false,
                    state: 'events',
                    message: t('admin.taskDeliveryMessage'),
                    progress: 0,
                    lastError: i18n.render((this.adminEvents.slice().reverse().find(event => ['delivery', 'conversion'].includes(event.category) && event.level === 'error') || {}).message),
                    cancellable: false,
                },
            ],
        });
    },

    async getAdminEvents(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const level = String(options.level || 'all').trim();
        const category = String(options.category || 'all').trim();
        const limit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 80));
        let events = (this.config.adminEventLogEnabled === false ? [] : this.adminEvents.slice().reverse());
        if (level !== 'all')
            events = events.filter(event => event.level === level);
        if (category !== 'all')
            events = events.filter(event => event.category === category);

        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: Math.max(1, Math.min(2000, parseInt(this.config.adminEventLogSize, 10) || 300)),
            events: events.slice(0, limit).map(event => this.renderAdminEvent(event)),
        };
    },

    async addAdminTestEvent(userId = '', profileAccessToken = '', level = 'warn') {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = String(level || 'warn').toLowerCase() === 'error' ? 'error' : 'warn';
        log(normalized === 'error' ? LM_ERR : LM_WARN, `Admin event log test: ${normalized}`);
        return {success: true};
    },

    async updateAdminEventLog(userId = '', profileAccessToken = '', options = {}) {
        await this.requireAdmin(userId, profileAccessToken);

        const patch = {
            adminEventLogEnabled: options.enabled !== false,
            adminEventLogSize: Math.max(20, Math.min(2000, parseInt(options.maxSize, 10) || 300)),
        };
        await this.saveRuntimeConfigPatch(patch);
        if (this.adminEvents.length > patch.adminEventLogSize)
            this.adminEvents.splice(0, this.adminEvents.length - patch.adminEventLogSize);
        this.addAdminEvent('info', 'settings', msg(patch.adminEventLogEnabled ? 'admin.eventLogEnabled' : 'admin.eventLogDisabled'));
        return {
            enabled: this.config.adminEventLogEnabled !== false,
            maxSize: patch.adminEventLogSize,
        };
    },

    //токен удалённой библиотеки: пустой или __KEEP__ - прежний токен источника с тем же id
    remoteTokenFor(id, token = '') {
        const value = String(token || '').trim();
        if (value && value !== '__KEEP__')
            return value;
        const current = (this.config.librarySources || []).find(item => item && item.remote && item.id === id);
        return (current ? current.remote.token : '');
    },

    normalizeAdminLibrarySources(sources = []) {
        return (Array.isArray(sources) ? sources : [])
            .map((source, index) => {
                if (source.remote && typeof(source.remote) === 'object') {
                    const normalized = normalizeRemoteSource(source, index, this.config.dataDir);
                    normalized.remote.token = this.remoteTokenFor(normalized.id, source.remote.token);
                    return (normalized.remote.url && normalized.remote.source ? normalized : null);
                }
                const inpx = String(source.inpx || source.inpxFile || '').trim();
                const libDir = String(source.libDir || '').trim();
                const name = String(source.name || '').trim() || path.basename(inpx, path.extname(inpx)) || `Library ${index + 1}`;
                const idBase = String(source.id || name || `source-${index + 1}`)
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]+/gi, '-')
                    .replace(/^-+|-+$/g, '')
                    .substring(0, 40) || `source-${index + 1}`;

                return {
                    id: idBase,
                    name,
                    inpx,
                    inpxFile: inpx,
                    libDir,
                    enabled: source.enabled !== false,
                };
            })
            .filter(source => source && (source.remote || source.inpx || source.libDir));
    },

    async updateAdminLibrarySources(userId = '', profileAccessToken = '', sources = []) {
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeAdminLibrarySources(sources);
        if (!normalized.length)
            throw new Error(t('errors.sourcesRequired'));
        if (!normalized.some(source => source.enabled !== false))
            throw new Error(t('errors.sourcesEnabledRequired'));

        await this.saveRuntimeConfigPatch({librarySources: normalized});
        for (const source of normalized.filter(item => item.remote))
            await fs.ensureDir(source.libDir);
        //новый INPX удалённой библиотеки нужен до сравнения хешей ниже
        if (normalized.some(item => item.remote))
            await this.remoteLib.syncAll();
        //пересборка нужна, только если изменился набор библиотек или содержимое INPX (тот же хеш, что у индекса),
        //или включена библиотека, которой нет в индексе; включение, название и папка применяются сразу
        let reindexNeeded = true;
        try {
            const indexed = await this.catalogSearch.applySourceVisibility();
            const hash = await this.inpxHashCreator.getHash();
            reindexNeeded = !indexed || hash !== String(this.catalogSearch.libraryConfig().buildHash || '');
        } catch (e) {
            log(LM_WARN, `Library sources visibility: ${e.message}`);
        }
        this.addAdminEvent('info', 'sources', msg('admin.sourcesUpdated', {n: normalized.length}));
        return {sources: normalized, reindexNeeded};
    },

    async diagnoseLibrarySource(userId = '', profileAccessToken = '', source = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        if (source.remote && typeof(source.remote) === 'object') {
            const {sources} = await this.listRemoteLibrarySources(userId, profileAccessToken, Object.assign({id: source.id}, source.remote));
            return {remoteSources: sources, remoteSourceFound: sources.some(item => item.id === String(source.remote.source || '').trim())};
        }
        return await this.getLibrarySourceDiagnostics(source);
    },

    //Библиотеки, которые токен открывает на сервере remote.url; id - источник, чей сохранённый токен взять
    async listRemoteLibrarySources(userId = '', profileAccessToken = '', remote = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        const url = String(remote.url || '').trim();
        if (!/^https?:\/\/[^/]/i.test(url))
            throw new Error(t('errors.remoteLibraryUrl'));
        const token = this.remoteTokenFor(String(remote.id || ''), remote.token);
        return {sources: await this.remoteLib.listSources({url, token})};
    },

    //---------- доступ других серверов к библиотекам этого (/remote/) ----------
    remoteAccessView(item) {
        return {id: item.id, name: item.name, sources: item.sources || [], createdAt: item.createdAt || ''};
    },

    async getRemoteAccess(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        return {
            items: (this.config.remoteAccess || []).map(item => this.remoteAccessView(item)),
            sources: getAllLibrarySources(this.config).filter(source => !source.remote).map(source => ({id: source.id, name: source.name, enabled: source.enabled})),
            path: remoteAccess.rootPath(this.config),
        };
    },

    normalizeRemoteAccess(access = {}) {
        const local = new Set(getAllLibrarySources(this.config).filter(source => !source.remote).map(source => source.id));
        const name = String(access.name || '').trim().slice(0, 100);
        if (!name)
            throw new Error(t('errors.remoteAccessName'));
        return {name, sources: [...new Set((Array.isArray(access.sources) ? access.sources : []).map(String))].filter(id => local.has(id))};
    },

    async createRemoteAccess(userId = '', profileAccessToken = '', access = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        const token = remoteAccess.newToken();
        const item = Object.assign({id: utils.randomHexString(8)}, this.normalizeRemoteAccess(access),
            {hash: remoteAccess.hashToken(token), createdAt: new Date().toISOString()});
        await this.saveRuntimeConfigPatch({remoteAccess: [...(this.config.remoteAccess || []), item]});
        this.addAdminEvent('info', 'settings', msg('admin.remoteAccessCreated', {name: item.name}));
        //токен показывается один раз: хранится только его хеш
        return Object.assign(await this.getRemoteAccess(userId, profileAccessToken), {token, created: this.remoteAccessView(item)});
    },

    async updateRemoteAccess(userId = '', profileAccessToken = '', access = {}) {
        await this.requireAdmin(userId, profileAccessToken);
        const list = this.config.remoteAccess || [];
        if (!list.some(item => item.id === access.id))
            throw new Error(t('errors.remoteAccessNotFound'));
        const patch = this.normalizeRemoteAccess(access);
        await this.saveRuntimeConfigPatch({remoteAccess: list.map(item => (item.id === access.id ? Object.assign({}, item, patch) : item))});
        return await this.getRemoteAccess(userId, profileAccessToken);
    },

    async deleteRemoteAccess(userId = '', profileAccessToken = '', id = '') {
        await this.requireAdmin(userId, profileAccessToken);
        const list = this.config.remoteAccess || [];
        const item = list.find(entry => entry.id === id);
        if (item) {
            await this.saveRuntimeConfigPatch({remoteAccess: list.filter(entry => entry.id !== id)});
            this.addAdminEvent('info', 'settings', msg('admin.remoteAccessDeleted', {name: item.name}));
        }
        return await this.getRemoteAccess(userId, profileAccessToken);
    },

    async cleanBrokenCoverCache(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);

        const result = await this.cleanBrokenCoverCacheFiles(this.config.coverDir || `${this.config.publicFilesDir}/cover`);
        this.addAdminEvent('info', 'cover', msg('admin.brokenCoversCleaned', {n: result.removed}), result);
        return result;
    },

    async rebuildCoverCacheForBook(userId = '', profileAccessToken = '', bookUid = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        const book = await this.getBookRecordByUid(bookUid);
        if (!book)
            throw new Error(t('errors.bookNotFound'));

        const libid = parseInt(book.libid, 10);

        const sourceId = String(book.sourceId || '').trim();
        const cacheBase = bookAssets.coverCacheKey(book, this.config);
        const coverDir = this.config.coverDir || `${this.config.publicFilesDir}/cover`;
        const removed = [];
        for (const ext of ['.png', '.jpg', '.gif']) {
            const filePath = path.join(coverDir, `${cacheBase}${ext}`);
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                removed.push(filePath);
            }
        }

        const coverUrl = `${this.config.rootPathStatic || ''}/cover/by-uid?uid=${encodeURIComponent(bookUid)}`;
        this.addAdminEvent('info', 'cover', msg('admin.coverCacheReset', {title: book.title || bookUid}), {bookUid, libid, sourceId, removed});
        return {
            success: true,
            bookUid,
            libid,
            sourceId,
            removed: removed.length,
            coverUrl,
        };
    },

    //Файл данных не читается, и администратор решил начать с пустых данных вместо восстановления бэкапа;
    //копия испорченного файла остаётся рядом с ним
    async acceptUserDataReset(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        const files = [];
        if (await this.readingListStore.acceptReset())
            files.push('reading-lists.json');
        if (this.koboService && await this.koboService.store.acceptReset())
            files.push('kobo-sync.json');
        if (files.length)
            this.addAdminEvent('warn', 'settings', msg('admin.userDataReset', {files: files.join(', ')}));
        return {success: true, reset: files};
    },

    async startAdminReindex(userId = '', profileAccessToken = '') {
        await this.requireAdmin(userId, profileAccessToken);
        this.checkMyState();

        this.addAdminEvent('warn', 'index', msg('admin.reindexStarted'));
        this.recreateDb();//no await
        return {started: true};
    },

    async saveRuntimeConfigPatch(patch = {}) {
        return withFileTransaction(this.config.configFile, async() => {
            //в файл - только patch поверх его значений; в памяти patch действует после успешной записи
            await ConfigManager.savePatch(this.config, patch);
            Object.assign(this.config, patch);
            //ключ, заданный переменной окружения, админка не меняет и в памяти
            ConfigManager.applyEnvOverrides(this.config);
        });
    },

    normalizeIntegrationPatch(patch = {}) {
        const normalized = {};

        if (utils.hasProp(patch, 'telegramShareEnabled'))
            normalized.telegramShareEnabled = !!patch.telegramShareEnabled;
        if (utils.hasProp(patch, 'telegramBotToken')) {
            const token = String(patch.telegramBotToken || '').trim();
            if (token !== '__KEEP__')
                normalized.telegramBotToken = token;
        }
        if (utils.hasProp(patch, 'telegramChatId'))
            normalized.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utils.hasProp(patch, 'telegramCaptionTemplate'))
            normalized.telegramCaptionTemplate = String(patch.telegramCaptionTemplate || '').trim() || '${AUTHOR} - ${TITLE}';

        if (utils.hasProp(patch, 'emailShareEnabled'))
            normalized.emailShareEnabled = !!patch.emailShareEnabled;
        if (utils.hasProp(patch, 'smtpHost'))
            normalized.smtpHost = String(patch.smtpHost || '').trim();
        if (utils.hasProp(patch, 'smtpPort'))
            normalized.smtpPort = Math.max(1, Math.min(parseInt(patch.smtpPort, 10) || 587, 65535));
        if (utils.hasProp(patch, 'smtpSecure'))
            normalized.smtpSecure = !!patch.smtpSecure;
        if (utils.hasProp(patch, 'smtpUser'))
            normalized.smtpUser = String(patch.smtpUser || '').trim();
        if (utils.hasProp(patch, 'smtpPass')) {
            const pass = String(patch.smtpPass || '');
            if (pass !== '__KEEP__')
                normalized.smtpPass = pass;
        }
        if (utils.hasProp(patch, 'emailFrom'))
            normalized.emailFrom = String(patch.emailFrom || '').trim();
        if (utils.hasProp(patch, 'emailTo'))
            normalized.emailTo = this.readingListStore.validateEmailTo(patch.emailTo);

        return this.dropSmtpPassOnNewServer(normalized);
    },

    //сохранённый пароль SMTP привязан к серверу и логину: при их смене он не уйдёт на новый сервер
    //(проверка подключения отправила бы его туда), администратор вводит пароль заново
    dropSmtpPassOnNewServer(patch) {
        const changed = ['smtpHost', 'smtpUser'].some(key => utils.hasProp(patch, key)
            && String(patch[key] || '').trim() !== String(this.config[key] || '').trim());
        if (changed && !utils.hasProp(patch, 'smtpPass'))
            patch.smtpPass = '';
        return patch;
    },

    normalizeAdminOpdsPatch(patch = {}) {
        const current = this.config.opds || {};
        const normalized = Object.assign({}, current);

        if (utils.hasProp(patch, 'enabled'))
            normalized.enabled = (patch.enabled !== false);
        if (utils.hasProp(patch, 'root')) {
            let root = String(patch.root || '/opds').trim() || '/opds';
            if (!root.startsWith('/'))
                root = `/${root}`;
            normalized.root = root.replace(/\/+$/g, '') || '/opds';
        }
        if (utils.hasProp(patch, 'user'))
            normalized.user = String(patch.user || '').trim();
        if (utils.hasProp(patch, 'guestAccess') && !utils.hasProp(process.env, 'INPX_OPDS_GUEST_ACCESS'))
            normalized.guestAccess = (patch.guestAccess === true);
        if (utils.hasProp(patch, 'lang')) {
            const lang = String(patch.lang || '').trim().toLowerCase();
            normalized.lang = (['ru', 'en'].includes(lang) ? lang : '');
        }
        if (utils.hasProp(patch, 'password')) {
            const password = String(patch.password || '');
            if (password !== '__KEEP__')
                normalized.password = password;
        }

        if (normalized.password && !normalized.user)
            throw new Error(t('errors.opdsLoginRequired'));

        return normalized;
    },

    async updateAdminIntegrationConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalized = this.normalizeIntegrationPatch(patch || {});
        await this.saveRuntimeConfigPatch(normalized);
        this.addAdminEvent('info', 'settings', msg('admin.deliverySettingsUpdated'));

        return {integrations: this.getAdminIntegrationConfig()};
    },

    async updateAdminOpdsConfig(userId = '', profileAccessToken = '', patch = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const opds = this.normalizeAdminOpdsPatch(patch || {});
        await this.saveRuntimeConfigPatch({opds});
        this.addAdminEvent('info', 'settings', msg('admin.opdsSettingsUpdated'));

        return {opds: this.getAdminOpdsConfig()};
    },

    async updateAdminGuestAccess(userId = '', profileAccessToken = '', guestAccess = false) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        if (utils.hasProp(process.env, 'INPX_GUEST_ACCESS'))
            throw new Error(t('errors.guestAccessSetByEnv'));
        await this.saveRuntimeConfigPatch({guestAccess: guestAccess === true});
        this.addAdminEvent('info', 'settings', msg(guestAccess === true ? 'admin.guestAccessOn' : 'admin.guestAccessOff'));

        return this.getAdminGuestAccess();
    },
};
