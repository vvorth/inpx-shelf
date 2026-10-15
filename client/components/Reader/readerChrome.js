//Панели вокруг текста (шаблоны - ReaderToolbar.vue, ReaderFooter.vue): заголовок, строка состояния и её тексты,
//индикаторы перестройки, справка, показ и скрытие панелей и настроек, полный экран, кнопка «Назад».
//Своего состояния нет: открытые панели и часы - поля Reader.
import {t, formatDateTime} from '../../share/i18n';

export default class ReaderChrome {
    get readerHeaderTitle() {
        return this.bookUid ? (this.title || this.uiText.readerHomeTitle) : this.uiText.readerHomeTitle;
    }

    get readerHeaderSubtitle() {
        return this.bookUid ? this.authorLine : this.readerHomeSubtitle;
    }

    updateStatusClock() {
        const date = new Date();
        this.statusClockText = formatDateTime(date, {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    get shouldUseStableReaderStatus() {
        return !!(this.stableReaderStatus.ready && (this.layoutRefreshing || this.isPagedBuildPending));
    }

    get displayProgressPercent() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.progressPercent : this.progressPercent;
    }

    get readerProgressLabel() {
        return `${this.uiText.readPrefix} ${this.displayProgressPercent}%`;
    }

    get readerHelpIntro() {
        return (this.isCompactLayout ? this.uiText.helpMobileIntro : this.uiText.helpDesktopIntro);
    }

    get readerHelpItems() {
        if (this.isPagedMode) {
            if (this.isCompactLayout) {
                return [
                    t('reader.tapLeftRightSide'),
                    t('reader.swipingUpDownLeft'),
                    t('reader.tapCenterShowHide'),
                    t('reader.buttonAlwaysOpensHelp'),
                ];
            }

            return [
                t('reader.clickTopBottomLeft'),
                t('reader.mouseWheelAlsoTurns'),
                t('reader.usePageupPagedownSpace'),
                t('reader.clickCenterShowHide'),
            ];
        }

        if (this.isCompactLayout) {
            return [
                t('reader.scrollSwipeReadBook'),
                t('reader.bottomBarGivesQuick'),
                t('reader.buttonOpensHelpAny'),
            ];
        }

        return [
            t('reader.scrollModeBookRead'),
            t('reader.useMouseTouchpadPageup'),
            t('reader.contentsMyPlacesHelp'),
        ];
    }

    get compactStatusBarText() {
        const base = (this.showDisplayPagedPageCounter)
            ? `${this.readerProgressLabel} | ${this.displayCurrentPage}/${this.displayTotalPages}`
            : this.readerProgressLabel;
        if (!this.activePreferences.statusBarRemaining || !this.statusRemainingText)
            return base;

        return `${base} · ${this.statusRemainingText}`;
    }

    get desktopStatusBarText() {
        const parts = [this.compactStatusBarText];
        if (this.currentSectionTitle)
            parts.push(this.currentSectionTitle);

        return parts.join(' · ');
    }

    get statusRemainingText() {
        const total = Math.max(1, Number(this.displayTotalPages || this.totalPages || 1) || 1);
        const current = Math.max(1, Math.min(total, Number(this.displayCurrentPage || this.currentPage || 1) || 1));
        const remaining = Math.max(0, total - current);
        return t('reader.pagesLeft', {n: remaining});
    }

    get statusBarProgressPercent() {
        return Math.max(0, Math.min(100, Number(this.displayProgressPercent || 0) || 0));
    }

    get statusBarSize() {
        return Math.max(10, Math.min(18, Math.round(Number(this.activePreferences.statusBarSize || 12) || 12)));
    }

    get statusBarStyle() {
        const size = this.statusBarSize;
        return {
            '--reader-status-font-size': `${size}px`,
            '--reader-status-padding-y': `${Math.max(3, Math.round(size * 0.38))}px`,
            '--reader-status-padding-x': `${Math.max(9, Math.round(size * 1.16))}px`,
            '--reader-status-progress-height': `${Math.max(3, Math.round(size * 0.32))}px`,
        };
    }

    get statusBarClass() {
        return {
            'reader-status-bar--progress-side': this.activePreferences.statusBarProgressPosition === 'side',
        };
    }

    get compactStatusBarBuildText() {
        const sourceMessage = String(this.loadingMessage || '').trim();
        const isActivePagedBuild = !!(this.bookPreparing || this.isPagedBuildPending);
        const hasMeasuredProgress = isActivePagedBuild && this.pagedBuildProgressPercent > 0;
        let pagesMessage = '';

        if (isActivePagedBuild && sourceMessage)
            pagesMessage = sourceMessage;
        else if (hasMeasuredProgress)
            pagesMessage = `${this.uiText.loadingPagesCompact.replace('...', '')} ${this.pagedBuildProgressPercent}%`;
        else if (this.isCompactChromeBuildPending || this.compactChromeStatusHold)
            pagesMessage = this.uiText.refreshingPagesCompact;
        else
            pagesMessage = this.uiText.loadingPagesCompact;

        return `${this.readerProgressLabel} · ${pagesMessage}`;
    }

    get isPagedBuildPending() {
        return !!(this.isPagedMode && (this.bookPreparing || this.pagedBuildInProgress));
    }

    get showCompactPagedBuildIndicator() {
        return !!(
            this.isCompactLayout
            && (this.isPagedBuildPending || this.isCompactChromeBuildPending || this.compactChromeStatusHold)
        );
    }

    get showDesktopPagedBuildIndicator() {
        return !!(
            !this.isCompactLayout
            && this.showDesktopStatusBar
            && this.isPagedBuildPending
        );
    }

    get showPagedPreparingSheet() {
        return !!(
            this.isPagedMode
            && !this.activePagedPage
            && this.readerHtml
            && (
                !this.pagedPages.length
                || this.bookPreparing
                || this.pagedBuildInProgress
                || this.pagedViewportBuildQueued
                || this.restorePending
                || this.loadingMessage
            )
        );
    }

    get pagedPreparingText() {
        const sourceMessage = String(this.loadingMessage || '').trim();
        if (sourceMessage)
            return sourceMessage;

        if (this.pagedBuildProgressPercent > 0)
            return `${this.uiText.loadingPagesCompact.replace('...', '')} ${this.pagedBuildProgressPercent}%`;

        if (this.restorePending)
            return this.uiText.restoringPage;

        return this.uiText.loadingPagesCompact;
    }

    get isCompactChromeBuildPending() {
        return !!(
            this.layoutRefreshReason === 'compact-chrome'
            || this.compactChromePagedBuildPending
            || this.compactChromeAwaitingCalibration
        );
    }

    get showPagedPageCounter() {
        return !!(this.isPagedMode && !this.isPagedBuildPending && this.totalPages > 1);
    }

    get showDisplayPagedPageCounter() {
        if (this.shouldUseStableReaderStatus)
            return !!this.stableReaderStatus.pageMeta;

        return this.showPagedPageCounter;
    }

    get displayCurrentPage() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.currentPage : this.currentPage;
    }

    get displayTotalPages() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.totalPages : this.totalPages;
    }

