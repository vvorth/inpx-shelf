<template>
    <div
        ref="page"
        class="reader-page"
        :class="[readerThemeClass, readerBackgroundClass, {'reader-page--immersive': readerChromeHidden}]"
        :style="readerPageStyle"
    >
        <ReaderToolbar ref="readerToolbar" :reader="readerContext">
            <ReaderSettingsPanel ref="settingsPanel" :reader="readerContext" />
        </ReaderToolbar>

        <div v-if="loading" class="reader-loading">
            <q-icon class="la la-spinner icon-rotate text-green-8" size="28px" />
            <div class="q-ml-sm">{{ loadingMessage || uiText.loadingBook }}</div>
        </div>

        <div v-else-if="error" class="reader-error">
            {{ error }}
        </div>

        <ReaderHome v-else-if="!bookUid && !isStandaloneMode" :reader="readerContext" />

        <template v-else>
            <div
                ref="scroller"
                class="reader-scroll"
                :class="{
                    'reader-scroll--paged': activePreferences.readMode === 'paged',
                }"
                @scroll="onScroll"
                @wheel="handleReaderWheel"
                @click="handleReaderTap"
                @click.capture="handleReaderLinkClick"
                @load.capture="handleReaderImageReady"
                @error.capture="handleReaderImageReady"
                @touchstart.passive="handleReaderTouchStart"
                @touchend="handleReaderTouchEnd"
                @touchcancel="handleReaderTouchCancel"
            >
                <div
                    ref="readerShell"
                    class="reader-shell"
                    :class="{
                        'reader-shell--under-toolbar': readerToolbarOverlay,
                        'reader-shell--paged': activePreferences.readMode === 'paged',
                    }"
                    :style="readerShellStyle"
                >
                    <div v-if="coverSrc && !isPagedMode" class="reader-cover-box">
                        <img :src="coverSrc" class="reader-cover" :alt="title" />
                    </div>

                    <div
                        ref="readerBody"
                        class="reader-body"
                        :class="{
                            'reader-body--paged': activePreferences.readMode === 'paged',
                        }"
                        :style="readerBodyStyle"
                    >
                        <template v-if="!isPagedMode">
                            <div v-if="seriesLine" class="reader-series">
                                {{ seriesLine }}
                            </div>
                            <h1 class="reader-heading">
                                {{ title }}
                            </h1>
                            <div v-if="authorLine" class="reader-subheading">
                                {{ authorLine }}
                            </div>

                            <div v-if="hasContents && !isCompactLayout" class="reader-contents-inline">
                                <div class="reader-contents-inline-head">
                                <div class="reader-contents-inline-title">
                                    {{ uiText.contents }}
                                </div>
                                    <button class="reader-contents-toggle" @click="toggleInlineContents">
                                        {{ inlineContentsVisible ? uiText.hide : uiText.show }}
                                    </button>
                                </div>
                                <div v-if="inlineContentsVisible" class="reader-contents-inline-list">
                                    <button
                                        v-for="item in inlineContents"
                                        :key="item.id"
                                        class="reader-contents-chip"
                                        @click="jumpToContent(item.id)"
                                    >
                                        {{ item.title }}
                                    </button>
                                </div>
                            </div>

                            <div class="reader-progress-bar">
                                <div class="reader-progress-bar-fill" :style="{width: `${displayProgressPercent}%`}"></div>
                            </div>

                            <div ref="readerHtml" class="reader-html" v-html="readerHtml"></div>
                        </template>

                        <template v-else>
                            <div class="reader-pages">
                                <div ref="pageStage" class="reader-page-stage">
                                    <article
                                        v-if="showPagedPreparingSheet"
                                        class="reader-page-sheet reader-page-sheet--placeholder"
                                        :class="{'reader-page-sheet--dual': isDualPagedSpread}"
                                    >
                                        <div class="reader-page-placeholder">
                                            <q-icon class="la la-spinner icon-rotate" size="26px" />
                                            <div class="reader-page-placeholder-title">{{ uiText.loadingPagedPage }}</div>
                                            <div class="reader-page-placeholder-text">{{ pagedPreparingText }}</div>
                                        </div>
                                    </article>
                                    <transition :name="pagedTransitionName">
                                        <article
                                            v-if="activePagedPage"
                                            :key="`page-${currentPageIndex}-${activePagedSpread.length}-${activePagedPage.sectionId || 'page'}`"
                                            class="reader-page-sheet reader-page-sheet--live"
                                    :class="[{'reader-page-sheet--dual': isDualPagedSpread}, isDualPagedSpread ? '' : pagePaddingPreviewClass]"
                                            :data-page-index="currentPageIndex"
                                        >
                                            <template v-if="isDualPagedSpread">
                                                <div class="reader-page-spread" :style="{gap: `${dualPageGap}px`}">
                                                    <section
                                                        v-for="spreadPage in activePagedSpread"
                                                        :key="spreadPage.index"
                                                        class="reader-page-column-sheet"
                                                        :class="[{'reader-page-column-sheet--empty': spreadPage.empty}, pagePaddingPreviewClass]"
                                                    >
                                                        <div class="reader-html" v-html="spreadPage.html"></div>
                                                    </section>
                                                </div>
                                            </template>
                                            <div v-else class="reader-html" v-html="activePagedPageRenderedHtml"></div>
                                        </article>
                                    </transition>
                                    <article
                                        ref="pageMeasure"
                                        class="reader-page-sheet reader-page-sheet--measure"
                                        aria-hidden="true"
                                    >
                                        <div class="reader-html"></div>
                                    </article>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>

            <transition name="reader-reflow-fade">
                <div
                    v-if="showLayoutRefreshIndicator"
                    class="reader-reflow-indicator"
                    :class="{'reader-reflow-indicator--compact': isCompactChromeLayoutRefresh}"
                >
                    <div class="reader-reflow-card" :class="{'reader-reflow-card--compact': isCompactChromeLayoutRefresh}">
                        <q-icon class="la la-spinner icon-rotate" size="22px" />
                        <span>{{ uiText.refreshingLayout }}</span>
                    </div>
                </div>
            </transition>

            <transition name="reader-reflow-fade">
                <div v-if="bookPreparing" class="reader-reflow-indicator reader-reflow-indicator--strong">
                    <div class="reader-reflow-card reader-reflow-card--loading">
                        <q-icon class="la la-spinner icon-rotate" size="24px" />
                        <span>{{ loadingMessage || uiText.loadingBook }}</span>
                    </div>
                </div>
            </transition>

            <ReaderDebugPanel
                v-if="readerDebugEnabled"
                :debug="readerDebug"
                :compact="isCompactLayout"
                :paged="isPagedMode"
                :current-page="currentPage"
                :total-pages="totalPages"
                :dynamic-clip="currentDynamicBottomClipCompensation"
                :font-size="activePreferences.fontSize"
                :line-height="activePreferences.lineHeight"
                @adjust="adjustDebugBottomCompensation"
                @reset="resetDebugBottomCompensation"
            />
        </template>

        <ReaderFooter :reader="readerContext" />

        <ReaderDialogs :reader="readerContext" />
    </div>
</template>

<script>
import {markRaw} from 'vue';
import vueComponent from '../vueComponent.js';
import ReaderEnvironment from './readerEnvironment.js';
import ReaderPaginator from './readerPaginator.js';
import ReaderProgressSync from './readerProgressSync.js';
import ReaderSearch from './readerSearch.js';
import ReaderBookmarks from './readerBookmarks.js';
import ReaderSettings from './readerSettings.js';
import ReaderReflow from './readerReflow.js';
import ReaderBottomClip from './readerBottomClip.js';
import ReaderViewport from './readerViewport.js';
import ReaderInput from './readerInput.js';
import ReaderNavigation from './readerNavigation.js';
import ReaderHomeList from './readerHomeList.js';
import ReaderProfile from './readerProfile.js';
import ReaderChrome from './readerChrome.js';
import ReaderGeometry from './readerGeometry.js';
import ReaderDebugPanel from './ReaderDebugPanel.vue';
import ReaderSettingsPanel from './ReaderSettingsPanel.vue';
import ReaderToolbar from './ReaderToolbar.vue';
import ReaderFooter from './ReaderFooter.vue';
import ReaderHome from './ReaderHome.vue';
import ReaderDialogs from './ReaderDialogs.vue';
const fb2ToReaderHtml = require('./fb2ToReaderHtml');
const readerTextAnchors = require('./readerTextAnchors');
import cloneDeep from 'lodash/cloneDeep';
import debounce from 'lodash/debounce';
import {t, tm} from '../../share/i18n';

const {readerPreferencesVersion, readerDefaults, einkReaderDefaults} = require('../../../shared/readerPreferences');

const componentOptions = {
    components: {ReaderDebugPanel, ReaderSettingsPanel, ReaderToolbar, ReaderFooter, ReaderHome, ReaderDialogs},
    watch: {
        readerSourceKey: {
            immediate: true,
            handler() {
                // Читалка ушла с экрана (keep-alive): книгу не меняем, вернётся - продолжит с того же места
                if (this.$route.path !== this.readerRoutePath)
                    return;
                if (this.readerSourceKey === this.loadedReaderSourceKey && !this.readerBookReleased)
                    return;
                // Сохраняем отложенный прогресс прежней книги до смены её состояния
                if (this.saveProgressDebounced)
                    this.saveProgressDebounced.flush();
                this.loadReader();// no await
            },
        },
        currentProfileReaderPreferences: {
            immediate: true,
            handler(newValue) {
                // Фон (data URL до 4 МБ) отправляем на сервер только при изменении
                this.serverBackgroundImage = (newValue ? String(newValue.backgroundImage || '') : null);
                if (newValue) {
                    this.profileReaderPreferencesApplied = true;
                    this.applyReaderPreferences(newValue, {persistLocal: true});
                }
            },
        },
    },
};

//Слои Reader - классы только с методами и геттерами, состояние - поля Reader. Собираем их в один прототип,
//который vueComponent обходит как обычного предка; одно имя в двух слоях - ошибка, а не тихая подмена
function readerLayers(...layers) {
    class ReaderLayers {}
    for (const layer of layers) {
        for (const name of Object.getOwnPropertyNames(layer.prototype)) {
            if (name === 'constructor')
                continue;
            if (Object.prototype.hasOwnProperty.call(ReaderLayers.prototype, name))
                throw new Error(`Reader layers: ${name} is defined twice`);
            Object.defineProperty(ReaderLayers.prototype, name, Object.getOwnPropertyDescriptor(layer.prototype, name));
        }
    }
    return ReaderLayers;
}

class Reader extends readerLayers(ReaderPaginator, ReaderProgressSync, ReaderSearch, ReaderBookmarks, ReaderSettings, ReaderReflow, ReaderBottomClip, ReaderViewport, ReaderInput, ReaderNavigation, ReaderHomeList, ReaderProfile, ReaderChrome, ReaderGeometry) {
    _options = componentOptions;
    _props = {
        standaloneSource: {
            type: Object,
            default: null,
        },
    };

