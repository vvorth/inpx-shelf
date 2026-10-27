//node:sqlite и другие API Node 24: на старой версии - понятное сообщение, а не ошибка при загрузке модулей ниже.
//Ниже 24.22.1 и 26.12.1 - уязвимые выпуски Node, их не запускаем (сборка: engines в package.json, бинарник - @yao-pkg/pkg)
const minNodeByMajor = {24: [24, 22, 1], 26: [26, 12, 1]};
const nodeVersion = process.versions.node.split('.').map(Number);
const minNode = minNodeByMajor[nodeVersion[0]];
const olderThan = (a, b) => a.map((part, i) => part - b[i]).find(diff => diff !== 0) < 0;
if (nodeVersion[0] < 24 || (minNode && olderThan(nodeVersion, minNode))) {
    console.error(`inpx-shelf requires Node.js 24.22.1 or newer (26.12.1 for Node.js 26), this is Node.js ${process.versions.node}`);
    process.exit(1);
}

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const express = require('express');
const http = require('http');

const utils = require('./core/utils');
const kobo = require('./core/kobo');
const {resolveLibrarySources} = require('./core/LibrarySources');

const ayncExit = new (require('./core/AsyncExit'))();

let log;
let config;
let argv;
let branch = '';
const argvStrings = ['host', 'port', 'config', 'data-dir', 'app-dir', 'lib-dir', 'inpx', 'library-sources', 'admin-login', 'admin-password'];

function showHelp(defaultConfig) {
    console.log(utils.versionText(defaultConfig));
    console.log(
`Usage: ${defaultConfig.name} [options]

Options:
  --help               Print ${defaultConfig.name} command line options
  --host=<ip>          Set web server host, default: ${defaultConfig.server.host}
  --port=<port>        Set web server port, default: ${defaultConfig.server.port}
  --config=<filepath>  Set config filename, default: <dataDir>/config.json
  --data-dir=<dirpath> (or --app-dir) Set application working directory, default: <execDir>/.${defaultConfig.name} (Windows binary: %LOCALAPPDATA%\\${defaultConfig.name})
  --lib-dir=<dirpath>  Set library directory, default: the same as ${defaultConfig.name} executable's
  --inpx=<filepath>    Set INPX collection file, default: the one that found in library dir
  --library-sources=<json> Set multiple INPX sources, JSON array or "name|inpx|libDir;..."
  --admin-login=<str>  Set admin profile login, default: ${defaultConfig.adminLogin}
  --admin-password=<str> Set admin profile password, default: random, printed to the log on first start
  --reset-admin-password Force reset of admin login/password on start
  --recreate           Force recreation of the search database on start
  --unsafe-filter      Use filter config at your own risk
`
    );
}

async function init() {
    argv = require('minimist')(process.argv.slice(2), {string: argvStrings});
    const argvDataDir = argv['data-dir'] || argv['app-dir'];
    const configFile = argv['config'];

    //config
    const ConfigManager = require('./config');
    const configManager = new ConfigManager();//singleton
    await configManager.init(argvDataDir, configFile);
    const defaultConfig = configManager.config;

    await configManager.load();
    config = configManager.config;
    require('./core/BookConverter').configure(config);
    branch = config.branch;

    //dirs
    config.dataDir = config.dataDir || argvDataDir || `${config.execDir}/.${config.name}`;
    await fs.ensureDir(config.dataDir);
    // Expand Windows 8.3 aliases before JembaDb watches its lock directory.
    // Node 24's fs.watch can abort the process for paths containing RUNNER~1 etc.
    if (process.platform === 'win32')
        config.dataDir = await require('util').promisify(require('fs').realpath.native)(config.dataDir);
    //кеши книг, обложек и tmp можно держать отдельно от данных пользователей, например на временном диске
    config.cacheDir = process.env.CACHE_DIR || config.dataDir;
    config.tempDir = config.tempDir || `${config.cacheDir}/tmp`;
    if (config.tempDir === '${OS}')
        config.tempDir = `${os.tmpdir()}/${config.name}`

    config.logDir = config.logDir || `${config.dataDir}/log`;    
    config.publicDir = `${config.dataDir}/public`;
    config.publicFilesDir = `${config.cacheDir}/public-files`;
    //без завершающего '/': маршруты собираются как `${rootPathStatic}/...`, root "/" - это ""
    config.rootPathStatic = String(config.server.root || '').replace(/\/+$/, '');
    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;
    config.coverDir = `${config.publicFilesDir}/cover`;

    configManager.config = config;

    await fs.ensureDir(config.bookDir);
    await fs.ensureDir(config.coverDir);
    await fs.ensureDir(config.tempDir);
    await fs.emptyDir(config.tempDir);

    //logger
    const appLogger = new (require('./core/AppLogger'))();//singleton
    await appLogger.init(config);
    log = appLogger.log;

    //cli
    if (argv.help) {
        showHelp(defaultConfig);
        ayncExit.exit(0);
    } else {
        log(utils.versionText(config));
        log('Initializing');
    }

    if (argv.host) {
        config.server.host = argv.host;
    }

    if (argv.port) {
        config.server.port = argv.port;
    }

    if (argv['admin-login']) {
        config.adminLogin = argv['admin-login'];
    }

    if (Object.prototype.hasOwnProperty.call(argv, 'admin-password')) {
        config.adminPassword = String(argv['admin-password'] || '');
    }

    if (argv['reset-admin-password']) {
        config.resetAdminPassword = true;
    }

    //восстановление из бэкапа разбирает источники библиотек с теми же параметрами
    configManager.argv = argv;
    await resolveLibrarySources(config, argv);

    config.recreateDb = argv.recreate || false;
    config.inpxFilterFile = config.inpxFilterFile || `${path.dirname(config.configFile)}/filter.json`;
    config.allowUnsafeFilter = argv['unsafe-filter'] || config.allowUnsafeFilter || false;

    //web app
    if (branch !== 'development') {
        const createWebApp = require('./createWebApp');
        await createWebApp(config);
    }

    //log dirs
    for (const prop of ['configFile', 'dataDir', 'tempDir', 'logDir']) {
        log(`${prop}: ${config[prop]}`);
    }

    if (await fs.pathExists(config.inpxFilterFile))
        log(`inpxFilterFile: ${config.inpxFilterFile}`)
}

