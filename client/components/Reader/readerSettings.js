//Настройки читалки: действующие настройки (e-ink, профиль устройства, отладочные из адреса), обработчики панели
//настроек, слияние с настройками с сервера и сохранение. Своего состояния нет: настройки - поле Reader.preferences.
import cloneDeep from 'lodash/cloneDeep';
import isEqual from 'lodash/isEqual';
const readerStorage = require('../../share/readerStorage');

const {migrateReaderPreferences} = require('../../../shared/readerPreferences');
const readerDeviceProfileKeys = ['regularProfile', 'compactProfile'];
const readerDeviceScopedPreferenceKeys = new Set([
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
    'pageOuterGapLeft',
    'pageOuterGapRight',
]);

export default class ReaderSettings {
    get readerDebugPreferenceOverrides() {
        if (!this.readerDebugEnabled)
            return {};

        const query = (this.$route && this.$route.query ? this.$route.query : {});
        const readMode = String(query.debugReadMode || '').trim().toLowerCase();
        const pagedDirection = String(query.debugPagedDirection || '').trim().toLowerCase();
        const result = {};

        if (readMode === 'paged' || readMode === 'scroll')
            result.readMode = readMode;
        if (pagedDirection === 'horizontal' || pagedDirection === 'vertical')
            result.pagedDirection = pagedDirection;

        return result;
    }

    get activePreferences() {
        const basePreferences = (this.preferences.theme === 'eink')
            ? Object.assign({}, this.preferences, this.preferences.einkProfile || {})
            : this.preferences;
        return Object.assign(
            {},
            basePreferences,
            this.getDeviceScopedReaderPreferences(basePreferences),
            this.readerDebugPreferenceOverrides,
        );
    }

    getActivePreferencesForTheme(theme = '', basePreferences = null) {
        const source = Object.assign({}, (basePreferences || this.preferences || {}), {theme});
        const themedPreferences = (theme === 'eink')
            ? Object.assign({}, source, source.einkProfile || {})
            : source;
        return Object.assign({}, themedPreferences, this.getDeviceScopedReaderPreferences(themedPreferences));
    }

    get activeReaderDeviceProfileKey() {
        return this.isCompactLayout ? 'compactProfile' : 'regularProfile';
    }

    getDeviceScopedReaderPreferences(preferences = {}) {
        const profile = preferences && preferences[this.activeReaderDeviceProfileKey];
        return (profile && typeof profile === 'object') ? profile : {};
    }

    normalizeFontFamily(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['serif', 'sans', 'mono', 'system'].includes(normalized) ? normalized : 'serif';
    }

    get selectedFontFamily() {
        return this.normalizeFontFamily(this.activePreferences.fontFamily);
    }

    get mobileSpacingControls() {
        return [
            {key: 'pageTop', label: this.uiText.pagePaddingTop, value: this.pagePaddingTop, kind: 'page', edge: 'top'},
            {key: 'pageBottom', label: this.uiText.pagePaddingBottom, value: this.pagePaddingBottom, kind: 'page', edge: 'bottom'},
            {key: 'pageLeft', label: this.uiText.pagePaddingLeft, value: this.pagePaddingLeft, kind: 'page', edge: 'left'},
            {key: 'pageRight', label: this.uiText.pagePaddingRight, value: this.pagePaddingRight, kind: 'page', edge: 'right'},
            {key: 'outerTop', label: this.uiText.pageOuterGapTop, value: this.pageOuterGapTop, kind: 'outer', edge: 'top'},
            {key: 'outerBottom', label: this.uiText.pageOuterGapBottom, value: this.pageOuterGapBottom, kind: 'outer', edge: 'bottom'},
            {key: 'outerLeft', label: this.uiText.pageOuterGapLeft, value: this.pageOuterGapLeft, kind: 'outer', edge: 'left'},
            {key: 'outerRight', label: this.uiText.pageOuterGapRight, value: this.pageOuterGapRight, kind: 'outer', edge: 'right'},
        ];
    }

    get activeMobileSpacingControl() {
        return this.mobileSpacingControls.find((item) => item.key === this.mobileSpacingControl)
            || this.mobileSpacingControls[1]
            || {key: 'pageBottom', label: '', value: 0, kind: 'page', edge: 'bottom'};
    }