    loading = false;
    loadingMessage = '';
    bookPreparing = false;
    pagedBuildProgressPercent = 0;
    error = '';
    title = '';
    authorLine = '';
    seriesLine = '';
    coverSrc = '';
    coverIntrinsicWidth = 0;
    coverIntrinsicHeight = 0;
    coverIntrinsicLoadId = 0;
    readerHtml = '';
    readerAnnotationHtml = '';
    readerNotesAnchorId = '';
    readerSearchText = '';
    pagedPages = [];
    currentPageIndex = 0;
    controlsOpen = false;
    contentsDialogOpen = false;
    contentsPanelView = 'contents';
    bookmarksDialogOpen = false;
    helpDialogOpen = false;
    searchDialogOpen = false;
    bookmarkComposerOpen = false;
    inlineContentsVisible = false;
    fullscreenActive = false;
    chromeHidden = false;
    readerMetaExpanded = false;
    resizeObserver = null;
    scrollerViewportWidth = 0;
    scrollerViewportHeight = 0;
    contents = [];
    bookmarks = [];
    searchQuery = '';
    searchResults = [];
    currentSearchResultIndex = -1;
    readerHomeLoading = false;
    readerHomeResetting = false;
    readerHomeBooks = [];
    readerHomeCounters = {all: 0, reading: 0, read: 0, hidden: 0};
    readerHomeFilter = 'reading';
    readerHomeSort = 'updatedDesc';
    readerHomeSearch = '';
    currentPlacesTab = 'progress';
    readerControlsTab = 'text';
    currentSectionId = '';
    readerNoteReturnPoint = null;
    pendingReaderAnchorJump = null;
    pendingReflowAnchor = null;
    stableReaderReflowAnchor = null;
    reflowPageStartOverride = null;
    reflowAnchorHighlightTimer = null;
    bookmarkDraft = {
        title: '',
        excerpt: '',
        note: '',
        percent: 0,
        sectionId: '',
    };
    preferences = {
        readerPreferencesVersion,
        theme: 'dark',
        ...readerDefaults,
        regularProfile: {},
        compactProfile: {},
        einkProfile: {...einkReaderDefaults, regularProfile: {}, compactProfile: {}},
    };
    defaultReaderPreferences = cloneDeep(this.preferences);
    progress = {
        percent: 0,
        sectionId: '',
        pageIndex: 0,
        textOffset: -1,
        textSnippet: '',
        updatedAt: '',
    };
    restorePending = false;
    restoreFromSavedProgress = false;
    restoredScrollTop = -1;
    saveProgressDebounced = null;
    savePreferencesDebounced = null;
    progressSavePromise = null;
    pendingReaderProgressUpload = false;
    readerProgressGeneration = 0;
    readerLoadJobId = 0;
    readerHomeJobId = 0;
    readerBackgroundMaxBytes = 4 * 1024 * 1024;
    statusClockText = '';
    profileReaderPreferencesApplied = false;
    pageTurnTimer = null;
    scrollFrame = 0;
    pageTurnAnimating = false;
    pageTurnDirection = 1;
    pagePaddingPreviewEdge = '';
    pagePaddingPreviewTimer = null;
    mobileSpacingControl = 'pageBottom';
    mobileSettingsPanelHeight = 0;
    touchStartPoint = null;
    suppressSyntheticReaderClickUntil = 0;
    imageLayoutFrame = 0;
    pagedViewportFrame = 0;
    pagedViewportBuildQueued = false;
    viewportRefreshFrame = 0;
    viewportResumeTimer = null;
    viewportResumePending = false;
    viewportResumeNeedsCalibration = false;
    viewportResumeGuardUntil = 0;
    pagedBuildInProgress = false;
    pagedBuildNeedsRefresh = false;
    pagedBuildOwnerJobId = 0;
    pagedBuildSignature = '';
    pagedBuildGeometrySignature = '';
    pagedBuildStage = 'idle';
    progressPersistPendingAfterPagedBuild = false;
    pagedBuildJobId = 0;
    pagedLayoutSignature = '';
    pagedLayoutCacheLimit = 2;
    restoreProgressFrame = 0;
    compactChromePagedBuildPending = false;
    compactChromeAwaitingCalibration = false;
    compactChromeInitialTotalPages = 0;
    compactChromeBuildSettleTimer = null;
    compactChromeBuildLastActivityAt = 0;
    compactChromeStatusHold = false;
    compactChromeViewportRefreshSuppressedUntil = 0;
    readerToolbarHeight = 0;
    toolbarResizeObserver = null;
    serverBackgroundImage = null;
    profileWarningNotifiedKey = '';
    fontFamilyOptions = [
        {label: 'Serif', value: 'serif'},
        {label: 'Sans', value: 'sans'},
        {label: 'Mono', value: 'mono'},
        {label: 'System', value: 'system'},
    ];
    compactChromeStatusHoldTimer = null;
    compactChromeStatusHoldUntil = 0;
    layoutRefreshing = false;
    layoutRefreshTimer = null;
    spacingReflowTimer = null;
    readerSettingsReflowPending = false;
    layoutRefreshStartedAt = 0;
    layoutRefreshReason = '';
    stableReaderStatus = {
        ready: false,
        progressPercent: 0,
        currentPage: 1,
        totalPages: 1,
        pageMeta: '',
        sectionMeta: '',
    };
    bottomCalibrationFrame = 0;
    bottomCalibrationTimer = null;
    bottomClipCalibrationPending = true;
    dynamicBottomClipCompensationCompact = 0;
    dynamicBottomClipCompensationRegular = 0;
    bottomClipCompensationGeometryKey = '';
    bottomClipCompensationPendingKey = '';
    bottomClipCalibrationSampleKey = '';
    bottomClipCalibrationSampleCount = 0;
    bottomClipCalibrationSampleOverflow = 0;
    bottomClipCalibrationSampleGeneration = 0;
    bottomClipGeometryChangedAt = 0;
    bottomClipViewportActivityAt = 0;
    bottomClipPageActivityAt = 0;
    pagedCommittedCalibrationKey = '';
    pagedCommittedCalibrationAt = 0;
    pagedCommittedCalibrationGeneration = 0;
    readerDebug = {
        measureAvailableHeight: 0,
        measureContentHeight: 0,
        measureOverflowPx: 0,
        liveSheetHeight: 0,
        liveSafeBottom: 0,
        liveTextBottom: 0,
        liveOverflowPx: 0,
        baseBottomClipCompensation: 0,
        totalBottomClipCompensation: 0,
        pagedContentSafetyInset: 0,
        paginationStats: null,
    };

    //Поля класса vueComponent делает глубоко реактивными: кэши разбивки, замеры, canvas и служебное состояние
    //живут вне data. Заводятся до created: immediate-watch readerSourceKey вызывает loadReader раньше него
    beforeCreate() {
        this.pagedLayoutCache = new Map();
        this.bottomClipCompensationByGeometry = new Map();
        this.bottomClipCalibrationAttemptsByGeometry = new Map();
        this.pagedTextMeasureCanvas = null;
        this.pagedTextMeasureContext = null;
        this.pagedMeasureAvailableHeight = 0;
        this.pagedAppliedBottomClipCompensation = 0;
        // Предложение перейти к позиции с другого устройства: что предложено и как закрыть уведомление
        this.offeredRemoteProgress = null;
        this.dismissRemoteProgressNotify = null;
        // Книга закрытой читалки (keep-alive): какая загружена, освобождена ли и таймер освобождения
        this.readerRoutePath = this.$route.path;
        this.loadedReaderSourceKey = '';
        this.readerBookReleased = false;
        this.releaseBookTimer = null;
        // Прокрутка ленты: при уходе разметка уже вынута из документа и scrollTop не прочитать
        this.lastScrollTop = 0;
    }

