const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');
const yazl = require('yazl');

const utils = require('./utils');
const {t, msg} = require('./i18n');
const ConfigManager = require('../config');
const log = new (require('./AppLogger'))().log;//singleton
const BackupFiles = require('./BackupFiles');

// What a backup holds: the full one, or only the English author names (exported and imported next to their download)
const scopes = {
    '': {prefix: 'inpx-shelf-backup', files: BackupFiles.names,
        note: 'Backup includes runtime config, secrets, user profiles, reading lists, reader progress and bookmarks, Kobo devices, '
            + 'English author names and work titles in other languages. '
            + 'It does not include source book archives, generated search DB or caches.'},
    'author-names': {prefix: 'inpx-shelf-author-names', files: ['author-names.json'], note: 'English author names from Wikidata.',
        event: 'admin.authorNamesImported'},
    'work-titles': {prefix: 'inpx-shelf-work-titles', files: ['work-titles.json'], note: 'Work titles in other languages from Wikidata.',
        event: 'admin.workTitlesImported'},
};

function backupScope(scope = '') {
    const result = scopes[String(scope || '')];
    if (!result)
        throw new Error(t('errors.backupUnknownFile'));
    return result;
}

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
            'bookReadLink',
            'loggingEnabled',
            'logServerStats',
            'logQueries',
            'loginRateLimitEnabled',
            'loginRateLimitWindowMs',
            'loginRateLimitMaxAttempts',
            'requireAuth',
            'proxyBindProfile',
            'authMode',
            'trustProxy',
            'proxyAuthHeader',
            'trustedProxyCidrs',
            'authExemptHealth',
            'metricsEnabled',
            'metricsPath',
            'maxFilesDirSize',
            'bookCacheSize',
            'coverCacheSize',
            'cacheCleanInterval',
            'cacheCleanTargetRatio',
            'adminEventLogEnabled',
            'adminEventLogSize',
            'inpxCheckInterval',
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
            throw new Error(t('errors.settingsFileInvalid'));

        const patch = _.pick(_.cloneDeep(source), this.adminSettingsExportKeys());
        if (!Object.keys(patch).length)
            throw new Error(t('errors.settingsFileEmpty'));

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
            throw new Error(t('errors.librarySourcesArray'));

        return this.dropSmtpPassOnNewServer(patch);
    },

    async importAdminSettings(userId = '', profileAccessToken = '', payload = {}) {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const patch = this.normalizeImportedAdminSettings(payload);
        await this.saveRuntimeConfigPatch(patch);
        this.addAdminEvent('info', 'settings', msg('admin.settingsRestored'));

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

    async createAdminBackup(userId = '', profileAccessToken = '', scope = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const {files} = backupScope(scope);
        if (!(await Promise.all(files.map(name => fs.pathExists(BackupFiles.filePath(this.config, name))))).some(Boolean))
            throw new Error(t('errors.backupNothingToSave'));
        //заметки о книгах в архиве: по ним списки найдут те же книги в другой библиотеке
        if (files.includes('reading-lists.json'))
            await this.trySyncListedBooks();
        const {withFileTransactions} = require('./FilePersistence');
        const targets = Object.values(require('./BackupTransaction').targets(this.config));
        return withFileTransactions(targets, () => this.createAdminBackupSnapshot(userId, profileAccessToken, scope));
    },

    async createAdminBackupSnapshot(userId = '', profileAccessToken = '', scope = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const {prefix, files, note} = backupScope(scope);

        const backupDir = path.join(this.config.dataDir, 'backups');
        await fs.ensureDir(backupDir);

        const createdAt = new Date();
        const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
        const fileName = `${prefix}-${stamp}-${utils.randomHexString(4)}.zip`;
        const outFile = path.join(backupDir, fileName);
        //в архиве secret.key: только владельцу, и под своим именем - только целиком записанный
        const tempFile = `${outFile}.tmp`;
        const zipFile = new yazl.ZipFile();
        const output = fs.createWriteStream(tempFile, {mode: 0o600});
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
            note,
        }, null, 4)), 'backup-info.json');

        // kobo-sync.json keeps token hashes: restored devices sync without being set up again.
        // author-names.json: Wikidata often refuses the download for hours (504), a new server takes the names from here.
        for (const name of files)
            await this.addBackupPath(zipFile, BackupFiles.filePath(this.config, name), name);

        zipFile.end();
        try {
            await done;
            await fs.rename(tempFile, outFile);
        } finally {
            await fs.remove(tempFile);
        }

        return {
            success: true,
            fileName,
            link: `${String(this.config.rootPathStatic || '').replace(/\/$/, '')}/admin-backups/${encodeURIComponent(fileName)}`,
            createdAt: createdAt.toISOString(),
        };
    },

    async importAdminBackup(userId = '', profileAccessToken = '', payload = {}, scope = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);
        const only = (scope ? backupScope(scope).files : null);
        const importEvent = (scope ? backupScope(scope).event : '');

        const transaction = require('./BackupTransaction');
        const {withFileTransactions} = require('./FilePersistence');
        const tempRoot = this.config.tempDir || os.tmpdir();
        await fs.ensureDir(tempRoot);
        const folder = await fs.mkdtemp(path.join(tempRoot, 'admin-restore-'));
        try {
            const archive = await require('./BackupArchive').read(payload, this.config, folder, {only});
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
                    // Keep machine-local settings: storage paths (including the recovery journal location),
                    // programs the server runs and file filters, the remote library. Release links stay too:
                    // an upstream inpx-web backup would point update checks at upstream.
                    const localKeys = ['dataDir', 'tempDir', 'logDir', 'converterPaths', 'allowUnsafeFilter', 'inpxFilterFile',
                        'remoteLib', 'allowRemoteLib', 'latestReleaseLink', 'checkReleaseLink'];
                    runtimePatch = Object.assign(_.omit(_.pick(decoded, ConfigManager.propsToSave), localKeys), _.pick(this.config, localKeys));
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
                let koboData = null;
                if (archive['kobo-sync.json']) {
                    const KoboStore = require('./kobo/KoboStore');
                    koboData = new KoboStore(this.config).normalizeData(archive['kobo-sync.json']);
                    content['kobo-sync.json'] = JSON.stringify(koboData, null, 2);
                }
                //таблицы Wikidata: файл - только из проверенных записей, после записи сведения о таблице читаются заново
                const tables = {'author-names.json': ['authorNames', require('./search/AuthorNames')], 'work-titles.json': ['workTitles', require('./search/WorkTitles')]};
                const counts = {};
                for (const [name, [, Table]] of Object.entries(tables)) {
                    if (!archive[name])
                        continue;
                    const data = Table.normalizeData(archive[name]);
                    content[name] = JSON.stringify(data);
                    counts[name] = data.entries.length;
                }
                const names = !!archive['author-names.json'];
                await transaction.commit(this.config, content);
                for (const name of Object.keys(counts))
                    if (this.catalogSearch)
                        this.catalogSearch[tables[name][0]].changed();
                if (koboData && this.koboService) {
                    // Restored devices and tokens take effect without a restart.
                    this.koboService.store.data = koboData;
                    this.koboService.store.rebuildIndex();
                }
                if (runtimePatch)
                    Object.assign(this.config, runtimePatch);
                //профили и пароли могли смениться - сеансы сбрасываются; одни имена авторов их не трогают
                if (archive['config.json'] || archive['reading-lists.json'])
                    this.profileSessions.clear();
                const restored = Object.keys(content);
                if (only)
                    this.addAdminEvent('info', 'settings', msg(importEvent, {count: counts[only[0]] || 0}));
                else
                    this.addAdminEvent('warn', 'settings', msg('admin.fullBackupRestored', {files: restored.join(', ')}));
                //правки метаданных и английские имена авторов из бэкапа попадают в поиск при пересборке БД библиотеки;
                //прежняя БД отвечает, пока строится новая
                if ((archive['reading-lists.json'] || names) && this.catalogSearch && this.catalogSearch.ready)
                    this.recreateDb().catch(e => log(LM_ERR, `Library DB rebuild after restore: ${e.message}`));//no await
                return {
                    success: true, restored, restartRecommended: !only,
                    message: (only ? '' : t('admin.fullBackupRestoredMessage')),
                };
            });
        } finally {
            await fs.remove(folder);
        }
    },
};
