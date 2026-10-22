const assert = require('assert');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');

require('../server/core/Logger');

const AppLogger = require('../server/core/AppLogger');

async function ensureLogger() {
    const logger = new AppLogger();
    if (!logger.inited)
        await logger.init({loggingEnabled: false, name: 'release-smoke-tests'});
}

function makeWorker(config = {}) {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    worker.config = Object.assign({
        name: 'inpx-shelf',
        version: 'test',
        librarySources: [],
        opds: {},
    }, config);
    worker.checkMyState = () => true;
    worker.requireAdmin = async() => true;
    worker.addAdminEvent = () => {};
    return worker;
}

async function withTempDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-release-smoke-'));
    try {
        return await fn(dir);
    } finally {
        await fs.remove(dir);
    }
}

// Reader.vue, его слои и дочерние компоненты одним текстом: проверки находят код, в каком бы файле читалки он ни был
async function readReaderSources() {
    const dir = path.resolve(__dirname, '../client/components/Reader');
    const files = (await fs.readdir(dir)).filter(file => /\.(vue|js)$/.test(file)).sort();
    return (await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8')))).join('\n');
}

function createHttpServer(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function testConfigSecretsSurviveRestart() {
    const execFile = require('util').promisify(require('child_process').execFile);
    const configModulePath = require.resolve('../server/config');
    const cases = [
        {explicit: true, cli: true, saved: true},
        {explicit: true, saved: true},
        {cli: true, saved: true},
        {explicit: true, cli: true},
        {explicit: true},
        {explicit: true, empty: true},
        {cli: true},
        {},
        {explicit: true, saved: true, plaintext: true},
        {legacy: true},
    ];
    const childScript = `
        const assert = require('assert');
        const path = require('path');
        const [modulePath, optionsJson, phase] = process.argv.slice(1);
        const options = JSON.parse(optionsJson);
        // Keep the executable's default data directory inside the test sandbox.
        for (const branch of ['development', 'production']) {
            const config = require(path.join(path.dirname(modulePath), branch));
            config.execDir = options.execDir;
            config.dataDir = '';
        }
        (async() => {
            const manager = new (require(modulePath))();
            await manager.init(options.cliDir, options.explicitFile);
            await manager.load();
            assert.strictEqual(path.resolve(manager.config.dataDir), options.expectedDir);
            assert.strictEqual(manager.config.opds.user, 'user1');
            assert.strictEqual(manager.config.checkReleaseLink, 'https://api.github.com/repos/vvorth/inpx-shelf/releases/latest');
            if (phase === 'save') {
                assert.strictEqual(manager.config.opds.password, options.initialPassword);
                manager.config = {
                    opds: {...manager.config.opds, password: 'opds-test-password'},
                    smtpPass: 'smtp-test-password',
                    telegramBotToken: 'telegram-test-token',
                    metricsToken: 'metrics-test-token',
                };
                await manager.save();
            } else {
                assert.strictEqual(manager.config.opds.password, 'opds-test-password');
                assert.strictEqual(manager.config.smtpPass, 'smtp-test-password');
                assert.strictEqual(manager.config.telegramBotToken, 'telegram-test-token');
                assert.strictEqual(manager.config.metricsToken, 'metrics-test-token');
            }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;

    for (const scenario of cases) {
        await withTempDir(async(dir) => {
            const execDir = path.join(dir, 'app');
            const cliDir = scenario.cli ? path.join(dir, 'cli-data') : undefined;
            // Installs from before the rename keep using their .inpx-web directory.
            const defaultDir = cliDir || path.join(execDir, scenario.legacy ? '.inpx-web' : '.inpx-shelf');
            const expectedDir = scenario.saved ? path.join(dir, 'saved-data') : defaultDir;
            const configFile = scenario.explicit ? path.join(dir, 'config.json') : path.join(defaultDir, 'config.json');
            const initialPassword = scenario.plaintext ? 'old-plaintext-password' : '';
            const initialConfig = {opds: {enabled: true, user: 'user1', password: initialPassword}};
            if (scenario.legacy)
                initialConfig.checkReleaseLink = 'https://api.github.com/repos/AceAsket/inpx-web/releases/latest';
            if (scenario.saved || scenario.empty)
                initialConfig.dataDir = scenario.saved ? expectedDir : '';
            await fs.outputJson(configFile, initialConfig);
            const options = {execDir, cliDir, expectedDir, initialPassword,
                explicitFile: scenario.explicit ? configFile : undefined};
            const run = phase => execFile(process.execPath,
                ['-e', childScript, configModulePath, JSON.stringify(options), phase], {cwd: dir});
            await run('save');
            const stored = await fs.readJson(configFile);
            assert.ok(stored.opds.password.startsWith('enc:v1:'));
            const keyFile = path.join(expectedDir, 'secret.key');
            const keyBeforeRestart = await fs.readFile(keyFile, 'utf8');
            await run('load');
            assert.strictEqual(await fs.readFile(keyFile, 'utf8'), keyBeforeRestart);
            assert.ok(!await fs.pathExists(path.join(dir, 'secret.key')));
        });
    }
}

// The packaged Windows binary keeps its data where the installer shortcuts do, unless a data directory next to the .exe already exists.
async function testWindowsDefaultDataDir() {
    const {resolveDefaultDataDir} = require('../server/config');
    const previous = process.env.LOCALAPPDATA;
    try {
        await withTempDir(async(dir) => {
            process.env.LOCALAPPDATA = path.join(dir, 'local');
            const config = {name: 'inpx-shelf', execDir: path.join(dir, 'app')};
            const resolve = packagedWindows => path.resolve(resolveDefaultDataDir(config, packagedWindows));
            assert.strictEqual(resolve(true), path.join(dir, 'local', 'inpx-shelf'));
            assert.strictEqual(resolve(false), path.join(dir, 'app', '.inpx-shelf'));
            await fs.ensureDir(path.join(dir, 'local', 'inpx-web'));
            assert.strictEqual(resolve(true), path.join(dir, 'local', 'inpx-web'));
            await fs.ensureDir(path.join(dir, 'app', '.inpx-web'));
            assert.strictEqual(resolve(true), path.join(dir, 'app', '.inpx-web'));
            await fs.ensureDir(path.join(dir, 'app', '.inpx-shelf'));
            assert.strictEqual(resolve(true), path.join(dir, 'app', '.inpx-shelf'));
        });
    } finally {
        if (previous === undefined)
            delete process.env.LOCALAPPDATA;
        else
            process.env.LOCALAPPDATA = previous;
    }
}

function testConvertedBookFileNames() {
    const bookConverter = require('../server/core/BookConverter');

    assert.strictEqual(bookConverter.getConvertedExtension('epub'), 'epub');
    assert.strictEqual(bookConverter.getConvertedExtension('epub3'), 'epub');
    assert.strictEqual(bookConverter.getConvertedExtension('kepub'), 'kepub.epub');
    assert.strictEqual(bookConverter.getConvertedExtension('KEPUB'), 'kepub.epub');
    assert.strictEqual(bookConverter.getConvertedExtension('AzW8'), 'azw8');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'kepub'), 'Book.kepub.epub');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'KEPUB'), 'Book.kepub.epub');
    assert.strictEqual(bookConverter.getConvertedFileName('Book.fb2', 'epub3'), 'Book.epub');
}

async function testFb2cngConfigAndConversionCache() {
    const baseConfigPath = require.resolve('../server/config/base');
    const ConfigManager = require('../server/config');
    const bookConverter = require('../server/core/BookConverter');
    const envNames = ['INPX_FB2CNG_CONFIG', 'FB2CNG_CONFIG'];
    const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

    try {
        process.env.INPX_FB2CNG_CONFIG = '/config/inpx.yaml';
        process.env.FB2CNG_CONFIG = '/config/legacy.yaml';
        delete require.cache[baseConfigPath];
        assert.strictEqual(require('../server/config/base').fb2cngConfigPath, '/config/inpx.yaml');

        delete process.env.INPX_FB2CNG_CONFIG;
        delete require.cache[baseConfigPath];
        assert.strictEqual(require('../server/config/base').fb2cngConfigPath, '/config/legacy.yaml');
    } finally {
        for (const name of envNames) {
            if (previousEnv[name] === undefined)
                delete process.env[name];
            else
                process.env[name] = previousEnv[name];
        }
        delete require.cache[baseConfigPath];
        require('../server/config/base');
    }

    assert.ok(!ConfigManager.propsToSave.includes('fb2cngConfigPath'));
    assert.strictEqual(typeof(bookConverter.convert), 'function');
    assert.strictEqual(typeof(bookConverter.prepareConvertedFile), 'function');

    await withTempDir(async(dir) => {
        const configPath = path.join(dir, 'fb2cng', 'config.yaml');
        const cacheBasePath = path.join(dir, 'cache', 'book-hash');
        await fs.outputFile(configPath, 'document:\n  title: first\n');

        const config = {
            conversionEnabled: true,
            converterPaths: {fb2cng: '/opt/tools/fbc-custom'},
            fb2cngConfigPath: configPath,
            fb2cngVersion: 'v1.2.3',
        };
        const common = {
            cacheBasePath,
            inputFile: path.join(dir, 'book.raw'),
            sourceFileName: 'Book.fb2',
            config,
        };
        const epub = await bookConverter.getConversionCacheInfo({...common, format: 'epub'});
        const epub3 = await bookConverter.getConversionCacheInfo({...common, format: 'epub3'});
        assert.notStrictEqual(epub.filePath, epub3.filePath);
        assert.match(epub.filePath, /\.converted-v2-epub-/);
        assert.match(epub3.filePath, /\.converted-v2-epub3-/);

        const otherVersion = await bookConverter.getConversionCacheInfo({
            ...common,
            format: 'epub',
            config: {...config, fb2cngVersion: 'v1.2.4'},
        });
        assert.notStrictEqual(epub.filePath, otherVersion.filePath);

        await fs.writeFile(configPath, 'document:\n  title: second\n');
        const changedConfig = await bookConverter.getConversionCacheInfo({...common, format: 'epub'});
        assert.notStrictEqual(epub.filePath, changedConfig.filePath);

        let validationCall = null;
        await bookConverter.validateFb2cngConfig(
            changedConfig.fb2cngConfig,
            config.converterPaths,
            async(commands, args) => {
                validationCall = {commands, args};
            },
        );
        assert.strictEqual(validationCall.commands[0], '/opt/tools/fbc-custom');
        assert.deepStrictEqual(validationCall.args, ['--config', path.resolve(configPath), 'dumpconfig']);

        await fs.writeFile(configPath, 'invalid: [yaml\n');
        const invalidConfig = await bookConverter.readFb2cngConfig(configPath);
        await assert.rejects(
            () => bookConverter.validateFb2cngConfig(
                invalidConfig,
                config.converterPaths,
                async() => { throw new Error('YAML parse error'); },
            ),
            /Invalid fb2cng config.+YAML parse error/,
        );

        await assert.rejects(
            () => bookConverter.getConversionCacheInfo({
                ...common,
                format: 'epub',
                config: {...config, fb2cngConfigPath: path.join(dir, 'missing.yaml')},
            }),
            /Invalid fb2cng config.+does not exist or is not readable/,
        );

        const noCustomConfig = {...config, fb2cngConfigPath: ''};
        const cached = await bookConverter.getConversionCacheInfo({
            ...common,
            format: 'epub',
            config: noCustomConfig,
        });
        await fs.outputFile(cached.filePath, 'cached conversion');
        const prepared = await bookConverter.prepareConvertedFile({
            inputFile: common.inputFile,
            cacheBasePath,
            format: 'epub',
            sourceFileName: common.sourceFileName,
            downFileName: common.sourceFileName,
            config: noCustomConfig,
        });
        assert.deepStrictEqual(prepared, {
            filePath: cached.filePath,
            downloadName: 'Book.epub',
            created: false,
        });
    });

    const staticSource = await fs.readFile(path.join(__dirname, '../server/static.js'), 'utf8');
    const workerSource = await fs.readFile(path.join(__dirname, '../server/core/WebWorker.js'), 'utf8');
    assert.match(staticSource, /cacheBasePath: bookFile/);
    assert.match(workerSource, /cacheBasePath: gzipFile/);
    assert.match(workerSource, /unsupportedMessage: t\('errors\.unsupportedDeliveryFormat'/);
    assert.match(workerSource, /disabledMessage: t\('list\.bookConversionDisabledImage'\)/);
}

function request(server, urlPath, headers = {}) {
    const port = server.address().port;
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port,
            path: urlPath,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
    });
}

async function withStaticServer(config, fn, worker = null, security = null) {
    const express = require('express');
    const app = express();
    if (security)
        app.use(security.middleware());
    require('../server/static')(app, Object.assign({rootPathStatic: ''}, config), worker, security);
    const server = await createHttpServer(app);
    try {
        return await fn(server);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function testFb2ContentsExcludeNotesBodies() {
    const Fb2Parser = require('../server/core/fb2/Fb2Parser');
    const xml = `
        <FictionBook>
            <description>
                <title-info>
                    <book-title>Annotation fixture</book-title>
                    <annotation><p>Separate annotation</p><p><strong>Formatted text</strong></p></annotation>
                </title-info>
            </description>
            <body>
                <section><title><p>От автора</p></title><p>Ссылка <a l:href="#note-1" type="note">[1]</a></p></section>
                <section>
                    <title><p>1</p></title>
                    <section><title><p>Вложенная глава</p></title></section>
                </section>
            </body>
            <body name=" NoTeS ">
                <section id="note-1"><title><p>1</p></title><p>Текст сноски</p></section>
                <section id="note-2"><title><p>2</p></title><p>Ещё одна сноска</p></section>
            </body>
        </FictionBook>
    `;
    const parser = new Fb2Parser();
    parser.fromString(xml, {lowerCase: true});

    const annotation = parser.bookInfo().titleInfo.annotation;
    assert.ok(Array.isArray(annotation));
    assert.strictEqual(annotation.length, 2);
    assert.strictEqual(annotation[0][1], 'p');

    const expectedContents = [
        {title: 'От автора', level: 0},
        {title: '1', level: 0},
        {title: 'Вложенная глава', level: 1},
    ];
    assert.deepStrictEqual(new (require('../server/core/fb2/Fb2Helper'))().pageInfo(xml).contents, expectedContents);

    assert.deepStrictEqual(require('../client/components/Reader/fb2ToReaderHtml').extractReaderContents(parser), expectedContents);
}

async function testReaderAnnotationStaysOutsideReadingFlow() {
    const readerSource = await readReaderSources();
    const fb2ToReaderHtml = require('../client/components/Reader/fb2ToReaderHtml');
    const annotationParser = new (require('../server/core/fb2/Fb2Parser'))();
    annotationParser.fromString(`<?xml version="1.0" encoding="utf-8"?>
        <FictionBook><description><title-info><annotation><p>Аннотация</p></annotation></title-info></description>
        <body><section><title><p>Глава</p></title><p>Текст</p></section></body></FictionBook>`, {lowerCase: true});
    const annotationHtml = fb2ToReaderHtml.buildReaderAnnotationHtml(annotationParser, annotationParser.bookInfo().titleInfo.annotation);
    assert.match(annotationHtml, /Аннотация/);
    assert.doesNotMatch(annotationHtml, /id="section-/);
    const {html: bodyHtml} = fb2ToReaderHtml.buildReaderHtml(annotationParser, {contents: [{id: 'section-1', title: 'Глава'}]});
    assert.doesNotMatch(bodyHtml, /Аннотация/);
    assert.match(bodyHtml, /<h2 id="section-1" class="reader-anchored-heading reader-section-heading">Глава<\/h2>/);
    assert.match(readerSource, /this\.readerAnnotationHtml = fb2ToReaderHtml\.buildReaderAnnotationHtml\(/);
    assert.match(readerSource, /this\.readerSearchText = readerTextAnchors\.normalizeReaderSearchText\(readerTextAnchors\.stripHtml\(this\.readerHtml \|\| ''\)\)\.toLowerCase\(\);/);
    assert.match(readerSource, /get hasContentsMenu\(\)[\s\S]{0,160}this\.hasContents \|\| this\.hasAnnotation/);
    assert.match(readerSource, /v-if="reader\.hasContentsMenu"/);
    assert.match(readerSource, /contentsPanelView === 'annotation'/);
    assert.match(readerSource, /this\.findPagedPageIndexByAnchor\(targetId\)/);
    assert.match(readerSource, /this\.readerHtmlHasAnchor\(targetId\)/);
    assert.match(readerSource, /img\.closest\('\.reader-annotation-html, \.reader-page-sheet--measure'\)/);
    assert.match(readerSource, /link\.closest\('\.reader-annotation-html'\)/);

    const handlerStart = readerSource.indexOf('    handleReaderAnnotationClick(event) {');
    const handlerEnd = readerSource.indexOf('    captureReaderNoteReturnPoint() {', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const handlerMethod = readerSource.slice(handlerStart, handlerEnd).trim();
    const AnnotationHandler = new Function(`return class AnnotationHandler {${handlerMethod}}`)();
    const makeHandler = ({pageIndex = -1, readerHtmlHasAnchor = false, annotationTarget = null} = {}) => {
        const handler = new AnnotationHandler();
        const jumps = [];
        const link = {};
        const root = {
            contains: item => item === link,
            querySelector: () => annotationTarget,
        };
        const event = {
            currentTarget: root,
            target: {closest: () => link},
            prevented: false,
            stopped: false,
            preventDefault() { this.prevented = true; },
            stopPropagation() { this.stopped = true; },
        };
        handler.$refs = {scroller: {querySelector: () => null}};
        handler.isPagedMode = true;
        handler.getReaderLinkTarget = () => 'chapter-2';
        handler.escapeCssId = value => value;
        handler.findPagedPageIndexByAnchor = () => pageIndex;
        handler.readerHtmlHasAnchor = () => readerHtmlHasAnchor;
        handler.captureReaderNoteReturnPoint = () => ({pageIndex: 0});
        handler.jumpToReaderAnchor = (id, options) => jumps.push({id, options});
        return {event, handler, jumps};
    };

    const offPage = makeHandler({pageIndex: 4});
    offPage.handler.handleReaderAnnotationClick(offPage.event);
    assert.strictEqual(offPage.event.prevented, true);
    assert.strictEqual(offPage.event.stopped, true);
    assert.deepStrictEqual(offPage.jumps, [{id: 'chapter-2', options: {returnPoint: {pageIndex: 0}}}]);

    let localScrolls = 0;
    const localTarget = {scrollIntoView: () => { localScrolls += 1; }};
    const localAnchor = makeHandler({annotationTarget: localTarget});
    localAnchor.handler.handleReaderAnnotationClick(localAnchor.event);
    assert.strictEqual(localAnchor.jumps.length, 0);
    assert.strictEqual(localScrolls, 1);
}

async function testReaderBookNotesMenuAndReturnLayout() {
    const readerSource = await readReaderSources();
    const dialogsSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/ReaderDialogs.vue'), 'utf8');
    const paginatorSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/readerPaginator.js'), 'utf8');

    assert.match(readerSource, /readerNotesAnchorId = '';/);
    assert.match(readerSource, /get hasBookNotes\(\)[\s\S]{0,120}readerNotesAnchorId/);
    assert.match(readerSource, /get hasContentsMenu\(\)[\s\S]{0,180}this\.hasContents \|\| this\.hasAnnotation \|\| this\.hasBookNotes/);
    assert.strictEqual((dialogsSource.match(/data-testid="reader-notes-link"/g) || []).length, 1);
    assert.strictEqual((readerSource.match(/'reader-note-return'/g) || []).length, 1);
    assert.match(dialogsSource, /v-if="\(reader\.hasAnnotation \|\| reader\.hasBookNotes\) && reader\.displayContents\.length"/);
    assert.match(readerSource, /bookNotes: t\('reader\.bookNotes'\)/);

    const firstAnnotationLink = dialogsSource.indexOf('@click="reader.showReaderAnnotation"');
    const firstNotesLink = dialogsSource.indexOf('@click="reader.showReaderNotes"', firstAnnotationLink);
    const firstFeatureSeparator = dialogsSource.indexOf('(reader.hasAnnotation || reader.hasBookNotes) && reader.displayContents.length', firstNotesLink);
    assert.ok(firstAnnotationLink >= 0 && firstNotesLink > firstAnnotationLink);
    assert.ok(firstFeatureSeparator > firstNotesLink);

    const fb2ToReaderHtml = require('../client/components/Reader/fb2ToReaderHtml');
    const anchorId = fb2ToReaderHtml.createReaderNotesAnchorId({
        eachDeepSelf(callback) {
            callback({type: 1, attrs: () => new Map([['id', 'reader-book-notes']])});
            callback({type: 1, attrs: () => new Map([['xml:id', 'reader-book-notes-2']])});
        },
    });
    assert.strictEqual(anchorId, 'reader-book-notes-3');

    const makeParser = (bodies) => ({
        $$array: selector => (selector === '/body' ? bodies : []),
        eachDeepSelf: () => {},
    });
    const makeBody = (name, ...nodes) => ({
        attrs: () => ({name}),
        rawNodes: [[1, 'body', [], nodes]],
    });
    const paragraph = text => [1, 'p', [], [[3, text]]];
    const note = (id, text) => [1, 'section', [['id', id]], [paragraph(text)]];
    const notes = fb2ToReaderHtml.buildReaderHtml(makeParser([
        makeBody('', paragraph('Основной текст')),
        makeBody('notes', note('note-1', 'Первая сноска')),
        makeBody(' NoTeS ', note('note-2', 'Вторая сноска')),
    ]), {notesTitle: 'Примечания'});
    const notesHtml = notes.html;
    assert.strictEqual(notes.notesAnchorId, 'reader-book-notes');
    assert.strictEqual((notesHtml.match(/id="reader-book-notes"/g) || []).length, 1);
    assert.match(notesHtml, /<section class="reader-notes"><h2 id="reader-book-notes">Примечания<\/h2>/);
    assert.doesNotMatch(notesHtml, /<section id="reader-book-notes" class="reader-notes">/);
    assert.strictEqual((notesHtml.match(/class="reader-notes"/g) || []).length, 2);

    const emptyNotes = fb2ToReaderHtml.buildReaderHtml(makeParser([makeBody('notes', [3, '   '])]), {notesTitle: 'Примечания'});
    assert.strictEqual(emptyNotes.notesAnchorId, '');
    assert.strictEqual(emptyNotes.html, '');
    assert.match(readerSource, /notesTitle: t\('reader\.bookNotes'\)/);

    const showNotesStart = readerSource.indexOf('    showReaderNotes() {');
    const showNotesEnd = readerSource.indexOf('    showContentsList() {', showNotesStart);
    assert.ok(showNotesStart >= 0 && showNotesEnd > showNotesStart);
    const showNotesMethod = readerSource.slice(showNotesStart, showNotesEnd).trim();
    const NotesNavigation = new Function(`return class NotesNavigation {${showNotesMethod}}`)();
    const notesNavigation = new NotesNavigation();
    const jumps = [];
    notesNavigation.hasBookNotes = true;
    notesNavigation.readerNotesAnchorId = 'reader-book-notes';
    notesNavigation.captureReaderNoteReturnPoint = () => ({pageIndex: 6, scrollTop: 240});
    notesNavigation.jumpToReaderAnchor = (id, options) => jumps.push({id, options});
    notesNavigation.showReaderNotes();
    assert.deepStrictEqual(jumps, [{
        id: 'reader-book-notes',
        options: {returnPoint: {pageIndex: 6, scrollTop: 240}},
    }]);

    assert.match(readerSource, /:class="\{'reader-back-btn--note-return': reader\.readerNoteReturnPoint\}"/);
    assert.match(readerSource, /:aria-label="reader\.readerNoteReturnPoint \? reader\.uiText\.noteReturn : reader\.uiText\.back"/);
    assert.match(readerSource, /:data-testid="reader\.readerNoteReturnPoint \? 'reader-note-return' : null"/);
    assert.match(readerSource, /:label="reader\.isCompactLayout \? '' : \(reader\.readerNoteReturnPoint \? reader\.uiText\.noteReturn : reader\.uiText\.back\)"/);
    assert.doesNotMatch(readerSource, /\{\{ (reader\.)?readerNoteReturnPoint \? (reader\.)?uiText\.noteReturn : (reader\.)?uiText\.back \}\}/);
    assert.match(readerSource, /\.reader-back-btn--note-return :deep\(\.block\) \{\s*display: none;/);
    assert.doesNotMatch(readerSource, /class="reader-note-return-btn"/);
    assert.match(readerSource, /v-if="reader\.bookUid && reader\.isCompactLayout"\s*ref="readerMobileFooter"/);
    assert.match(readerSource, /v-if="reader\.bookUid && reader\.showDesktopStatusBar"/);

    const goBackStart = readerSource.indexOf('    goBack() {');
    const goBackEnd = readerSource.indexOf('    toggleControls() {', goBackStart);
    assert.ok(goBackStart >= 0 && goBackEnd > goBackStart);
    const goBackMethod = readerSource.slice(goBackStart, goBackEnd).trim();
    const ReaderBack = new Function(`return class ReaderBack {${goBackMethod}}`)();
    const readerBack = new ReaderBack();
    let returnedFromNote = 0;
    readerBack.readerNoteReturnPoint = {pageIndex: 6};
    readerBack.returnFromReaderNote = () => { returnedFromNote += 1; };
    readerBack.$router = {
        back() { throw new Error('router back must not run while returning from a note'); },
        push() { throw new Error('router push must not run while returning from a note'); },
    };
    readerBack.goBack();
    assert.strictEqual(returnedFromNote, 1);

    const clearRestoreStart = readerSource.indexOf('    clearPendingReaderNavigationRestore({clearNoteReturn = false} = {}) {');
    const clearRestoreEnd = readerSource.indexOf('    capturePendingReflowAnchor(', clearRestoreStart);
    assert.ok(clearRestoreStart >= 0 && clearRestoreEnd > clearRestoreStart);
    const clearRestoreMethod = readerSource.slice(clearRestoreStart, clearRestoreEnd).trim();
    const ReaderNavigationRestore = new Function(`return class ReaderNavigationRestore {${clearRestoreMethod}}`)();
    const navigationRestore = new ReaderNavigationRestore();
    navigationRestore.pendingReflowAnchor = {textSnippet: 'notes'};
    navigationRestore.stableReaderReflowAnchor = {textSnippet: 'notes'};
    navigationRestore.reflowPageStartOverride = {pageIndex: 72};
    navigationRestore.pendingReaderAnchorJump = {id: 'reader-book-notes'};
    navigationRestore.pendingPagedNavigation = () => {};
    navigationRestore.restorePending = true;
    navigationRestore.restoreFromSavedProgress = true;
    navigationRestore.restoreProgressFrame = 0;
    navigationRestore.readerNoteReturnPoint = {pageIndex: 3};
    let clearedHighlights = 0;
    navigationRestore.clearReaderReflowAnchorHighlight = () => { clearedHighlights += 1; };
    navigationRestore.clearPendingReaderNavigationRestore({clearNoteReturn: true});
    assert.strictEqual(navigationRestore.pendingReflowAnchor, null);
    assert.strictEqual(navigationRestore.stableReaderReflowAnchor, null);
    assert.strictEqual(navigationRestore.reflowPageStartOverride, null);
    assert.strictEqual(navigationRestore.pendingReaderAnchorJump, null);
    assert.strictEqual(navigationRestore.pendingPagedNavigation, null);
    assert.strictEqual(navigationRestore.restorePending, false);
    assert.strictEqual(navigationRestore.restoreFromSavedProgress, false);
    assert.strictEqual(navigationRestore.restoreProgressFrame, 0);
    assert.strictEqual(navigationRestore.readerNoteReturnPoint, null);
    assert.strictEqual(clearedHighlights, 1);
    navigationRestore.readerNoteReturnPoint = {pageIndex: 4};
    navigationRestore.clearPendingReaderNavigationRestore();
    assert.deepStrictEqual(navigationRestore.readerNoteReturnPoint, {pageIndex: 4});

    assert.match(readerSource, /jumpToContent\(id = ''\) \{\s*this\.clearPendingReaderNavigationRestore\(\{clearNoteReturn: true\}\);/);
    assert.match(paginatorSource, /setCurrentPagedPage\(index = 0, save = false\) \{[\s\S]{0,140}if \(save\)\s*this\.clearPendingReaderNavigationRestore\(\);/);
    assert.match(readerSource, /returnFromReaderNote\(\) \{\s*const point = this\.readerNoteReturnPoint;\s*this\.clearPendingReaderNavigationRestore\(\{clearNoteReturn: true\}\);/);
}

async function testReaderPreferencesMigrate() {
    const readerSource = await readReaderSources();
    const ReadingListStore = require('../server/core/ReadingListStore');
    await withTempDir(async dir => {
        const store = new ReadingListStore({dataDir: dir});
        const defaults = store.normalizeReaderPreferences();
        const shared = require('../shared/readerPreferences');
        assert.strictEqual(defaults.readerPreferencesVersion, shared.readerPreferencesVersion);
        // The removed background image (up to 4 MB) and text shadow are dropped from saved settings, on the server and in the reader.
        const removed = {backgroundImage: 'data:image/png;base64,AAAA', backgroundImageName: 'a.png',
            backgroundTransparentPages: true, backgroundTransparentStatus: true, textShadow: true};
        const old = Object.assign({theme: 'sepia', einkProfile: Object.assign({}, removed)}, removed);
        for (const result of [store.normalizeReaderPreferences(old), shared.migrateReaderPreferences(old)]) {
            assert.strictEqual(result.theme, 'sepia');
            for (const key of Object.keys(removed))
                assert.ok(!Object.hasOwn(result, key) && !Object.hasOwn(result.einkProfile, key), key);
        }
        // The untouched old 1040px default becomes viewport-wide; an explicit choice saved at the current version stays.
        assert.strictEqual(store.normalizeReaderPreferences({contentWidthMode: 'fixed', contentWidth: 1040}).contentWidthMode, 'viewport');
        const current = store.normalizeReaderPreferences({readerPreferencesVersion: shared.readerPreferencesVersion, contentWidthMode: 'fixed', contentWidth: 1040});
        assert.strictEqual(current.contentWidthMode, 'fixed');
        assert.strictEqual(store.normalizeReaderPreferences(current).contentWidthMode, 'fixed');
        // A side without its own value comes from the shared one, as in the reader: bottom = vertical + 4.
        const spacing = store.normalizeReaderPreferences({readerPreferencesVersion: shared.readerPreferencesVersion,
            pageVerticalPadding: 30, pageHorizontalPadding: 40, regularProfile: {pageVerticalPadding: 12}});
        assert.deepStrictEqual([spacing.pagePaddingTop, spacing.pagePaddingBottom, spacing.pagePaddingLeft, spacing.pagePaddingRight], [30, 34, 40, 40]);
        assert.deepStrictEqual([spacing.regularProfile.pagePaddingTop, spacing.regularProfile.pagePaddingBottom], [12, 16]);
        assert.match(readerSource, /next\.pagePaddingBottom = Math\.max\(0, vertical \+ 4\);/);
        assert.match(readerSource, /require\('\.\.\/\.\.\/\.\.\/shared\/readerPreferences'\)/);
        assert.match(readerSource, /normalizeReaderSpacingPreferences\(migrateReaderPreferences\(preferences\)\)/);
        assert.match(readerSource, /defaultReaderPreferences = cloneDeep\(this\.preferences\);/);
    });
}

async function testReaderPaginationResumesAcrossViewportGeometry() {
    const readerSource = await readReaderSources();
    const paginatorSource = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/readerPaginator.js'), 'utf8');

    assert.match(readerSource, /beforeCreate\(\) \{\s*this\.pagedLayoutCache = new Map\(\);/, 'The layout cache lives outside reactive data');
    assert.match(readerSource, /pagedLayoutCacheLimit = 2;/);
    assert.match(paginatorSource, /const checkpoint = \(cachedLayout && cachedLayout\.type === 'partial'\)/);
    assert.match(paginatorSource, /for \(let index = startIndex; index < queue\.length; index \+= 1\)/);
    assert.match(paginatorSource, /storePartialLayout\(index\);\s*return false;/);
    assert.match(paginatorSource, /type: 'complete',\s*pages: finalPages/);
    assert.match(readerSource, /async loadReader\(\) \{[\s\S]{0,600}this\.pagedLayoutCache\.clear\(\);/);
}

async function testReaderDefersViewportRefreshAcrossScreenUnlock() {
    const readerSource = await readReaderSources();

    assert.match(readerSource, /document\.visibilityState === 'hidden'[\s\S]{0,140}this\.suspendViewportRefreshForVisibility\(\);/);
    assert.match(readerSource, /document\.visibilityState === 'visible'[\s\S]{0,140}this\.resumeViewportRefreshAfterVisibility\(\);/);
    assert.match(readerSource, /resumeViewportRefreshAfterVisibility\(\) \{[\s\S]{0,500}this\.viewportResumeGuardUntil = Date\.now\(\) \+ 520;/);
    assert.match(readerSource, /deferViewportRefreshForVisibility\(calibrate = true\)[\s\S]{0,700}Date\.now\(\) \+ 220/);
    assert.match(readerSource, /scheduleViewportRefresh\(\{calibrate = true\} = \{\}\) \{[\s\S]{0,180}this\.deferViewportRefreshForVisibility\(calibrate\)/);
    assert.match(readerSource, /await this\.waitForStablePagedStage\(\);\s*if \(this\.deferViewportRefreshForVisibility\(true\)\)/);
}

// Hiding the reader bars keeps their place: the text does not jump and pages are not rebuilt.
async function testReaderChromeToggleKeepsLayout() {
    const readerSource = await readReaderSources();
    const toggle = readerSource.slice(readerSource.indexOf('    async setReaderChromeHidden('), readerSource.indexOf('    async toggleCompactChromeVisibility('));

    assert.ok(toggle.includes('this.chromeHidden = nextHidden;'));
    assert.doesNotMatch(toggle, /beginLayoutRefresh|pagedBuild|requestAnimationFrame|updateScrollerViewport/);
    assert.doesNotMatch(readerSource, /v-show="!(reader\.)?readerChromeHidden"/);
    assert.match(readerSource, /'reader-toolbar--hidden': reader\.readerChromeHidden/);
    assert.match(readerSource, /'reader-mobile-bar--hidden': reader\.compactChromeHidden/);
    assert.match(readerSource, /\.reader-toolbar--hidden \{\s*opacity: 0;\s*visibility: hidden;/);
}

async function testReaderHomeFieldsIgnoreGlobalDarkTheme() {
    const readerSource = await readReaderSources();

    assert.match(
        readerSource,
        /\.reader-page \.reader-home-search :deep\(\.q-field__control\),\s*\.reader-page \.reader-home-sort :deep\(\.q-field__control\) \{[\s\S]{0,180}background: var\(--reader-surface\);/
    );
}

async function testReaderImageDataUrlsAreValidated() {
    const readerContent = require('../server/core/fb2/ReaderContent');
    assert.strictEqual(
        readerContent.createReaderImageDataUrl('image/png', ' iVBORw0KGgo=\n'),
        'data:image/png;base64,iVBORw0KGgo='
    );
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AQI'), 'data:image/png;base64,AQI');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/svg+xml', 'AAAA'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png" onerror="alert(1)', 'AAAA'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AAAA" onerror="alert(1)'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'A'), '');
    assert.strictEqual(readerContent.createReaderImageDataUrl('image/png', 'AAAA==='), '');
}

// The web app is compressed once at extraction; static.js serves the .br/.gz copy the browser accepts.
// Fonts woff2 and books are sent as they are; hashed fonts are cached as immutable.
async function testStaticAssetsArePrecompressed() {
    const zlib = require('zlib');
    await withTempDir(async(dir) => {
        const publicDir = path.join(dir, 'public');
        const bookDir = path.join(dir, 'book');
        const script = `console.log(${JSON.stringify('compressible '.repeat(400))});`;
        const files = {
            'index.html': `<html>${'<p>shell</p>'.repeat(200)}</html>`,
            'app/bundle.0123456789abcdef.js': script,
            'app/fonts/icons.0123456789abcdef.woff2': 'woff2 '.repeat(400),
            'app/fonts/plain.woff2': 'woff2 '.repeat(400),
            'build-id.txt': 'id',
        };
        for (const [name, content] of Object.entries(files))
            await fs.outputFile(path.join(publicDir, name), content);
        await fs.outputFile(path.join(bookDir, 'fixture.txt'), 'book '.repeat(400));
        await require('../server/createWebApp').precompress({publicDir});
        assert.ok(await fs.pathExists(path.join(publicDir, 'app/bundle.0123456789abcdef.js.br')));
        assert.ok(await fs.pathExists(path.join(publicDir, 'app/bundle.0123456789abcdef.js.gz')));
        assert.ok(!await fs.pathExists(path.join(publicDir, 'app/fonts/plain.woff2.gz')), 'woff2 is compressed already');
        assert.ok(!await fs.pathExists(path.join(publicDir, 'build-id.txt.gz')), 'No copy bigger than the file');

        await withStaticServer({rootPathStatic: '/shelf', bookPathStatic: '/shelf/book', bookDir, publicDir,
            publicFilesDir: dir, tempDir: path.join(dir, 'tmp'), libDir: dir, librarySources: []}, async(server) => {
            const get = (url, encoding) => request(server, url, (encoding === undefined ? {} : {'accept-encoding': encoding}));
            const unpack = {br: zlib.brotliDecompressSync, gzip: zlib.gunzipSync};
            for (const [encoding, expected] of [['gzip, deflate, br', 'br'], ['br', 'br'], ['gzip', 'gzip'], ['br;q=0, gzip', 'gzip'], ['identity', undefined], [undefined, undefined]]) {
                const res = await get('/shelf/app/bundle.0123456789abcdef.js', encoding);
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.headers['content-encoding'], expected, String(encoding));
                assert.match(res.headers.vary || '', /Accept-Encoding/i);
                assert.match(res.headers['content-type'], /javascript/);
                assert.match(res.headers['cache-control'], /immutable/);
                assert.strictEqual((expected ? unpack[expected](res.body) : res.body).toString(), script);
            }
            const index = await get('/shelf/', 'br');
            assert.deepStrictEqual([index.headers['content-encoding'], index.headers['cache-control']], ['br', 'no-store']);
            assert.match(index.headers['content-type'], /text\/html/);
            assert.strictEqual(zlib.brotliDecompressSync(index.body).toString(), files['index.html']);
            const cached = await get('/shelf/app/bundle.0123456789abcdef.js', 'br');
            const notModified = await request(server, '/shelf/app/bundle.0123456789abcdef.js', {'accept-encoding': 'br', 'if-none-match': cached.headers.etag});
            assert.strictEqual(notModified.status, 304);

            const font = await get('/shelf/app/fonts/icons.0123456789abcdef.woff2', 'gzip, br');
            assert.strictEqual(font.headers['content-encoding'], undefined);
            assert.match(font.headers['cache-control'], /immutable/, 'A hashed font is immutable');
            const plainFont = await get('/shelf/app/fonts/plain.woff2', 'gzip, br');
            assert.strictEqual(plainFont.headers['content-encoding'], undefined);
            assert.doesNotMatch(plainFont.headers['cache-control'] || '', /immutable/, 'An unhashed font is not');
            const book = await get('/shelf/book/fixture.txt', 'gzip, br');
            assert.deepStrictEqual([book.status, book.headers['content-encoding'], book.body.toString()], [200, undefined, 'book '.repeat(400)]);
            assert.strictEqual((await get('/shelf/..%2f..%2fbook%2ffixture.txt', 'br')).status, 404);
        });
    });
}

async function testAppCacheRecoveryBootstrapAndRoute() {
    const mainSource = (await fs.readFile(path.resolve(__dirname, '../client/main.js'), 'utf8'))
        .replace(/\r\n/g, '\n');
    const bootstrapStart = mainSource.indexOf('async function bootstrapApplication()');
    const bootstrapEnd = mainSource.indexOf('\n}\n\nbootstrapApplication()', bootstrapStart);
    assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
    const bootstrapSource = mainSource.slice(bootstrapStart, bootstrapEnd);
    const resetIndex = bootstrapSource.indexOf('await handleRequestedCacheReset()');
    const buildIndex = bootstrapSource.indexOf('await ensureCurrentAppBuild()');
    const mountIndex = bootstrapSource.indexOf('mountApplication()');
    assert.ok(resetIndex >= 0 && resetIndex < buildIndex);
    assert.ok(buildIndex < mountIndex);
    assert.match(mainSource, /Promise\.allSettled\(\[\s*clearKnownAppCaches\(\),\s*unregisterScopedServiceWorkers\(\)/);
    assert.match(mainSource, /const appReloadMaxAttempts = 3;/);
    assert.doesNotMatch(mainSource, /searchParams\.get\('appBuild'\) === deployedBuildId/);

    await withTempDir(async(dir) => {
        const publicDir = path.join(dir, 'public');
        const bookDir = path.join(dir, 'book');
        await fs.ensureDir(publicDir);
        await fs.ensureDir(bookDir);

        await withStaticServer({
            rootPathStatic: '/shelf',
            bookPathStatic: '/shelf/book',
            bookDir,
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir,
            tempDir: path.join(dir, 'tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            const response = await request(
                server,
                '/shelf/app-reset?return=https%3A%2F%2Fevil.example%2F%3Cscript%3E'
            );
            assert.strictEqual(response.status, 200);
            assert.match(response.headers['cache-control'] || '', /no-store/);
            assert.strictEqual(response.headers.pragma, 'no-cache');
            assert.match(response.headers['content-type'] || '', /text\/html/);

            const body = response.body.toString('utf8');
            assert.match(body, /const BASE_PATH = "\/shelf\/";/);
            assert.match(body, /Promise\.allSettled/);
            assert.match(body, /key\.startsWith\('inpx-web-'\)/);
            assert.match(body, /registration\.scope === currentScope/);
            assert.match(body, /target\.origin !== window\.location\.origin/);
            assert.match(body, /Настройки читалки, прогресс и закладки сохраняются/);
            assert.doesNotMatch(body, /evil\.example|<script><\/script>/);
            assert.doesNotMatch(body, /localStorage|sessionStorage\.clear|inpx\.reader\./);

            const outsideBase = await request(server, '/app-reset');
            assert.strictEqual(outsideBase.status, 404);
        });

        await withStaticServer({
            rootPathStatic: '/',
            bookPathStatic: '/book',
            bookDir,
            publicFilesDir: path.join(dir, 'root-public-files'),
            publicDir,
            tempDir: path.join(dir, 'root-tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            const response = await request(server, '/app-reset');
            assert.strictEqual(response.status, 200);
            assert.match(response.headers['cache-control'] || '', /no-store/);
            assert.match(response.body.toString('utf8'), /const BASE_PATH = "\/";/);
        });
    });
}

async function testAdminSettingsRestoreKeepsSecrets() {
    const worker = makeWorker({
        opds: {
            enabled: true,
            login: 'opds',
            password: 'current-secret',
        },
    });

    const patch = worker.normalizeImportedAdminSettings({
        settings: {
            opds: {
                enabled: false,
                passwordSet: true,
            },
            coverCacheSize: 128,
            converterPaths: {djxl: '/tmp/not-djxl'},
        },
    });

    assert.strictEqual(patch.coverCacheSize, 128);
    assert.ok(!Object.hasOwn(patch, 'converterPaths'), 'programs to run come only from the local config.json');
    assert.strictEqual(patch.opds.enabled, false);
    assert.strictEqual(patch.opds.password, 'current-secret');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(patch.opds, 'passwordSet'), false);
    assert.throws(
        () => worker.normalizeImportedAdminSettings({settings: {librarySources: {bad: true}}}),
        /librarySources/
    );

    //the stored SMTP password never goes to another server or account: changing them drops it
    Object.assign(worker.config, {smtpHost: 'smtp.example.test', smtpUser: 'mailer', smtpPass: 'smtp-secret'});
    worker.readingListStore = {validateEmailTo: value => value};
    assert.strictEqual(worker.normalizeImportedAdminSettings({settings: {smtpHost: 'evil.example.test'}}).smtpPass, '');
    assert.strictEqual(worker.normalizeIntegrationPatch({smtpHost: 'evil.example.test', smtpPass: '__KEEP__'}).smtpPass, '');
    assert.strictEqual(worker.normalizeIntegrationPatch({smtpUser: 'other', smtpPass: '__KEEP__'}).smtpPass, '');
    assert.strictEqual(worker.normalizeIntegrationPatch({smtpHost: 'evil.example.test', smtpPass: 'new'}).smtpPass, 'new');
    assert.ok(!Object.hasOwn(worker.normalizeIntegrationPatch({smtpHost: ' smtp.example.test ', smtpUser: 'mailer', smtpPass: '__KEEP__', smtpPort: 465}), 'smtpPass'),
        'Same server and account keep the password');
    assert.ok(!Object.hasOwn(worker.normalizeImportedAdminSettings({settings: {smtpHost: 'smtp.example.test', emailFrom: 'a@b.c'}}), 'smtpPass'));
}

async function testDisabledLibrarySourceIsKept() {
    await withTempDir(async(dir) => {
        const libA = path.join(dir, 'a');
        await fs.ensureDir(libA);
        await fs.writeFile(path.join(libA, 'a.inpx'), '');
        const {resolveLibrarySources, getEnabledLibrarySources} = require('../server/core/LibrarySources');
        const config = {librarySources: [
            {id: 'a', name: 'A', libDir: libA},
            {id: 'b', name: 'B', libDir: path.join(dir, 'missing'), enabled: false},
        ]};

        const enabled = await resolveLibrarySources(config);
        assert.deepStrictEqual(enabled.map(source => source.id), ['a']);
        assert.deepStrictEqual(config.librarySources.map(source => [source.id, source.enabled]), [['a', true], ['b', false]]);
        assert.strictEqual(config.libDir, libA);
        assert.deepStrictEqual(getEnabledLibrarySources(config).map(source => source.id), ['a']);

        const worker = makeWorker({librarySources: config.librarySources, adminEventLogEnabled: false});
        worker.getIndexStatus = async() => ({ready: false});
        worker.buildAdminDashboardMetrics = async() => ({paths: {}, sizes: {coverCache: {}}, limits: {}});
        worker.wState = {get: () => ({})};
        worker.adminEvents = [];
        const dashboard = await worker.getAdminDashboard();
        assert.deepStrictEqual(dashboard.sources.map(source => [source.id, source.enabled]), [['a', true], ['b', false]]);

        //выключение и включение уже проиндексированной библиотеки - без переиндексации
        const CatalogSearch = require('../server/core/search/CatalogSearch');
        const catalogSearch = new CatalogSearch(worker.config, worker);
        catalogSearch.ready = true;
        let hidden = null;
        catalogSearch.getThread = () => ({call: async(action, ids) => {
            hidden = ids;
            return {stats: null, books: 1, indexed: ['a', 'b']};
        }});
        worker.catalogSearch = catalogSearch;
        catalogSearch.meta = {inpxHash: 'built'};
        let currentHash = 'built';
        worker.inpxHashCreator = {getHash: async() => currentHash};
        worker.saveRuntimeConfigPatch = async(patch) => Object.assign(worker.config, patch);
        const save = sources => worker.updateAdminLibrarySources('', '', sources);
        const both = enabledB => [{id: 'a', name: 'A', inpx: path.join(libA, 'a.inpx'), libDir: libA}, {id: 'b', name: 'B', inpx: config.librarySources[1].inpx, libDir: path.join(dir, 'missing'), enabled: enabledB}];
        assert.strictEqual((await save(both(true))).reindexNeeded, false);
        assert.deepStrictEqual(hidden, []);
        assert.strictEqual((await save(both(false))).reindexNeeded, false);
        assert.deepStrictEqual(hidden, ['b']);
        const moved = both(false);
        moved[0].libDir = path.join(dir, 'moved');
        moved[0].name = 'Renamed';
        assert.strictEqual((await save(moved)).reindexNeeded, false, 'rename and folder move apply without reindex');
        currentHash = 'other';
        assert.strictEqual((await save(moved)).reindexNeeded, true, 'changed INPX content needs reindex');
        currentHash = 'built';
        catalogSearch.getThread = () => ({call: async() => ({stats: null, books: 1, indexed: ['a']})});
        assert.strictEqual((await save(both(true))).reindexNeeded, true, 'enabling a library missing from the index needs reindex');
        catalogSearch.meta = {inpxHash: 'h'};
        catalogSearch.visibility = {indexed: ['a', 'b']};
        assert.strictEqual(catalogSearch.libraryKey(), 'h');
        worker.config.librarySources[1].enabled = false;
        assert.notStrictEqual(catalogSearch.libraryKey(), 'h', 'caches keyed by library change when a library is hidden');
        assert.strictEqual(catalogSearch.libraryConfig().buildHash, 'h');
    });
}

//выключенная библиотека остаётся в индексе, но её книги не видны нигде; включение - без пересборки
async function testDisabledLibraryHiddenWithoutRebuild() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const file = path.join(dir, 'catalog.sqlite');
        const book = (id, title, author, extra = {}) => Object.assign({
            id, _uid: `u${id}`, title, author, series: '', serno: 0, genre: 'prose_classic', lang: 'ru', ext: 'fb2',
            size: 1000, date: '2020-01-01', librate: 4, del: 0, sourceId: 'main', keywords: '', libid: String(id),
        }, extra);

        const index = new CatalogIndex();
        index.beginBuild(file, [], [{id: 'main', name: 'Main', libDir: dir}, {id: 'second', name: 'Second', libDir: dir}]);
        index.insertBooks([
            book(1, 'Мастер и Маргарита', 'Булгаков Михаил'),
            book(2, 'Собачье сердце', 'Булгаков Михаил', {sourceId: 'second', series: 'Повести', lang: 'en', genre: 'sf'}),
            book(3, 'Пикник на обочине', 'Стругацкий Аркадий', {sourceId: 'second', series: 'Повести'}),
        ]);
        index.finishBuild({inpxHash: 'hash'});

        index.open(file, ['second', 'unknown']);
        assert.deepStrictEqual(index.search({q: ''}).ids, [1]);
        assert.deepStrictEqual(index.search({q: 'булгаков'}).authors, [{name: 'Булгаков Михаил', books: 1}]);
        assert.deepStrictEqual(index.search({q: 'стругацкий'}).authors, [], 'author with only hidden books is not suggested');
        assert.deepStrictEqual(index.listNames({kind: 'author'}).items.map(item => [item.name, item.books]), [['Булгаков Михаил', 1]]);
        assert.deepStrictEqual(index.listNames({kind: 'series'}).items, []);
        assert.deepStrictEqual(index.suggest({q: 'сердце'}).books, []);
        assert.deepStrictEqual(index.getBooks([1, 2, 3]).map(row => row.id), [1]);
        assert.deepStrictEqual(Object.keys(index.getBooksByStableKeys(['second:2'])), []);
        assert.deepStrictEqual(index.facetValues().lang, ['ru']);
        assert.deepStrictEqual(index.findBooks({author: 'булгаков'}).ids, [1]);
        assert.deepStrictEqual(index.opdsNames('author', {}).found.map(row => row.author), ['Булгаков Михаил']);
        assert.deepStrictEqual(index.opdsNames('series', {}).found, []);
        const visibility = index.sourceVisibility();
        assert.strictEqual(visibility.books, 1);
        assert.strictEqual(visibility.stats.bookCount, 1);
        assert.strictEqual(visibility.stats.seriesCount, 0);
        assert.deepStrictEqual(visibility.indexed, ['main', 'second']);

        index.setHiddenSources([], [{id: 'second', name: 'Renamed'}]);
        assert.deepStrictEqual(index.search({q: ''}).ids.sort(), [1, 2, 3]);
        const [renamed] = index.getBooks([2]);
        assert.strictEqual(renamed.sourceName, 'Renamed', 'name comes from current settings');
        assert.ok(!('sourceLibDir' in renamed), 'records carry no server paths');
        assert.strictEqual(index.getBooks([1])[0].sourceName, 'Main', 'falls back to the name stored in the index');
        assert.deepStrictEqual(index.search({q: 'булгаков'}).authors, [{name: 'Булгаков Михаил', books: 2}]);
        assert.deepStrictEqual(index.opdsNames('series', {}).found.map(row => [row.series, row.bookCount]), [['Повести', 2]]);
        assert.deepStrictEqual(index.findBooks({author: 'булгаков'}).ids.sort(), [1, 2]);
        assert.strictEqual(index.sourceVisibility().stats, null);

        //правка метаданных переносит книгу выключаемой библиотеки к другому автору: счётчики по библиотекам следуют за ней
        index.updateBook(file, {id: 3, title: 'Пикник на обочине', author: 'Булгаков Михаил', series: 'Повести'});
        index.open(file, []);
        assert.deepStrictEqual(index.listNames({kind: 'author'}).items.map(item => [item.name, item.books]), [['Булгаков Михаил', 3]]);
        index.open(file, ['second']);
        assert.deepStrictEqual(index.listNames({kind: 'author'}).items.map(item => [item.name, item.books]), [['Булгаков Михаил', 1]]);
        index.close();
    });
}

// The names card shows a rebuild as soon as one is requested, before the INPX hashing starts.
async function testAuthorNamesStatusSeesRequestedRebuild() {
    const CatalogSearch = require('../server/core/search/CatalogSearch');
    const search = Object.create(CatalogSearch.prototype);
    const authorNames = {info: async() => ({ready: true, count: 2, updatedAt: ''}), status: () => ({running: false})};
    Object.assign(search, {building: false, meta: {aliases: 0}, worker: {dbLoad: null}, authorNames, workTitles: {}});
    assert.strictEqual((await search.wikidataStatus()).indexBuilding, false);
    search.worker.dbLoad = Promise.resolve();
    assert.strictEqual((await search.wikidataStatus()).indexBuilding, true);
}

// Work titles come in one query per source; rows of one work (several authors, original title) become one entry.
async function testWorkTitlesDownload() {
    await withTempDir(async(dir) => {
        const WorkTitles = require('../server/core/search/WorkTitles');
        const queries = [];
        const row = (item, ru, en, extra = {}) => Object.assign({item: {value: item}, ru: {value: ru}, en: {value: en}}, extra);
        const titles = new WorkTitles({dataDir: dir, version: 'test'}, async(query) => {
            queries.push(query);
            if (!query.includes('wd:Q7725634'))
                return {results: {bindings: []}};
            return {results: {bindings: [
                row('Q1', 'Гиперион', 'Hyperion', {aru: {value: 'Дэн Симмонс'}, aen: {value: 'Dan Simmons'}}),
                row('Q2', 'Отверженные', 'Les Misérables', {title: {value: 'Les Misérables'}, aru: {value: 'Виктор Гюго'}}),
                row('Q3', 'Пикник на обочине', 'Roadside Picnic', {aru: {value: 'Аркадий Стругацкий'}}),
                row('Q3', 'Пикник на обочине', 'Roadside Picnic', {aru: {value: 'Борис Стругацкий'}}),
                row('Q4', 'Чикаго', 'Chicago'),
            ]}};
        });
        assert.strictEqual(await titles.download(), 3, 'a work without an author is dropped');
        assert.strictEqual(queries.length, 3, 'one query per source, no pages');
        assert.ok(queries.every(query => /wikipedia\.org/.test(query) && !/OFFSET/.test(query)));
        assert.deepStrictEqual((await titles.readEntries()).entries, [
            [['Гиперион', 'Hyperion'], ['Дэн Симмонс', 'Dan Simmons']],
            [['Отверженные', 'Les Misérables'], ['Виктор Гюго']],
            [['Пикник на обочине', 'Roadside Picnic'], ['Аркадий Стругацкий', 'Борис Стругацкий']],
        ]);
        assert.deepStrictEqual(await titles.sameWork('Пикник на обочине', 'Стругацкий Борис Натанович'),
            {titles: ['пикник на обочине', 'roadside picnic'], authors: ['Аркадий Стругацкий', 'Борис Стругацкий']});
        assert.deepStrictEqual((await titles.sameWork('Гиперион', 'Гёльдерлин Фридрих')).titles, []);
    });
}

// English author names move between servers in their own archive, through the same checks as the full backup.
async function testAuthorNamesExportAndImport() {
    await withTempDir(async(dir) => {
        const StreamZip = require('node-stream-zip');
        const ReadingListStore = require('../server/core/ReadingListStore');
        const server = (name) => {
            const dataDir = path.join(dir, name);
            const worker = makeWorker({dataDir, tempDir: path.join(dir, `${name}-tmp`), configFile: path.join(dataDir, 'config.json')});
            worker.readingListStore = new ReadingListStore({dataDir, adminLogin: 'admin', adminPassword: 'admin'});
            const table = () => ({infoCache: {ready: false}, changed() { this.infoCache = null; }});
            worker.catalogSearch = {ready: false, authorNames: table(), workTitles: table()};
            return worker;
        };
        const source = server('old');
        const target = server('new');
        await fs.ensureDir(target.config.dataDir);
        await assert.rejects(target.createAdminBackup('admin', 'token', 'author-names'), /Nothing to save|нечего/);

        const names = {source: 'wikidata', updatedAt: '2026-10-01T00:00:00.000Z', entries: [['Азимов Айзек', 'Isaac Asimov'], [1, 2]]};
        await fs.outputJson(path.join(source.config.dataDir, 'author-names.json'), names);
        await fs.outputJson(source.config.configFile, {opds: {}});
        const exported = await source.createAdminBackup('admin', 'token', 'author-names');
        assert.match(exported.fileName, /^inpx-shelf-author-names-.+\.zip$/);
        const file = path.join(source.config.dataDir, 'backups', exported.fileName);
        const zip = new StreamZip.async({file});
        try {
            assert.deepStrictEqual(Object.keys(await zip.entries()).sort(), ['author-names.json', 'backup-info.json']);
        } finally {
            await zip.close();
        }
        const upload = async(name) => ({file: path.join(source.config.dataDir, 'backups', name)});

        //имена не подменяют полный бэкап, а полный бэкап не загружается вместо имён
        await assert.rejects(target.importAdminBackup('admin', 'token', await upload(exported.fileName)), /полный|full/i);
        const full = await source.createAdminBackup('admin', 'token');
        await assert.rejects(target.importAdminBackup('admin', 'token', await upload(full.fileName), 'author-names'), /неизвестн|unknown/i);
        await assert.rejects(target.importAdminBackup('admin', 'token', await upload(full.fileName), 'everything'));

        const events = [];
        target.addAdminEvent = (level, area, message) => events.push([level, area, message]);
        const validAfter = (await target.readingListStore.load()).users.map(user => user.sessionsValidAfter);
        const result = await target.importAdminBackup('admin', 'token', await upload(exported.fileName), 'author-names');
        assert.deepStrictEqual(result.restored, ['author-names.json']);
        assert.deepStrictEqual(events.map(([level, area]) => [level, area]), [['info', 'settings']]);
        assert.doesNotMatch(JSON.stringify(events), /fullBackupRestored/, 'a names import is not reported as a full restore');
        assert.match(JSON.stringify(events), /authorNamesImported/);
        assert.strictEqual(result.restartRecommended, false);
        assert.deepStrictEqual((await target.readingListStore.load()).users.map(user => user.sessionsValidAfter), validAfter,
            'importing names keeps everyone signed in');
        assert.strictEqual(target.catalogSearch.authorNames.infoCache, null, 'the names status is read again');
        assert.deepStrictEqual(await fs.readJson(path.join(target.config.dataDir, 'author-names.json')),
            {source: 'wikidata', updatedAt: '2026-10-01T00:00:00.000Z', entries: [['Азимов Айзек', 'Isaac Asimov']]});
        assert.strictEqual(await fs.pathExists(target.config.configFile), false, 'nothing else is written');

        //названия произведений - так же, своим архивом
        await fs.outputJson(path.join(source.config.dataDir, 'work-titles.json'),
            {source: 'wikidata', updatedAt: '2026-10-02T00:00:00.000Z', entries: [[['Гиперион', 'Hyperion'], ['Дэн Симмонс']]]});
        const works = await source.createAdminBackup('admin', 'token', 'work-titles');
        assert.match(works.fileName, /^inpx-shelf-work-titles-/);
        await assert.rejects(target.importAdminBackup('admin', 'token', await upload(exported.fileName), 'work-titles'), /work-titles|неизвестн|unknown/i);
        events.length = 0;
        assert.deepStrictEqual((await target.importAdminBackup('admin', 'token', await upload(works.fileName), 'work-titles')).restored, ['work-titles.json']);
        assert.strictEqual(target.catalogSearch.workTitles.infoCache, null);
        assert.match(JSON.stringify(events), /workTitlesImported/);
        assert.strictEqual((await fs.readJson(path.join(target.config.dataDir, 'work-titles.json'))).entries.length, 1);

        //профиль: Kobo из бэкапа проверяется правилами kobo-sync.json до изменения данных
        await target.readingListStore.load();
        const before = await fs.readFile(target.readingListStore.file, 'utf8');
        await assert.rejects(target.importReadingLists('', {lists: [{name: 'New', books: []}], kobo: {devices: {}}}), /kobo-sync\.json/);
        assert.strictEqual(await fs.readFile(target.readingListStore.file, 'utf8'), before);
    });
}

async function testAdminBackupArchiveAndDownload() {
    await withTempDir(async(dir) => {
        const bookDir = path.join(dir, 'book');
        const dataDir = path.join(dir, 'data');
        const configFile = path.join(dataDir, 'config.json');
        await fs.ensureDir(dataDir);
        await fs.writeJson(configFile, {
            coverCacheSize: 256,
            opds: {
                enabled: true,
                password: 'full-backup-secret',
            },
            // machine-local: a restore must not take these from the backup
            allowUnsafeFilter: true,
            inpxFilterFile: '/elsewhere/filter.json',
            converterPaths: {fb2cng: '/elsewhere/tool'},
        });
        await fs.writeJson(path.join(dataDir, 'reading-lists.json'), {
            version: 5,
            users: [{
                id: 'reader',
                name: 'Reader',
                readerProgress: {'book:1': {percent: 0.5}},
                readerBookmarks: {'book:1': [{id: 'bookmark-1', title: 'Chapter'}]},
            }],
            lists: [{id: 'list-1', userId: 'reader', name: 'Reading', books: [{bookUid: 'book:1', read: false}]}],
        });
        await fs.writeJson(path.join(dataDir, 'discovery-cache.json'), {items: []});
        await fs.writeJson(path.join(dataDir, 'author-names.json'), {source: 'wikidata', updatedAt: '2026-10-01T00:00:00.000Z',
            entries: [['Азимов Айзек', 'Isaac Asimov'], ['bad']]});
        const KoboStore = require('../server/core/kobo/KoboStore');
        const koboToken = 'abcdef0123456789abcdef0123456789';
        await fs.writeJson(path.join(dataDir, 'kobo-sync.json'), {
            version: 1,
            devices: [{id: 'kobo-1', userId: 'reader', name: 'Clara', tokenHash: KoboStore.hashToken(koboToken), listIds: ['list-1'],
                books: {'0b5c6f9e-3d0a-5c1e-9f6a-2b7d8e4c1a90': {bookUid: 'book:1', size: 10}}}],
            states: {reader: {'0b5c6f9e-3d0a-5c1e-9f6a-2b7d8e4c1a90': {status: 'Reading'}}},
        });
        const backupSecretKey = require('crypto').randomBytes(32).toString('base64');
        await fs.writeFile(path.join(dataDir, 'secret.key'), backupSecretKey);
        await fs.ensureDir(path.join(dataDir, 'db'));
        await fs.writeFile(path.join(dataDir, 'db', 'index.json'), '{}');

        const worker = makeWorker({
            name: 'inpx-shelf',
            version: '1.6.7-test',
            bookDir,
            bookPathStatic: '/book',
            dataDir,
            configFile,
        });

        const result = await worker.createAdminBackup('admin', 'token');
        assert.strictEqual(result.success, true);
        assert.match(result.fileName, /^inpx-shelf-backup-.+\.zip$/);
        assert.strictEqual(result.link, `/admin-backups/${encodeURIComponent(result.fileName)}`);
        assert.strictEqual(await fs.pathExists(path.join(dataDir, 'backups', result.fileName)), true);
        assert.deepStrictEqual(await fs.readdir(path.join(dataDir, 'backups')), [result.fileName], 'No temporary files left');
        if (process.platform !== 'win32')
            assert.strictEqual((await fs.stat(path.join(dataDir, 'backups', result.fileName))).mode & 0o777, 0o600, 'The backup holds secret.key');

        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({file: path.join(dataDir, 'backups', result.fileName)});
        try {
            const entries = await zip.entries();
            assert.ok(entries['backup-info.json']);
            assert.ok(entries['config.json']);
            assert.ok(entries['reading-lists.json']);
            assert.ok(entries['secret.key']);
            assert.strictEqual(entries['discovery-cache.json'], undefined);
            assert.ok(entries['kobo-sync.json']);
            assert.ok(entries['author-names.json']);
            assert.strictEqual(entries['db/index.json'], undefined);

            const readingLists = JSON.parse((await zip.entryData('reading-lists.json')).toString('utf8'));
            assert.strictEqual(readingLists.users[0].readerProgress['book:1'].percent, 0.5);
            assert.strictEqual(readingLists.users[0].readerBookmarks['book:1'][0].id, 'bookmark-1');
            assert.strictEqual(readingLists.lists[0].books[0].bookUid, 'book:1');

            const info = JSON.parse((await zip.entryData('backup-info.json')).toString('utf8'));
            assert.match(info.note, /reader progress and bookmarks/);
            assert.match(info.note, /does not include .*search DB/i);
        } finally {
            await zip.close();
        }

        const Security = require('../server/core/Security');
        const security = new Security({dataDir});
        await security.init();
        const users = [{id: 'admin', isAdmin: true, sessionsValidAfter: 0}, {id: 'reader', sessionsValidAfter: 0}];
        worker.readingListStore = {load: async() => ({users})};
        worker.requireAdmin = async(userId) => {
            if (userId !== 'admin')
                throw new Error('Admin required');
        };
        const sessionHeaders = (userId, fields) => ({cookie: require('./api-test-client').sessionCookie(security, userId, fields).cookie});
        const adminHeaders = sessionHeaders('admin');
        const readerHeaders = sessionHeaders('reader');
        await fs.outputFile(path.join(bookDir, 'backup', result.fileName), 'legacy-secret');

        await withStaticServer({
            bookDir,
            bookPathStatic: '/book',
            dataDir,
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'),
            libDir: dir,
            librarySources: [],
        }, async(server) => {
            assert.strictEqual((await request(server, result.link)).status, 401);
            assert.strictEqual((await request(server, result.link, readerHeaders)).status, 403);
            const ok = await request(server, result.link, adminHeaders);
            assert.strictEqual(ok.status, 200);
            assert.match(ok.headers['content-disposition'] || '', /attachment/);
            assert.ok(ok.body.length > 0);

            const expiredHeaders = sessionHeaders('admin', {createdAt: Date.now() - 400*24*60*60*1000});
            assert.strictEqual((await request(server, result.link, expiredHeaders)).status, 401);

            const notZip = await request(server, '/admin-backups/readme.txt', adminHeaders);
            assert.strictEqual(notZip.status, 404);
            for (const prefix of ['/book/backup/', '/book/%62ackup/', '/book/BACKUP/', '/book/foo/../backup/', '/book/backup%2f']) {
                const denied = await request(server, prefix + result.fileName, adminHeaders);
                assert.strictEqual(denied.status, 403, prefix);
                assert.ok(!denied.body.includes(Buffer.from('legacy-secret')));
            }
            users[0].sessionsValidAfter = Date.now() + 1;
            assert.strictEqual((await request(server, result.link, adminHeaders)).status, 401, 'Sessions ended');
        }, worker, security);

        const ReadingListStore = require('../server/core/ReadingListStore');
        const restoreDataDir = path.join(dir, 'restore-data');
        const restoreConfigFile = path.join(restoreDataDir, 'config.json');
        const restoreWorker = makeWorker({
            dataDir: restoreDataDir,
            tempDir: path.join(dir, 'restore-tmp'),
            configFile: restoreConfigFile,
            bookDir: path.join(dir, 'restore-book'),
            bookPathStatic: '/book',
            opds: {
                enabled: false,
                password: 'old-secret',
            },
        });
        restoreWorker.readingListStore = new ReadingListStore({
            dataDir: restoreDataDir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });

        // A full admin restore is authoritative: it must be able to replace a
        // newer local reset generation with the progress stored in the backup.
        await restoreWorker.readingListStore.save({
            version: 5,
            users: [{
                id: 'reader',
                name: 'Reader before restore',
                readerProgress: {
                    'book:stale': {
                        percent: 0.9,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            }],
            lists: [],
        });
        const preRestoreReset = await restoreWorker.readingListStore.clearReaderProgress('reader');
        assert.strictEqual(preRestoreReset.generation, 1);
        const restoreStarted = Date.now();
        const restoreKoboStore = new KoboStore({dataDir: restoreDataDir});
        await restoreKoboStore.load();
        restoreWorker.koboService = {store: restoreKoboStore};
        assert.strictEqual(restoreKoboStore.findDeviceByToken(koboToken), null);

        const restored = await restoreWorker.importAdminBackup('admin', 'token', {file: path.join(dataDir, 'backups', result.fileName)});
        assert.strictEqual(restored.success, true);
        assert.ok((await restoreWorker.readingListStore.load()).users.every(user => user.sessionsValidAfter > restoreStarted), 'A restore ends all sessions');
        assert.strictEqual(restored.restartRecommended, true);
        assert.match(restored.snapshot, /^inpx-shelf-pre-restore-.+\.zip$/, 'the state before the restore is kept');
        assert.ok(restored.restored.includes('config.json'));
        assert.ok(restored.restored.includes('secret.key'));
        assert.ok(restored.restored.includes('reading-lists.json'));
        assert.ok(restored.restored.includes('kobo-sync.json'));
        assert.deepStrictEqual(await fs.readJson(path.join(restoreDataDir, 'author-names.json')),
            {source: 'wikidata', updatedAt: '2026-10-01T00:00:00.000Z', entries: [['Азимов Айзек', 'Isaac Asimov']]},
            'English author names come back without a Wikidata download; malformed rows are dropped');
        const restoredKobo = await fs.readJson(path.join(restoreDataDir, 'kobo-sync.json'));
        assert.strictEqual(restoredKobo.devices[0].tokenHash, KoboStore.hashToken(koboToken), 'devices keep their token');
        assert.strictEqual(restoredKobo.states.reader['0b5c6f9e-3d0a-5c1e-9f6a-2b7d8e4c1a90'].status, 'Reading');
        assert.strictEqual(restoreKoboStore.findDeviceByToken(koboToken).id, 'kobo-1', 'the running service sees restored devices');
        const restoredSecrets = await new (require('../server/core/SecretStore'))({dataDir: restoreDataDir})
            .unprotectConfig(await fs.readJson(restoreConfigFile));
        assert.strictEqual(restoredSecrets.config.opds.password, 'full-backup-secret');
        for (const key of ['allowUnsafeFilter', 'inpxFilterFile', 'converterPaths']) {
            assert.strictEqual(restoredSecrets.config[key], undefined, key);
            assert.strictEqual(restoreWorker.config[key], undefined, key);
        }
        assert.strictEqual((await fs.readFile(path.join(restoreDataDir, 'secret.key'), 'utf8')), backupSecretKey);

        const restoredLists = await restoreWorker.readingListStore.load();
        const restoredReader = restoredLists.users.find(user => user.id === 'reader');
        assert.ok(restoredReader);
        assert.strictEqual(restoredReader.readerProgressGeneration, 2);
        assert.strictEqual(restoredReader.readerProgress['book:1'].percent, 0.5);
        assert.strictEqual(restoredReader.readerProgress['book:1'].generation, 2);
        assert.strictEqual(restoredReader.readerBookmarks['book:1'][0].id, 'bookmark-1');

        const staleAfterRestore = await restoreWorker.readingListStore.updateReaderProgress('reader', 'book:1', {
            percent: 0.99,
            updatedAt: '2030-01-01T00:00:00.000Z',
            generation: 1,
        });
        assert.strictEqual(staleAfterRestore.generationMismatch, true);
        assert.strictEqual(staleAfterRestore.percent, 0.5);
    });
}

async function testUserBackupExportsAndRestoresReaderState() {
    //импорт берёт только настоящие _uid (base64 от SHA-256)
    const bookUid = require('crypto').createHash('sha256').update('source:book:1').digest('base64');
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({
            dataDir: dir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });
        await store.save({
            version: 5,
            users: [{
                id: 'reader-a',
                name: 'Reader A',
                emailTo: 'reader@example.test',
                telegramChatId: '12345',
                opdsEnabled: true,
                opdsAuthEnabled: true,
                readerPreferences: {
                    theme: 'sepia',
                    fontFamily: 'sans',
                    fontSize: 21,
                },
                readerProgress: {
                    [bookUid]: {
                        percent: 0.75,
                        sectionId: 'chapter-3',
                        hidden: false,
                    },
                },
                readerBookmarks: {
                    [bookUid]: [{
                        id: 'bookmark-a',
                        title: 'Chapter 3',
                        excerpt: 'Text',
                        note: 'Note',
                        percent: 0.75,
                    }],
                },
                discoveryPreferences: {
                    taste: {genres: ['sf']},
                },
            }, {
                id: 'reader-b',
                name: 'Reader B',
            }],
            lists: [{
                id: 'list-a',
                userId: 'reader-a',
                name: 'Reading',
                visibility: 'private',
                books: [{bookUid}],
            }],
        });

        const exported = await store.exportData('reader-a');
        assert.strictEqual(exported.version, 4);
        assert.strictEqual(exported.user.emailTo, 'reader@example.test');
        assert.strictEqual(exported.user.readerPreferences.theme, 'sepia');
        assert.strictEqual(exported.user.readerProgress[bookUid].percent, 0.75);
        assert.strictEqual(exported.user.readerBookmarks[bookUid][0].id, 'bookmark-a');
        assert.deepStrictEqual(exported.user.discoveryPreferences.taste.genres, ['sf']);
        assert.deepStrictEqual(exported.lists[0].books, [{bookUid}]);

        const imported = await store.importData('reader-b', exported);
        assert.strictEqual(imported.importedLists, 1);
        assert.strictEqual(imported.importedBooks, 1);
        assert.strictEqual(imported.importedProgress, 1);
        assert.strictEqual(imported.importedBookmarks, 1);

        const restored = await store.exportData('reader-b');
        assert.strictEqual(restored.user.name, 'Reader B');
        assert.strictEqual(restored.user.telegramChatId, '12345');
        assert.strictEqual(restored.user.readerPreferences.fontFamily, 'sans');
        assert.strictEqual(restored.user.readerProgress[bookUid].sectionId, 'chapter-3');
        assert.strictEqual(restored.user.readerBookmarks[bookUid][0].note, 'Note');
        assert.deepStrictEqual(restored.user.discoveryPreferences.taste.genres, ['sf']);

        // OPDS and KOReader credentials travel as hashes, like Kobo device tokens.
        const opdsHash = `scrypt:v1:${'a'.repeat(32)}:${'b'.repeat(64)}`;
        const withCredentials = JSON.parse(JSON.stringify(exported));
        Object.assign(withCredentials.user, {opdsPasswordHash: opdsHash, kosyncKeyHash: 'c'.repeat(64), kosyncProgress: {
            ['d'.repeat(32)]: {progress: '/body/p[3]', percentage: 0.4, device: 'kr', device_id: 'X', timestamp: 100},
            bad: {progress: 'x', percentage: 1, timestamp: 1},
        }});
        await store.importData('reader-b', withCredentials);
        let readerB = await store.getUser('reader-b');
        assert.strictEqual(readerB.opdsPasswordHash, '', 'no login, no OPDS password');
        assert.strictEqual(readerB.kosyncKeyHash, 'c'.repeat(64));
        assert.deepStrictEqual(Object.keys(readerB.kosyncProgress), ['d'.repeat(32)]);
        await store.updateUser('reader-b', {login: 'reader-b'});
        withCredentials.user.kosyncProgress['d'.repeat(32)].timestamp = 50;
        await store.importData('reader-b', withCredentials);
        readerB = await store.getUser('reader-b');
        assert.strictEqual(readerB.opdsPasswordHash, opdsHash);
        assert.strictEqual(readerB.kosyncProgress['d'.repeat(32)].timestamp, 100, 'an older row does not replace a newer one');
        const exportedB = await store.exportData('reader-b');
        assert.strictEqual(exportedB.user.opdsPasswordHash, opdsHash);
        assert.strictEqual(exportedB.user.kosyncKeyHash, 'c'.repeat(64));
        // another profile cannot take a KOReader key already in use
        await store.importData('reader-a', exportedB);
        assert.strictEqual((await store.getUser('reader-a')).kosyncKeyHash || '', '');
        await store.updateUser('reader-b', {emailTo: 'b@example.test'});

        // An older backup must not roll back a position saved after it.
        const backup = JSON.parse(JSON.stringify(exported));
        backup.user.readerProgress[bookUid].updatedAt = '2020-01-01T00:00:00.000Z';
        await store.updateReaderProgress('reader-b', bookUid, {percent: 0.9, updatedAt: new Date().toISOString(), force: true});
        const again = await store.importData('reader-b', backup);
        assert.strictEqual(again.importedProgress, 0);
        assert.strictEqual((await store.exportData('reader-b')).user.readerProgress[bookUid].percent, 0.9);
    });
}

async function testProfileReadingSummaryLeavesOutReadBooks() {
    const worker = makeWorker();
    worker.catalogSearch = {getBooksByUids: async uids => uids.map(uid => ({_uid: uid, title: 'Книга', author: 'Автор', ext: 'fb2'}))};
    const summary = await worker.buildUserReadingSummary({readerProgress: {
        reading: {percent: 0.5},
        finished: {percent: 1},
        almost: {percent: 0.9995},
        hidden: {percent: 0.3, hidden: true},
    }}, 48);
    assert.deepStrictEqual(summary.items.map(book => book.bookUid), ['reading']);
    assert.strictEqual(summary.count, 1);
}

// A series feed lists the filtered books in series order and links to all when the filter hid some.
async function testOpdsSeriesEntriesAndFilter() {
    const page = Object.assign(Object.create(require('../server/core/opds/SeriesPage').prototype),
        {config: {}, opdsRoot: '/opds', id: 'series', showDeleted: false});
    const books = [
        {_uid: 'b', author: 'A', series: 'S', title: 'Beta', genre: 'sf', serno: 2, ext: 'fb2'},
        {_uid: 'a', author: 'A', series: 'S', title: 'Alpha', genre: 'det', serno: 1, ext: 'fb2'},
    ];
    assert.deepStrictEqual(page.seriesEntries(books, {series: '=s', genre: 'sf'}, '/series?all=1').map(e => e.id), ['all_series_books', 'b']);
    assert.deepStrictEqual(page.seriesEntries(books, {series: '=s', genre: 'sf', all: '1'}, '').map(e => e.id), ['a', 'b']);
    assert.deepStrictEqual(page.filterBooks(books, {title: '~^al'}).map(book => book._uid), ['a']);
}

async function testBookPageRecordAndReaderStates() {
    const worker = makeWorker();
    worker.getBookRecordByUid = async(uid) => (uid === 'book:1' ? {_uid: 'book:1', title: 'Старое название', author: 'Автор Первый', ext: 'fb2', size: 10, series: 'Цикл', serno: 1} : null);
    worker.readingListStore = {getMetadataOverrides: async() => ({'book:1': {title: 'Новое название'}}), getBookNoteState: async() => ({uids: [], notes: {}})};
    worker.applyMetadataOverridesToRows = (rows, overrides) => rows.forEach(row => Object.assign(row, overrides[row._uid] || {}));
    worker.applyPreparedBookSizesToRows = async() => {};
    //издания - как замены недоступной книги: то же название и первый автор, серия может быть записана иначе
    worker.catalogSearch = {getBooksByUids: async() => [], getBooksByTitles: async() => ({'старое название': [
        {_uid: 'book:1', title: 'Старое название', author: 'Автор Первый', series: 'Цикл', serno: 1},
        {_uid: 'book:2', title: 'Старое название', author: 'Автор Первый Отчество', series: 'Цикл (другая запись)', serno: 1},
        {_uid: 'book:3', title: 'Старое название', author: 'Другой Автор'},
    ]})};

    const page = await worker.getBook('book:1');
    assert.strictEqual(page.book.title, 'Новое название');
    assert.deepStrictEqual(page.editions.map(book => book._uid), ['book:2'], 'the book page gets the other editions, whatever their series');
    await assert.rejects(() => worker.getBook('missing'), /Книга не найдена/);

    //помеченная удалённой: вместо изданий - неудалённые замены, и старые тоже; новая редакция на том же языке - флаг для списков
    const hyperion = {_uid: 'del:1', title: 'Гиперион', author: 'Симмонс Дэн', lang: 'en', date: '2017-10-27', del: 1};
    const editionsOf = (...rows) => async() => ({'гиперион': [hyperion, ...rows.map(row => Object.assign({title: 'Гиперион', author: 'Симмонс Дэн', del: 0}, row))]});
    worker.getBookRecordByUid = async(uid) => (uid === hyperion._uid ? Object.assign({}, hyperion) : null);
    worker.catalogSearch.getBooksByTitles = editionsOf({_uid: 'old', lang: 'en', date: '2013-10-30'}, {_uid: 'gone', lang: 'en', date: '2020-01-01', del: 1},
        {_uid: 'new', lang: 'en', date: '2026-09-12'}, {_uid: 'ru', lang: 'ru', date: '2026-10-01'});
    const deleted = await worker.getBook(hyperion._uid);
    assert.deepStrictEqual(deleted.editions, []);
    assert.deepStrictEqual(deleted.replacements.map(book => book._uid).sort(), ['new', 'old', 'ru'], 'a deleted book offers every non-deleted match');
    const listed = [Object.assign({}, hyperion), Object.assign({}, hyperion, {_uid: 'del:2', unavailable: 'disabled'}), {_uid: 'live', title: 'Гиперион', author: 'Симмонс Дэн'}];
    await worker.markNewerEditions(listed);
    assert.deepStrictEqual(listed.map(book => !!book.newerEdition), [true, false, false], 'only a readable deleted book with a later edition is flagged');
    worker.catalogSearch.getBooksByTitles = editionsOf({_uid: 'old', lang: 'en', date: '2013-10-30'}, {_uid: 'ru', lang: 'ru', date: '2026-10-01'});
    const noNewer = [Object.assign({}, hyperion)];
    await worker.markNewerEditions(noNewer);
    assert.strictEqual(noNewer[0].newerEdition, false, 'an older edition or another language is not a newer edition');

    const user = {readerProgress: {a: {percent: 0.4}, b: {percent: 1}, c: {percent: 0.2, hidden: true}}};
    assert.deepStrictEqual(worker.getUserBookStates(user, ['a', 'b', 'c', 'missing', '']).states, {
        a: {percent: 0.4, read: false, hidden: false, inList: false},
        b: {percent: 1, read: true, hidden: false, inList: false},
        c: {percent: 0.2, read: false, hidden: true, inList: false},
    });
    assert.deepStrictEqual(worker.getUserBookStates(null, ['a']).states, {});
    worker.readingListStore.normalizeEntries = rows => rows;
    assert.deepStrictEqual(worker.getUserBookStates(user, ['a', 'd', 'e'], [{books: [{bookUid: 'a'}, {bookUid: 'd'}]}]).states, {
        a: {percent: 0.4, read: false, hidden: false, inList: true},
        d: {percent: 0, read: false, hidden: false, inList: true},
    });

    worker.getEffectiveUser = async(userId) => ({
        guest: {id: 'default', name: 'Без профиля', login: '', passwordHash: ''},
        open: {id: 'open', name: 'Дети', passwordHash: ''},
        locked: {id: 'locked', name: 'Вера', passwordHash: 'hash'},
    })[userId];
    assert.strictEqual(await worker.getAuthorizedUserOrNull('guest', ''), null);
    assert.strictEqual((await worker.getAuthorizedUserOrNull('open', '')).id, 'open');
    assert.strictEqual(await worker.getAuthorizedUserOrNull('locked', ''), null);
    assert.strictEqual((await worker.getAuthorizedUserOrNull('locked', worker.profileToken('locked'))).id, 'locked');
    assert.strictEqual(await worker.getAuthorizedUserOrNull('locked', {userId: 'locked'}), null, 'Only a token the server issued');
}

async function testCatalogIndexSearch() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const file = path.join(dir, 'catalog.sqlite');
        const book = (id, title, author, extra = {}) => Object.assign({
            id, _uid: `u${id}`, title, author, series: '', serno: 0, genre: 'prose_classic', lang: 'ru', ext: 'fb2',
            size: 1000, date: '2020-01-01', librate: 4, del: 0, sourceId: 'main', keywords: '', libid: String(id),
        }, extra);

        const index = new CatalogIndex();
        index.beginBuild(file);
        index.insertBooks([
            book(1, 'Мастер и Маргарита', 'Булгаков Михаил Афанасьевич', {date: '2020-03-01'}),
            book(2, 'Собачье сердце', 'Булгаков Михаил Афанасьевич', {date: '2020-02-01'}),
            book(3, 'Трудно быть богом', 'Стругацкий Аркадий Натанович,Стругацкий Борис Натанович', {series: 'Мир Полудня', serno: 3, genre: 'sf_social,sf'}),
            book(4, 'Ёлка у Ивановых', 'Введенский Александр', {genre: 'dramaturgy'}),
            book(5, 'A Wizard of Earthsea', 'Le Guin Ursula', {lang: 'en', ext: 'epub', genre: 'sf_fantasy'}),
            book(6, 'Мастер и Маргарита', 'Булгаков Михаил Афанасьевич', {sourceId: 'second'}),
            book(7, 'Удалённая книга', 'Булгаков Михаил Афанасьевич', {del: 1}),
        ]);
        assert.deepStrictEqual(index.finishBuild({inpxHash: 'hash'}), {books: 7, authors: 5, series: 1, aliases: 0});
        assert.strictEqual(index.open(file).inpxHash, 'hash');

        //записи книг: исходные поля, поиск по _uid и по ключу Kobo, статистика, колонки из файла
        const [rec] = index.getBooks([3]);
        assert.strictEqual(rec._uid, 'u3');
        assert.strictEqual(rec.author, 'Стругацкий Аркадий Натанович,Стругацкий Борис Натанович');
        assert.strictEqual(rec.series, 'Мир Полудня');
        assert.strictEqual(rec.serno, 3);
        assert.strictEqual(rec.sourceId, 'main');
        assert.deepStrictEqual(index.getBooks([5, 1]).map(row => row.id), [5, 1], 'order of ids is kept');
        assert.deepStrictEqual(index.getBooksByUids(['u2', 'nope']).map(row => row.id), [2]);
        const byKey = index.getBooksByStableKeys(['main:1', 'main:none']);
        assert.deepStrictEqual(Object.keys(byKey), ['main:1']);
        assert.strictEqual(byKey['main:1'][0]._uid, 'u1');
        const stats = JSON.parse(index.meta().stats);
        assert.strictEqual(stats.bookCount, 6);
        assert.strictEqual(stats.bookDelCount, 1);
        assert.strictEqual(stats.seriesCount, 1);
        index.close();
        index.open(file);

        const search = (q, extra = {}) => index.search(Object.assign({q}, extra));
        assert.deepStrictEqual(search('булгаков').ids.sort(), [1, 2, 6]);
        const typo = search('булгоков');
        assert.strictEqual(typo.corrected, 'булгаков');
        assert.strictEqual(typo.total, 3);
        assert.deepStrictEqual(typo.authors, [{name: 'Булгаков Михаил Афанасьевич', books: 3}]);
        const layout = search('vfcnth');
        assert.strictEqual(layout.layout, true);
        assert.deepStrictEqual(layout.ids.sort(), [1, 6]);
        assert.deepStrictEqual(search('елка').ids, [4], 'ё and е must match');
        assert.deepStrictEqual(search('гацк').authors.map(item => item.name), ['Стругацкий Аркадий Натанович', 'Стругацкий Борис Натанович']);
        assert.deepStrictEqual(search('мир полудня').series.map(item => item.name), ['Мир Полудня']);
        assert.deepStrictEqual(search('author:стругацк').ids, [3]);
        assert.deepStrictEqual(search('title:="мастер и маргарита"').ids.sort(), [1, 6]);
        assert.deepStrictEqual(search('lang:en').ids, [5]);
        assert.strictEqual(search('булгаков -genre:prose_classic').total, 0);
        //издания одного произведения (1 и 6) - одна позиция выдачи; итог и страницы считают произведения
        const grouped = search('мастер', {group: true});
        assert.deepStrictEqual([grouped.ids, grouped.editions, grouped.total], [[1], {1: 2}, 1]);
        const secondSource = search('мастер', {group: true, filters: {source: ['second']}});
        assert.deepStrictEqual([secondSource.ids, secondSource.editions], [[6], {}], 'editions are counted after filters');
        assert.deepStrictEqual(search('мастер').ids.sort(), [1, 6], 'without group every edition is listed');
        const byDate = search('', {group: true, sort: 'date'});
        assert.deepStrictEqual([byDate.ids, byDate.total], [[1, 2, 5, 4, 3], 5]);
        assert.deepStrictEqual(search('', {group: true, sort: 'date', offset: 2, limit: 2}).ids, [5, 4]);
        assert.deepStrictEqual(search('булгаков', {group: true}).editions, {1: 2}, 'relevance order is grouped too');
        assert.strictEqual(index.suggest({q: 'мастер'}).books.length, 1, 'suggestions show one edition');
        assert.strictEqual(search('булгаков', {showDeleted: true}).total, 4);
        assert.deepStrictEqual(search('', {filters: {genre: ['sf']}}).ids, [3]);
        assert.deepStrictEqual(search('', {sort: 'date', limit: 2}).ids, [1, 2]);
        assert.deepStrictEqual(search('', {sort: 'date', limit: 2, offset: 1}).ids, [2, 6], 'equal dates: newer id first');

        //счётчик фильтра считается без его собственного условия
        const facets = search('', {filters: {lang: ['en']}}).facets;
        assert.deepStrictEqual(facets.lang, [['ru', 5], ['en', 1]]);
        assert.deepStrictEqual(facets.ext, [['epub', 1]]);

        const authorsAll = index.listNames({kind: 'author', limit: 2});
        assert.strictEqual(authorsAll.total, 5);
        assert.deepStrictEqual(authorsAll.items.map(item => item.name), ['Le Guin Ursula', 'Булгаков Михаил Афанасьевич'], 'authors are listed alphabetically');
        assert.deepStrictEqual(index.listNames({kind: 'author', q: 'струг'}).items.map(item => item.name).sort(), ['Стругацкий Аркадий Натанович', 'Стругацкий Борис Натанович']);
        assert.deepStrictEqual(index.listNames({kind: 'series', q: 'пол'}).items, [{name: 'Мир Полудня', books: 1}]);
        assert.strictEqual(index.listNames({kind: 'author', q: 'xyz'}).total, 0);

        //«Похожие»: книги автора из вкуса и любимого жанра - в совпадениях, остальные - в «новом», удалённые не попадают
        const similar = index.similarCandidates({
            preferredAuthors: {'булгаков михаил афанасьевич': 1},
            preferredGenres: {sf: 1},
            limit: 10,
            now: Date.parse('2020-06-01'),
        });
        assert.deepStrictEqual(similar.affinity.map(item => item.id).sort(), [1, 2, 3, 6]);
        assert.deepStrictEqual(similar.explore.map(item => item.id).sort(), [4, 5]);
        assert.ok(similar.affinity[0].score >= similar.affinity[3].score);

        const suggest = index.suggest({q: 'струг'});
        assert.deepStrictEqual(suggest.books.map(item => item.id), [3]);
        assert.strictEqual(suggest.authors.length, 2);

        index.updateBook(file, {id: 2, title: 'Сердце собаки', author: 'Булгаков Михаил Афанасьевич', lang: 'ru', librate: 4});
        assert.deepStrictEqual(search('собаки').ids, [2]);
        assert.strictEqual(search('собачье').total, 0);
        index.close();
    });
}

async function testAuthorEnglishNames() {
    const AuthorNames = require('../server/core/search/AuthorNames');
    const lookup = AuthorNames.buildLookup([
        ['Айзек Азимов', 'Isaac Asimov'],
        ['Михаил Афанасьевич Булгаков', 'Mikhail Bulgakov'],
        ['Джон Смит', 'John Smith'],
        ['Джон Смит', 'John Smyth'],
        ['Борис Акунин', 'Борис Акунин'],
        ['Артур Конан Дойл', 'Arthur Conan Doyle'],
        ['Адриан Конан Дойль', 'Adrian Conan Doyle'],
    ]);
    assert.strictEqual(AuthorNames.englishName(lookup, 'Азимов Айзек'), 'Isaac Asimov', 'word order must not matter');
    //ь пишут не везде
    assert.strictEqual(AuthorNames.englishName(lookup, 'Конан Дойль Артур'), 'Arthur Conan Doyle');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Дойль Артур Конан'), 'Arthur Conan Doyle');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Дойл Адриан Конан'), 'Adrian Conan Doyle');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Булгаков Михаил Афанасьевич'), 'Mikhail Bulgakov');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Азимов Айзек Юдович'), 'Isaac Asimov', 'a patronymic in the library is ignored');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Смит Джон'), '', 'namesakes with different English names are skipped');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Акунин Борис'), '', 'names without Latin letters are skipped');
    assert.strictEqual(AuthorNames.englishName(lookup, 'Азимов'), '', 'a surname alone is not enough');

    await withTempDir(async(dir) => {
        const queries = [];
        const names = new AuthorNames({dataDir: dir, version: 'test'}, async(query) => {
            queries.push(query);
            const offset = Number((query.match(/OFFSET (\d+)/) || [])[1]);
            const bindings = (query.includes('wd:Q36180') && offset === 0
                ? [{item: {value: 'Q1'}, ru: {value: 'Айзек Азимов'}, en: {value: 'Isaac Asimov'}}]
                : []);
            return {results: {bindings}};
        });
        assert.strictEqual((await names.info()).ready, false);
        assert.strictEqual(await names.download(), 1);
        assert.ok(queries.length >= 11, 'every occupation is queried');
        const info = await names.info();
        assert.strictEqual(info.ready, true);
        assert.strictEqual(info.count, 1);
        assert.deepStrictEqual((await names.readEntries()).entries, [['Айзек Азимов', 'Isaac Asimov']]);

        const failing = new AuthorNames({dataDir: path.join(dir, 'other'), version: 'test'}, async() => {
            throw new Error('HTTP 429');
        });
        failing.retryDelayMs = 1;
        await assert.rejects(() => failing.download(), /HTTP 429/);

        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const file = path.join(dir, 'catalog.sqlite');
        const index = new CatalogIndex();
        index.beginBuild(file, (await names.readEntries()).entries);
        index.insertBooks([
            {id: 1, _uid: 'u1', title: 'Основание', author: 'Азимов Айзек', series: '', serno: 0, genre: 'sf', lang: 'ru', ext: 'fb2', size: 1, date: '2020-01-01', librate: 0, del: 0, sourceId: 'main', keywords: ''},
            {id: 2, _uid: 'u2', title: 'Пикник', author: 'Стругацкий Аркадий', series: '', serno: 0, genre: 'sf', lang: 'ru', ext: 'fb2', size: 1, date: '2020-01-01', librate: 0, del: 0, sourceId: 'main', keywords: ''},
        ]);
        assert.strictEqual(index.finishBuild({inpxHash: 'h'}).aliases, 1);
        assert.strictEqual(index.open(file).aliases, '1');
        assert.deepStrictEqual(index.search({q: 'asimov'}).ids, [1]);
        assert.deepStrictEqual(index.search({q: 'isaac asimov основание'}).ids, [1]);
        assert.deepStrictEqual(index.search({q: 'asimov'}).authors, [{name: 'Азимов Айзек', books: 1, alias: 'Isaac Asimov'}]);
        assert.deepStrictEqual(index.suggest({q: 'asim'}).authors, [{name: 'Азимов Айзек', books: 1, alias: 'Isaac Asimov'}]);
        assert.deepStrictEqual(index.authorAliases('Азимов Айзек'), ['Isaac Asimov']);
        assert.deepStrictEqual(index.authorAliases('Стругацкий Аркадий'), []);
        assert.deepStrictEqual(index.authorAliasesOf(['Азимов Айзек, Стругацкий Аркадий']), {'Азимов Айзек, Стругацкий Аркадий': ['Isaac Asimov']});
        index.close();
    });
}

async function testReaderHomeKeepsUnavailableProgressVisible() {
    const worker = makeWorker();
    worker.catalogSearch = {getBooksByUids: async(uids) => uids.includes('available')
        ? [{_uid: 'available', title: 'Доступная книга', author: 'Автор', ext: 'fb2'}] : []};
    const user = {readerProgress: Object.fromEntries(Array.from({length: 12}, (_, i) => [
        `missing-${i}`, {percent: (i + 1) / 100, hidden: false, updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}`},
    ]))};
    const saved = JSON.stringify(user);
    const missing = await worker.getUserReadingLibrary(user);
    assert.strictEqual(missing.counters.reading, 12);
    assert.strictEqual(missing.count, 12);
    assert.strictEqual(missing.items.length, 12);
    assert.ok(missing.items.every(book => book.unavailable && book.title && book.percent > 0));
    assert.strictEqual(JSON.stringify(user), saved, 'Reading the library must preserve saved progress');

    user.readerProgress.available = {percent: 0.5};
    user.readerProgress.finished = {percent: 1};
    user.readerProgress.hidden = {percent: 0.3, hidden: true};
    user.readerProgress['   '] = {percent: 0.2};
    const all = await worker.getUserReadingLibrary(user, {state: 'all', limit: 2});
    assert.deepStrictEqual(all.counters, {all: 15, reading: 13, read: 1, hidden: 1});
    assert.strictEqual(all.count, 15);
    assert.strictEqual(all.items.length, 2);
    const found = await worker.getUserReadingLibrary(user, {query: 'Автор'});
    assert.strictEqual(found.items.length, 1);
    assert.strictEqual(found.items[0].bookUid, 'available');
    assert.strictEqual(found.items[0].unavailable, false);
    assert.strictEqual((await worker.getUserReadingLibrary(user, {state: 'read'})).items[0].bookUid, 'finished');
    assert.strictEqual((await worker.getUserReadingLibrary(user, {state: 'hidden'})).items[0].bookUid, 'hidden');

    const ReadingProgressPage = require('../server/core/opds/ReadingProgressPage');
    const page = Object.create(ReadingProgressPage.prototype);
    Object.assign(page, {id: 'reading-progress', rootTag: 'feed', opdsRoot: '/opds',
        webWorker: {getOpdsUserReadingLibrary: async() => await worker.getUserReadingLibrary(user, {state: 'all'})},
    });
    const xml = await page.body({query: {user: 'reader', state: 'all'}, originalUrl: '/opds/reading-progress?user=reader&state=all'});
    assert.match(xml, /Прогресс сохранён, но книга не найдена/);
    assert.match(xml, /\/book\?uid=available/);
    assert.doesNotMatch(xml, /\/book\?uid=(?:missing-\d+|finished|hidden)/, 'Unavailable books must not expose broken acquisition links');
}