    get showLayoutRefreshIndicator() {
        return !!(
            this.layoutRefreshing
            && !this.bookPreparing
            && !(this.isCompactLayout && this.layoutRefreshReason === 'compact-chrome')
            && (!this.pagedBuildInProgress || this.layoutRefreshReason === 'compact-chrome')
        );
    }

    get isCompactChromeLayoutRefresh() {
        return this.layoutRefreshReason === 'compact-chrome';
    }

    get readerPageMeta() {
        if (this.shouldUseStableReaderStatus)
            return this.stableReaderStatus.pageMeta || '';

        return (this.showPagedPageCounter)
            ? `${this.currentPage}/${this.totalPages}`
            : '';
    }

    get readerSectionMeta() {
        if (this.shouldUseStableReaderStatus)
            return this.stableReaderStatus.sectionMeta || '';

        return (this.isCompactLayout ? '' : this.currentSectionTitle);
    }

    get showCompactStatusBar() {
        return !!(this.isCompactLayout && this.activePreferences.showStatusBar);
    }

    get showCompactPagedBuildOverlay() {
        return !!(
            this.showCompactPagedBuildIndicator
            && !this.showCompactStatusBar
            && !this.controlsOpen
        );
    }

    get showDesktopStatusBar() {
        return !this.isCompactLayout && !!this.activePreferences.showStatusBar;
    }