    async setReadMode(mode = 'scroll') {
        const nextMode = (mode === 'paged' ? 'paged' : 'scroll');
        if (this.activePreferences.readMode === nextMode)
            return;

        //место берём, пока на экране прежний режим
        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            readMode: nextMode,
        });
        this.savePreferencesDebounced();
        // On desktop the settings panel is an overlay, so it is safe to rebuild
        // immediately. Deferring a mode switch hides the scroll content at once
        // but never starts pagination until the panel is closed, leaving the
        // preparing sheet on screen indefinitely. Compact settings still defer
        // because their sheet temporarily changes the usable viewport height.
        this.requestReaderSettingsReflow({immediate: !this.isCompactLayout});
    }

    async setPagedDirection(direction = 'vertical') {
        const nextDirection = (direction === 'horizontal' ? 'horizontal' : 'vertical');
        if (this.activePreferences.pagedDirection === nextDirection)
            return;

        this.updateActivePreferences({
            pagedDirection: nextDirection,
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    async setContentWidthMode(mode = 'fixed') {
        this.updateActivePreferences({
            contentWidthMode: (mode === 'viewport' ? 'viewport' : 'fixed'),
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    async setPagedSpreadMode(mode = 'single') {
        const nextMode = (mode === 'dual' ? 'dual' : 'single');
        if (this.activePreferences.pagedSpreadMode === nextMode)
            return;

        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            pagedSpreadMode: nextMode,
        });
        this.currentPageIndex = this.isDualPagedSpread
            ? this.currentPageIndex - (this.currentPageIndex % 2)
            : this.currentPageIndex;
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    async changeDualPageGap(delta = 0) {
        const next = Math.max(0, Math.min(240, this.dualPageGap + (Number(delta || 0) || 0)));
        if (next === this.dualPageGap)
            return;

        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            dualPageGap: next,
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow({previewSpacing: true});
    }

    async changePagePadding(edge = '', delta = 0) {
        const map = {
            top: ['pagePaddingTop', this.pagePaddingTop, 160],
            bottom: ['pagePaddingBottom', this.pagePaddingBottom, 160],
            left: ['pagePaddingLeft', this.pagePaddingLeft, 200],
            right: ['pagePaddingRight', this.pagePaddingRight, 200],
        };
        const target = map[edge];
        if (!target)
            return;

        const [key, current, max] = target;
        const next = Math.max(0, Math.min(max, current + (Number(delta || 0) || 0)));
        if (next === current)
            return;

        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            [key]: next,
        });
        this.showPagePaddingPreview(edge);
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow({previewSpacing: true});
    }

    async changePageOuterGap(edge = '', delta = 0) {
        const map = {
            top: ['pageOuterGapTop', this.pageOuterGapTop],
            bottom: ['pageOuterGapBottom', this.pageOuterGapBottom],
            left: ['pageOuterGapLeft', this.pageOuterGapLeft],
            right: ['pageOuterGapRight', this.pageOuterGapRight],
        };
        const target = map[edge];
        this.capturePendingReflowAnchor(true);
        if (!target) {
            const nextTop = Math.max(0, Math.min(160, this.pageOuterGapTop + (Number(edge || delta || 0) || 0)));
            const nextBottom = Math.max(0, Math.min(160, this.pageOuterGapBottom + (Number(edge || delta || 0) || 0)));
            this.updateActivePreferences({
                pageOuterGapTop: nextTop,
                pageOuterGapBottom: nextBottom,
                pageOuterGap: nextTop,
            });
        } else {
            const [key, current] = target;
            const next = Math.max(0, Math.min(160, current + (Number(delta || 0) || 0)));
            if (next === current)
                return;

            this.updateActivePreferences({
                [key]: next,
            });
        }
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow({previewSpacing: true});
    }

    setMobileSpacingControl(key = '') {
        const next = this.mobileSpacingControls.find((item) => item.key === key);
        if (!next)
            return;

        this.mobileSpacingControl = next.key;
    }

    changeMobileSpacingControl(delta = 0) {
        const control = this.activeMobileSpacingControl;
        if (!control)
            return;

        if (control.kind === 'outer') {
            this.changePageOuterGap(control.edge, delta);
            return;
        }

        this.changePagePadding(control.edge, delta);
    }

    setPageAnimation(mode = 'soft') {
        this.updateActivePreferences({
            pageAnimation: (['none', 'soft', 'slide'].includes(mode) ? mode : 'soft'),
        });
        this.savePreferencesDebounced();
    }

    setPageAnimationSpeed(speed = 'normal') {
        this.updateActivePreferences({
            pageAnimationSpeed: (['fast', 'normal', 'slow'].includes(speed) ? speed : 'normal'),
        });
        this.savePreferencesDebounced();
    }

    setStatusBarVisible(enabled = true) {
        this.updateActivePreferences({
            showStatusBar: !!enabled,
        });
        this.savePreferencesDebounced();
    }

    setStatusBarOption(key = '', enabled = false) {
        const allowed = ['statusBarClock', 'statusBarProgressBar', 'statusBarRemaining'];
        if (!allowed.includes(key))
            return;

        this.updateActivePreferences({
            [key]: !!enabled,
        });
        this.savePreferencesDebounced();
    }

    setStatusBarAlign(align = 'center') {
        this.updateActivePreferences({
            statusBarAlign: (align === 'edge' ? 'edge' : 'center'),
        });
        this.savePreferencesDebounced();
    }

    setStatusBarProgressPosition(position = 'bottom') {
        this.updateActivePreferences({
            statusBarProgressPosition: (position === 'side' ? 'side' : 'bottom'),
        });
        this.savePreferencesDebounced();
    }

    changeStatusBarSize(delta = 0) {
        const next = Math.max(10, Math.min(18, this.statusBarSize + (Number(delta || 0) || 0)));
        this.updateActivePreferences({
            statusBarSize: next,
        });
        this.savePreferencesDebounced();
    }

    setReaderControlsTab(tab = 'text') {
        const next = ['text', 'page', 'status'].includes(tab) ? tab : 'text';
        if (this.readerControlsTab === next)
            return;

        this.readerControlsTab = next;
        if (this.isCompactLayout && this.controlsOpen)
            this.refreshCompactSettingsViewport();
    }

    async resetReaderAppearance() {
        const dialog = this.$root && this.$root.stdDialog;
        const confirmed = dialog
            ? await dialog.confirm(this.uiText.resetReaderAppearanceConfirm, this.uiText.resetReaderAppearance, {
                dialogClass: 'std-dialog-card--reader',
                dialogStyle: this.readerDialogStyle,
            })
            : true;
        if (!confirmed)
            return;

        if (this.savePreferencesDebounced && this.savePreferencesDebounced.cancel)
            this.savePreferencesDebounced.cancel();

        this.preferences = cloneDeep(this.defaultReaderPreferences);
        this.writeStoredReaderPreferences();
        this.requestReaderSettingsReflow();
        try {
            await this.persistPreferences();
        } catch (e) {
            if ((e && e.message) !== 'need_profile_login')
                throw e;
        }

        if (this.$root && this.$root.notify)
            this.$root.notify.success(this.uiText.resetReaderAppearanceSuccess, '', this.readerNotifyOptions);
    }

    changeEinkContrast(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkContrast: Math.max(72, Math.min(100, (Number(this.activePreferences.einkContrast || 92) || 92) + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeEinkPaperTone(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkPaperTone: Math.max(84, Math.min(99, (Number(this.activePreferences.einkPaperTone || 94) || 94) + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeEinkInkTone(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkInkTone: Math.max(4, Math.min(26, (Number(this.activePreferences.einkInkTone || 10) || 10) + delta)),
        });
        this.savePreferencesDebounced();
    }

    updateActivePreferences(patch = {}) {
        const scopedPatch = {};
        const globalPatch = {};
        for (const [key, value] of Object.entries(patch || {})) {
            if (readerDeviceScopedPreferenceKeys.has(key))
                scopedPatch[key] = value;
            else
                globalPatch[key] = value;
        }
        const hasScopedPatch = Object.keys(scopedPatch).length > 0;
        const hasGlobalPatch = Object.keys(globalPatch).length > 0;
        const deviceProfileKey = this.activeReaderDeviceProfileKey;

        if (this.preferences.theme === 'eink') {
            const currentEinkProfile = this.preferences.einkProfile || {};
            const nextEinkProfile = Object.assign({}, currentEinkProfile, globalPatch);
            if (hasScopedPatch) {
                nextEinkProfile[deviceProfileKey] = Object.assign(
                    {},
                    currentEinkProfile[deviceProfileKey] || {},
                    scopedPatch,
                );
            }
            this.preferences = Object.assign({}, this.preferences, {
                einkProfile: nextEinkProfile,
            });
            return;
        }

        const nextPreferences = Object.assign({}, this.preferences, globalPatch);
        if (hasScopedPatch) {
            nextPreferences[deviceProfileKey] = Object.assign(
                {},
                this.preferences[deviceProfileKey] || {},
                scopedPatch,
            );
        }

        if (hasGlobalPatch || hasScopedPatch)
            this.preferences = nextPreferences;
    }

    async persistPreferences() {
        this.writeStoredReaderPreferences();

        const api = this.$root.api;
        if (!api)
            return;

        try {
            await api.updateReaderPreferences(this.preferences, {suppressProfileLogin: true});
        } catch (e) {
            if ((e && e.message) !== 'need_profile_login')
                throw e;
        }
    }

    mergeReaderPreferences(preferences = {}) {
        if (!preferences || typeof preferences !== 'object')
            return this.preferences;

        const normalized = this.normalizeReaderSpacingPreferences(migrateReaderPreferences(preferences));
        const nextPreferences = Object.assign({}, this.preferences, normalized, {
            einkProfile: Object.assign(
                {},
                this.preferences.einkProfile || {},
                this.normalizeReaderSpacingPreferences(normalized.einkProfile || {}),
            ),
        });
        this.mergeReaderDeviceProfiles(nextPreferences, this.preferences, normalized);
        if (nextPreferences.einkProfile)
            this.mergeReaderDeviceProfiles(nextPreferences.einkProfile, this.preferences.einkProfile || {}, normalized.einkProfile || {});
        return nextPreferences;
    }

    normalizeReaderSpacingPreferences(preferences = {}) {
        if (!preferences || typeof preferences !== 'object')
            return {};

        const next = Object.assign({}, preferences);
        const hasOwn = key => Object.prototype.hasOwnProperty.call(next, key);
        const numberOrNull = value => {
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
        };

        const vertical = numberOrNull(next.pageVerticalPadding);
        if (vertical != null) {
            if (!hasOwn('pagePaddingTop'))
                next.pagePaddingTop = vertical;
            if (!hasOwn('pagePaddingBottom'))
                next.pagePaddingBottom = Math.max(0, vertical + 4);
        }

        const horizontal = numberOrNull(next.pageHorizontalPadding);
        if (horizontal != null) {
            if (!hasOwn('pagePaddingLeft'))
                next.pagePaddingLeft = horizontal;
            if (!hasOwn('pagePaddingRight'))
                next.pagePaddingRight = horizontal;
        }

        const outer = numberOrNull(next.pageOuterGap);
        if (outer != null) {
            if (!hasOwn('pageOuterGapTop'))
                next.pageOuterGapTop = outer;
            if (!hasOwn('pageOuterGapBottom'))
                next.pageOuterGapBottom = outer;
        }

        for (const key of readerDeviceProfileKeys) {
            if (next[key] && typeof next[key] === 'object')
                next[key] = this.normalizeReaderSpacingPreferences(next[key]);
        }

        return next;
    }

    mergeReaderDeviceProfiles(target = {}, base = {}, incoming = {}) {
        for (const key of readerDeviceProfileKeys) {
            if (!incoming[key] || typeof incoming[key] !== 'object')
                continue;

            target[key] = Object.assign({}, base[key] || {}, incoming[key] || {});
        }
    }

    applyReaderPreferences(preferences = {}, options = {}) {
        const nextPreferences = this.mergeReaderPreferences(preferences);
        if (isEqual(nextPreferences, this.preferences)) {
            if (options.persistLocal)
                this.writeStoredReaderPreferences();
            return;
        }

        this.preferences = nextPreferences;
        if (options.persistLocal)
            this.writeStoredReaderPreferences();
    }

    applyStoredReaderPreferences() {
        const preferences = this.readStoredReaderPreferences();
        if (preferences)
            this.applyReaderPreferences(preferences, {persistLocal: true});
    }

    readStoredReaderPreferences() {
        return readerStorage.readPreferences(String(this.currentUserId || '').trim());
    }

    writeStoredReaderPreferences() {
        readerStorage.writePreferences(String(this.currentUserId || '').trim(), this.preferences);
    }

    async setTheme(theme) {
        if (!this.bookUid) {
            this.preferences = Object.assign({}, this.preferences, {theme});
            this.savePreferencesDebounced();
            return;
        }

        const previousSignature = this.layoutSignatureForPreferences(this.activePreferences);
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        const nextSignature = this.layoutSignatureForPreferences(this.getActivePreferencesForTheme(theme, this.preferences));
        //место берём до смены темы: у e-ink свои шрифт и режим чтения
        if (previousSignature !== nextSignature)
            this.capturePendingReflowAnchor(true);
        this.preferences = Object.assign({}, this.preferences, {theme});
        this.savePreferencesDebounced();
        if (previousSignature !== nextSignature) {
            this.reflowReaderLayout();
        } else {
            this.endLayoutRefresh(140);
        }
    }

    changeFontSize(delta) {
        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            fontSize: Math.max(14, Math.min(30, this.activePreferences.fontSize + delta)),
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    setFontFamily(fontFamily) {
        const next = this.normalizeFontFamily(fontFamily);
        if (next === this.selectedFontFamily)
            return;

        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({fontFamily: next});
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    changeContentWidth(delta) {
        this.capturePendingReflowAnchor(true);
        this.updateActivePreferences({
            contentWidth: Math.max(480, Math.min(2200, this.activePreferences.contentWidth + delta)),
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }

    changeLineHeight(delta) {
        this.capturePendingReflowAnchor(true);
        const next = Math.round((this.activePreferences.lineHeight + delta) * 100) / 100;
        this.updateActivePreferences({
            lineHeight: Math.max(1.15, Math.min(2.2, next)),
        });
        this.savePreferencesDebounced();
        this.requestReaderSettingsReflow();
    }
}
