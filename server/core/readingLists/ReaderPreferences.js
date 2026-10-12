const {readerPreferencesVersion, readerDefaults, einkReaderDefaults, migrateReaderPreferences} = require('../../../shared/readerPreferences');

function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

// Reader settings normalizers. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    normalizeReaderTheme(theme) {
        const value = String(theme || '').trim().toLowerCase();
        return (['light', 'sepia', 'dark', 'eink'].includes(value) ? value : 'dark');
    },

    normalizeReaderRuntimeSettings(value = {}, defaults = {}) {
        const setting = (key, fallback) => (
            utilsHasProp(value, key)
                ? value[key]
                : (utilsHasProp(defaults, key) ? defaults[key] : fallback)
        );
        //сторона без своего значения берётся из общего, как в читалке (normalizeReaderSpacingPreferences): низ = верх + 4
        const side = (key, shared, extra = 0) => {
            if (!utilsHasProp(value, key) && utilsHasProp(value, shared) && Number.isFinite(Number(value[shared])))
                return Number(value[shared]) + extra;
            return setting(key, 0);
        };
        const fontFamily = String(setting('fontFamily', 'serif')).trim().toLowerCase();
        const contentWidthMode = String(setting('contentWidthMode', 'fixed')).trim().toLowerCase();
        const pagedSpreadMode = String(setting('pagedSpreadMode', 'single')).trim().toLowerCase();
        return {
            readMode: (String(setting('readMode', '')).trim().toLowerCase() === 'paged' ? 'paged' : 'scroll'),
            pagedNavigation: (String(setting('pagedNavigation', '')).trim().toLowerCase() === 'wheel' ? 'wheel' : 'tap'),
            pagedDirection: (String(setting('pagedDirection', '')).trim().toLowerCase() === 'horizontal' ? 'horizontal' : 'vertical'),
            pageAnimation: (['none', 'soft', 'slide'].includes(String(setting('pageAnimation', '')).trim().toLowerCase())
                ? String(setting('pageAnimation', '')).trim().toLowerCase()
                : 'soft'),
            pageAnimationSpeed: (['fast', 'normal', 'slow'].includes(String(setting('pageAnimationSpeed', '')).trim().toLowerCase())
                ? String(setting('pageAnimationSpeed', '')).trim().toLowerCase()
                : 'normal'),
            showStatusBar: (value.showStatusBar !== false),
            statusBarClock: (value.statusBarClock === true),
            statusBarProgressBar: (value.statusBarProgressBar === true),
            statusBarProgressPosition: (String(setting('statusBarProgressPosition', '')).trim().toLowerCase() === 'side' ? 'side' : 'bottom'),
            statusBarRemaining: (value.statusBarRemaining === true),
            statusBarAlign: (String(setting('statusBarAlign', '')).trim().toLowerCase() === 'edge' ? 'edge' : 'center'),
            statusBarSize: Math.max(10, Math.min(18, parseInt(setting('statusBarSize', 12), 10) || 12)),
            fontFamily: (['serif', 'sans', 'mono', 'system'].includes(fontFamily) ? fontFamily : 'serif'),
            fontSize: Math.max(14, Math.min(30, parseInt(setting('fontSize', 18), 10) || 18)),
            lineHeight: Math.max(1.15, Math.min(2.2, Number(setting('lineHeight', 1.7)) || 1.7)),
            textShadow: (setting('textShadow', false) === true),
            contentWidth: Math.max(480, Math.min(2200, parseInt(setting('contentWidth', 1040), 10) || 1040)),
            contentWidthMode: (contentWidthMode === 'viewport' ? 'viewport' : 'fixed'),
            backgroundImage: String(setting('backgroundImage', '') || '').trim(),
            backgroundImageName: String(setting('backgroundImageName', '') || '').trim().slice(0, 160),
            backgroundTransparentPages: (value.backgroundTransparentPages === true),
            backgroundTransparentStatus: (value.backgroundTransparentStatus === true),
            pagedSpreadMode: (pagedSpreadMode === 'dual' ? 'dual' : 'single'),
            dualPageGap: Math.max(0, Math.min(240, parseInt(setting('dualPageGap', 28), 10) || 0)),
            pageVerticalPadding: Math.max(0, Math.min(160, parseInt(setting('pageVerticalPadding', 18), 10) || 0)),
            pageHorizontalPadding: Math.max(0, Math.min(220, parseInt(setting('pageHorizontalPadding', 18), 10) || 0)),
            pagePaddingTop: Math.max(0, Math.min(160, parseInt(side('pagePaddingTop', 'pageVerticalPadding'), 10) || 0)),
            pagePaddingBottom: Math.max(0, Math.min(160, parseInt(side('pagePaddingBottom', 'pageVerticalPadding', 4), 10) || 0)),
            pagePaddingLeft: Math.max(0, Math.min(220, parseInt(side('pagePaddingLeft', 'pageHorizontalPadding'), 10) || 0)),
            pagePaddingRight: Math.max(0, Math.min(220, parseInt(side('pagePaddingRight', 'pageHorizontalPadding'), 10) || 0)),
            pageOuterGap: Math.max(0, Math.min(220, parseInt(setting('pageOuterGap', 28), 10) || 0)),
            pageOuterGapTop: Math.max(0, Math.min(220, parseInt(side('pageOuterGapTop', 'pageOuterGap'), 10) || 0)),
            pageOuterGapBottom: Math.max(0, Math.min(220, parseInt(side('pageOuterGapBottom', 'pageOuterGap'), 10) || 0)),
            einkContrast: Math.max(72, Math.min(100, parseInt(setting('einkContrast', 92), 10) || 92)),
            einkPaperTone: Math.max(84, Math.min(99, parseInt(setting('einkPaperTone', 94), 10) || 94)),
            einkInkTone: Math.max(4, Math.min(26, parseInt(setting('einkInkTone', 10), 10) || 10)),
        };
    },

    normalizeReaderDeviceSettings(value = {}, defaults = {}) {
        if (!value || typeof(value) !== 'object')
            return {};

        const hasOwn = key => utilsHasProp(value, key);
        const normalized = this.normalizeReaderRuntimeSettings(value, defaults);
        const allowed = [
            'readMode',
            'pagedNavigation',
            'pagedDirection',
            'pageAnimation',
            'pageAnimationSpeed',
            'contentWidth',
            'contentWidthMode',
            'pagedSpreadMode',
            'dualPageGap',
            'pageVerticalPadding',
            'pageHorizontalPadding',
            'pagePaddingTop',
            'pagePaddingBottom',
            'pagePaddingLeft',
            'pagePaddingRight',
            'pageOuterGap',
            'pageOuterGapTop',
            'pageOuterGapBottom',
        ];
        const result = {};
        for (const key of allowed) {
            if (hasOwn(key))
                result[key] = normalized[key];
        }

        if (hasOwn('pageVerticalPadding')) {
            if (!hasOwn('pagePaddingTop'))
                result.pagePaddingTop = normalized.pagePaddingTop;
            if (!hasOwn('pagePaddingBottom'))
                result.pagePaddingBottom = normalized.pagePaddingBottom;
        }
        if (hasOwn('pageHorizontalPadding')) {
            if (!hasOwn('pagePaddingLeft'))
                result.pagePaddingLeft = normalized.pagePaddingLeft;
            if (!hasOwn('pagePaddingRight'))
                result.pagePaddingRight = normalized.pagePaddingRight;
        }
        if (hasOwn('pageOuterGap')) {
            if (!hasOwn('pageOuterGapTop'))
                result.pageOuterGapTop = normalized.pageOuterGapTop;
            if (!hasOwn('pageOuterGapBottom'))
                result.pageOuterGapBottom = normalized.pageOuterGapBottom;
        }

        return result;
    },

    normalizeReaderPreferences(value = {}) {
        const preferences = migrateReaderPreferences((value && typeof(value) === 'object') ? value : {});
        const einkProfile = this.normalizeReaderRuntimeSettings(preferences.einkProfile || {}, einkReaderDefaults);
        einkProfile.regularProfile = this.normalizeReaderDeviceSettings((preferences.einkProfile || {}).regularProfile || {}, einkReaderDefaults);
        einkProfile.compactProfile = this.normalizeReaderDeviceSettings((preferences.einkProfile || {}).compactProfile || {}, einkReaderDefaults);

        return {
            readerPreferencesVersion,
            theme: this.normalizeReaderTheme(preferences.theme),
            ...this.normalizeReaderRuntimeSettings(preferences, readerDefaults),
            regularProfile: this.normalizeReaderDeviceSettings(preferences.regularProfile || {}, readerDefaults),
            compactProfile: this.normalizeReaderDeviceSettings(preferences.compactProfile || {}, readerDefaults),
            einkProfile,
        };
    },
};