    created() {
        if (!this.profileReaderPreferencesApplied)
            this.applyStoredReaderPreferences();

        this.handleBeforeUnload = () => {
            this.flushProgress();
        };
        this.handleFullscreenChange = () => {
            this.fullscreenActive = !!document.fullscreenElement;
            this.beginLayoutRefresh();
            this.requestBottomClipCalibration();
            this.runAfterLayoutRefreshPaint(() => {
                this.updateScrollerViewport();
                requestAnimationFrame(() => {
                    this.restoreProgress();
                    this.endLayoutRefresh(260);
                });
            });
        };
        this.handleWindowResize = () => {
            this.scheduleViewportRefresh();
        };
        this.handleVisualViewportResize = () => {
            this.scheduleViewportRefresh();
        };
        this.handleReaderKeydown = (event) => {
            this.handleGlobalKeydown(event);
        };
        this.handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this.flushProgress();
                this.suspendViewportRefreshForVisibility();
                return;
            }
            if (document.visibilityState === 'visible') {
                this.resumeViewportRefreshAfterVisibility();
                this.checkRemoteProgress();// no await
                if (this.environment.wakeLockRequested)
                    this.environment.requestWakeLock();// no await
            }
        };
        this.handlePageHide = () => {
            this.flushProgress();
        };
        this.environment = new ReaderEnvironment({
            handlers: {
                beforeunload: this.handleBeforeUnload,
                fullscreenchange: this.handleFullscreenChange,
                resize: this.handleWindowResize,
                keydown: this.handleReaderKeydown,
                visibilitychange: this.handleVisibilityChange,
                pagehide: this.handlePageHide,
                viewportResize: this.handleVisualViewportResize,
            },
            onClockTick: () => this.updateStatusClock(),
        });

        // uid книги фиксируется при вызове: отложенное сохранение не должно попасть в другую книгу
        this.saveProgressDebounced = debounce((bookUid) => {
            this.queuePersistProgress(bookUid);// no await
        }, 800);

        this.savePreferencesDebounced = debounce(() => {
            this.persistPreferences();// no await
        }, 500);
    }

    mounted() {
        this.environment.attach();
        this.handleFullscreenChange();
        this.$nextTick(() => {
            this.attachScrollerObserver();
            this.updateScrollerViewport();
        });
    }

    activated() {
        clearTimeout(this.releaseBookTimer);
        this.releaseBookTimer = null;
        // При первом монтировании activated тоже вызывается: окружение уже подключено
        if (this.environment.attached)
            return;
        this.environment.attach();
        this.$nextTick(() => this.attachScrollerObserver());
        if (this.readerBookReleased || this.readerSourceKey !== this.loadedReaderSourceKey) {
            this.loadReader();// no await
            return;
        }

        // Вставленная обратно разметка ленты начинается с начала: возвращаем прокрутку, это не чтение
        const scroller = this.$refs.scroller;
        if (scroller) {
            scroller.scrollTop = this.lastScrollTop;
            this.restoredScrollTop = scroller.scrollTop;
        }
        this.checkRemoteProgress();// no await
    }

    deactivated() {
        // Быстрый возврат в читалку - мгновенный, а надолго закрытая не держит книгу в памяти
        clearTimeout(this.releaseBookTimer);
        this.releaseBookTimer = setTimeout(() => this.releaseReaderBook(), 30000);
        this.dismissRemoteProgressOffer();
        this.environment.detach();
        this.detachScrollerObserver();
        this.flushProgress();
        this.clearSpacingReflowTimer();
        clearTimeout(this.pageTurnTimer);
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    beforeUnmount() {
        clearTimeout(this.releaseBookTimer);
        this.dismissRemoteProgressOffer();
        this.environment.detach();
        this.detachScrollerObserver();
        this.clearSpacingReflowTimer();
        this.clearReaderReflowAnchorHighlight();
        if (this.pagePaddingPreviewTimer) {
            clearTimeout(this.pagePaddingPreviewTimer);
            this.pagePaddingPreviewTimer = null;
        }
        clearTimeout(this.pageTurnTimer);
        if (this.scrollFrame) {
            cancelAnimationFrame(this.scrollFrame);
            this.scrollFrame = 0;
        }
        if (this.imageLayoutFrame) {
            cancelAnimationFrame(this.imageLayoutFrame);
            this.imageLayoutFrame = 0;
        }
        if (this.pagedViewportFrame) {
            cancelAnimationFrame(this.pagedViewportFrame);
            this.pagedViewportFrame = 0;
        }
        this.pagedViewportBuildQueued = false;
        this.pagedLayoutCache.clear();
        if (this.viewportRefreshFrame) {
            cancelAnimationFrame(this.viewportRefreshFrame);
            this.viewportRefreshFrame = 0;
        }
        if (this.viewportResumeTimer) {
            clearTimeout(this.viewportResumeTimer);
            this.viewportResumeTimer = null;
        }
        this.viewportResumePending = false;
        this.viewportResumeNeedsCalibration = false;
        this.viewportResumeGuardUntil = 0;
        if (this.bottomCalibrationFrame) {
            cancelAnimationFrame(this.bottomCalibrationFrame);
            this.bottomCalibrationFrame = 0;
        }
        if (this.bottomCalibrationTimer) {
            clearTimeout(this.bottomCalibrationTimer);
            this.bottomCalibrationTimer = null;
        }
        if (this.layoutRefreshTimer) {
            clearTimeout(this.layoutRefreshTimer);
            this.layoutRefreshTimer = null;
        }
        if (this.compactChromeStatusHoldTimer) {
            clearTimeout(this.compactChromeStatusHoldTimer);
            this.compactChromeStatusHoldTimer = null;
        }
        this.flushProgress();
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    get bookUid() {
        return String(this.$route.query.bookUid || this.$route.params.bookUid || '').trim();
    }

    get isStandaloneMode() {
        return !!(this.standaloneSource && String(this.standaloneSource.fb2 || '').trim());
    }

    get config() {
        return this.$store.state.config || {};
    }

    get settings() {
        return this.$store.state.settings || {};
    }

    get readerSourceKey() {
        if (this.isStandaloneMode) {
            const source = (this.standaloneSource || {});
            return `standalone:${String(source.sourceKey || source.fileName || source.title || source.fb2 || '').slice(0, 256)}`;
        }

        return this.bookUid ? `book:${this.bookUid}` : `reader-home:${this.currentUserId}:${this.config.profileAuthorized ? 'auth' : 'guest'}`;
    }

    get readerDebugEnabled() {
        return ['1', 'true', 'yes', 'on'].includes(String(this.$route.query.debugReader || '').trim().toLowerCase());
    }

    //в полноэкранном режиме окно q-dialog уходит в body, вне полноэкранного элемента: там панели - обычные блоки
    get readerPanelTag() {
        return (this.fullscreenActive ? 'div' : 'q-dialog');
    }

    get readerPanelClass() {
        return [(this.fullscreenActive ? 'reader-overlay-panel' : 'reader-dialog reader-dialog--contents'), 'std-dialog-card--reader', this.readerThemeClass];
    }

    readerPanelBinding(flag) {
        if (this.fullscreenActive)
            return {};
        return {modelValue: this[flag], position: 'right', 'onUpdate:modelValue': value => { this[flag] = value; }};
    }

    get readerThemeClass() {
        return `reader-theme-${this.preferences.theme || 'dark'}`;
    }

    get readerBackgroundClass() {
        const hasBackground = !!String(this.preferences.backgroundImage || '').trim();
        return {
            'reader-page--background-image': hasBackground,
            'reader-page--transparent-pages': hasBackground && !!this.activePreferences.backgroundTransparentPages,
            'reader-page--transparent-status': hasBackground && !!this.activePreferences.backgroundTransparentStatus,
            'reader-page--text-shadow': !!this.activePreferences.textShadow,
        };
    }

    get readerFontFamilyCss() {
        switch (this.selectedFontFamily) {
            case 'sans':
                return 'Inter, Arial, Helvetica, sans-serif';
            case 'mono':
                return '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
            case 'system':
                return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
            case 'serif':
            default:
                return 'Georgia, "Times New Roman", Times, serif';
        }
    }

    get readerThemeStyle() {
        const backgroundStyle = this.readerBackgroundStyle;
        if (this.preferences.theme !== 'eink')
            return backgroundStyle;

        const contrast = Math.max(72, Math.min(100, Number(this.activePreferences.einkContrast || 92) || 92));
        const paperTone = Math.max(84, Math.min(99, Number(this.activePreferences.einkPaperTone || 94) || 94));
        const inkTone = Math.max(4, Math.min(26, Number(this.activePreferences.einkInkTone || 10) || 10));
        const accentSoftAlpha = Math.max(0.03, Math.min(0.16, (100 - contrast) / 240));
        const borderAlpha = Math.max(0.1, Math.min(0.28, (contrast - 60) / 160));
        const mutedTone = Math.max(28, Math.min(48, inkTone + 24));

        return Object.assign({}, {
            '--reader-eink-bg': `hsl(48 18% ${Math.max(80, paperTone - 4)}%)`,
            '--reader-eink-surface': `hsl(48 20% ${paperTone}%)`,
            '--reader-eink-surface-2': `hsl(48 16% ${Math.max(82, paperTone - 5)}%)`,
            '--reader-eink-text': `hsl(40 10% ${inkTone}%)`,
            '--reader-eink-muted': `hsl(40 8% ${mutedTone}%)`,
            '--reader-eink-border': `rgba(20, 20, 20, ${borderAlpha.toFixed(3)})`,
            '--reader-eink-accent-soft': `rgba(20, 20, 20, ${accentSoftAlpha.toFixed(3)})`,
        }, backgroundStyle);
    }

    get readerBackgroundStyle() {
        const image = String(this.preferences.backgroundImage || '').trim();
        if (!image)
            return {};

        const theme = String(this.preferences.theme || 'dark');
        const overlay = (theme === 'dark')
            ? 'rgba(18, 23, 21, 0.58)'
            : 'rgba(248, 241, 229, 0.46)';

        return {
            '--reader-background-image': `url(${JSON.stringify(image)})`,
            '--reader-background-overlay': overlay,
        };
    }

    //диалоги рисуются вне .reader-page: им тоже нужны соответствия --app-* для общих классов (.tabs)
    get readerDialogStyle() {
        return Object.assign({
            '--app-text': 'var(--reader-text)',
            '--app-muted': 'var(--reader-muted)',
            '--app-border': 'var(--reader-border)',
            '--app-primary': 'var(--reader-accent)',
        }, this.readerDialogThemeStyle);
    }

    get readerDialogThemeStyle() {
        if (this.preferences.theme === 'eink') {
            const themeStyle = this.readerThemeStyle;
            return Object.assign({}, themeStyle, {
                '--reader-bg': themeStyle['--reader-eink-bg'],
                '--reader-surface': themeStyle['--reader-eink-surface'],
                '--reader-surface-2': themeStyle['--reader-eink-surface-2'],
                '--reader-text': themeStyle['--reader-eink-text'],
                '--reader-muted': themeStyle['--reader-eink-muted'],
                '--reader-border': themeStyle['--reader-eink-border'],
                '--reader-accent': themeStyle['--reader-eink-text'],
                '--reader-accent-soft': themeStyle['--reader-eink-accent-soft'],
            });
        }

        const theme = String(this.preferences.theme || 'dark');
        if (theme === 'sepia') {
            return {
                '--reader-bg': '#f4ecdd',
                '--reader-surface': '#fbf6ec',
                '--reader-surface-2': '#efe4d2',
                '--reader-text': '#402f20',
                '--reader-muted': '#7c6855',
                '--reader-border': 'rgba(64, 47, 32, 0.16)',
                '--reader-accent': '#b76a2c',
                '--reader-accent-soft': 'rgba(183, 106, 44, 0.12)',
            };
        }

        if (theme === 'light') {
            return {
                '--reader-bg': '#f4f6f5',
                '--reader-surface': '#ffffff',
                '--reader-surface-2': '#eef3f1',
                '--reader-text': '#18201d',
                '--reader-muted': '#5c6863',
                '--reader-border': '#d6dcd9',
                '--reader-accent': '#1f5c50',
                '--reader-accent-soft': '#dcebe6',
            };
        }

        return {
            '--reader-bg': '#121715',
            '--reader-surface': '#1a201e',
            '--reader-surface-2': '#222a27',
            '--reader-text': '#e6ece9',
            '--reader-muted': '#98a59f',
            '--reader-border': '#313b37',
            '--reader-accent': '#6fbfa9',
            '--reader-accent-soft': '#1f3a33',
        };
    }

    get readerDialogSurfaceStyle() {
        return Object.assign({}, this.readerDialogStyle, {
            background: 'var(--reader-surface)',
            color: 'var(--reader-text)',
        });
    }

    get readerAnnotationStyle() {
        return {
            fontFamily: this.readerFontFamilyCss,
            fontSize: `${this.activePreferences.fontSize}px`,
            lineHeight: String(this.activePreferences.lineHeight),
        };
    }

    get readerNotifyOptions() {
        return {
            color: 'white',
            icon: 'la la-bookmark',
            iconColor: 'var(--reader-text)',
            messageColor: 'var(--reader-text)',
            captionColor: 'var(--reader-text)',
            position: (this.isCompactLayout ? 'bottom' : 'top-right'),
            textColor: 'black',
            style: `
                background: var(--reader-surface);
                color: var(--reader-text);
                border: 1px solid var(--reader-border);
                border-radius: 6px;
                box-shadow: 0 18px 42px rgba(0, 0, 0, 0.18);
            `,
        };
    }

    get uiText() {
        return {
            back: t('reader.back'),
            myPlaces: t('reader.myPlaces'),
            continueReading: t('reader.continueReading'),
            bookmarks: t('reader.bookmarks'),
            notes: t('reader.notes'),
            readerHelp: t('reader.readerHelp'),
            searchTitle: t('reader.searchTitle'),
            searchPlaceholder: t('reader.searchPlaceholder'),
            searchPrev: t('reader.searchPrev'),
            searchNext: t('reader.searchNext'),
            searchEmpty: t('reader.searchEmpty'),
            searchHint: t('reader.searchHint'),
            helpMobileIntro: t('reader.helpMobileIntro'),
            helpDesktopIntro: t('reader.helpDesktopIntro'),
            bookmark: t('reader.bookmark'),
            readShort: t('reader.readShort'),
            unreadShort: t('reader.unreadShort'),
            noBookmarks: t('reader.noBookmarks'),
            noNotes: t('reader.noNotes'),
            newPlace: t('reader.newPlace'),
            noteLabel: t('reader.noteLabel'),
            simpleBookmark: t('reader.simpleBookmark'),
            saveAsNote: t('reader.saveAsNote'),
            readPrefix: t('reader.readPrefix'),
            bookmarkAdded: t('reader.bookmarkAdded'),
            noteSaved: t('reader.noteSaved'),
            readMarked: t('reader.readMarked'),
            readUnmarked: t('reader.readUnmarked'),
            undo: t('reader.undo'),
            bookmarkTitle: t('reader.bookmarkTitle'),
            error: t('reader.error'),
            profileLoginRequired: t('reader.profileLoginRequired'),
            profileNotSelected: t('reader.profileNotSelected'),
            profileLoginReaderHint: t('reader.profileLoginReaderHint'),
            profileSelectReaderHint: t('reader.profileSelectReaderHint'),
            profileLoginAction: t('reader.profileLoginAction'),
            profile: t('reader.profile'),
            profileNeedsLoginShort: t('reader.profileNeedsLoginShort'),
            profileLoggedInShort: t('reader.profileLoggedInShort'),
            profileOpenShort: t('reader.profileOpenShort'),
            refresh: t('reader.refresh'),
            readerHomeTitle: t('reader.readerHomeTitle'),
            readerHomeEmptyTitle: t('reader.readerHomeEmptyTitle'),
            readerHomeEmptyText: t('reader.readerHomeEmptyText'),
            readerHomeSearchPlaceholder: t('reader.readerHomeSearchPlaceholder'),
            readerHomeSearchEmptyText: t('reader.readerHomeSearchEmptyText'),
            readerHomeUnavailableText: t('reader.readerHomeUnavailableText'),
            readerHomeReadEmptyText: t('reader.readerHomeReadEmptyText'),
            readerHomeHiddenEmptyText: t('reader.readerHomeHiddenEmptyText'),
            readerHomeFilterReading: t('reader.readerHomeFilterReading'),
            readerHomeFilterRead: t('reader.readerHomeFilterRead'),
            readerHomeFilterHidden: t('reader.readerHomeFilterHidden'),
            readerHomeFilterAll: t('reader.readerHomeFilterAll'),
            readerHomeSortUpdatedDesc: t('reader.readerHomeSortUpdatedDesc'),
            readerHomeSortUpdatedAsc: t('reader.readerHomeSortUpdatedAsc'),
            readerHomeSortTitle: t('reader.readerHomeSortTitle'),
            readerHomeSortAuthor: t('reader.readerHomeSortAuthor'),
            readerHomeSortProgressDesc: t('reader.readerHomeSortProgressDesc'),
            readerHomeSortProgressAsc: t('reader.readerHomeSortProgressAsc'),
            resetReaderProgress: t('reader.resetReaderProgress'),
            resetReaderProgressAction: t('reader.resetReaderProgressAction'),
            resetReaderProgressConfirm: t('reader.resetReaderProgressConfirm'),
            resetReaderProgressSuccess: t('reader.resetReaderProgressSuccess'),
            openBook: t('reader.openBook'),
            restoreToReading: t('reader.restoreToReading'),
            forgetBook: t('reader.forgetBook'),
            forgetAllHidden: t('reader.forgetAllHidden'),
            restoreReadingSuccess: t('reader.restoreReadingSuccess'),
            removeFromReading: t('reader.removeFromReading'),
            removeReadingConfirm: t('reader.removeReadingConfirm'),
            removeReadingSuccess: t('reader.removeReadingSuccess'),
            untitledBook: t('reader.untitledBook'),
            series: t('reader.series'),
            themeDark: t('reader.themeDark'),
            themeSepia: t('reader.themeSepia'),
            themeLight: t('reader.themeLight'),
            themeEink: 'eink',
            readModeScroll: t('reader.readModeScroll'),
            readModePages: t('reader.readModePages'),
            widthFixed: t('reader.widthFixed'),
            widthViewport: t('reader.widthViewport'),
            textShadowOn: t('reader.textShadowOn'),
            textShadowOff: t('reader.textShadowOff'),
            spreadSingle: t('reader.spreadSingle'),
            spreadDual: t('reader.spreadDual'),
            pageGap: t('reader.pageGap'),
            pageVerticalPadding: t('reader.pageVerticalPadding'),
            pageHorizontalPadding: t('reader.pageHorizontalPadding'),
            pageOuterGap: t('reader.pageOuterGap'),
            pagePaddingTop: t('reader.pagePaddingTop'),
            pagePaddingBottom: t('reader.pagePaddingBottom'),
            pagePaddingLeft: t('reader.pagePaddingLeft'),
            pagePaddingRight: t('reader.pagePaddingRight'),
            pageOuterGapTop: t('reader.pageOuterGapTop'),
            pageOuterGapBottom: t('reader.pageOuterGapBottom'),
            pageOuterGapLeft: t('reader.pageOuterGapLeft'),
            pageOuterGapRight: t('reader.pageOuterGapRight'),
            controlsText: t('reader.controlsText'),
            controlsPage: t('reader.controlsPage'),
            controlsBackground: t('reader.controlsBackground'),
            controlsStatus: t('reader.controlsStatus'),
            controlsReset: t('reader.controlsReset'),
            controlsView: t('reader.controlsView'),
            controlsTheme: t('reader.controlsTheme'),
            controlsFont: t('reader.controlsFont'),
            controlsTypography: t('reader.controlsTypography'),
            controlsFontSize: t('reader.controlsFontSize'),
            controlsLineHeight: t('reader.controlsLineHeight'),
            controlsTextShadow: t('reader.controlsTextShadow'),
            controlsWidth: t('reader.controlsWidth'),
            controlsTextWidth: t('reader.controlsTextWidth'),
            controlsTextWidthMode: t('reader.controlsTextWidthMode'),
            controlsInk: 'E-ink',
            controlsMode: t('reader.controlsMode'),
            controlsReadMode: t('reader.controlsReadMode'),
            controlsPageFlow: t('reader.controlsPageFlow'),
            controlsSpread: t('reader.controlsSpread'),
            controlsSpacing: t('reader.controlsSpacing'),
            controlsAnimation: t('reader.controlsAnimation'),
            controlsAnimationType: t('reader.controlsAnimationType'),
            controlsAnimationSpeed: t('reader.controlsAnimationSpeed'),
            controlsBackgroundImage: t('reader.controlsBackgroundImage'),
            controlsBackgroundLayers: t('reader.controlsBackgroundLayers'),
            controlsPages: t('reader.controlsPages'),
            controlsStatusBar: t('reader.controlsStatusBar'),
            controlsStatusField: t('reader.controlsStatusField'),
            controlsStatusVisibility: t('reader.controlsStatusVisibility'),
            controlsStatusPosition: t('reader.controlsStatusPosition'),
            controlsStatusContent: t('reader.controlsStatusContent'),
            controlsClock: t('reader.controlsClock'),
            controlsProgressBar: t('reader.controlsProgressBar'),
            controlsProgressPosition: t('reader.controlsProgressPosition'),
            controlsRemaining: t('reader.controlsRemaining'),
            noteReturn: t('reader.noteReturn'),
            directionVertical: t('reader.directionVertical'),
            directionHorizontal: t('reader.directionHorizontal'),
            animationNone: t('reader.animationNone'),
            animationSoft: t('reader.animationSoft'),
            animationSlide: t('reader.animationSlide'),
            speedFast: t('reader.speedFast'),
            speedNormal: t('reader.speedNormal'),
            speedSlow: t('reader.speedSlow'),
            statusBarOn: t('reader.statusBarOn'),
            statusBarOff: t('reader.statusBarOff'),
            statusClockOn: t('reader.statusClockOn'),
            statusClockOff: t('reader.statusClockOff'),
            statusProgressOn: t('reader.statusProgressOn'),
            statusProgressOff: t('reader.statusProgressOff'),
            statusProgressBottom: t('reader.statusProgressBottom'),
            statusProgressSide: t('reader.statusProgressSide'),
            statusRemainingOn: t('reader.statusRemainingOn'),
            statusRemainingOff: t('reader.statusRemainingOff'),
            statusAlignCenter: t('reader.statusAlignCenter'),
            statusAlignEdge: t('reader.statusAlignEdge'),
            statusSize: t('reader.statusSize'),
            backgroundUpload: t('reader.backgroundUpload'),
            backgroundClear: t('reader.backgroundClear'),
            backgroundPagesSolid: t('reader.backgroundPagesSolid'),
            backgroundPagesTransparent: t('reader.backgroundPagesTransparent'),
            backgroundStatusSolid: t('reader.backgroundStatusSolid'),
            backgroundStatusTransparent: t('reader.backgroundStatusTransparent'),
            resetReaderAppearance: t('reader.resetReaderAppearance'),
            resetReaderAppearanceHint: t('reader.resetReaderAppearanceHint'),
            resetReaderAppearanceConfirm: t('reader.resetReaderAppearanceConfirm'),
            resetReaderAppearanceSuccess: t('reader.resetReaderAppearanceSuccess'),
            backgroundTooLarge: t('reader.backgroundTooLarge'),
            backgroundInvalid: t('reader.backgroundInvalid'),
            einkContrast: t('reader.einkContrast'),
            einkPaper: t('reader.einkPaper'),
            einkInk: t('reader.einkInk'),
            loadingBook: t('reader.loadingBook'),
            loadingFetch: t('reader.loadingFetch'),
            loadingParse: t('reader.loadingParse'),
            loadingPages: t('reader.loadingPages'),
            loadingPagesCompact: t('reader.loadingPagesCompact'),
            loadingPagesCompacting: t('reader.loadingPagesCompacting'),
            loadingPagesFinalizing: t('reader.loadingPagesFinalizing'),
            loadingPagedPage: t('reader.loadingPagedPage'),
            restoringPage: t('reader.restoringPage'),
            refreshingPagesCompact: t('reader.refreshingPagesCompact'),
            contents: t('reader.contents'),
            annotation: t('reader.annotation'),
            bookNotes: t('reader.bookNotes'),
            backToContents: t('reader.backToContents'),
            show: t('reader.show'),
            hide: t('reader.hide'),
            settings: t('reader.settings'),
            screen: t('reader.screen'),
            rebuildPages: t('reader.rebuildPages'),
            refreshingLayout: t('reader.refreshingLayout'),
        };
    }

    get isPagedMode() {
        return this.activePreferences.readMode === 'paged';
    }

    get isHorizontalPaged() {
        return this.isPagedMode && this.activePreferences.pagedDirection === 'horizontal';
    }

    get isVerticalPaged() {
        return this.isPagedMode && !this.isHorizontalPaged;
    }

    get totalPages() {
        const scroller = this.$refs ? this.$refs.scroller : null;
        if (this.isPagedMode)
            return Math.max(1, Math.ceil(this.pagedPages.length / this.pagedStep));

        if (!scroller || !(this.scrollerViewportHeight || scroller.clientHeight))
            return 1;

        return Math.max(1, Math.ceil(scroller.scrollHeight / scroller.clientHeight));
    }

    get currentPage() {
        if (this.isPagedMode)
            return Math.min(this.totalPages, Math.max(1, Math.floor(this.currentPagedPageIndex / this.pagedStep) + 1));

        const scroller = this.$refs ? this.$refs.scroller : null;
        if (!scroller || !(this.scrollerViewportHeight || scroller.clientHeight))
            return 1;

        return Math.min(this.totalPages, Math.max(1, Math.floor(scroller.scrollTop / scroller.clientHeight) + 1));
    }

    get isCompactLayout() {
        return !!(this.$q && this.$q.screen && this.$q.screen.lt && this.$q.screen.lt.md);
    }

    //части шаблона вынесены в дочерние компоненты (ReaderSettingsPanel и др.): им передаётся сам Reader
    get readerContext() {
        return this;
    }

    childRef(child, name) {
        const component = this.$refs && this.$refs[child];
        return (component && component.$refs) ? component.$refs[name] : null;
    }

    get readerPageStyle() {
        return Object.assign({'--reader-toolbar-height': `${this.readerToolbarHeight}px`}, this.readerThemeStyle);
    }

    getReaderDocumentSearchText() {
        if (this.readerSearchText)
            return this.readerSearchText;

        this.readerSearchText = readerTextAnchors.normalizeReaderSearchText(readerTextAnchors.stripHtml(this.readerHtml || '')).toLowerCase();
        return this.readerSearchText;
    }

    decodeReaderText(value = '') {
        return fb2ToReaderHtml.decodeReaderText(value);
    }

    escapeHtml(value = '') {
        return fb2ToReaderHtml.escapeHtml(value);
    }

    escapeCssId(id = '') {
        const value = String(id || '');
        if (typeof(CSS) !== 'undefined' && CSS.escape)
            return CSS.escape(value);
        return value.replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
    }

    async applyReaderDocumentSource({
        book = {},
        fb2 = '',
        cover = '',
        stateResponse = {},
    } = {}) {
        const parser = fb2ToReaderHtml.createFb2Parser(fb2);
        const fb2Info = parser.bookInfo();
        const authorFallback = ((fb2Info.titleInfo && fb2Info.titleInfo.author) ? fb2Info.titleInfo.author.join(', ') : '');

        this.title = this.decodeReaderText(book.title || (fb2Info.titleInfo && fb2Info.titleInfo.bookTitle) || t('common.untitled'));
        this.authorLine = this.decodeReaderText(book.author || authorFallback);
        this.seriesLine = this.decodeReaderText(book.series ? `${book.series}${book.serno ? ` #${book.serno}` : ''}` : '');
        if (stateResponse && stateResponse.preferences)
            this.applyReaderPreferences(stateResponse.preferences || {}, {persistLocal: true});
        this.coverSrc = cover || '';
        const coverSizePromise = this.loadCoverIntrinsicSize(this.coverSrc);
        if (this.isPagedMode)
            await coverSizePromise;
        this.readerAnnotationHtml = fb2ToReaderHtml.buildReaderAnnotationHtml(
            parser,
            (fb2Info.titleInfo && fb2Info.titleInfo.annotation) || []
        );
        this.contents = markRaw(fb2ToReaderHtml.sanitizeContents(fb2ToReaderHtml.extractReaderContents(parser)));
        const {html: readerHtml, notesAnchorId} = fb2ToReaderHtml.buildReaderHtml(parser, {
            contents: this.contents,
            notesTitle: t('reader.bookNotes'),
        });
        this.readerHtml = readerHtml;
        this.readerNotesAnchorId = notesAnchorId;
        this.readerSearchText = readerTextAnchors.normalizeReaderSearchText(readerTextAnchors.stripHtml(this.readerHtml || '')).toLowerCase();

        this.applyOpeningProgress(stateResponse);
        this.bookmarks = Array.isArray(stateResponse && stateResponse.bookmarks) ? stateResponse.bookmarks : [];
        this.currentSectionId = String(this.progress.sectionId || '').trim();
        this.restorePending = true;
        this.currentPageIndex = 0;
        this.readerNoteReturnPoint = null;

        this.$root.setAppTitle(this.title);
    }

    //Освобождает книгу закрытой читалки: текст, страницы и кэши разбивки. Место в книге уже сохранено
    //(deactivated -> flushProgress), при возврате loadReader строит всё заново и открывает его
    releaseReaderBook() {
        this.releaseBookTimer = null;
        if (this.readerBookReleased || (!this.readerHtml && !this.pagedPages.length))
            return;

        this.readerLoadJobId += 1;
        this.pagedBuildJobId += 1;
        this.pagedLayoutCache.clear();
        this.pagedPages = [];
        this.readerHtml = '';
        this.readerAnnotationHtml = '';
        this.readerSearchText = '';
        this.searchResults = [];
        this.contents = [];
        this.readerBookReleased = true;
    }

    async loadReader() {
        const loadJobId = ++this.readerLoadJobId;
        this.loadedReaderSourceKey = this.readerSourceKey;
        this.readerBookReleased = false;
        this.dismissRemoteProgressOffer();
        // Invalidate queued/in-flight pagination from the previous source before
        // replacing readerHtml and the shared measurement DOM.
        this.pagedBuildJobId += 1;
        this.pagedBuildNeedsRefresh = false;
        this.pagedLayoutSignature = '';
        this.pagedLayoutCache.clear();
        this.progressPersistPendingAfterPagedBuild = false;
        this.compactChromePagedBuildPending = false;
        this.compactChromeAwaitingCalibration = false;
        this.dynamicBottomClipCompensationCompact = 0;
        this.dynamicBottomClipCompensationRegular = 0;
        this.bottomClipCompensationGeometryKey = '';
        this.bottomClipCompensationPendingKey = '';
        this.bottomClipCompensationByGeometry.clear();
        this.bottomClipCalibrationAttemptsByGeometry.clear();
        this.resetBottomClipCalibrationSample();
        this.bottomClipGeometryChangedAt = 0;
        this.bottomClipViewportActivityAt = 0;
        this.bottomClipPageActivityAt = 0;
        this.pagedCommittedCalibrationKey = '';
        this.pagedCommittedCalibrationAt = 0;
        this.pagedCommittedCalibrationGeneration = 0;
        this.bottomClipCalibrationPending = true;
        this.cancelCompactChromeBuildPendingClear();
        this.clearCompactChromeStatusHold();
        if (this.bottomCalibrationFrame) {
            cancelAnimationFrame(this.bottomCalibrationFrame);
            this.bottomCalibrationFrame = 0;
        }
        if (this.bottomCalibrationTimer) {
            clearTimeout(this.bottomCalibrationTimer);
            this.bottomCalibrationTimer = null;
        }
        if (!this.bookUid && !this.isStandaloneMode) {
            await this.loadReaderHome();
            return;
        }

        const api = this.$root.api;
        if (!api && !this.isStandaloneMode) {
            this.error = t('reader.readerNotReadyYet');
            return;
        }

        this.loading = true;
        this.loadingMessage = this.uiText.loadingFetch;
        this.bookPreparing = false;
        this.error = '';
        this.readerHtml = '';
        this.readerAnnotationHtml = '';
        this.readerNotesAnchorId = '';
        this.readerSearchText = '';
        this.contents = [];
        this.bookmarks = [];
        this.currentPlacesTab = 'progress';
        this.currentSectionId = '';
        this.restorePending = false;
        this.restoreFromSavedProgress = false;
        this.restoredScrollTop = -1;
        this.pendingReflowAnchor = null;
        this.controlsOpen = false;
        this.contentsDialogOpen = false;
        this.contentsPanelView = 'contents';
        this.bookmarksDialogOpen = false;
        this.helpDialogOpen = false;
        this.bookmarkComposerOpen = false;
        this.inlineContentsVisible = false;
        this.chromeHidden = false;
        this.readerMetaExpanded = false;

        try {
            await this.afterLayoutRefreshPaint();
            if (loadJobId !== this.readerLoadJobId)
                return;

        this.loadingMessage = this.uiText.loadingParse;
        await this.afterLayoutRefreshPaint();
        if (loadJobId !== this.readerLoadJobId)
            return;

        if (this.isStandaloneMode) {
                const source = (this.standaloneSource || {});
                await this.applyReaderDocumentSource({
                    book: Object.assign({}, source.book || {}, {
                        title: source.title || (source.book && source.book.title) || '',
                        author: source.author || (source.book && source.book.author) || '',
                        series: source.series || (source.book && source.book.series) || '',
                        serno: source.serno || (source.book && source.book.serno) || 0,
                    }),
                    fb2: source.fb2 || '',
                    cover: source.cover || '',
                    stateResponse: (source.stateResponse || {}),
                });
            } else {
                const [bookResponse, stateResponseRaw] = await Promise.all([
                    api.getBookInfo(this.bookUid),
                    api.getReaderState(this.bookUid, {suppressProfileLogin: true}).catch(() => ({preferences: {}, progress: {}})),
                ]);
                const stateResponse = (stateResponseRaw || {preferences: {}, progress: {}});

                // Исходный FB2 нужен только для разбора: в состоянии читалки его не держим
                const info = ((bookResponse && bookResponse.bookInfo) || {});
                if (!info.fb2)
                    throw new Error(t('common.builtReaderCurrentlySupports'));

                await this.applyReaderDocumentSource({
                    book: (info.book || {}),
                    fb2: info.fb2 || '',
                    cover: info.cover || '',
                    stateResponse,
                });
            }
            if (loadJobId !== this.readerLoadJobId)
                return;

            this.loading = false;
            this.bookPreparing = true;
            this.loadingMessage = this.uiText.loadingPages;
            this.pagedPages = [];
            {
                const savedPageIndex = Number(this.progress && this.progress.pageIndex);
                this.currentPageIndex = (Number.isFinite(savedPageIndex) && savedPageIndex > 0)
                    ? Math.max(0, Math.round(savedPageIndex))
                    : 0;
            }

            await this.$nextTick();
            await this.afterLayoutRefreshPaint();
            if (loadJobId !== this.readerLoadJobId)
                return;
            if (this.isPagedMode) {
                let initialBuildCommitted = false;
                for (let attempt = 0; attempt < 3 && !initialBuildCommitted; attempt += 1) {
                    const initialBuildJobId = ++this.pagedBuildJobId;
                    if (!await this.waitForPagedBuildIdle(2400))
                        throw new Error(t('reader.couldNotFinishPrevious'));
                    await this.waitForStablePagedStage();
                    if (
                        loadJobId !== this.readerLoadJobId
                        || initialBuildJobId !== this.pagedBuildJobId
                    )
                        return;
                    this.scrollerViewportWidth = ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientWidth) || 0);
                    this.scrollerViewportHeight = ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0);
                    initialBuildCommitted = await this.buildPagedPagesChunked(initialBuildJobId);
                    if (
                        loadJobId !== this.readerLoadJobId
                        || initialBuildJobId !== this.pagedBuildJobId
                    )
                        return;
                    if (!initialBuildCommitted)
                        await this.waitForAnimationFrames(2);
                }
                if (!initialBuildCommitted)
                    throw new Error(t('reader.pageGeometryDidNot'));
                if (this.hasReaderProgressPlace(this.progress))
                    this.restorePending = true;
                this.restoreFromSavedProgress = this.restorePending;
                if (!this.restorePending)
                    this.syncPagedProgress(false);
                if (this.bottomClipCalibrationPending)
                    this.scheduleBottomClipCalibration();
            } else {
                this.updateScrollerViewport();
                await this.waitForAnimationFrames(2);
            }
            this.attachScrollerObserver();
            await this.waitForAnimationFrames(2);
            if (loadJobId !== this.readerLoadJobId)
                return;
            this.restoreProgress();
            if (this.pendingReaderProgressUpload) {
                this.pendingReaderProgressUpload = false;
                this.queuePersistProgress();
            }
            if (this.offeredRemoteProgress)
                this.offerRemoteProgress(this.offeredRemoteProgress);
            await this.waitForAnimationFrames(2);
        } catch (e) {
            if (loadJobId === this.readerLoadJobId)
                this.error = tm(e.message);
        } finally {
            if (loadJobId === this.readerLoadJobId) {
                this.loading = false;
                this.bookPreparing = false;
                this.loadingMessage = '';
                this.captureStableReaderStatus(true);
                if (this.isPagedMode && this.bottomClipCalibrationPending)
                    this.scheduleBottomClipCalibration();
            }
        }
    }

    restoreProgress() {
        if (!this.restorePending || !this.$refs.scroller)
            return;

        const restoreFromSavedProgress = !!this.restoreFromSavedProgress;
        if (this.isPagedMode) {
            const layoutSignature = this.getPagedLayoutSignature();
            if (
                this.pagedBuildInProgress
                || this.pagedViewportFrame
                || !this.pagedPages.length
                || (!restoreFromSavedProgress && layoutSignature && layoutSignature !== this.pagedLayoutSignature)
            ) {
                this.updateScrollerViewport();
                this.scheduleRestoreProgressRetry();
                return;
            }
        }

        this.restorePending = false;
        this.restoreFromSavedProgress = false;
        if (restoreFromSavedProgress)
            this.pendingReflowAnchor = null;
        else if (this.restorePendingReflowAnchor())
            return;
        const scroller = this.$refs.scroller;

        if (this.isPagedMode) {
            const savedPageIndex = Number(this.progress.pageIndex);
            const textOffset = Number(this.progress.textOffset);
            const textSnippet = String(this.progress.textSnippet || '').trim();
            if ((Number.isFinite(textOffset) && textOffset >= 0) || textSnippet) {
                const textPageIndex = this.findPagedPageIndexByReaderTextAnchor(textSnippet, textOffset, savedPageIndex);
                if (textPageIndex >= 0) {
                    this.setCurrentPagedRestorePage(textPageIndex, {
                        textSnippet,
                        textOffset,
                    });
                    return;
                }
            }
            const progressPercent = Number(this.progress.percent || 0) || 0;
            if (progressPercent > 0 && progressPercent < 1 && this.totalPagedLogicalPages > 1) {
                this.setCurrentPagedPage(Math.round((this.totalPagedLogicalPages - 1) * progressPercent), false);
                return;
            }
            if (Number.isFinite(savedPageIndex) && savedPageIndex > 0) {
                this.setCurrentPagedPage(savedPageIndex, false);
                return;
            }
        }

        if (this.progress.sectionId) {
            if (this.isPagedMode) {
                const pageIndex = this.getPageIndexForSection(this.progress.sectionId);
                if (pageIndex >= 0) {
                    this.setCurrentPagedPage(pageIndex, false);
                    return;
                }
            }

            const target = scroller.querySelector(`#${this.escapeCssId(this.progress.sectionId)}`);
            if (target) {
                if (this.isPagedMode)
                    this.setPagedScroll(this.getPagedOffset(target));
                else
                    scroller.scrollTop = this.readerScrollTargetTop(scroller, target);
                this.restoredScrollTop = scroller.scrollTop;
                this.updateCurrentSectionFromScroll();
                return;
            }
        }

        if (this.isPagedMode) {
            const pageIndex = Math.round((this.totalPagedLogicalPages - 1) * (Number(this.progress.percent || 0) || 0));
            this.setCurrentPagedPage(pageIndex, false);
        } else {
            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTop = maxScroll * (Number(this.progress.percent || 0) || 0);
            this.restoredScrollTop = scroller.scrollTop;
            this.updateCurrentSectionFromScroll();
        }
    }

    scheduleRestoreProgressRetry() {
        if (!this.restorePending || typeof window === 'undefined')
            return;
        if (this.restoreProgressFrame)
            cancelAnimationFrame(this.restoreProgressFrame);

        this.restoreProgressFrame = requestAnimationFrame(() => {
            this.restoreProgressFrame = 0;
            this.$nextTick(() => {
                if (!this.restorePending)
                    return;
                requestAnimationFrame(() => this.restoreProgress());
            });
        });
    }

    setCurrentPagedRestorePage(index = 0, anchor = null) {
        if (!this.isPagedMode)
            return;

        const rawIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Math.round(Number(index || 0) || 0)));
        if (this.isDualPagedSpread) {
            const previousIndex = this.currentPageIndex;
            this.pageTurnDirection = (rawIndex < this.currentPageIndex ? -1 : 1);
            this.currentPageIndex = rawIndex;
            if (rawIndex !== previousIndex) {
                this.bottomClipPageActivityAt = Date.now();
                this.resetBottomClipCalibrationSample();
            }
            this.setReflowPageStartOverride(rawIndex, anchor);
            this.syncPagedProgress(false);
            return;
        }

        this.setReflowPageStartOverride(rawIndex, anchor);
        this.setCurrentPagedPage(rawIndex, false);
    }

    onScroll() {
        // Не чаще одного раза за кадр: расчёт читает offsetTop всех разделов оглавления
        if (this.scrollFrame || this.loading || this.isPagedMode || !this.$refs.scroller)
            return;

        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = 0;
            this.handleScrollFrame();
        });
    }

    handleScrollFrame() {
        if (this.loading || this.isPagedMode || !this.$refs.scroller)
            return;

        const scroller = this.$refs.scroller;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const currentScroll = scroller.scrollTop;
        this.lastScrollTop = currentScroll;
        const percent = (maxScroll > 0 ? currentScroll / maxScroll : 0);
        this.updateCurrentSectionFromScroll();
        // Прокрутка самой читалкой к месту (восстановление, отметка «прочитано») - ещё не чтение: прогресс
        // не перезаписывается, пока читатель сам не прокрутит текст (позиция другого устройства, отметка остаются)
        if (this.restoredScrollTop >= 0 && Math.abs(currentScroll - this.restoredScrollTop) < scroller.clientHeight / 2)
            return;
        this.restoredScrollTop = -1;
        this.progress = Object.assign({}, this.progress, {
            percent,
            sectionId: this.currentSectionId || '',
            updatedAt: new Date().toISOString(),
        });
        // Локальная копия пишется в отложенном сохранении (persistProgress)
        this.saveProgressDebounced(this.bookUid);
    }

}

