const RootPage = require('./RootPage');
const AuthorPage = require('./AuthorPage');
const SeriesPage = require('./SeriesPage');
const TitlePage = require('./TitlePage');
const GenrePage = require('./GenrePage');
const BookPage = require('./BookPage');
const ReadingListsPage = require('./ReadingListsPage');
const ReadingListPage = require('./ReadingListPage');
const ReadingProfilesPage = require('./ReadingProfilesPage');
const ReadingProgressPage = require('./ReadingProgressPage');

const OpensearchPage = require('./OpensearchPage');
const SearchPage = require('./SearchPage');
const SearchHelpPage = require('./SearchHelpPage');
const i18n = require('../i18n');
const {resolveViewer, canSeeProfile} = require('./Auth');

const log = new (require('../AppLogger'))().log;//singleton

// Profile lookups fall back to the first profile (the admin), and the OPDS auth check skips profiles
// without OPDS: a ?user= scope must name a profile with OPDS on, or the signed-in profile itself.
// A profile with a password is shown only to itself and to an admin (see Auth.canSeeProfile).
function scopeGuard(getWorker, security = null) {
    return async(req, res, next) => {
        try {
            const worker = getWorker();
            req.opdsViewer = await resolveViewer(req, worker, security);
            const scopeUser = String((req.query && req.query.user) || '').trim();
            const identity = req.profileAccessIdentity;
            if (scopeUser && !(identity && identity.user && identity.user.id === scopeUser)) {
                const user = await worker.readingListStore.getOpdsUser(scopeUser);
                if (!user || !canSeeProfile(req, user.id, !!user.passwordHash)) {
                    res.set('Cache-Control', 'no-store');
                    return res.status(404).send('Profile not found');
                }
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

// ?author[]=x and ?a[b]=x parse to arrays and objects; the pages expect strings.
function stringQuery(req, res, next) {
    for (const [key, value] of Object.entries(req.query || {})) {
        if (typeof value !== 'string')
            req.query[key] = (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '');
    }
    next();
}

module.exports = function(app, config, security = new (require('../Security'))(config)) {
    if (!config.opds || !config.opds.enabled)
        return;
    
    const opdsRoot = config.opds.root || '/opds';
    config.opdsRoot = opdsRoot;

    const root = new RootPage(config);
    const author = new AuthorPage(config);
    const series = new SeriesPage(config);
    const title = new TitlePage(config);
    const genre = new GenrePage(config);
    const book = new BookPage(config);
    book.security = security;
    const readingLists = new ReadingListsPage(config);
    const readingList = new ReadingListPage(config);
    const readingProfiles = new ReadingProfilesPage(config);
    const readingProgress = new ReadingProgressPage(config);

    const opensearch = new OpensearchPage(config);
    const search = new SearchPage(config);
    const searchHelp = new SearchHelpPage(config);

    const routes = [
        ['', root],
        ['/root', root],
        ['/author', author],
        ['/series', series],
        ['/title', title],
        ['/genre', genre],
        ['/book', book],
        ['/reading-lists', readingLists],
        ['/reading-lists/list', readingList],
        ['/reading-profiles', readingProfiles],
        ['/reading-progress', readingProgress],

        ['/opensearch', opensearch],
        ['/search', search],
        ['/search-help', searchHelp],
    ];

    const pages = new Map();
    for (const r of routes) {
        pages.set(`${opdsRoot}${r[0]}`, r[1]);
    }

    const opds = async(req, res, next) => {
        try {
            const page = pages.get(req.path);

            if (page) {
                res.set('Content-Type', req.path === `${opdsRoot}/opensearch`
                    ? 'application/opensearchdescription+xml; charset=utf-8'
                    : 'application/atom+xml; charset=utf-8');

                const lang = i18n.resolveOpdsLang(config, req);
                res.set('Content-Language', lang);
                res.vary('Accept-Language');

                const result = await i18n.run(lang, () => page.body(req, res));

                if (result !== false)
                    res.send(result);
            } else {
                next();
            }
        } catch (e) {
            log(LM_ERR, `OPDS: ${e.message}, url: ${req.originalUrl}`);
            res.status(500).send({error: 'Internal server error'});
        }
    };

    const opdsPaths = [opdsRoot, `${opdsRoot}/*`];

    app.use(opdsPaths, stringQuery);
    app.use(opdsPaths, new (require('../ProfileAccess'))(config, root.webWorker, security).httpGuard(true));
    app.use(opdsPaths, require('./Auth')(config, (...args) => root.webWorker.verifyOpdsPassword(...args), security));
    app.use(opdsPaths, scopeGuard(() => root.webWorker, security));

    app.get(opdsPaths, opds);
};

module.exports.scopeGuard = scopeGuard;
module.exports.stringQuery = stringQuery;