//Какая позиция открывается: новее - сервер, недавняя копия дальше по книге - браузер, после сброса - ничего старого
async function testReaderProgressChoice() {
    const readerProgress = require('../client/share/readerProgress');
    const at = minutes => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
    const server = {percent: 0.5, pageIndex: 50, updatedAt: at(30)};

    assert.strictEqual(readerProgress.merge(server, {percent: 0.2, pageIndex: 20, updatedAt: at(10)}).pageIndex, 50, 'Newer server position wins');
    assert.strictEqual(readerProgress.merge(server, {percent: 0.6, pageIndex: 60, updatedAt: at(29)}, {preferSecondaryRecentForward: true}).pageIndex, 60,
        'A local copy under 2 minutes older but further on wins');
    assert.strictEqual(readerProgress.merge(server, {percent: 0.6, pageIndex: 60, updatedAt: at(20)}, {preferSecondaryRecentForward: true}).pageIndex, 50,
        'An older local copy loses even if further on');
    assert.strictEqual(readerProgress.shouldUpload(server, {percent: 0.6, pageIndex: 60, updatedAt: at(31)}), true);
    assert.strictEqual(readerProgress.shouldUpload(server, {percent: 0.6, pageIndex: 60, updatedAt: at(29)}), false);

    assert.strictEqual(readerProgress.afterReset({pageIndex: 5, generation: 1}, '', 2), null, 'A reset generation discards older progress');
    assert.strictEqual(readerProgress.afterReset({pageIndex: 5, updatedAt: at(10)}, at(20), 0), null, 'Progress before resetAt is discarded');
    assert.strictEqual(readerProgress.normalize({}, 3).generation, 3);
}

