//Геометрия страницы из настроек и размера экрана: ширина колонки и разворота, поля и отступы, высота страницы,
//анимация листания, CSS-переменные тела книги и подпись раскладки: по ней видно, нужна ли новая разбивка.
//Своего состояния нет: всё считается из настроек и размеров области чтения (поля Reader).

export default class ReaderGeometry {
    layoutSignatureForPreferences(prefs = {}) {
        const preferenceValue = (key, fallback) => (prefs[key] != null ? prefs[key] : fallback);
        const verticalPadding = preferenceValue('pageVerticalPadding', 18);
        const horizontalPadding = preferenceValue('pageHorizontalPadding', 18);
        const outerGap = preferenceValue('pageOuterGap', 28);
        const outerInlineGap = this.isCompactLayout ? 6 : 18;
        return [
            prefs.readMode || 'scroll',
            prefs.pagedDirection || 'vertical',
            prefs.fontFamily || 'serif',
            prefs.fontSize || 18,
            prefs.contentWidth || 1040,
            prefs.contentWidthMode || 'viewport',
            prefs.pagedSpreadMode || 'single',
            prefs.dualPageGap || 28,
            preferenceValue('pagePaddingTop', verticalPadding),
            preferenceValue('pagePaddingBottom', verticalPadding),
            preferenceValue('pagePaddingLeft', horizontalPadding),
            preferenceValue('pagePaddingRight', horizontalPadding),
            preferenceValue('pageOuterGapTop', outerGap),
            preferenceValue('pageOuterGapBottom', outerGap),
            preferenceValue('pageOuterGapLeft', outerInlineGap),
            preferenceValue('pageOuterGapRight', outerInlineGap),
            prefs.lineHeight || 1.7,
        ].join('|');
    }

    get dualPageGap() {
        if (this.isCompactLayout)
            return 0;

        const value = Number(this.activePreferences.dualPageGap);
        return Math.max(0, Math.min(240, Math.round(Number.isFinite(value) ? value : 28)));
    }

    get pageVerticalPadding() {
        const fallback = (this.isCompactLayout ? 6 : 18);
        return this.normalizePageSpacingValue(this.activePreferences.pageVerticalPadding, fallback, 160);
    }

    get pageHorizontalPadding() {
        const fallback = (this.isCompactLayout ? 5 : 18);
        return this.normalizePageSpacingValue(this.activePreferences.pageHorizontalPadding, fallback, 200);
    }

    get pageOuterGap() {
        const fallback = (this.isCompactLayout ? 10 : 28);
        return this.normalizePageSpacingValue(this.activePreferences.pageOuterGap, fallback, 160);
    }

    get pagePaddingTop() {
        return this.normalizePageSpacingValue(this.activePreferences.pagePaddingTop, this.pageVerticalPadding, 160);
    }

    get pagePaddingBottom() {
        const fallback = this.isCompactLayout ? Math.max(0, this.pageVerticalPadding + 2) : Math.max(0, this.pageVerticalPadding + 4);
        return this.normalizePageSpacingValue(this.activePreferences.pagePaddingBottom, fallback, 160);
    }

    get pagePaddingLeft() {
        return this.normalizePageSpacingValue(this.activePreferences.pagePaddingLeft, this.pageHorizontalPadding, 200);
    }

    get pagePaddingRight() {
        return this.normalizePageSpacingValue(this.activePreferences.pagePaddingRight, this.pageHorizontalPadding, 200);
    }

    get pagePaddingPreviewClass() {
        const edge = String(this.pagePaddingPreviewEdge || '').trim();
        return edge ? `reader-page-sheet--padding-preview-${edge}` : '';
    }

    get pageOuterGapTop() {
        return this.normalizePageSpacingValue(this.activePreferences.pageOuterGapTop, this.pageOuterGap, 160);
    }

    get pageOuterGapBottom() {
        return this.normalizePageSpacingValue(this.activePreferences.pageOuterGapBottom, this.pageOuterGap, 160);
    }

    get pageOuterGapLeft() {
        const fallback = this.isCompactLayout ? 6 : 18;
        return this.normalizePageSpacingValue(this.activePreferences.pageOuterGapLeft, fallback, 160);
    }

    get pageOuterGapRight() {
        const fallback = this.isCompactLayout ? 6 : 18;
        return this.normalizePageSpacingValue(this.activePreferences.pageOuterGapRight, fallback, 160);
    }

    get configuredReaderShellHorizontalPadding() {
        return Math.max(0, this.pageOuterGapLeft + this.pageOuterGapRight);
    }

    normalizePageSpacingValue(value, fallback = 0, max = 160) {
        const fallbackNumber = Number(fallback);
        const safeFallback = Math.max(0, Math.min(max, Math.round(Number.isFinite(fallbackNumber) ? fallbackNumber : 0)));
        const number = value != null ? Number(value) : safeFallback;
        return Math.max(0, Math.min(max, Math.round(Number.isFinite(number) ? number : safeFallback)));
    }

    get pagedTransitionName() {
        if (this.isHorizontalPaged)
            return (this.pageTurnDirection < 0 ? 'reader-page-slide-x-back' : 'reader-page-slide-x-forward');

        return (this.pageTurnDirection < 0 ? 'reader-page-slide-y-back' : 'reader-page-slide-y-forward');
    }

    get pageAnimationDurationMs() {
        const speed = String(this.activePreferences.pageAnimationSpeed || 'normal');
        if (speed === 'fast')
            return 90;
        if (speed === 'slow')
            return 320;
        return 180;
    }