export default vueComponent(Reader);
</script>

<style scoped>
.reader-page {
    --q-primary: var(--reader-accent);
    /* общие классы библиотеки (.tabs, .page-title) внутри читалки берут цвета её темы */
    --app-text: var(--reader-text);
    --app-muted: var(--reader-muted);
    --app-border: var(--reader-border);
    --app-primary: var(--reader-accent);
    --app-surface: var(--reader-surface);
    --app-accent-soft: var(--reader-accent-soft);
    /* формы и шрифт заголовков как в библиотеке */
    --reader-radius: 6px;
    --reader-radius-lg: 8px;
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 100%;
    overflow: hidden;
    background:
        linear-gradient(var(--reader-background-overlay, transparent), var(--reader-background-overlay, transparent)),
        var(--reader-background-image, none),
        var(--reader-bg);
    background-attachment: fixed;
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
    color: var(--reader-text);
}

.reader-page--immersive {
    cursor: default;
}

.reader-page :deep(.q-field--focused .q-field__control) {
    box-shadow: 0 0 0 3px var(--reader-accent-soft);
}

.reader-page :deep(.q-field.q-field--focused .q-field__control::after) {
    border-color: var(--reader-accent);
}

.reader-theme-switch,
.reader-stepper {
    display: inline-flex;
    align-items: center;
    align-content: stretch;
    flex-wrap: wrap;
    gap: 1px;
    padding: 1px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    overflow: hidden;
}