async function testReaderProgressResetAndHiddenState() {
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({
            dataDir: dir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });
        await store.save({
            version: 5,
            users: [{
                id: 'reader-reset',
                name: 'Reader Reset',
                readerProgress: {
                    'book:hidden': {
                        percent: 0.2,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        hidden: true,
                    },
                    'book:visible': {
                        percent: 0.6,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        hidden: false,
                    },
                },
                readerBookmarks: {
                    'book:hidden': [{id: 'bookmark-reset', title: 'Keep me'}],
                },
            }],
            lists: [],
        });

        const hidden = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.4,
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
        assert.strictEqual(hidden.hidden, true);

        const staleSnapshot = await store.load();
        const reset = await store.clearReaderProgress('reader-reset');
        assert.strictEqual(reset.success, true);
        assert.strictEqual(reset.count, 2);
        assert.strictEqual(reset.generation, 1);
        assert.deepStrictEqual(reset.bookUids.sort(), ['book:hidden', 'book:visible']);
        assert.ok(Number.isFinite(Date.parse(reset.resetAt)));

        await store.save(staleSnapshot);

        let data = await store.load();
        let user = data.users.find(item => item.id === 'reader-reset');
        assert.deepStrictEqual(user.readerProgress, {});
        assert.strictEqual(user.readerProgressGeneration, reset.generation);
        assert.strictEqual(user.readerProgressResetAt, reset.resetAt);
        assert.strictEqual(user.readerBookmarks['book:hidden'][0].id, 'bookmark-reset');

        const stale = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.9,
            updatedAt: '2026-01-03T00:00:00.000Z',
        });
        assert.strictEqual(stale.reset, true);
        assert.strictEqual(stale.generation, reset.generation);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.deepStrictEqual(user.readerProgress, {});

        // A valid reset generation must not depend on synchronized client/server clocks.
        const freshUpdatedAt = '2001-01-01T00:00:00.000Z';
        const fresh = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            percent: 0.1,
            updatedAt: freshUpdatedAt,
            generation: reset.generation,
        });
        assert.strictEqual(fresh.percent, 0.1);
        assert.strictEqual(fresh.hidden, false);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:hidden'].updatedAt, freshUpdatedAt);

        const explicitlyHidden = await store.updateReaderProgress('reader-reset', 'book:hidden', {
            hidden: true,
            percent: 0.1,
        });
        assert.strictEqual(explicitlyHidden.hidden, true);

        await Promise.all([
            store.updateReaderProgress('reader-reset', 'book:parallel-a', {
                percent: 0.2,
                updatedAt: '2002-01-01T00:00:00.000Z',
                generation: reset.generation,
            }),
            store.updateReaderProgress('reader-reset', 'book:parallel-b', {
                percent: 0.3,
                updatedAt: '2003-01-01T00:00:00.000Z',
                generation: reset.generation,
            }),
        ]);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:parallel-a'].percent, 0.2);
        assert.strictEqual(user.readerProgress['book:parallel-b'].percent, 0.3);

        await store.setBooksRead('reader-reset', ['book:read'], true);
        data = await store.load();
        user = data.users.find(item => item.id === 'reader-reset');
        assert.strictEqual(user.readerProgress['book:read'].generation, reset.generation);
    });
}

