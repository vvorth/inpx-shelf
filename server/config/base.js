const path = require('path');
const pckg = require('../../package.json');

const execDir = path.resolve(__dirname, '..');
const MB = 1024*1024;

module.exports = {
    branch: 'unknown',
    version: pckg.version,
    latestVersion: '',
    name: pckg.name,

    execDir,
    dataDir: '',
    tempDir: '',
    logDir: '',
    libDir: '',
    inpx: '',
    librarySources: [],
    inpxFilterFile: '',

    allowConfigRewrite: false,
    allowUnsafeFilter: false,
    bookReadLink: '',
    loggingEnabled: true,
    logServerStats: false,
    logQueries: false,
    //переменные окружения для ключей из propsToSave применяет ConfigManager.applyEnvOverrides: здесь только умолчания,
    //иначе config.json, созданный при первом запуске, сохранил бы значение переменной и после её снятия
    loginRateLimitEnabled: true,
    loginRateLimitWindowMs: 15*60*1000,
    loginRateLimitMaxAttempts: 8,
    requireAuth: false,
    proxyBindProfile: false,
    //гостевой доступ к веб-приложению: каталог, книги и общие полки без входа (opds.guestAccess - то же для OPDS)
    guestAccess: false,
    authMode: 'local',
    trustProxy: false,
    proxyAuthHeader: 'Remote-User',
    trustedProxyCidrs: [],
    authExemptHealth: true,
    metricsEnabled: false,
    metricsPath: '/metrics',
    metricsToken: '',
    koboEnabled: process.env.INPX_KOBO_ENABLED === 'true',
    koboPublicUrl: String(process.env.INPX_KOBO_PUBLIC_URL || '').trim(),
    kosyncEnabled: process.env.INPX_KOSYNC_ENABLED === 'true',

    // Поправить при критических изменениях разбора INPX (InpxParser, LibraryImport):
    // входит в хеш библиотеки, и БД библиотеки будет перестроена.
    dbVersion: '13',

    maxPayloadSize: 500,//in MB
    apiMessageLimitMb: 1,
    importLimitMb: 16,
    backupUploadLimitMb: 256,
    backupExpandedLimitMb: 512,
    maxFilesDirSize: 2048*MB,//legacy alias for bookCacheSize
    bookCacheSize: 2048*MB,
    coverCacheSize: 512*MB,
    cacheCleanInterval: 24*60,//minutes
    cacheCleanSchedule: '0 0 * * *',
    cacheCleanTargetRatio: 0.8,
    adminEventLogEnabled: true,
    adminEventLogSize: 300,
    inpxCheckInterval: 60,//minutes

    webConfigParams: ['name', 'version', 'latestVersion', 'branch', 'bookReadLink', 'dbVersion', 'latestReleaseLink', 'rootPathStatic', 'conversionEnabled', 'conversionFormats', 'telegramShareEnabled', 'emailShareEnabled', 'onlineReaderEnabled', 'installMode', 'uiDefaults', 'discovery', 'librarySources', 'koboEnabled', 'kosyncEnabled'],

    //токены API удалённой библиотеки (/remote/): [{id, name, hash, sources, createdAt}], хранится только SHA-256 токена
    remoteAccess: [],

    server: {
        host: '0.0.0.0',
        port: '22380',
        root: '',
    },
    //opds: false,
    opds: {
        enabled: true,
        user: '',
        password: '',
        root: '/opds',
        //каталог OPDS без входа (также INPX_OPDS_GUEST_ACCESS); профили и их списки по-прежнему по паролю OPDS
        guestAccess: false,
        //язык каталога: '' - автоматически, 'ru', 'en' (переменная окружения INPX_OPDS_LANG важнее)
        lang: '',
    },

    latestReleaseLink: 'https://github.com/vvorth/inpx-shelf/releases/latest',
    checkReleaseLink: 'https://api.github.com/repos/vvorth/inpx-shelf/releases/latest',
    installMode: process.env.INPX_INSTALL_MODE || '',
    adminLogin: process.env.INPX_ADMIN_LOGIN || 'admin',
    adminPassword: process.env.INPX_ADMIN_PASSWORD || '',
    resetAdminPassword: process.env.INPX_RESET_ADMIN_PASSWORD === 'true',
    conversionEnabled: process.env.INPX_ENABLE_CONVERSION !== 'false',
    conversionConcurrency: 2,
    conversionQueueLimit: 16,
    conversionTimeoutMs: 120000,
    conversionQueueTimeoutMs: 120000,
    conversionFormats: String(process.env.INPX_CONVERSION_FORMATS || 'epub,epub3,kepub,kfx,azw8,pdf').split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
    converterPaths: {},
    fb2cngConfigPath: process.env.INPX_FB2CNG_CONFIG || process.env.FB2CNG_CONFIG || '',
    fb2cngVersion: process.env.INPX_FB2CNG_VERSION || '',
    telegramShareEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramCaptionTemplate: '${AUTHOR} - ${TITLE}',
    emailShareEnabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    emailFrom: '',
    emailTo: '',
    deliveryRateLimit: 20,
    onlineReaderEnabled: true,
    discovery: {
        enabled: true,
        shelfLimit: 8,
        externalSource: 'none',
        externalName: '',
        externalTtlMinutes: 1440,
    },

    uiDefaults: {
        limit: 20,
        downloadAsZip: false,
        showCounts: true,
        showRates: true,
        showInfo: true,
        showGenres: true,
        bookCardView: 'cards',
        showDates: false,
        showDeleted: false,
        abCacheEnabled: true,
        langDefault: '',
        showJson: false,
        showNewReleaseAvailable: true,
        darkTheme: false,
        uiLang: '',
    },
};