.reader-theme-switch :deep(.q-btn),
.reader-stepper :deep(.q-btn) {
    min-height: 30px;
    min-width: 30px;
    padding: 3px 7px;
    font-size: 12px;
}

.reader-loading,
.reader-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.reader-home-state--locked > div {
    flex: 1 1 220px;
    min-width: 0;
}

.reader-reflow-indicator {
    position: absolute;
    inset: 0;
    z-index: 18;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    pointer-events: none;
}

.reader-reflow-indicator--compact {
    z-index: 20;
    background: color-mix(in srgb, var(--reader-bg) 18%, transparent);
    backdrop-filter: blur(2px);
}

.reader-reflow-indicator--strong {
    z-index: 22;
    background: color-mix(in srgb, var(--reader-bg) 48%, transparent);
    backdrop-filter: blur(4px);
}

.reader-reflow-card {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    color: var(--reader-text);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(10px);
    font-size: 13px;
    font-weight: 700;
}

.reader-reflow-card--compact {
    padding: 12px 16px;
    box-shadow: 0 18px 36px rgba(0, 0, 0, 0.18);
}

.reader-reflow-card--loading {
    padding: 14px 18px;
    border-radius: var(--reader-radius);
    box-shadow: 0 20px 44px rgba(0, 0, 0, 0.18);
    font-size: 14px;
}