async function testMarkReadKeepsReadingPlace() {
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({dataDir: dir, adminLogin: 'admin', adminPassword: 'admin'});
        const place = {sectionId: 's9', pageIndex: 41, textOffset: 120, textSnippet: 'Глава девятая'};
        await store.save({
            version: 5,
            users: [{
                id: 'reader',
                name: 'Reader',
                readerProgress: {
                    'book:a': Object.assign({percent: 0.63, updatedAt: '2026-01-01T00:00:00.000Z'}, place),
                    'book:b': {percent: 1, updatedAt: '2026-01-01T00:00:00.000Z'},
                },
            }],
            lists: [],
        });
        const progress = async uid => (await store.load()).users.find(item => item.id === 'reader').readerProgress[uid];

        await store.setBooksRead('reader', ['book:a'], true);
        let row = await progress('book:a');
        assert.strictEqual(row.percent, 1);
        assert.deepStrictEqual([row.sectionId, row.pageIndex, row.textOffset, row.textSnippet], Object.values(place), 'The place stays');

        //читалка пересохраняет место отмеченной книги: доля до отметки не теряется
        await store.updateReaderProgress('reader', 'book:a', Object.assign({percent: 1, updatedAt: '2026-02-01T00:00:00.000Z'}, place));
        assert.strictEqual((await progress('book:a')).percentBeforeRead, 0.63);
        //второе нажатие «прочитано» не затирает долю до первого
        await store.setBooksRead('reader', ['book:a'], true);

        await store.setBooksRead('reader', ['book:a'], false);
        row = await progress('book:a');
        assert.strictEqual(row.percent, 0.63, 'Unmarking returns to the share read before the mark');
        assert.strictEqual(row.pageIndex, 41);
        assert.ok(!Object.hasOwn(row, 'percentBeforeRead'));

        //книга прочитана до конца без отметки: снятие отметки сбрасывает её, как раньше
        await store.setBooksRead('reader', ['book:b'], false);
        assert.strictEqual(await progress('book:b'), undefined);

        //читатель ушёл с отмеченной книги назад: доля до отметки больше не нужна
        await store.setBooksRead('reader', ['book:a'], true);
        await store.updateReaderProgress('reader', 'book:a', {percent: 0.4, updatedAt: new Date(Date.now() + 60000).toISOString()});
        assert.ok(!Object.hasOwn(await progress('book:a'), 'percentBeforeRead'));
    });
}

