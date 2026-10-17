const _ = require('lodash');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const SecretStore = require('../core/SecretStore');
const {withFileTransaction, writeFileAtomic} = require('../core/FilePersistence');

const branchFilename = __dirname + '/application_env';

const upstreamReleaseLinks = [
    'https://github.com/bookpauk/inpx-web/releases/latest',
    'https://github.com/AceAsket/inpx-web/releases/latest',
];
const upstreamCheckReleaseLinks = [
    'https://api.github.com/repos/bookpauk/inpx-web/releases/latest',
    'https://api.github.com/repos/AceAsket/inpx-web/releases/latest',
];

const propsToSave = [
    'dataDir',
    'wsMessageLimitMb',
    'importLimitMb',
    'backupUploadLimitMb',
    'backupExpandedLimitMb',
    'tempDir',
    'logDir',
    'libDir',
    'inpx',
    'librarySources',
    'inpxFilterFile',
    'allowConfigRewrite',
    'allowUnsafeFilter',
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
    'metricsToken',
    'maxFilesDirSize',
    'bookCacheSize',
    'coverCacheSize',
    'cacheCleanInterval',
    'cacheCleanSchedule',
    'cacheCleanTargetRatio',
    'adminEventLogEnabled',
    'adminEventLogSize',
    'inpxCheckInterval',
    'converterPaths',
    'conversionConcurrency',
    'conversionQueueLimit',
    'conversionTimeoutMs',
    'conversionQueueTimeoutMs',
    'remoteAccess',
    'server',
    'opds',
    'latestReleaseLink',
    'checkReleaseLink',
    'telegramShareEnabled',
    'telegramBotToken',
    'telegramChatId',
    'telegramCaptionTemplate',
    'emailShareEnabled',
    'smtpHost',
    'smtpPort',
    'smtpSecure',
    'smtpUser',
    'smtpPass',
    'emailFrom',
    'emailTo',
    'deliveryRateLimit',
    'discovery',
    'uiDefaults',
];

async function resolveInstallMode(config = {}) {
    const raw = String(config.installMode || '').trim().toLowerCase();
    if (raw)
        return raw;

    try {
        if (await fs.pathExists('/.dockerenv'))
            return 'docker';
    } catch (err) {
        //
    }

    return 'native';
}

let instance = null;

// Installs from before the rename to inpx-shelf keep their data under the inpx-web name.
const legacyName = 'inpx-web';

function preferLegacyDir(dirPath, legacyPath) {
    if (!fs.pathExistsSync(dirPath) && fs.pathExistsSync(legacyPath))
        return legacyPath;

    return dirPath;
}

function resolveDefaultDataDir(config = {}) {
    return preferLegacyDir(`${config.execDir}/.${config.name}`, `${config.execDir}/.${legacyName}`);
}

function resolveFallbackDataDir(config = {}) {
    const appDataDir = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (appDataDir)
        return preferLegacyDir(path.join(appDataDir, config.name), path.join(appDataDir, legacyName));

    return preferLegacyDir(path.join(os.homedir(), `.${config.name}`), path.join(os.homedir(), `.${legacyName}`));
}

async function ensureWritableDir(dirPath) {
    await fs.ensureDir(dirPath);
    await fs.access(dirPath, fs.constants.W_OK);
}

//singleton
class ConfigManager {
    constructor() {    
        if (!instance) {
            this.inited = false;

            instance = this;
        }

        return instance;
    }

