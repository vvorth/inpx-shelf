// Reader defaults and migration of saved reader settings. The server stores and normalizes
// them, the reader applies them: both must agree on the defaults and the version.
const readerPreferencesVersion = 3;

const readerDefaults = {
    readMode: 'scroll',
    pagedNavigation: 'tap',
    pagedDirection: 'vertical',
    pageAnimation: 'soft',
    pageAnimationSpeed: 'normal',
    showStatusBar: true,
    statusBarClock: false,
    statusBarProgressBar: false,
    statusBarProgressPosition: 'bottom',
    statusBarRemaining: false,
    statusBarAlign: 'center',
    statusBarSize: 12,
    fontFamily: 'serif',
    fontSize: 18,
    lineHeight: 1.7,
    textShadow: false,
    contentWidth: 1040,
    contentWidthMode: 'viewport',
    backgroundImage: '',
    backgroundImageName: '',
    backgroundTransparentPages: false,
    backgroundTransparentStatus: false,
    pagedSpreadMode: 'single',
    dualPageGap: 28,
    pageVerticalPadding: 18,
    pageHorizontalPadding: 18,
    pagePaddingTop: 18,
    pagePaddingBottom: 22,
    pagePaddingLeft: 18,
    pagePaddingRight: 18,
    pageOuterGap: 28,
    pageOuterGapTop: 28,
    pageOuterGapBottom: 28,
    einkContrast: 92,
    einkPaperTone: 94,
    einkInkTone: 10,
};

const einkReaderDefaults = Object.assign({}, readerDefaults, {
    readMode: 'paged',
    pageAnimation: 'none',
    pageAnimationSpeed: 'fast',
    fontSize: 19,
    lineHeight: 1.8,
    contentWidth: 920,
    contentWidthMode: 'fixed',
});
// The e-ink profile keeps the regular background image: it has no image of its own.
delete einkReaderDefaults.backgroundImage;
delete einkReaderDefaults.backgroundImageName;

function migrateReaderPreferences(preferences = {}) {
    if (!preferences || typeof preferences !== 'object')
        return {};

    // Vue's reactive proxies cannot be structuredClone'd; the settings are plain JSON
    const next = JSON.parse(JSON.stringify(preferences));
    const version = Math.max(0, parseInt(next.readerPreferencesVersion, 10) || 0);
    if (version < 2) {
        next.textShadow = false;
        next.einkProfile = Object.assign({}, next.einkProfile || {}, {textShadow: false});
    }
    if (
        version < 3
        && next.contentWidthMode === 'fixed'
        && (Number(next.contentWidth || 1040) || 1040) === 1040
    ) {
        // The previous desktop default constrained the whole two-page
        // spread to 1040px. Migrate only that untouched default; custom
        // fixed widths remain an explicit reader preference.
        next.contentWidthMode = 'viewport';
    }
    next.readerPreferencesVersion = readerPreferencesVersion;
    return next;
}

module.exports = {readerPreferencesVersion, readerDefaults, einkReaderDefaults, migrateReaderPreferences};