function logQueries(app) {
    app.use(function(req, res, next) {
        const start = Date.now();
        log(`${req.method} ${kobo.maskTokens(req.originalUrl)} ${utils.cutString(req.body)}`);
        //log(`${JSON.stringify(req.headers, null, 2)}`)
        res.once('finish', () => {
            log(`${Date.now() - start}ms`);
        });
        next();
    });
}

async function main() {
    const log = new (require('./core/AppLogger'))().log;//singleton

    //язык интерфейса для запросов (см. server/core/i18n.js)
    const i18n = require('./core/i18n');
    i18n.setDefaultLang(config);

    //server
    const app = express();
    // First, so every request is logged, not only unmatched ones.
    // The development build has its own request logger.
    if (config.logQueries && branch !== 'development')
        logQueries(app);
    app.use(i18n.httpMiddleware(config));
    const security = new (require('./core/Security'))(config);
    await security.init();
    if (config.trustProxy)
        app.set('trust proxy', (address) => security.isTrustedProxyAddress(address));
    app.use(security.middleware());
    app.use(security.requiredAuthMiddleware());

    const server = http.createServer(app);

    let devModule = undefined;
    if (branch == 'development') {
        const devFileName = './dev.js'; //require ignored by pkg -50Mb executable size
        devModule = require(devFileName);
        devModule.webpackDevMiddleware(app);
    }

    if (devModule)
        devModule.logQueries(app);

    const opds = require('./core/opds');
    opds(app, config, security);


    const { ApiController } = require('./controllers');
    const apiController = new ApiController(config, security);
    await apiController.webWorker.readingListStore.warnIfDefaultAdminPassword()
        .catch(e => log(LM_WARN, `Cannot check the admin password: ${e.message}`));

    const koboService = kobo.init(app, config, apiController.webWorker, security);
    if (koboService)
        await koboService.ready;
    require('./core/Kosync').init(app, config, apiController.webWorker, security);
    require('./core/RemoteAccess').init(app, config, apiController.webWorker, security);

    const initHealthRoutes = require('./core/HealthRoutes');
    initHealthRoutes(app, config, apiController.webWorker, security, apiController);

    //после HealthRoutes (/api/index-status при пустом root) и до static: неизвестный /api/... - JSON 404, а не веб-приложение
    app.use(`${String(config.rootPathStatic || '').replace(/\/$/, '')}/api`, security.apiGuard(), apiController.router());

    const initStatic = require('./static');
    initStatic(app, config, apiController.webWorker, security);

    if (devModule) {
        devModule.logErrors(app);
    } else {
        app.use(function(err, req, res, next) {// eslint-disable-line no-unused-vars
            log(LM_ERR, err.stack);
            res.sendStatus(500);
        });
    }

    server.listen(config.server.port, config.server.host, () => {
        config.server.ready = true;
        log(`Server accessible at http://127.0.0.1:${config.server.port} (listening on ${config.server.host}:${config.server.port})`);
        log(require('./core/ExposedPaths').exposedPathsText(config));
    });
}

(async() => {
    try {
        await init();
        await main();
    } catch (e) {
        const mes = (branch == 'development' ? e.stack : e.message);
        if (log)
            log(LM_FATAL, mes);
        else
            console.error(mes);

        ayncExit.exit(1);
    }
})();