async function testCoverCacheRoutesAndCleaner() {
    await withTempDir(async(dir) => {
        const coverDir = path.join(dir, 'cover');
        await fs.ensureDir(coverDir);
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        await fs.writeFile(path.join(coverDir, 'source-a-123.jpg'), jpg);

        const book = {_uid: 'uid-123', sourceId: 'source-a', libid: 123, file: '123', ext: 'fb2'};
        await fs.writeFile(path.join(coverDir, `${require('../server/core/BookAssets').coverCacheKey(book)}.jpg`), jpg);

        await withStaticServer({
            coverDir,
            bookDir: path.join(dir, 'book'),
            bookPathStatic: '/book',
            publicFilesDir: path.join(dir, 'public-files'),
            publicDir: path.join(dir, 'public'),
            tempDir: path.join(dir, 'tmp'),
        }, async(server) => {
            const cached = await request(server, '/cover/by-uid?uid=uid-123');
            assert.strictEqual(cached.status, 200);
            assert.match(cached.headers['content-type'] || '', /image\/jpeg/);
            assert.deepStrictEqual(cached.body, jpg);

            const missing = await request(server, '/cover/by-uid?uid=missing');
            assert.strictEqual(missing.status, 404);
        }, {getBookRecordByUid: async uid => (uid === book._uid ? book : null), getBookCover: async() => null});

        await fs.writeFile(path.join(coverDir, 'empty.jpg'), '');
        await fs.writeFile(path.join(coverDir, 'bad.webp'), 'not cached here');
        const worker = makeWorker();
        const cleaned = await worker.cleanBrokenCoverCacheFiles(coverDir);
        assert.strictEqual(cleaned.checked, 4);
        assert.strictEqual(cleaned.removed, 2);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'source-a-123.jpg')), true);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'empty.jpg')), false);
        assert.strictEqual(await fs.pathExists(path.join(coverDir, 'bad.webp')), false);
    });
}