    async init(defaultDataDir, configFile) {
        if (this.inited)
            throw new Error('already inited');

        this.branch = 'production';
        try {
            await fs.access(branchFilename);
            this.branch = (await fs.readFile(branchFilename, 'utf8')).trim();
        } catch (err) {
            //
        }

        process.env.NODE_ENV = this.branch;

        this.branchConfigFile = __dirname + `/${this.branch}.js`;
        const config = require(this.branchConfigFile);
        const defaultExecDataDir = resolveDefaultDataDir(config);
        const canUseWindowsFallback = !defaultDataDir && !configFile && process.pkg && process.platform === 'win32';

        if (!defaultDataDir)
            defaultDataDir = defaultExecDataDir;

        if (configFile) {
            config.configFile = path.resolve(configFile);
            config.dataDir = config.dataDir || defaultDataDir;
        } else {
            let resolvedDataDir = defaultDataDir;

            try {
                await ensureWritableDir(resolvedDataDir);
            } catch (err) {
                if (!canUseWindowsFallback)
                    throw err;

                const fallbackDataDir = resolveFallbackDataDir(config);
                if (path.resolve(fallbackDataDir) === path.resolve(resolvedDataDir))
                    throw err;

                await ensureWritableDir(fallbackDataDir);
                resolvedDataDir = fallbackDataDir;
            }

            config.dataDir = config.dataDir || resolvedDataDir;
            config.configFile = `${resolvedDataDir}/config.json`;
        }

        this._config = config;

        this.inited = true;
    }

    get config() {
        if (!this.inited)
            throw new Error('not inited');
        return _.cloneDeep(this._config);
    }

    set config(value) {
        Object.assign(this._config, value);
    }

    async load() {
        try {
            if (!this.inited)
                throw new Error('not inited');

            let recoveryDir = this._config.dataDir;
            if (await fs.pathExists(this._config.configFile))
                recoveryDir = (await fs.readJson(this._config.configFile)).dataDir || recoveryDir;
            await require('../core/BackupTransaction').recover({...this._config, dataDir: recoveryDir});

            if (await fs.pathExists(this._config.configFile)) {
                const data = JSON.parse(await fs.readFile(this._config.configFile, 'utf8'));
                const rawConfig = _.pick(data, propsToSave);
                // Resolve the same data directory for decrypting and saving secrets.
                rawConfig.dataDir = rawConfig.dataDir || this._config.dataDir;
                const secretStore = new SecretStore(rawConfig);
                const secretResult = await secretStore.unprotectConfig(rawConfig);
                const config = secretResult.config;
                let needsSave = false;

                // Configs saved by bookpauk/inpx-web or AceAsket/inpx-web point their update check at those projects.
                if (!config.latestReleaseLink || upstreamReleaseLinks.includes(config.latestReleaseLink)) {
                    config.latestReleaseLink = this._config.latestReleaseLink;
                    needsSave = true;
                }

                if (!config.checkReleaseLink || upstreamCheckReleaseLinks.includes(config.checkReleaseLink)) {
                    config.checkReleaseLink = this._config.checkReleaseLink;
                    needsSave = true;
                }

                if (secretResult.needsSave)
                    needsSave = true;

                const discovery = Object.assign({}, this._config.discovery || {}, config.discovery || {});

                this.config = config;
                this._config.discovery = discovery;
                this._config.installMode = await resolveInstallMode(this._config);

                //сохраним конфиг, если не все атрибуты присутствуют в файле конфига
                if (needsSave) {
                    await this.save();
                } else if (config.allowConfigRewrite) {
                    for (const prop of propsToSave) {
                        if (!Object.prototype.hasOwnProperty.call(config, prop)) {
                            await this.save();
                            break;                        
                        }
                    }
                }
            } else {
                this._config.installMode = await resolveInstallMode(this._config);
                await this.save();
            }
        } catch(e) {
            throw new Error(`Error while loading "${this._config.configFile}": ${e.message}`);
        }
    }

    async save() {
        if (!this.inited)
            throw new Error('not inited');

        await withFileTransaction(this._config.configFile, async() => {
            const snapshot = _.cloneDeep(this._config);
            const secretStore = new SecretStore(snapshot);
            const dataToSave = await secretStore.protectConfig(_.pick(snapshot, propsToSave));
            await writeFileAtomic(snapshot.configFile, JSON.stringify(dataToSave, null, 4));
        });
    }
}

ConfigManager.propsToSave = propsToSave;

module.exports = ConfigManager;
