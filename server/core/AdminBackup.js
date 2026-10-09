const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');
const yazl = require('yazl');

const utils = require('./utils');
const ConfigManager = require('../config');

// Admin settings export/import and full backups. Mixed into WebWorker.prototype: `this` is the worker.
module.exports = {
    async exportAdminSettings(userId = '', profileAccessToken = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const data = _.cloneDeep(this.config);
        const opdsSettings = Object.assign({}, data.opds || {});
        opdsSettings.passwordSet = !!String(opdsSettings.password || '').trim();
        delete opdsSettings.password;
        delete data.adminPassword;
        delete data.webConfigParams;
        delete data.inpxFileHash;

        const result = {
            exportedAt: new Date().toISOString(),
            settings: _.pick(data, this.adminSettingsExportKeys()),
        };
        result.settings.opds = opdsSettings;
        return result;
    },

    adminSettingsExportKeys() {
        return [
            'libDir',
            'inpx',
            'librarySources',
            'inpxFilterFile',
            'extendedSearch',
            'bookReadLink',
            'loggingEnabled',
            'logServerStats',
            'logQueries',
            'loginRateLimitEnabled',
            'loginRateLimitWindowMs',
            'loginRateLimitMaxAttempts',
            'requireAuth',
            'allowAnonymousAccess',
            'proxyBindProfile',
            'authMode',
            'trustProxy',
            'proxyAuthHeader',
            'trustedProxyCidrs',
            'authExemptHealth',
            'metricsEnabled',
            'metricsPath',
            'metricsExemptAuth',
            'dbCacheSize',
            'maxFilesDirSize',
            'bookCacheSize',
            'coverCacheSize',
            'queryCacheEnabled',
            'queryCacheMemSize',
            'queryCacheDiskSize',
            'cacheCleanInterval',
            'cacheCleanTargetRatio',
            'adminEventLogEnabled',
            'adminEventLogSize',
            'inpxCheckInterval',
            'lowMemoryMode',
            'fullOptimization',
            'converterPaths',
            'server',
            'opds',
            'telegramShareEnabled',
            'telegramChatId',
            'telegramCaptionTemplate',
            'emailShareEnabled',
            'smtpHost',
            'smtpPort',
            'smtpSecure',
            'smtpUser',
            'emailFrom',
            'emailTo',
            'discovery',
            'uiDefaults',
        ];
    },

    normalizeImportedAdminSettings(payload = {}) {
        require('./RequestLimits').checkImport(payload, this.config);
        const source = (payload && payload.settings && typeof payload.settings === 'object')
            ? payload.settings
            : payload;
        if (!source || typeof source !== 'object' || Array.isArray(source))
            throw new Error('Файл настроек имеет неверный формат');

        const patch = _.pick(_.cloneDeep(source), this.adminSettingsExportKeys());
        if (!Object.keys(patch).length)
            throw new Error('В файле не найдены настройки для восстановления');

        if (patch.opds && typeof patch.opds === 'object') {
            const currentOpds = this.config.opds || {};
            const opds = Object.assign({}, currentOpds, patch.opds);
            if (utils.hasProp(opds, 'passwordSet'))
                delete opds.passwordSet;
            if (!utils.hasProp(patch.opds, 'password'))
                opds.password = currentOpds.password || '';
            patch.opds = opds;
        }

        if (utils.hasProp(patch, 'librarySources') && !Array.isArray(patch.librarySources))
            throw new Error('librarySources должен быть массивом');

        return patch;
    },

    async importAdminSettings(userId = '', profileAccessToken = '', payload = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const patch = this.normalizeImportedAdminSettings(payload);
        await this.saveRuntimeConfigPatch(patch);
        this.addAdminEvent('info', 'settings', 'Восстановлены настройки администратора из файла');

        return {
            success: true,
            importedKeys: Object.keys(patch),
            settings: (await this.exportAdminSettings(userId, profileAccessToken)).settings,
        };
    },

    async addBackupPath(zipFile, sourcePath, zipPath) {
        if (!sourcePath || !await fs.pathExists(sourcePath))
            return;

        const stat = await fs.stat(sourcePath);
        if (stat.isDirectory()) {
            const entries = await fs.readdir(sourcePath);
            for (const entry of entries)
                await this.addBackupPath(zipFile, path.join(sourcePath, entry), `${zipPath}/${entry}`);
            return;
        }

        zipFile.addFile(sourcePath, zipPath);
    },

    async createAdminBackup(userId = '', profileAccessToken = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const {withFileTransactions} = require('./FilePersistence');
        const files = Object.values(require('./BackupTransaction').targets(this.config));
        return withFileTransactions(files, () => this.createAdminBackupSnapshot(userId, profileAccessToken));
    },

    async createAdminBackupSnapshot(userId = '', profileAccessToken = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const backupDir = path.join(this.config.dataDir, 'backups');
        await fs.ensureDir(backupDir);

        const createdAt = new Date();
        const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
        const fileName = `inpx-web-backup-${stamp}-${utils.randomHexString(4)}.zip`;
        const outFile = path.join(backupDir, fileName);
        const zipFile = new yazl.ZipFile();
        const output = fs.createWriteStream(outFile);
        const done = new Promise((resolve, reject) => {
            output.on('finish', resolve);
            output.on('error', reject);
            zipFile.outputStream.on('error', reject);
        });
        zipFile.outputStream.pipe(output);

        zipFile.addBuffer(Buffer.from(JSON.stringify({
            app: this.config.name,
            version: this.config.version,
            createdAt: createdAt.toISOString(),
            note: 'Backup includes runtime config, secrets, user profiles, reading lists, reader progress and bookmarks, and Kobo devices. '
                + 'It does not include source book archives, generated search DB or caches.',
        }, null, 4)), 'backup-info.json');

        await this.addBackupPath(zipFile, this.config.configFile, 'config.json');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'secret.key'), 'secret.key');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'reading-lists.json'), 'reading-lists.json');
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'discovery-cache.json'), 'discovery-cache.json');
        // Token hashes included: restored devices keep syncing without being set up again.
        await this.addBackupPath(zipFile, path.join(this.config.dataDir, 'kobo-sync.json'), 'kobo-sync.json');

        zipFile.end();
        await done;

        return {
            success: true,
            fileName,
            link: `${String(this.config.rootPathStatic || '').replace(/\/$/, '')}/admin-backups/${encodeURIComponent(fileName)}`,
            createdAt: createdAt.toISOString(),
        };
    },

    async importAdminBackup(userId = '', profileAccessToken = '', payload = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const transaction = require('./BackupTransaction');
        const {withFileTransactions} = require('./FilePersistence');
        const tempRoot = this.config.tempDir || os.tmpdir();
        await fs.ensureDir(tempRoot);
        const folder = await fs.mkdtemp(path.join(tempRoot, 'admin-restore-'));
        try {
            const archive = await require('./BackupArchive').read(payload, this.config, folder);
            return await withFileTransactions(Object.values(transaction.targets(this.config)), async() => {
                // Recheck after waiting for earlier writes or another restore.
                await this.requireAdmin(userId, profileAccessToken);
                const content = {};
                let runtimePatch = null;
                if (archive['config.json']) {
                    const SecretStore = require('./SecretStore');
                    const sourceKey = archive['secret.key'];
                    if (sourceKey) {
                        await fs.writeFile(path.join(folder, 'secret.key'), sourceKey, {mode: 0o600});
                        content['secret.key'] = sourceKey;
                    } else {
                        const currentKey = path.join(this.config.dataDir, 'secret.key');
                        if (await fs.pathExists(currentKey))
                            await fs.copy(currentKey, path.join(folder, 'secret.key'));
                    }
                    const secretStore = new SecretStore({dataDir: folder});
                    const {config: decoded} = await secretStore.unprotectConfig(archive['config.json']);
                    this.normalizeImportedAdminSettings(decoded);
                    // Keep machine-local storage paths, including the recovery journal location.
                    runtimePatch = Object.assign(_.pick(decoded, ConfigManager.propsToSave), {
                        dataDir: this.config.dataDir, tempDir: this.config.tempDir, logDir: this.config.logDir,
                    });
                    const protectedConfig = await secretStore.protectConfig(runtimePatch);
                    if (await fs.pathExists(path.join(folder, 'secret.key')))
                        content['secret.key'] = await fs.readFile(path.join(folder, 'secret.key'));
                    content['config.json'] = JSON.stringify(protectedConfig, null, 4);
                }
                if (archive['reading-lists.json']) {
                    const normalized = this.readingListStore.normalizeData(archive['reading-lists.json']);
                    const rebased = await this.readingListStore.rebaseReaderProgressGeneration(normalized);
                    content['reading-lists.json'] = JSON.stringify(rebased, null, 2);
                }
                if (archive['discovery-cache.json'])
                    content['discovery-cache.json'] = JSON.stringify(archive['discovery-cache.json'], null, 2);
                let koboData = null;
                if (archive['kobo-sync.json']) {
                    const KoboStore = require('./kobo/KoboStore');
                    koboData = new KoboStore(this.config).normalizeData(archive['kobo-sync.json']);
                    content['kobo-sync.json'] = JSON.stringify(koboData, null, 2);
                }
                await transaction.commit(this.config, content);
                if (koboData && this.koboService) {
                    // Restored devices and tokens take effect without a restart.
                    this.koboService.store.data = koboData;
                    this.koboService.store.rebuildIndex();
                }
                if (runtimePatch)
                    Object.assign(this.config, runtimePatch);
                this.profileSessions.clear();
                if (archive['discovery-cache.json']) {
                    this.discoveryCache = new Map();
                    this.discoveryDiskCache = archive['discovery-cache.json'];
                }
                const restored = Object.keys(content);
                this.addAdminEvent('warn', 'settings', 'Восстановлен полный бэкап: ' + restored.join(', '));
                return {
                    success: true, restored, restartRecommended: true,
                    message: 'Полный бэкап восстановлен. Перезапустите приложение для применения всех настроек. При смене библиотек выполните переиндексацию.',
                };
            });
        } finally {
            await fs.remove(folder);
        }
    },
};
