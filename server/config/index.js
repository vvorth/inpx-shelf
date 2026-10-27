const _ = require('lodash');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const SecretStore = require('../core/SecretStore');
const {withFileTransaction, writeFileAtomic} = require('../core/FilePersistence');
const {normalizeLang} = require('../../shared/i18nEngine');

const MB = 1024*1024;

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
    'apiMessageLimitMb',
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
    'guestAccess',
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

function hasEnv(name) {
    return Object.prototype.hasOwnProperty.call(process.env, name);
}

const toInt = value => parseInt(value, 10);

// Число из переменной окружения; не задана, пустая или не число - undefined.
function envNumber(name, parse = Number) {
    const value = String(process.env[name] || '').trim();
    const number = (value ? parse(value) : NaN);
    return (Number.isFinite(number) ? number : undefined);
}

// Размер кеша: сначала в байтах, затем в МБ.
function envSize(bytesName, mbName) {
    const bytes = envNumber(bytesName, toInt);
    if (bytes >= 0)
        return bytes;
    const mb = envNumber(mbName, toInt);
    return (mb >= 0 ? mb * MB : undefined);
}

// Переменные окружения поверх config.json: действуют в памяти, в файл не пишутся.
function applyEnvOverrides(targetConfig) {
    if (hasEnv('INPX_PROXY_BIND_PROFILE'))
        targetConfig.proxyBindProfile = process.env.INPX_PROXY_BIND_PROFILE === 'true';
    if (hasEnv('INPX_GUEST_ACCESS'))
        targetConfig.guestAccess = process.env.INPX_GUEST_ACCESS === 'true';

    const opds = {};
    if (hasEnv('INPX_OPDS_GUEST_ACCESS'))
        opds.guestAccess = process.env.INPX_OPDS_GUEST_ACCESS === 'true';
    if (hasEnv('INPX_OPDS_LANG'))
        opds.lang = normalizeLang(process.env.INPX_OPDS_LANG);
    if (!_.isEmpty(opds))
        targetConfig.opds = Object.assign({}, targetConfig.opds, opds);

    for (const [field, variable] of Object.entries({
        apiMessageLimitMb: 'INPX_API_MESSAGE_LIMIT_MB',
        importLimitMb: 'INPX_IMPORT_LIMIT_MB',
        backupUploadLimitMb: 'INPX_BACKUP_UPLOAD_LIMIT_MB',
        backupExpandedLimitMb: 'INPX_BACKUP_EXPANDED_LIMIT_MB',
        conversionConcurrency: 'INPX_CONVERSION_CONCURRENCY',
        conversionQueueLimit: 'INPX_CONVERSION_QUEUE_LIMIT',
        conversionTimeoutMs: 'INPX_CONVERSION_TIMEOUT_MS',
        conversionQueueTimeoutMs: 'INPX_CONVERSION_QUEUE_TIMEOUT_MS',
        cacheCleanInterval: 'INPX_CACHE_CLEAN_INTERVAL_MINUTES',
        cacheCleanTargetRatio: 'INPX_CACHE_CLEAN_TARGET_RATIO',
    })) {
        const value = envNumber(variable);
        if (value !== undefined)
            targetConfig[field] = value;
    }

    const bookCacheSize = envSize('INPX_BOOK_CACHE_SIZE', 'INPX_BOOK_CACHE_SIZE_MB');
    if (bookCacheSize !== undefined)
        Object.assign(targetConfig, {bookCacheSize, maxFilesDirSize: bookCacheSize});
    const coverCacheSize = envSize('INPX_COVER_CACHE_SIZE', 'INPX_COVER_CACHE_SIZE_MB');
    if (coverCacheSize !== undefined)
        targetConfig.coverCacheSize = coverCacheSize;

    if (process.env.TELEGRAM_BOT_TOKEN)
        Object.assign(targetConfig, {telegramShareEnabled: true, telegramBotToken: process.env.TELEGRAM_BOT_TOKEN});
    if (hasEnv('TELEGRAM_CHAT_ID'))
        targetConfig.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (process.env.TELEGRAM_CAPTION_TEMPLATE)
        targetConfig.telegramCaptionTemplate = process.env.TELEGRAM_CAPTION_TEMPLATE;

    if (process.env.SMTP_HOST)
        Object.assign(targetConfig, {emailShareEnabled: true, smtpHost: process.env.SMTP_HOST});
    const smtpPort = envNumber('SMTP_PORT', toInt);
    if (smtpPort !== undefined)
        targetConfig.smtpPort = smtpPort;
    if (hasEnv('SMTP_SECURE'))
        targetConfig.smtpSecure = process.env.SMTP_SECURE === 'true';
    for (const [field, variable] of Object.entries({smtpUser: 'SMTP_USER', smtpPass: 'SMTP_PASS', emailTo: 'EMAIL_TO'})) {
        if (hasEnv(variable))
            targetConfig[field] = process.env[variable];
    }
    if (hasEnv('EMAIL_FROM') || hasEnv('SMTP_USER'))
        targetConfig.emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || '';

    const discovery = {};
    const shelfLimit = envNumber('INPX_DISCOVERY_LIMIT', toInt);
    if (shelfLimit)
        discovery.shelfLimit = shelfLimit;
    if (hasEnv('INPX_DISCOVERY_EXTERNAL_SOURCE'))
        discovery.externalSource = String(process.env.INPX_DISCOVERY_EXTERNAL_SOURCE).trim().toLowerCase() || 'none';
    if (hasEnv('INPX_DISCOVERY_EXTERNAL_NAME'))
        discovery.externalName = String(process.env.INPX_DISCOVERY_EXTERNAL_NAME).trim();
    const externalTtlMinutes = envNumber('INPX_DISCOVERY_EXTERNAL_TTL_MINUTES', toInt);
    if (externalTtlMinutes)
        discovery.externalTtlMinutes = externalTtlMinutes;
    if (!_.isEmpty(discovery))
        targetConfig.discovery = Object.assign({}, targetConfig.discovery, discovery);

    if (hasEnv('INPX_REQUIRE_AUTH'))
        targetConfig.requireAuth = process.env.INPX_REQUIRE_AUTH === 'true';
    if (process.env.INPX_AUTH_MODE)
        targetConfig.authMode = String(process.env.INPX_AUTH_MODE || '').trim().toLowerCase();
    if (hasEnv('INPX_TRUST_PROXY'))
        targetConfig.trustProxy = process.env.INPX_TRUST_PROXY === 'true';
    if (process.env.INPX_PROXY_AUTH_HEADER)
        targetConfig.proxyAuthHeader = process.env.INPX_PROXY_AUTH_HEADER;
    if (process.env.INPX_TRUSTED_PROXY_CIDRS)
        targetConfig.trustedProxyCidrs = String(process.env.INPX_TRUSTED_PROXY_CIDRS || '').split(',').map(item => item.trim()).filter(Boolean);
    if (hasEnv('INPX_AUTH_EXEMPT_HEALTH'))
        targetConfig.authExemptHealth = process.env.INPX_AUTH_EXEMPT_HEALTH !== 'false';
    if (hasEnv('INPX_METRICS_ENABLED'))
        targetConfig.metricsEnabled = process.env.INPX_METRICS_ENABLED === 'true';
    if (process.env.INPX_METRICS_PATH)
        targetConfig.metricsPath = process.env.INPX_METRICS_PATH;
    if (hasEnv('INPX_METRICS_TOKEN'))
        targetConfig.metricsToken = process.env.INPX_METRICS_TOKEN || '';
    if (hasEnv('INPX_LOGIN_RATE_LIMIT_ENABLED'))
        targetConfig.loginRateLimitEnabled = process.env.INPX_LOGIN_RATE_LIMIT_ENABLED !== 'false';
    return targetConfig;
}