async function testCacheRotationUsesTargetWatermark() {
    await withTempDir(async(dir) => {
        const cacheDir = path.join(dir, 'cache');
        await fs.ensureDir(cacheDir);

        const now = Date.now();
        const files = ['oldest.bin', 'old.bin', 'new.bin', 'newest.bin'];
        for (let i = 0; i < files.length; i++) {
            const filePath = path.join(cacheDir, files[i]);
            await fs.writeFile(filePath, Buffer.alloc(400, i));
            const time = new Date(now - ((files.length - i) * 60000));
            await fs.utimes(filePath, time, time);
        }

        const worker = makeWorker();
        const cleaned = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetSize: null,
            targetRatio: 0.5,
        });

        assert.strictEqual(cleaned.size, 1600);
        assert.strictEqual(cleaned.targetSize, 500);
        assert.strictEqual(cleaned.removed, 3);
        assert.strictEqual(cleaned.after, 400);
        assert.deepStrictEqual((await fs.readdir(cacheDir)).sort(), ['newest.bin']);

        await fs.emptyDir(cacheDir);
        await fs.writeFile(path.join(cacheDir, 'old.bin'), Buffer.alloc(400));
        await fs.writeFile(path.join(cacheDir, 'new.bin'), Buffer.alloc(400));

        const passive = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetRatio: 0.5,
        });
        assert.strictEqual(passive.removed, 0);

        const forced = await worker.cleanDir({
            dir: cacheDir,
            maxSize: 1000,
            targetRatio: 0.5,
            forceTarget: true,
        });
        assert.strictEqual(forced.removed, 1);
    });
}

async function testCacheRotationAlignsToServerClock() {
    const worker = makeWorker({
        cacheCleanSchedule: '0 0 * * *',
    });
    const morning = new Date(2026, 0, 2, 10, 15, 30, 0);
    const nextMidnight = new Date(2026, 0, 3, 0, 0, 0, 0);
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(morning), nextMidnight.getTime() - morning.getTime());

    worker.config.cacheCleanSchedule = '0 11 * * *';
    const nextHour = new Date(2026, 0, 2, 11, 0, 0, 0);
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(morning), nextHour.getTime() - morning.getTime());
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(new Date(2026, 0, 2, 11, 0, 0, 0)), 0);

    worker.config.cacheCleanSchedule = '*/15 10-11 * * 1-5';
    assert.strictEqual(worker.cacheCleanNextScheduledDelay(new Date(2026, 0, 2, 10, 10, 0, 0)), 5*60*1000);
    assert.throws(() => worker.normalizeAdminCachePatch({cacheCleanSchedule: 'bad cron'}), /cron/);
}