.reader-reflow-fade-enter-active,
.reader-reflow-fade-leave-active {
    transition: opacity 0.18s ease, transform 0.18s ease;
}

.reader-reflow-fade-enter-from,
.reader-reflow-fade-leave-to {
    opacity: 0;
    transform: translateY(6px);
}

.reader-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}

.reader-scroll--paged {
    overflow: clip;
    overflow: hidden;
    scroll-behavior: smooth;
    overscroll-behavior: contain;
    touch-action: none;
}

.reader-scroll--paged-vertical {
    overflow-y: hidden;
    overflow-x: hidden;
    scroll-snap-type: y mandatory;
    touch-action: none;
}

.reader-scroll--paged-horizontal {
    overflow-x: hidden;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 0;
    touch-action: none;
}

.reader-shell {
    padding: 28px 18px 72px;
}

/* двойной класс: правила для телефона ниже не должны сбросить отступ под панель */
.reader-shell.reader-shell--under-toolbar {
    padding-top: calc(28px + var(--reader-toolbar-height, 0px));
}

.reader-shell--paged {
    min-height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    padding:
        var(--reader-page-outer-gap-top, 28px)
        var(--reader-page-outer-gap-right, 18px)
        var(--reader-page-outer-gap-bottom, 28px)
        var(--reader-page-outer-gap-left, 18px);
}