// Значения config.json как есть (секреты зашифрованы).
async function readFileConfig(configFile) {
    return (await fs.pathExists(configFile) ? _.pick(await fs.readJson(configFile), propsToSave) : {});
}

// Ключ, заданный переменной окружения, сохраняет значение из файла; в opds и discovery - по вложенным ключам
// (opds собирается из рабочего конфига целиком).
function keepFileValues(data, file, overrides) {
    for (const [key, value] of Object.entries(overrides)) {
        if (_.isPlainObject(value) && _.isPlainObject(data[key]))
            keepFileValues(data[key], (_.isPlainObject(file[key]) ? file[key] : {}), value);
        else if (Object.prototype.hasOwnProperty.call(file, key))
            data[key] = file[key];
        else
            delete data[key];
    }
}

let instance = null;

// Installs from before the rename to inpx-shelf keep their data under the inpx-web name.
const legacyName = 'inpx-web';

function preferLegacyDir(dirPath, legacyPath) {
    if (!fs.pathExistsSync(dirPath) && fs.pathExistsSync(legacyPath))
        return legacyPath;

    return dirPath;
}

//Windows-сборка хранит данные там же, где их ищут ярлыки установщика (%LOCALAPPDATA%\inpx-shelf);
//каталог рядом с .exe, созданный прежними версиями, остаётся в работе
function resolveDefaultDataDir(config = {}, packagedWindows = Boolean(process.pkg) && process.platform === 'win32') {
    const execDataDir = preferLegacyDir(`${config.execDir}/.${config.name}`, `${config.execDir}/.${legacyName}`);
    if (packagedWindows && !fs.pathExistsSync(execDataDir))
        return resolveFallbackDataDir(config);

    return execDataDir;
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
        //для восстановления из бэкапа: ключ, которого нет в бэкапе, получает значение по умолчанию
        this.defaults = _.cloneDeep(_.pick(config, propsToSave));

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
                    await ConfigManager.savePatch(this._config, _.pick(config, ['latestReleaseLink', 'checkReleaseLink']));
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
            //после записи файла: переменные окружения действуют только в памяти
            applyEnvOverrides(this._config);
        } catch(e) {
            throw new Error(`Error while loading "${this._config.configFile}": ${e.message}`, {cause: e});
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

    // В файл - его собственные значения и patch: рабочий конфиг (env, CLI, вычисленные пути) в него не попадает.
    static async savePatch(config, patch) {
        await withFileTransaction(config.configFile, async() => {
            const file = await readFileConfig(config.configFile);
            const data = Object.assign({}, file, _.cloneDeep(_.pick(patch, propsToSave)));
            keepFileValues(data, file, applyEnvOverrides({}));
            const dataToSave = await new SecretStore(config).protectConfig(data);
            await writeFileAtomic(config.configFile, JSON.stringify(dataToSave, null, 4));
        });
    }
}

ConfigManager.propsToSave = propsToSave;
ConfigManager.applyEnvOverrides = applyEnvOverrides;
ConfigManager.readFileConfig = readFileConfig;
ConfigManager.resolveDefaultDataDir = resolveDefaultDataDir;

module.exports = ConfigManager;