async function testExternalDiscoveryMultiSourceSearch() {
    const singleSourceWorker = makeWorker({
        librarySources: [{id: 'only', name: 'Only', enabled: true}],
    });
    assert.deepStrictEqual(singleSourceWorker.externalDiscoverySearchQueries({title: 'Night Watch'}, 5), [
        {title: '=Night Watch', del: '0', limit: 5},
        {title: '*Night Watch', del: '0', limit: 5},
    ]);

    const multiSourceWorker = makeWorker({
        librarySources: [
            {id: 'one', name: 'One', enabled: true},
            {id: 'two', name: 'Two', enabled: true},
            {id: 'disabled', name: 'Disabled', enabled: false},
            {id: 'three', name: 'Three', enabled: true},
        ],
    });
    const queries = multiSourceWorker.externalDiscoverySearchQueries({title: 'Night Watch'}, 7);
    assert.strictEqual(queries.length, 6);
    assert.deepStrictEqual(queries.map(item => item.sourceId), ['one', 'one', 'two', 'two', 'three', 'three']);

    const calls = [];
    multiSourceWorker.bookSearch = async(query) => {
        calls.push(query);
        return {
            found: query.sourceId === 'three'
                ? [{_uid: 'three:1', title: 'Night Watch'}]
                : [],
        };
    };
    const candidates = await multiSourceWorker.findExternalDiscoveryCandidates({title: 'Night Watch'}, 7);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]._uid, 'three:1');
    assert.strictEqual(calls.length, 6);
}

async function testWikidataAwardsShelf() {
    const axios = require('axios');
    const originalGet = axios.get;
    const queries = [];
    const literal = value => ({type: 'literal', value});
    axios.get = async(url, options) => {
        queries.push(options.params.query);
        //писатели месяца: лауреат с языком оригинала и книга, которой нет среди лауреатов
        if (options.params.query.includes('P569'))
            return {data: {results: {bindings: [
                {work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q25217632'}, titleEn: literal('The Fifth Season'), langs: literal('en')},
                {work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q645394'}, titleEn: literal('The Left Hand of Darkness'),
                    authorEn: literal('Ursula K. Le Guin'), langs: literal('en')},
            ]}}};
        return {data: {results: {bindings: [
            {
                work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q25217632'},
                titleRu: literal('Пятое время года'), titleEn: literal('The Fifth Season'),//i18n-ignore: тестовые данные
                authorRu: literal('Нора Джемисин'), authorEn: literal('N. K. Jemisin'),//i18n-ignore: тестовые данные
                awards: literal('Q255032 Q266012'),
            },
            {work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q100540380'}, titleEn: literal('Network Effect'), authorEn: literal('Martha Wells'), awards: literal('Q266012')},
            {work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q123300220'}, authorEn: literal('Emily Tesh'), awards: literal('Q255032')},
        ]}}};
    };
    const makeAwardsWorker = () => {
        const worker = makeWorker({discovery: {externalSource: 'wikidata-awards', externalName: 'Example'}});
        worker.discoveryCache = new Map();
        worker.discoveryDiskCache = {};
        worker.saveDiscoveryDiskCache = async() => {};
        worker.getSharedDiscoveryConfig = async() => ({});
        worker.dbConfig = async() => ({inpxHash: 'test-hash'});
        //в библиотеке книга только под английским названием
        worker.bookSearch = async(query) => ({
            found: (query.title.includes('Fifth Season') ? [{_uid: 'local-1', title: 'The Fifth Season', author: 'Jemisin N. K.'}] : []),
        });
        return worker;
    };

    try {
        const worker = makeAwardsWorker();
        const hugo = await worker.buildExternalDiscoveryShelfV2(8, worker.getDiscoveryConfig({externalBrowseUrl: 'https://www.wikidata.org/wiki/Q255032'}));
        assert.match(queries[0], /wd:Q255032 wd:Q266012/);
        assert.match(queries[1], new RegExp(`MONTH\\(\\?born\\) = ${new Date().getUTCMonth() + 1}\\)`));
        assert.strictEqual(hugo.sourceUrl, 'https://www.wikidata.org/wiki/Q255032');
        assert.strictEqual(hugo.genreOptions.length, 9);
        assert.deepStrictEqual(hugo.items.map(book => book._uid), ['local-1']);
        assert.strictEqual(hugo.items[0].discoveryUrl, 'https://www.wikidata.org/wiki/Q25217632');
        assert.strictEqual(hugo.discoveryHasMore, false);

        //другая премия и все премии берутся из уже загруженного списка
        const nebula = await worker.buildExternalDiscoveryShelfV2(8, worker.getDiscoveryConfig({externalBrowseUrl: 'https://www.wikidata.org/wiki/Q266012'}));
        assert.deepStrictEqual(nebula.items.map(book => book.title), ['The Fifth Season', 'Network Effect']);
        assert.strictEqual(nebula.items[1].discoveryMissingLocal, true);
        //ссылка на жанр прежней веб-витрины не выбирает премию
        const all = await worker.buildExternalDiscoveryShelfV2(1, worker.getDiscoveryConfig({externalBrowseUrl: 'https://www.litres.ru/genre/fantastika/'}));
        assert.strictEqual(all.sourceUrl, '');
        assert.strictEqual(all.items.length, 1);
        assert.strictEqual(all.discoveryHasMore, true);
        assert.strictEqual(queries.length, 2);
        //«Все премии» - без писателей месяца; у писателей месяца нет ссылки на премию
        const allAwards = await worker.buildExternalDiscoveryShelfV2(8, worker.getDiscoveryConfig());
        assert.deepStrictEqual(allAwards.items.map(book => book.title), ['The Fifth Season', 'Network Effect']);
        const born = await worker.buildExternalDiscoveryShelfV2(8, worker.getDiscoveryConfig({externalBrowseUrl: 'born-this-month'}));
        assert.deepStrictEqual(born.items.map(book => book.title), ['The Fifth Season', 'The Left Hand of Darkness']);
        assert.strictEqual(born.sourceUrl, '');

        //все полки собираются из одного сопоставления: в кеше только лауреаты и сопоставление, прогрев берёт их из кеша
        const searches = [];
        const bookSearch = worker.bookSearch;
        worker.bookSearch = async(query) => {
            searches.push(query.title);
            return bookSearch(query);
        };
        await worker.warmExternalDiscoveryShelves();
        assert.deepStrictEqual(Array.from(worker.discoveryCache.keys()).map(key => key.split(':')[0]).sort(), ['wikidata-awards', 'wikidata-matches']);
        assert.strictEqual(searches.length, 0);
        assert.strictEqual(queries.length, 2);

        //писатели месяца не загрузились: полки премий всё равно есть
        axios.get = async(url, options) => {
            if (options.params.query.includes('P569'))
                throw new Error('timeout');
            return {data: {results: {bindings: [{work: {type: 'uri', value: 'http://www.wikidata.org/entity/Q1'}, titleEn: literal('Dune'), awards: literal('Q255032')}]}}};
        };
        const withoutBorn = await makeAwardsWorker().fetchWikidataAwardWinners();
        assert.deepStrictEqual(withoutBorn.items.map(item => item.title), ['Dune']);

        axios.get = async() => {
            throw new Error('HTTP 429');
        };
        const failing = makeAwardsWorker();
        await assert.rejects(
            () => failing.buildExternalDiscoveryShelfV2(8, failing.getDiscoveryConfig()),
            /Example.+HTTP 429/
        );
    } finally {
        axios.get = originalGet;
    }
}

// Award winners: a partial title needs the right author, every copy with the winner's title is listed
// (the page keeps those in the reader's languages), and the shelf lists the books in the library first.
async function testAwardsShelfEditionsAndOrder() {
    const worker = makeWorker();
    assert.strictEqual(worker.pickDiscoveryBookMatchV2({title: 'The Everlasting', author: 'Alix E. Harrow'},
        [{_uid: 'nory', title: 'The Everlasting Story of Nory', author: 'Baker Nicholson'}]), null);

    const library = [
        {_uid: 'uk', title: 'Нейромант', author: 'Гибсон Уильям', lang: 'uk'},//i18n-ignore: тестовые данные
        {_uid: 'ru', title: 'Нейромант', author: 'Гибсон Уильям', lang: 'ru'},//i18n-ignore: тестовые данные
        {_uid: 'ru-2', title: 'Нейромант', author: 'Гибсон Уильям', lang: 'ru'},//i18n-ignore: тестовые данные
        {_uid: 'en', title: 'Neuromancer', author: 'Gibson William', lang: 'en'},
        {_uid: 'other', title: 'Нейромант. Возвращение', author: 'Гибсон Уильям', lang: 'ru'},//i18n-ignore: тестовые данные
    ];
    worker.bookSearch = async query => ({found: library.filter(book => (query.title[0] === '*'
        ? book.title.includes(query.title.slice(1)) : book.title === query.title.slice(1)))});
    const {items} = await worker.matchExternalItems([
        {title: 'Новинка', author: 'Автор Новый', url: 'u:new', awards: ['Q255032'], alternates: []},//i18n-ignore: тестовые данные
        {title: 'Нейромант', author: 'Уильям Гибсон', url: 'u:neuro', awards: ['Q255032'],//i18n-ignore: тестовые данные
            alternates: [{title: 'Neuromancer', author: 'William Gibson'}]},
    ]);
    assert.deepStrictEqual(items[1].books.map(book => book._uid).sort(), ['en', 'ru', 'ru-2', 'uk'], 'a longer title is another book');
    assert.deepStrictEqual(items[1].books.map(book => book.lang), ['ru', 'ru', 'en', 'uk']);
    //оригинал идёт перед переводами
    const original = await worker.matchExternalItems([{title: 'Нейромант', author: 'Уильям Гибсон', url: 'u:neuro', langs: ['en'],//i18n-ignore: тестовые данные
        alternates: [{title: 'Neuromancer', author: 'William Gibson'}]}]);
    assert.deepStrictEqual(original.items[0].books.map(book => book.lang), ['en', 'ru', 'ru', 'uk']);

    worker.getWikidataAwardMatches = async() => ({items});
    const shelf = await worker.buildExternalDiscoveryShelfV2(5, worker.getDiscoveryConfig({externalSource: 'wikidata-awards',
        externalBrowseUrl: 'https://www.wikidata.org/wiki/Q255032'}));
    assert.deepStrictEqual(shelf.items.map(book => book.discoveryUrl), ['u:neuro', 'u:neuro', 'u:neuro', 'u:neuro', 'u:new'],
        'all copies in the library come before newer missing winners');
    assert.strictEqual(shelf.discoveryHasMore, false);
    assert.deepStrictEqual([shelf.subtitle.params.inLibrary, shelf.subtitle.params.notInLibrary], [1, 1]);

    // Copies in other languages are dropped before paging, so a page is full of books the reader sees.
    const english = await worker.buildExternalDiscoveryShelfV2(1, worker.getDiscoveryConfig({externalSource: 'wikidata-awards',
        externalBrowseUrl: 'https://www.wikidata.org/wiki/Q255032', externalLanguages: ['EN', 'bad language']}));
    assert.deepStrictEqual(english.items.map(book => book._uid), ['en']);
    assert.strictEqual(english.discoveryHasMore, true, 'the missing winner is on the next page');

    // Removed books never match; English editions filed under the Russian author name still do,
    // and a trailing note in brackets does not make another book.
    const algernon = worker.pickDiscoveryBookMatchV2({title: 'Flowers for Algernon', author: 'Daniel Keyes',
        authors: 'Дэниел Киз, Daniel Keyes'}, [//i18n-ignore: тестовые данные
        {_uid: 'removed', title: 'Flowers for Algernon', author: 'Киз Дэниел', del: 1, lang: 'en'},//i18n-ignore: тестовые данные
        {_uid: 'novel', title: 'Flowers for Algernon (novel)', author: 'Киз Дэниел', lang: 'en'},//i18n-ignore: тестовые данные
    ]);
    assert.strictEqual(algernon.book._uid, 'novel');
    assert.deepStrictEqual(algernon.copies.map(copy => copy.book._uid), ['novel']);
    assert.ok(worker.externalDiscoverySearchQueries({title: 'Flowers for Algernon'}).every(query => query.del === '0'));
}

// One cached award matching per library serves every language and page; an expired one is served at once
// and refreshed in the background, and a failed refresh keeps the previous shelf.
async function testExternalShelfCacheIsSharedAndRefreshedInBackground() {
    const axios = require('axios');
    const CatalogIndex = require('../server/core/search/CatalogIndex');
    const originalGet = axios.get;
    const literal = value => ({type: 'literal', value});
    let winners = [['Q1', 'Dune', 'Frank Herbert'], ['Q2', 'Solaris', 'Stanislaw Lem']];
    let wikidataCalls = 0;
    let gate = null;
    let open = () => {};
    axios.get = async(url, options) => {
        wikidataCalls++;
        await gate;
        if (options.params.query.includes('P569'))
            return {data: {results: {bindings: []}}};
        return {data: {results: {bindings: winners.map(([id, title, author]) => ({work: {type: 'uri', value: `http://www.wikidata.org/entity/${id}`},
            titleEn: literal(title), authorEn: literal(author), awards: literal('Q255032')}))}}};
    };

    try {
        await withTempDir(async(dir) => {
            const book = (id, title, author, lang) => ({id, _uid: `uid-${id}`, author, title, series: '', serno: 0, size: 1, librate: 0, del: 0,
                sourceId: 'main', insno: 0, folder: 'a.zip', file: String(id), libid: String(id), ext: 'fb2', lang, date: '2010-01-01'});
            const index = new CatalogIndex();
            const file = path.join(dir, 'library.sqlite');
            index.beginBuild(file, [], []);
            index.insertBooks([book(1, 'Dune', 'Herbert Frank', 'en'), book(2, 'Dune', 'Herbert Frank', 'ru'),
                book(3, 'Solaris', 'Lem Stanislaw', 'pl'), book(4, 'Solaris', 'Lem Stanislaw', 'ru')]);
            index.finishBuild({});
            index.open(file, []);

            const worker = makeWorker({dataDir: dir, discovery: {externalSource: 'wikidata-awards', externalName: 'Awards'}});
            worker.discoveryCache = new Map();
            worker.getSharedDiscoveryConfig = async() => ({});
            worker.dbConfig = async() => ({inpxHash: 'lib-hash'});
            let searches = 0;
            const findBooks = async(query) => {
                searches++;
                return index.withBooks('findBooks', query);
            };
            worker.catalogSearch = {findBooks};
            const shelf = async(options) => (await worker.getDiscoveryShelvesV2(Object.assign({section: 'external', userId: 'reader'}, options))).shelves[0];
            const uids = value => value.items.map(item => item._uid);
            const persisted = async() => JSON.parse(await fs.readFile(path.join(dir, 'discovery-cache.json'), 'utf8'));
            const settle = () => Promise.allSettled([...worker.discoveryPending.values()]);
            const waitFor = async(check) => {
                for (let i = 0; i < 100 && !check(); i++)
                    await new Promise(resolve => setImmediate(resolve));
            };

            //разные языки и размеры страниц - один запрос к Викиданным, одно сопоставление и ни одной записи на читателя
            const english = await shelf({externalLanguages: ['en'], externalLimit: 1});
            assert.deepStrictEqual([uids(english), english.discoveryHasMore], [['uid-1'], false]);
            const russianPage = await shelf({externalLanguages: ['ru'], externalLimit: 1});
            assert.deepStrictEqual([uids(russianPage), russianPage.discoveryHasMore], [['uid-2'], true]);
            const russian = await shelf({externalLanguages: ['ru', 'pl'], externalLimit: 24});
            assert.deepStrictEqual(uids(russian), ['uid-2', 'uid-4', 'uid-3']);
            assert.deepStrictEqual([russian.subtitle.params.inLibrary, english.subtitle.params.inLibrary], [2, 1]);
            assert.strictEqual(wikidataCalls, 2, 'one awards query and one born-this-month query');
            const matchedSearches = searches;
            assert.deepStrictEqual(Object.keys(await persisted()).map(key => key.split(':')[0]).sort(), ['wikidata-awards', 'wikidata-matches']);
            //выданные книги - копии: правка ответа не меняет кеш
            russian.items[0].title = 'changed';
            assert.strictEqual((await shelf({externalLanguages: ['ru']})).items[0].title, 'Dune');

            //срок вышел: прежняя полка отдаётся сразу, одно обновление идёт в фоне, после него - новая
            const expire = () => {
                for (const entry of [...worker.discoveryCache.values(), ...Object.values(worker.discoveryDiskCache)])
                    entry.time -= 2*24*60*60*1000;
            };
            expire();
            winners = [...winners, ['Q3', 'Hyperion', 'Dan Simmons']];
            gate = new Promise(resolve => {
                open = resolve;
            });
            const prompt = promise => Promise.race([promise, new Promise((resolve, reject) =>
                setTimeout(() => reject(new Error('the request waited for the refresh')), 2000).unref())]);
            const staleFirst = await prompt(shelf({externalLanguages: ['en']}));
            const staleSecond = await prompt(shelf({externalLanguages: ['ru']}));
            assert.deepStrictEqual([uids(staleFirst), uids(staleSecond)], [['uid-1'], ['uid-2', 'uid-4']]);
            assert.strictEqual(staleFirst.discoveryStale, false);
            await waitFor(() => wikidataCalls > 2);
            assert.strictEqual(worker.discoveryPending.size, 2, 'one matching refresh waiting for the awards query');
            assert.strictEqual(wikidataCalls, 3);
            open();
            gate = null;
            await settle();
            const refreshed = await shelf({externalLanguages: ['en']});
            assert.deepStrictEqual(refreshed.items.map(item => item.title), ['Dune', 'Hyperion']);
            assert.strictEqual(refreshed.items[1].discoveryMissingLocal, true);
            assert.ok(Object.values(await persisted()).every(entry => Date.now() - entry.time < 60*1000));

            //обновление не удалось: остаётся прежняя полка с пометкой, повтора сразу нет
            expire();
            worker.catalogSearch = {findBooks: async() => {
                throw new Error('library busy');
            }};
            assert.strictEqual((await shelf({externalLanguages: ['en']})).items.length, 2);
            await settle();
            const kept = await shelf({externalLanguages: ['en']});
            assert.deepStrictEqual([kept.items.map(item => item.title), kept.discoveryStale], [['Dune', 'Hyperion'], true]);
            assert.strictEqual(worker.discoveryPending.size, 0, 'no retry right after a failure');
            const matchesEntry = Object.entries(await persisted()).find(([key]) => key.startsWith('wikidata-matches:'))[1];
            assert.ok(Date.now() - matchesEntry.time > 24*60*60*1000, 'the failed refresh is not saved');

            //админ обновляет сразу, без прежней полки
            worker.catalogSearch = {findBooks};
            const callsBefore = wikidataCalls;
            const forced = await shelf({externalLanguages: ['en'], forceRefresh: true, userId: 'admin'});
            assert.strictEqual(forced.discoveryStale, false);
            assert.strictEqual(wikidataCalls, callsBefore + 2);
            assert.ok(searches > matchedSearches);
            index.close();
        });
    } finally {
        open();
        axios.get = originalGet;
    }
}

async function testConfiguredConverterPathsHavePriority() {
    const externalTools = require('../server/core/ExternalTools');
    const bookConverter = require('../server/core/BookConverter');
    const configured = {
        djxl: '/opt/tools/djxl-custom',
        dwebp: '/opt/tools/dwebp-custom',
        fb2cng: '/opt/tools/fbc-custom',
        mutool: '/opt/tools/mutool-custom',
    };

    assert.strictEqual(externalTools.djxlCommandCandidates(configured)[0], configured.djxl);
    assert.strictEqual(externalTools.dwebpCommandCandidates(configured)[0], configured.dwebp);
    assert.strictEqual(bookConverter.fb2cngCommandCandidates(configured)[0], configured.fb2cng);
    assert.strictEqual(bookConverter.mutoolCommandCandidates(configured)[0], configured.mutool);
}

async function testDiscoveryShelvesBuildOnlyRequestedSection() {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    worker.discoveryCache = new Map();
    worker.checkMyState = () => {};
    worker.getDiscoveryConfigForRequest = async() => ({
        enabled: true,
        shelfLimit: 8,
        externalSource: 'wikidata-awards',
        externalTtlMinutes: 60,
    });
    worker.dbConfig = async() => ({inpxHash: 'test-hash'});
    worker.warmExternalDiscoveryShelves = async() => {};
    const calls = [];
    worker.getPersonalDiscoveryShelvesV2 = async() => {
        calls.push('personal');
        return [{id: 'similar-books', items: []}];
    };
    worker.rememberPersistedDiscovery = async() => {
        calls.push('external');
        return {items: []};
    };

    let result = await worker.getDiscoveryShelvesV2({section: 'personal'});
    assert.deepStrictEqual(calls, ['personal']);
    assert.deepStrictEqual(result.shelves.map(shelf => shelf.id), ['similar-books']);

    calls.length = 0;
    result = await worker.getDiscoveryShelvesV2({section: 'external'});
    assert.deepStrictEqual(calls, ['external']);
    assert.deepStrictEqual(result.shelves.map(shelf => shelf.id), ['external-source']);
}

async function testPersonalDiscoveryCacheAndSingleFlight() {
    const WebWorker = require('../server/core/WebWorker');
    const worker = Object.create(WebWorker.prototype);
    const user = {id: 'reader', readerProgress: {}, discoveryPreferences: {events: {a: {impressionCount: 1, openCount: 0}}}};
    let lists = [{id: 'l1', books: ['a']}];
    let builds = 0;
    worker.getEffectiveUser = async() => user;
    worker.getProfileSessionUser = () => user.id;
    worker.readingListStore = {getLists: async() => lists};
    worker.dbConfig = async() => ({inpxHash: 'h'});
    worker.buildPersonalDiscoveryShelvesV2 = async() => {
        builds++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return [{id: 'similar-books', items: [{_uid: `b${builds}`}]}];
    };

    const [first, second] = await Promise.all([
        worker.getPersonalDiscoveryShelvesV2('reader', '', 8, {}),
        worker.getPersonalDiscoveryShelvesV2('reader', '', 8, {}),
    ]);
    assert.strictEqual(builds, 1);
    assert.deepStrictEqual(first, second);

    user.discoveryPreferences.events.a.impressionCount = 5;
    await worker.getPersonalDiscoveryShelvesV2('reader', '', 8, {});
    assert.strictEqual(builds, 1, 'impressions do not invalidate the cache');

    lists = [{id: 'l1', books: ['a', 'b']}];
    await worker.getPersonalDiscoveryShelvesV2('reader', '', 8, {});
    assert.strictEqual(builds, 2, 'list change rebuilds');

    await worker.getPersonalDiscoveryShelvesV2('reader', '', 8, {forceRefresh: true});
    assert.strictEqual(builds, 3, 'forceRefresh rebuilds');
}

// The unfinished-series shelf skips deleted books and gets all series in one library thread call.
async function testUnfinishedSeriesSkipsDeletedBooks() {
    await withTempDir(async(dir) => {
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const CatalogSearch = require('../server/core/search/CatalogSearch');
        const book = (id, series, serno, del = 0) => ({_uid: `u${id}`, title: `Книга ${id}`, author: 'Автор', series, serno, del, genre: 'sf', lang: 'ru',
            ext: 'fb2', date: '2026-01-01', sourceId: 'main', folder: 'a.zip', file: String(id), libid: String(id)});
        const index = new CatalogIndex();
        index.beginBuild(path.join(dir, 'library.sqlite'), [], [{id: 'main', name: 'Main', libDir: dir}]);
        index.insertBooks([book(1, 'Сага', 1), book(2, 'Сага', 2, 1), book(3, 'Сага', 3), book(4, 'Цикл', 1), book(5, 'Цикл', 2)]);
        index.finishBuild({});

        const worker = makeWorker();
        worker.readingListStore = {getMetadataOverrides: async() => ({})};
        worker.resetLibraryAssetCaches();
        const search = new CatalogSearch({dataDir: dir}, worker);
        worker.catalogSearch = search;
        await search.openIndex(search.getThread());
        search.ready = true;
        const thread = search.getThread();
        const call = thread.call.bind(thread);
        const actions = [];
        thread.call = (action, ...args) => {
            actions.push(action === 'withBooks' ? args[0] : action);
            return call(action, ...args);
        };
        try {
            const progressMap = {u1: {percent: 1, updatedAt: '2026-09-02T00:00:00Z'}, u4: {percent: 1, updatedAt: '2026-09-01T00:00:00Z'}};
            const shelf = await worker.buildUnfinishedSeriesShelfV2({id: 'reader'}, 8, {progressMap, lists: [], readBookUids: new Set()});
            assert.deepStrictEqual(shelf.items.map(item => item._uid), ['u3', 'u5']);
            assert.deepStrictEqual(actions.filter(action => action === 'seriesBooksOf'), ['seriesBooksOf']);
        } finally {
            await search.close();
        }
    });
}

async function testDiscoveryPreferencesAndEventsPersist() {
    await withTempDir(async(dir) => {
        const ReadingListStore = require('../server/core/ReadingListStore');
        const store = new ReadingListStore({
            dataDir: dir,
            adminLogin: 'admin',
            adminPassword: 'admin',
        });
        await store.save({
            version: 5,
            users: [
                {id: 'reader-feedback', name: 'Reader'},
                {id: 'reader-dismiss', name: 'Reader Dismiss'},
            ],
            lists: [],
        });

        const preferences = await store.updateDiscoveryPreferences('reader-feedback', {
            taste: {
                genres: ['sf_fantasy'],
                authors: ['Favorite Author'],
                languages: ['ru'],
                explorationRatio: 0.25,
                completedAt: '2026-07-13T00:00:00.000Z',
            },
        });
        assert.deepStrictEqual(preferences.taste.genres, ['sf_fantasy']);
        assert.deepStrictEqual(preferences.taste.authors, ['Favorite Author']);
        assert.strictEqual(preferences.taste.explorationRatio, 0.25);

        await store.recordDiscoveryEvents('reader-feedback', [
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
        ]);
        await store.recordDiscoveryEvents('reader-feedback', [
            {bookUid: 'book:candidate', type: 'impression', shelfId: 'similar-books'},
            {bookUid: 'book:candidate', type: 'open', shelfId: 'similar-books'},
        ]);
        const exported = await store.exportData('reader-feedback');
        const event = exported.user.discoveryPreferences.events['book:candidate'];
        assert.strictEqual(event.impressionCount, 2);
        assert.strictEqual(event.openCount, 1);
        assert.ok(event.lastShownAt);
        assert.ok(event.lastOpenedAt);
        const metrics = await store.getDiscoveryMetrics();
        assert.strictEqual(metrics.totals.impression, 2);
        assert.strictEqual(metrics.totals.open, 1);
        assert.strictEqual(metrics.shelves['similar-books'].impression, 2);
        assert.strictEqual(metrics.rates.ctr, 0.5);
        assert.strictEqual(metrics.configuredProfiles, 1);

        const dismissedPreferences = await store.updateDiscoveryPreferences('reader-dismiss', {
            tastePromptDismissedAt: '2026-07-14T00:00:00.000Z',
        });
        assert.strictEqual(dismissedPreferences.taste.completedAt, '');
        assert.strictEqual(dismissedPreferences.taste.promptDismissedAt, '2026-07-14T00:00:00.000Z');
    });
}

async function testPersonalDiscoveryUsesColdStartTaste() {
    const worker = makeWorker();
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    worker.catalogSearch = {getBooksByUids: async() => []};

    const profile = await worker.buildPersonalDiscoveryTasteProfile({
        id: 'cold-reader',
        discoveryPreferences: {
            taste: {
                genres: ['sf_fantasy'],
                authors: ['Favorite Author'],
                languages: ['ru'],
                explorationRatio: 0.25,
                completedAt: '2026-07-13T00:00:00.000Z',
            },
        },
        readerProgress: {},
    }, {lists: []});

    assert.strictEqual(profile.signalCount, 0);
    assert.ok(profile.authorWeights.get('favorite author') > 0);
    assert.ok(profile.genreWeights.get('sf_fantasy') > 0);
    assert.ok(profile.explicitTasteAuthors.has('favorite author'));
    assert.strictEqual(profile.taste.explorationRatio, 0.25);

    const preferredScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'preferred', author: 'Favorite Author', genre: 'sf_fantasy', lang: 'ru', title: 'Preferred',
    }, profile, 5);
    const unrelatedScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'unrelated', author: 'Other Author', genre: 'history', lang: 'en', title: 'Unrelated',
    }, profile, 5);
    assert.ok(preferredScore > 0);
    assert.strictEqual(unrelatedScore, 0);
    assert.ok(worker.scorePersonalDiscoveryExplorationCandidate({
        _uid: 'explore', author: 'New Author', genre: 'history', lang: 'ru', title: 'Explore', librate: 5,
    }, profile, 5) > 0);
}