.reader-shell--paged-horizontal {
    display: flex;
    justify-content: flex-start;
    align-items: flex-start;
    width: max-content;
    min-width: 100%;
    padding-inline: 0;
    box-sizing: border-box;
}

.reader-cover-box,
.reader-html :deep(.reader-cover-box) {
    display: flex;
    justify-content: center;
    margin-bottom: 24px;
}

.reader-cover,
.reader-html :deep(.reader-cover) {
    width: 180px;
    max-width: 42vw;
    border-radius: var(--reader-radius);
    box-shadow: 0 18px 38px rgba(0, 0, 0, 0.18);
}

.reader-body {
    width: min(100%, var(--reader-content-width));
    margin: 0 auto;
    font-family: var(--reader-font-family);
    font-size: var(--reader-font-size);
    line-height: var(--reader-line-height);
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes {
    min-height: auto;
    padding-bottom: 0;
}

.reader-body--paged {
    width: 100%;
    max-width: none;
    min-height: auto;
    height: auto;
    max-height: none;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    overflow: visible;
}

.reader-body--paged .reader-html {
    display: block;
    height: auto;
    max-height: none;
    overflow: hidden;
}

.reader-page-sheet {
    display: flex;
    flex-direction: column;
}

.reader-page-sheet .reader-html,
.reader-page-column-sheet .reader-html {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
    max-height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    padding-bottom: 0;
}

.reader-page-sheet .reader-html :deep(.reader-page-content),
.reader-page-column-sheet .reader-html :deep(.reader-page-content) {
    display: flow-root;
    min-height: 0;
    padding-bottom: 0;
    box-sizing: border-box;
}

.reader-page-sheet .reader-html :deep(.reader-page-spacer),
.reader-page-column-sheet .reader-html :deep(.reader-page-spacer) {
    height: 0;
    pointer-events: none;
}

.reader-body--paged .reader-html > .reader-page-content > :first-child {
    margin-top: 0;
}

.reader-body--paged .reader-html > .reader-page-content > :last-child {
    margin-bottom: 0;
}

.reader-pages {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--reader-page-gap);
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    height: var(--reader-page-min-height);
    overflow: visible;
}

.reader-page-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(100%, var(--reader-page-frame-width));
    max-width: var(--reader-page-frame-width);
    height: var(--reader-page-min-height);
    overflow: visible;
}

.reader-pages--horizontal {
    flex-direction: row;
    gap: 0;
    align-items: center;
    justify-content: center;
}

.reader-page-sheet {
    position: relative;
    width: min(100%, var(--reader-page-frame-width));
    max-width: var(--reader-page-frame-width);
    height: var(--reader-page-min-height);
    padding: var(--reader-page-padding);
    padding-block-start: var(--reader-page-padding-top);
    padding-inline-end: var(--reader-page-padding-right);
    padding-block-end: var(--reader-page-padding-bottom);
    padding-inline-start: var(--reader-page-padding-left);
    box-sizing: border-box;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius-lg);
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    box-shadow: none;
    background-clip: padding-box;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow: hidden;
    contain: layout paint style;
}

.reader-page-sheet--horizontal {
    flex: 0 0 var(--reader-page-frame-width);
    width: var(--reader-page-frame-width);
    max-width: var(--reader-page-frame-width);
    height: var(--reader-page-min-height);
}

.reader-page-sheet--live {
    position: absolute;
    inset: 0 0 auto;
    margin: 0 auto;
}

.reader-page-sheet--placeholder {
    position: absolute;
    inset: 0 0 auto;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--reader-muted);
}

.reader-page-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: min(360px, 82%);
    padding: 18px 22px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface) 88%, transparent);
    text-align: center;
}

.reader-page-placeholder-title {
    color: var(--reader-text);
    font-size: 15px;
    font-weight: 800;
}

.reader-page-placeholder-text {
    font-size: 13px;
    font-weight: 650;
}

.reader-page-sheet--dual {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    contain: layout paint style;
}

.reader-page-spread {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    width: 100%;
    height: 100%;
}

.reader-page-column-sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    padding: var(--reader-page-padding);
    padding-block-start: var(--reader-page-padding-top);
    padding-inline-end: var(--reader-page-padding-right);
    padding-block-end: var(--reader-page-padding-bottom);
    padding-inline-start: var(--reader-page-padding-left);
    box-sizing: border-box;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius-lg);
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    overflow: hidden;
    contain: layout paint style;
}

.reader-page-sheet--padding-preview-top::after,
.reader-page-sheet--padding-preview-bottom::after,
.reader-page-sheet--padding-preview-left::after,
.reader-page-sheet--padding-preview-right::after {
    content: "";
    position: absolute;
    pointer-events: none;
    z-index: 2;
    border-radius: inherit;
    background:
        repeating-linear-gradient(
            45deg,
            color-mix(in srgb, var(--reader-accent) 20%, transparent) 0 8px,
            color-mix(in srgb, var(--reader-accent) 7%, transparent) 8px 16px
        );
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--reader-accent) 28%, transparent);
}

.reader-page-sheet--padding-preview-top::after {
    inset: 0 0 auto;
    height: var(--reader-page-padding-top);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
}

.reader-page-sheet--padding-preview-bottom::after {
    inset: auto 0 0;
    height: var(--reader-page-padding-bottom);
    border-top-left-radius: 0;
    border-top-right-radius: 0;
}

.reader-page-sheet--padding-preview-left::after {
    inset: 0 auto 0 0;
    width: var(--reader-page-padding-left);
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
}

.reader-page-sheet--padding-preview-right::after {
    inset: 0 0 0 auto;
    width: var(--reader-page-padding-right);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
}

.reader-page-sheet.reader-reflow-anchor-highlight,
.reader-page-column-sheet.reader-reflow-anchor-highlight,
.reader-html :deep(.reader-reflow-anchor-highlight) {
    position: relative;
    border-radius: var(--reader-radius);
    animation: reader-reflow-anchor-pulse 4.2s ease-out both;
}

.reader-html :deep(.reader-reflow-anchor-highlight) {
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
}

@keyframes reader-reflow-anchor-pulse {
    0% {
        background-color: color-mix(in srgb, var(--reader-accent) 30%, transparent);
        box-shadow:
            0 0 0 4px color-mix(in srgb, var(--reader-accent) 24%, transparent),
            0 0 22px color-mix(in srgb, var(--reader-accent) 30%, transparent);
    }
    55% {
        background-color: color-mix(in srgb, var(--reader-accent) 16%, transparent);
        box-shadow:
            0 0 0 2px color-mix(in srgb, var(--reader-accent) 14%, transparent),
            0 0 14px color-mix(in srgb, var(--reader-accent) 16%, transparent);
    }
    100% {
        background-color: transparent;
        box-shadow: none;
    }
}

.reader-page-column-sheet--empty {
    opacity: 0.38;
}

.reader-page-sheet--measure {
    position: absolute;
    inset: 0;
    margin: auto;
    width: min(100%, var(--reader-page-measure-frame-width));
    max-width: var(--reader-page-measure-frame-width);
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
    filter: none;
}