    get defaultMobileSettingsFooterHeight() {
        if (typeof window === 'undefined')
            return 388;

        return Math.round(Math.min(window.innerHeight * 0.46, 388));
    }

    get readerMobileFooterStyle() {
        if (!this.controlsOpen || !this.isCompactLayout)
            return {};

        const height = this.mobileSettingsPanelHeight || this.defaultMobileSettingsFooterHeight;
        return {
            '--reader-mobile-settings-height': `${height}px`,
        };
    }

    get compactChromeHidden() {
        return this.isCompactLayout && this.readerChromeHidden;
    }

    get readerChromeHidden() {
        return !!(this.bookUid && this.chromeHidden);
    }

    //в режиме прокрутки панель лежит поверх текста: в начале книги под ней пустой фон, дальше - текст
    get readerToolbarOverlay() {
        return !!this.bookUid && !this.isPagedMode;
    }

    get showToolbarActions() {
        return this.controlsOpen;
    }

    goBack() {
        if (this.readerNoteReturnPoint) {
            this.returnFromReaderNote();
            return;
        }

        if (window.history.length > 1)
            this.$router.back();
        else
            this.$router.push('/');
    }

    toggleControls() {
        const nextOpen = !this.controlsOpen;
        if (nextOpen && this.isCompactLayout)
            this.readerControlsTab = 'text';
        this.controlsOpen = nextOpen;
        if (this.isCompactLayout)
            this.refreshCompactSettingsViewport();
        if (!nextOpen)
            this.mobileSettingsPanelHeight = 0;
        if (!nextOpen)
            this.applyPendingReaderSettingsReflow();
    }

    refreshCompactSettingsViewport() {
        if (!this.isCompactLayout)
            return;

        const refreshReaderViewport = !this.controlsOpen;
        this.$nextTick(() => {
            requestAnimationFrame(() => {
                this.updateMobileSettingsPanelHeight();
                if (refreshReaderViewport)
                    requestAnimationFrame(() => this.updateScrollerViewport());
            });
        });
    }

    updateMobileSettingsPanelHeight() {
        if (!this.controlsOpen || !this.isCompactLayout || typeof window === 'undefined') {
            this.mobileSettingsPanelHeight = 0;
            return;
        }

        const panel = this.childRef('settingsPanel', 'readerToolbarActions');
        const rect = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
        const fallback = this.defaultMobileSettingsFooterHeight;
        const measured = rect && rect.height
            ? Math.ceil(Math.max(0, window.innerHeight - rect.top))
            : fallback;
        const shouldKeepFullHeight = ['text', 'page'].includes(this.readerControlsTab);
        const nextHeight = Math.max(
            shouldKeepFullHeight ? fallback : 128,
            Math.min(fallback, measured),
        );

        this.mobileSettingsPanelHeight = nextHeight;
    }

    toggleHelpDialog() {
        this.helpDialogOpen = !this.helpDialogOpen;
    }

    async setReaderChromeHidden(hidden = false) {
        const nextHidden = !!hidden;
        if (this.chromeHidden === nextHidden)
            return;

        //размер области чтения не меняется, поэтому страницы не перестраиваются
        this.chromeHidden = nextHidden;
        if (this.chromeHidden) {
            const hadOpenControls = this.controlsOpen;
            this.controlsOpen = false;
            this.contentsDialogOpen = false;
            this.contentsPanelView = 'contents';
            this.helpDialogOpen = false;
            if (hadOpenControls)
                this.applyPendingReaderSettingsReflow();
        }
    }

    async toggleCompactChromeVisibility() {
        await this.setReaderChromeHidden(!this.readerChromeHidden);
    }

    toggleReaderMeta() {
        if (!this.isCompactLayout)
            return;
        this.readerMetaExpanded = !this.readerMetaExpanded;
    }

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (this.$refs.page && this.$refs.page.requestFullscreen) {
                await this.$refs.page.requestFullscreen();
            }
        } catch(e) {
            // ignore browser-specific fullscreen failures
        }
    }
}