async function testPersonalDiscoveryUsesEngagementTopicsAndDismissals() {
    const worker = makeWorker();
    const books = {
        glance: {
            _uid: 'glance', author: 'Glance Author', genre: 'detective', keywords: 'crime', lang: 'ru',
        },
        favorite: {
            _uid: 'favorite', author: 'Favorite Author', genre: 'sf_fantasy', keywords: 'dragons, magic', lang: 'ru',
        },
    };
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    worker.catalogSearch = {getBooksByUids: async uids => uids.map(uid => books[uid]).filter(Boolean)};

    const profile = await worker.buildPersonalDiscoveryTasteProfile({
        id: 'reader',
        readerProgress: {
            glance: {percent: 0.01, updatedAt: '2024-01-01T00:00:00.000Z'},
            favorite: {percent: 1, updatedAt: '2024-01-02T00:00:00.000Z'},
        },
    }, {lists: []});

    assert.strictEqual(profile.authorWeights.has('glance author'), false);
    assert.ok(profile.authorWeights.get('favorite author') > 0);
    assert.ok(profile.keywordWeights.get('dragons') > 0);
    assert.ok(profile.keywordWeights.get('magic') > 0);
    assert.ok(profile.knownBookUids.has('glance'));
    assert.strictEqual(profile.genreWeights.has('history'), false);

    const topicalScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7);
    const unrelatedScore = worker.scorePersonalDiscoveryCandidate({
        _uid: 'unrelated', author: 'Another Author', genre: 'history', keywords: 'rome', lang: 'ru',
    }, profile, 7);

    assert.ok(topicalScore > unrelatedScore);

    profile.discoveryEvents.topic = {
        impressionCount: 3,
        openCount: 0,
        lastShownAt: new Date().toISOString(),
    };
    assert.strictEqual(worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7), 0);
    profile.discoveryEvents.topic.openCount = 1;
    assert.ok(worker.scorePersonalDiscoveryCandidate({
        _uid: 'topic', author: 'New Author', genre: 'sf_fantasy', keywords: 'dragons', lang: 'ru',
    }, profile, 7) > 0);
}

async function testPersonalDiscoveryDiversifiesAuthorsAndSeries() {
    const worker = makeWorker();
    const favorite = {
        _uid: 'favorite', author: 'Favorite Author', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru',
    };
    worker.readingListStore = {
        getLists: async() => [],
        normalizeEntries: entries => (Array.isArray(entries) ? entries : []),
    };
    const getBooksByUids = async uids => (uids.includes('favorite') ? [favorite] : []);

    const user = {
        id: 'reader',
        discoveryPreferences: {},
        readerProgress: {
            favorite: {percent: 1, updatedAt: '2024-01-02T00:00:00.000Z'},
        },
    };
    await withTempDir(async dir => {
        //кандидаты считаются по БД библиотеки, как на сервере
        const CatalogIndex = require('../server/core/search/CatalogIndex');
        const index = new CatalogIndex();
        const file = path.join(dir, 'library.sqlite');
        index.beginBuild(file);
        try {
            index.insertBooks([
                {_uid: 'same-1', title: 'Same 1', author: 'Favorite Author', series: 'Saga A', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-2', title: 'Same 2', author: 'Favorite Author', series: 'Saga B', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-3', title: 'Same 3', author: 'Favorite Author', series: 'Saga C', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'new-author', title: 'New Author', author: 'Different Author', series: '', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'same-series', title: 'Same Series', author: 'Third Author', series: 'Saga A', genre: 'sf_fantasy', keywords: 'magic', lang: 'ru'},
                {_uid: 'explore-1', title: 'Explore History', author: 'History Author', series: '', genre: 'history', keywords: 'rome', lang: 'ru', librate: 5},
                {_uid: 'explore-2', title: 'Explore Detective', author: 'Detective Author', series: '', genre: 'detective', keywords: 'crime', lang: 'ru', librate: 4},
            ].map((row, i) => Object.assign({id: i + 1, date: '2026-01-01', sourceId: 'main'}, row)));
            index.finishBuild({});
            index.open(file);
            worker.catalogSearch = {
                ready: true,
                getBooksByUids,
                similarCandidates: async request => index.withBooks('similarCandidates', request),
            };
            const shelf = await worker.buildSimilarBooksShelfV2(user, 4, {
                lists: [],
                progressMap: user.readerProgress,
                readBookUids: new Set(['favorite']),
            });
            const favoriteAuthorCount = shelf.items.filter(book => book.author === 'Favorite Author').length;
            const sagaACount = shelf.items.filter(book => book.series === 'Saga A').length;

            assert.ok(shelf.items.some(book => book.author !== 'Favorite Author'));
            assert.ok(shelf.items.some(book => book._discoveryExplore === true));
            assert.strictEqual(shelf.discoveryNeedsTasteSetup, true);
            assert.ok(favoriteAuthorCount <= 2);
            assert.ok(sagaACount <= 1);

            user.discoveryPreferences.taste = {promptDismissedAt: '2026-07-14T00:00:00.000Z'};
            const dismissedShelf = await worker.buildSimilarBooksShelfV2(user, 4, {
                lists: [],
                progressMap: user.readerProgress,
                readBookUids: new Set(['favorite']),
            });
            assert.strictEqual(dismissedShelf.discoveryNeedsTasteSetup, false);
        } finally {
            index.close();
        }
    });
}

//Запросы OPDS к БД библиотеки: отдельный скрипт, запускается как есть
function testOpdsIndexQueries() {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'opds-index-tests.js')], {stdio: 'pipe'});
}

//Архивы из S3: отдельный процесс, адрес S3 задаётся до запуска потоков архивов
function testS3Archives() {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 's3-archive-tests.js')], {stdio: 'pipe'});
}

const tests = [
    ...require('./fb2-encoding-tests'),
    ...require('./catalog-regression-tests'),
    ...require('./library-metadata-tests'),
    ...require('./epub-archive-tests'),
    ...require('./profile-access-tests'),
    ...require('./audit-stage4-tests'),
    ...require('./resource-limit-tests'),
    ...require('./dependency-smoke-tests'),
    ...require('./reader-tests'),
    ...require('./security-regression-tests'),
    ...require('./kobo-sync-tests'),
    ...require('./kosync-tests'),
    ...require('./remote-library-tests'),
    ...require('./inpx-parser-tests'),
    ...require('./library-fs-tests'),
    ...require('./xml-parser-tests'),
    ...require('./client-tests'),
    ...require('./web-worker-tests'),
    ...require('./api-routes-tests'),
    testConfigSecretsSurviveRestart,
    testWindowsDefaultDataDir,
    testAppCacheRecoveryBootstrapAndRoute,
    testStaticAssetsArePrecompressed,
    testFb2ContentsExcludeNotesBodies,
    testReaderAnnotationStaysOutsideReadingFlow,
    testReaderBookNotesMenuAndReturnLayout,
    testReaderPreferencesMigrate,
    testReaderPaginationResumesAcrossViewportGeometry,
    testReaderDefersViewportRefreshAcrossScreenUnlock,
    testReaderChromeToggleKeepsLayout,
    testReaderHomeFieldsIgnoreGlobalDarkTheme,
    testReaderImageDataUrlsAreValidated,
    testConvertedBookFileNames,
    testFb2cngConfigAndConversionCache,
    testAdminSettingsRestoreKeepsSecrets,
    testAdminBackupArchiveAndDownload,
    testAuthorNamesExportAndImport,
    testWorkTitlesDownload,
    testAuthorNamesStatusSeesRequestedRebuild,
    testDisabledLibrarySourceIsKept,
    testDisabledLibraryHiddenWithoutRebuild,
    testUserBackupExportsAndRestoresReaderState,
    testReaderProgressChoice,
    testReaderProgressResetAndHiddenState,
    testMarkReadKeepsReadingPlace,
    testProfileReadingSummaryLeavesOutReadBooks,
    testReaderHomeKeepsUnavailableProgressVisible,
    testBookPageRecordAndReaderStates,
    testOpdsSeriesEntriesAndFilter,
    testCatalogIndexSearch,
    testAuthorEnglishNames,
    testDiscoveryPreferencesAndEventsPersist,
    testCoverCacheRoutesAndCleaner,
    testCacheRotationUsesTargetWatermark,
    testCacheRotationAlignsToServerClock,
    testExternalDiscoveryMultiSourceSearch,
    testWikidataAwardsShelf,
    testAwardsShelfEditionsAndOrder,
    testExternalShelfCacheIsSharedAndRefreshedInBackground,
    testConfiguredConverterPathsHavePriority,
    testDiscoveryShelvesBuildOnlyRequestedSection,
    testOpdsIndexQueries,
    testS3Archives,
    testPersonalDiscoveryCacheAndSingleFlight,
    testUnfinishedSeriesSkipsDeletedBooks,
    testPersonalDiscoveryUsesColdStartTaste,
    testPersonalDiscoveryUsesEngagementTopicsAndDismissals,
    testPersonalDiscoveryDiversifiesAuthorsAndSeries,
];

//node:test: упавший тест печатает not ok, остальные продолжают, код выхода ненулевой
const {test, before} = require('node:test');
before(ensureLogger);
for (const t of tests)
    test(t.name, () => t());