    get pageAnimationShiftPx() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 0;
        if (animation === 'slide')
            return 34;
        return 0;
    }

    get pageAnimationOpacityStart() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 1;
        if (animation === 'slide')
            return 0;
        return 0.15;
    }

    get pageAnimationScaleStart() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 1;
        if (animation === 'slide')
            return 1;
        return 0.992;
    }

    get compactVisibleScrollerHeight() {
        if (!this.isCompactLayout || typeof window === 'undefined')
            return 0;

        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (!scroller || !window.visualViewport)
            return 0;

        const rect = scroller.getBoundingClientRect();
        const viewportHeight = Number(window.visualViewport.height || 0) || 0;
        if (!viewportHeight)
            return 0;

        return Math.max(0, Math.min(
            rect.height || 0,
            viewportHeight - Math.max(0, rect.top || 0),
        ));
    }

    get readerBodyStyle() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        const pagePaddingX = Math.max(0, this.pagePaddingLeft + this.pagePaddingRight);
        const fallbackHeight = Math.max((this.isCompactLayout ? 120 : 180), scrollerHeight - (this.isCompactLayout ? 16 : 44));
        const pageHeight = Math.max((this.isCompactLayout ? 120 : 180), this.pageMinHeight || fallbackHeight);
        const pageColumnWidth = Math.max(180, this.pageMeasureFrameWidth - pagePaddingX - 2);
        return {
            '--reader-font-size': `${this.activePreferences.fontSize}px`,
            '--reader-font-family': this.readerFontFamilyCss,
            '--reader-line-height': String(this.activePreferences.lineHeight),
            '--reader-content-width': `${this.readerContentFrameWidth}px`,
            '--reader-page-min-height': `${pageHeight}px`,
            '--reader-page-gap': `${this.pageGap}px`,
            '--reader-page-frame-width': `${this.pageFrameWidth}px`,
            '--reader-page-measure-frame-width': `${this.pageMeasureFrameWidth}px`,
            '--reader-page-column-width': `${pageColumnWidth}px`,
            '--reader-page-padding': `${this.pagePaddingTop}px ${this.pagePaddingRight}px ${this.pagePaddingBottom}px ${this.pagePaddingLeft}px`,
            '--reader-page-padding-top': `${this.pagePaddingTop}px`,
            '--reader-page-padding-right': `${this.pagePaddingRight}px`,
            '--reader-page-padding-bottom': `${this.pagePaddingBottom}px`,
            '--reader-page-padding-left': `${this.pagePaddingLeft}px`,
            '--reader-page-media-max-height': `${Math.max(120, pageHeight - (this.isCompactLayout ? 48 : 84))}px`,
            '--reader-page-transition-duration': `${this.pageAnimationDurationMs}ms`,
            '--reader-page-shift-x': `${this.pageAnimationShiftPx}px`,
            '--reader-page-shift-y': `${Math.max(0, Math.round(this.pageAnimationShiftPx * 0.72))}px`,
            '--reader-page-enter-opacity': String(this.pageAnimationOpacityStart),
            '--reader-page-enter-scale': String(this.pageAnimationScaleStart),
        };
    }

    get readerShellStyle() {
        if (!this.isPagedMode)
            return {};

        return {
            '--reader-page-outer-gap-top': `${this.pageOuterGapTop}px`,
            '--reader-page-outer-gap-bottom': `${this.pageOuterGapBottom}px`,
            '--reader-page-outer-gap-left': `${this.pageOuterGapLeft}px`,
            '--reader-page-outer-gap-right': `${this.pageOuterGapRight}px`,
        };
    }

    get pageGap() {
        return (this.isCompactLayout ? 18 : 32);
    }

    get availableReaderFrameWidth() {
        const scrollerWidth = (this.scrollerViewportWidth || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientWidth) || 0));
        const shellInlinePadding = this.isHorizontalPaged ? 0 : this.configuredReaderShellHorizontalPadding;
        return Math.max(280, scrollerWidth - shellInlinePadding);
    }

    get readerContentFrameWidth() {
        const fixedWidth = Math.max(280, Number(this.activePreferences.contentWidth || 1040) || 1040);
        if (this.activePreferences.contentWidthMode === 'viewport')
            return this.availableReaderFrameWidth;

        return Math.max(280, Math.min(fixedWidth, this.availableReaderFrameWidth));
    }

    get pageFrameWidth() {
        if (this.activePreferences.contentWidthMode === 'viewport')
            return this.availableReaderFrameWidth;

        return this.readerContentFrameWidth;
    }

    get pageMeasureFrameWidth() {
        if (!this.isDualPagedSpread)
            return this.pageFrameWidth;

        return Math.max(280, Math.floor((this.pageFrameWidth - this.dualPageGap) / 2));
    }

    get pageMinHeight() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        if (this.isCompactLayout) {
            const visibleScrollerHeight = this.compactVisibleScrollerHeight || 0;
            const availableHeight = (visibleScrollerHeight
                ? Math.min(Math.max(0, scrollerHeight || visibleScrollerHeight), visibleScrollerHeight)
                : scrollerHeight);
            return Math.max(120, availableHeight - this.configuredReaderShellVerticalPadding);
        }
        return Math.max(180, scrollerHeight - this.configuredReaderShellVerticalPadding - 2);
    }

    get configuredReaderShellVerticalPadding() {
        return Math.max(0, this.pageOuterGapTop + this.pageOuterGapBottom);
    }

    get readerScrollTopInset() {
        return (this.readerToolbarOverlay ? this.readerToolbarHeight : 0);
    }

    //позиция элемента в области прокрутки так, чтобы он оказался под панелью, а не за ней
    readerScrollTargetTop(scroller, target) {
        const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        return Math.max(0, offset - 18 - this.readerScrollTopInset);
    }
}