.reader-page-slide-x-forward-enter-active,
.reader-page-slide-x-forward-leave-active,
.reader-page-slide-x-back-enter-active,
.reader-page-slide-x-back-leave-active,
.reader-page-slide-y-forward-enter-active,
.reader-page-slide-y-forward-leave-active,
.reader-page-slide-y-back-enter-active,
.reader-page-slide-y-back-leave-active {
    position: absolute;
    inset: 0;
    transition: opacity var(--reader-page-transition-duration, 180ms) ease, transform var(--reader-page-transition-duration, 180ms) cubic-bezier(.2, .75, .3, 1);
    will-change: opacity, transform;
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-y-forward-enter-from,
.reader-page-slide-x-back-enter-from,
.reader-page-slide-y-back-enter-from,
.reader-page-slide-x-forward-leave-to,
.reader-page-slide-y-forward-leave-to,
.reader-page-slide-x-back-leave-to,
.reader-page-slide-y-back-leave-to {
    opacity: var(--reader-page-enter-opacity, 0);
    transform: scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-x-back-leave-to {
    transform: translateX(var(--reader-page-shift-x, 10px)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-x-back-enter-from,
.reader-page-slide-x-forward-leave-to {
    transform: translateX(calc(var(--reader-page-shift-x, 10px) * -1)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-y-forward-enter-from,
.reader-page-slide-y-back-leave-to {
    transform: translateY(var(--reader-page-shift-y, 8px)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-y-back-enter-from,
.reader-page-slide-y-forward-leave-to {
    transform: translateY(calc(var(--reader-page-shift-y, 8px) * -1)) scale(var(--reader-page-enter-scale, 1));
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes,
.reader-body--paged .reader-progress-bar,
.reader-body--paged .reader-contents-inline,
.reader-body--paged .reader-series,
.reader-body--paged .reader-heading,
.reader-body--paged .reader-subheading,
.reader-body--paged .reader-image-block,
.reader-body--paged .reader-cover-box,
.reader-body--paged .reader-html :deep(.reader-section),
.reader-body--paged .reader-html :deep(.reader-notes),
.reader-body--paged .reader-html :deep(.reader-progress-bar),
.reader-body--paged .reader-html :deep(.reader-contents-inline),
.reader-body--paged .reader-html :deep(.reader-series),
.reader-body--paged .reader-html :deep(.reader-heading),
.reader-body--paged .reader-html :deep(.reader-subheading),
.reader-body--paged .reader-html :deep(.reader-image-block),
.reader-body--paged .reader-html :deep(.reader-cover-box) {
    break-inside: avoid;
}

.reader-series,
.reader-html :deep(.reader-series) {
    color: var(--reader-muted);
    font-size: 0.92em;
    font-weight: 650;
}

.reader-heading,
.reader-html :deep(.reader-heading) {
    margin: 10px 0 0;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.06;
}

.reader-subheading,
.reader-html :deep(.reader-subheading) {
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 0.98em;
}

.reader-opening-title,
.reader-html :deep(.reader-opening-title) {
    margin: 0 0 18px;
    font-size: 1.22em;
    font-weight: 700;
    line-height: 1.35;
}

.reader-html :deep(.reader-section-block) {
    margin-top: 18px;
}

.reader-body--paged .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: page;
    page-break-before: always;
}

.reader-body--paged-horizontal .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: column;
    page-break-before: auto;
}

.reader-html :deep(.reader-section-heading) {
    margin: 1.3em 0 0.55em;
    line-height: 1.18;
}

.reader-html :deep(.reader-subtitle) {
    margin: 1em 0 0.5em;
    line-height: 1.25;
}

.reader-html :deep(.reader-epigraph),
.reader-html :deep(.reader-cite) {
    margin: 1.1em 0;
    padding: 0.4em 0 0.4em 1.1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(.reader-epigraph-author) {
    margin-top: 0.55em;
    text-align: right;
    font-size: 0.92em;
}

.reader-html :deep(.reader-poem),
.reader-html :deep(.reader-stanza) {
    margin: 1em 0;
}

.reader-html :deep(.reader-image-block) {
    margin: 1.1em 0;
    text-align: center;
}

.reader-html :deep(.reader-empty-line) {
    height: 1em;
}

.reader-contents-inline {
    margin: 22px 0 0;
    padding: 14px 16px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface) 82%, transparent);
}

.reader-contents-inline-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.reader-contents-inline-title {
    font-size: 14px;
    font-weight: 750;
    color: var(--reader-muted);
}

.reader-contents-toggle {
    padding: 6px 10px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.reader-contents-inline-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.reader-contents-chip {
    padding: 8px 12px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    cursor: pointer;
}

.reader-progress-bar {
    margin: 20px 0 28px;
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--reader-surface-2);
    overflow: hidden;
}

.reader-progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--reader-accent), color-mix(in srgb, var(--reader-accent) 72%, white));
}

.reader-html {
    color: var(--reader-text);
}

.reader-html :deep(h1),
.reader-html :deep(h2),
.reader-html :deep(h3),
.reader-html :deep(h4) {
    line-height: 1.15;
    margin: 1.45em 0 0.5em;
}

.reader-html :deep(.reader-anchored-heading) {
    scroll-margin-top: 84px;
}

.reader-html :deep(.reader-inline-link) {
    color: var(--reader-accent);
    font-weight: 700;
    text-decoration: none;
}

.reader-html :deep(a.reader-inline-link) {
    cursor: pointer;
}

.reader-html :deep(a.reader-inline-link:hover) {
    text-decoration: underline;
}

.reader-html :deep(p),
.reader-paragraph {
    margin: 0.8em 0;
    text-align: justify;
}

.reader-body--paged .reader-html :deep(p),
.reader-body--paged .reader-paragraph {
    margin: 0.42em 0;
}

.reader-body--paged .reader-html :deep(.reader-section-heading) {
    margin: 0.9em 0 0.38em;
}

.reader-body--paged .reader-html :deep(.reader-subtitle) {
    margin: 0.75em 0 0.35em;
}

.reader-html :deep(blockquote) {
    margin: 1.2em 0;
    padding-left: 1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(img),
.reader-inline-image {
    display: block;
    max-width: min(100%, 680px);
    height: auto;
    margin: 18px auto;
    border-radius: var(--reader-radius);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

.reader-body--paged .reader-cover,
.reader-body--paged .reader-html :deep(.reader-cover) {
    width: 180px;
    max-width: min(100%, 320px);
    max-height: var(--reader-page-media-max-height);
    aspect-ratio: var(--reader-cover-aspect, auto);
    object-fit: contain;
}

.reader-body--paged .reader-html :deep(img),
.reader-body--paged .reader-inline-image {
    width: auto;
    max-width: 100%;
    max-height: var(--reader-page-media-max-height);
    object-fit: contain;
}

.reader-notes {
    margin-top: 2.5em;
    padding-top: 1.5em;
    border-top: 1px solid var(--reader-border);
}

.reader-mobile-btn-label {
    display: block;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    font-size: 10.5px;
    font-weight: 760;
    letter-spacing: 0;
    text-align: center;
    text-wrap: balance;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: normal;
    hyphens: auto;
}

.reader-dialog {
    width: min(92vw, 420px);
    max-height: 85vh;
    border-radius: var(--reader-radius-lg);
    background: var(--reader-surface) !important;
    color: var(--reader-text) !important;
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.reader-overlay-panel {
    position: absolute;
    top: 76px;
    right: 14px;
    z-index: 35;
    width: min(92vw, 420px);
    max-height: calc(100vh - 120px);
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius-lg);
    overflow: hidden;
    background: var(--reader-surface);
    color: var(--reader-text);
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.reader-home {
    text-shadow: none !important;
}

.reader-dialog--contents {
    overflow: hidden;
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-html :deep(.reader-search-hit) {
    padding: 0.04em 0.14em;
    border-radius: 0.28em;
    background: color-mix(in srgb, var(--reader-accent) 28%, transparent);
    color: inherit;
}

/* тёмная и светлая темы - палитра библиотеки (App.vue) */
.reader-theme-dark {
    --reader-on-accent: #0d1d18;
    --reader-bg: #121715;
    --reader-surface: #1a201e;
    --reader-surface-2: #222a27;
    --reader-text: #e6ece9;
    --reader-muted: #98a59f;
    --reader-border: #313b37;
    --reader-accent: #6fbfa9;
    --reader-accent-soft: #1f3a33;
}

.reader-theme-sepia {
    --reader-on-accent: #ffffff;
    --reader-bg: #f4ecdd;
    --reader-surface: #fbf6ec;
    --reader-surface-2: #efe4d2;
    --reader-text: #402f20;
    --reader-muted: #7c6855;
    --reader-border: rgba(64, 47, 32, 0.16);
    --reader-accent: #b76a2c;
    --reader-accent-soft: rgba(183, 106, 44, 0.12);
}

.reader-theme-light {
    --reader-on-accent: #ffffff;
    --reader-bg: #f4f6f5;
    --reader-surface: #ffffff;
    --reader-surface-2: #eef3f1;
    --reader-text: #18201d;
    --reader-muted: #5c6863;
    --reader-border: #d6dcd9;
    --reader-accent: #1f5c50;
    --reader-accent-soft: #dcebe6;
}

.reader-theme-eink {
    --reader-on-accent: var(--reader-eink-bg, #f3f3ee);
    --reader-bg: var(--reader-eink-bg, #f3f3ee);
    --reader-surface: var(--reader-eink-surface, #fbfbf7);
    --reader-surface-2: var(--reader-eink-surface-2, #efefe8);
    --reader-text: var(--reader-eink-text, #111111);
    --reader-muted: var(--reader-eink-muted, #555555);
    --reader-border: var(--reader-eink-border, rgba(17, 17, 17, 0.14));
    --reader-accent: var(--reader-eink-text, #111111);
    --reader-accent-soft: var(--reader-eink-accent-soft, rgba(17, 17, 17, 0.08));
}

.reader-theme-eink .reader-inline-image,
.reader-theme-eink .reader-page-sheet,
.reader-theme-eink .reader-dialog,
.reader-theme-eink .reader-overlay-panel {
    box-shadow: none;
}

.reader-page--transparent-pages .reader-page-sheet:not(.reader-page-sheet--measure):not(.reader-page-sheet--dual),
.reader-page--transparent-pages .reader-page-column-sheet {
    border-color: color-mix(in srgb, var(--reader-border) 52%, transparent);
    background: transparent !important;
    box-shadow: none;
    backdrop-filter: none;
}

.reader-page--text-shadow.reader-page--transparent-pages .reader-body:not(.reader-body--paged),
.reader-page--text-shadow.reader-page--transparent-pages .reader-page-sheet:not(.reader-page-sheet--measure) .reader-html {
    text-shadow: 0 1px 2px color-mix(in srgb, var(--reader-bg) 36%, transparent);
}

.reader-page:not(.reader-page--text-shadow) .reader-body,
.reader-page:not(.reader-page--text-shadow) .reader-page-sheet .reader-html {
    text-shadow: none !important;
}

.reader-theme-eink .reader-page-slide-x-forward-enter-active,
.reader-theme-eink .reader-page-slide-x-forward-leave-active,
.reader-theme-eink .reader-page-slide-x-back-enter-active,
.reader-theme-eink .reader-page-slide-x-back-leave-active,
.reader-theme-eink .reader-page-slide-y-forward-enter-active,
.reader-theme-eink .reader-page-slide-y-forward-leave-active,
.reader-theme-eink .reader-page-slide-y-back-enter-active,
.reader-theme-eink .reader-page-slide-y-back-leave-active {
    transition: none;
    will-change: auto;
}

@media (max-width: 640px) {

    .reader-mobile-spacing-target strong {
        color: var(--reader-text);
        font-weight: 850;
    }

    .reader-mobile-spacing-target.is-active {
        border-color: color-mix(in srgb, var(--reader-accent) 42%, var(--reader-border));
        background: var(--reader-accent-soft);
        color: var(--reader-accent);
    }

    .reader-mobile-spacing-target.is-active strong {
        color: var(--reader-accent);
    }

    .reader-theme-switch,
    .reader-stepper,
    .reader-font-select,
    .reader-background-control {
        width: 100%;
        max-width: none;
        justify-content: center;
        border-radius: var(--reader-radius);
        min-height: 44px;
    }

    .reader-theme-switch :deep(.q-btn),
    .reader-stepper :deep(.q-btn) {
        min-height: 36px;
    }

    .reader-shell {
        padding: 2px 16px 10px;
    }

    .reader-shell--paged {
        padding:
            var(--reader-page-outer-gap-top, 10px)
            var(--reader-page-outer-gap-right, 6px)
            var(--reader-page-outer-gap-bottom, 10px)
            var(--reader-page-outer-gap-left, 6px);
    }

    .reader-body--paged {
        width: 100%;
        border-radius: var(--reader-radius-lg);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
    }

    .reader-pages {
        margin-bottom: 12px;
    }

    .reader-page-sheet,
    .reader-page-sheet--horizontal {
        width: 100%;
        max-width: 100%;
        border-radius: var(--reader-radius);
    }

    .reader-shell--paged-horizontal {
        padding-inline: 0;
    }

    .reader-cover,
    .reader-html :deep(.reader-cover),
    .reader-body--paged .reader-cover,
    .reader-body--paged .reader-html :deep(.reader-cover) {
        width: 140px;
        max-width: 46vw;
    }

    .reader-body {
        width: 100%;
    }

    .reader-mobile-btn-label {
        font-size: 10px;
    }

    .reader-html :deep(p),
    .reader-paragraph {
        text-align: left;
    }
}
</style>
