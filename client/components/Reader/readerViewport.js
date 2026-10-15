//Размер области чтения и перестройка под него: наблюдатели размера, отложенное обновление после разблокировки
//экрана, запуск разбивки под новый размер, индикатор перестройки со стабильной строкой состояния, ожидание
//кадров, шрифтов и картинок. Своего состояния нет: размеры, кадры и таймеры - поля Reader.

export default class ReaderViewport {
    attachScrollerObserver() {
        this.detachScrollerObserver();
        if (typeof ResizeObserver === 'undefined' || !this.$refs || !this.$refs.scroller)
            return;

        const scroller = this.$refs.scroller;
        this.resizeObserver = new ResizeObserver(() => {
            // Скрытый (keep-alive) читатель имеет размер 0x0: не перестраиваем страницы под него
            if (this.controlsOpen || !scroller.clientWidth || !scroller.clientHeight)
                return;
            if (
                this.isCompactLayout
                && this.isPagedMode
                && Date.now() < (Number(this.compactChromeViewportRefreshSuppressedUntil || 0) || 0)
            )
                return;
            this.scheduleViewportRefresh({calibrate: false});
        });
        this.resizeObserver.observe(scroller);

        const toolbar = this.$refs.readerToolbar && this.$refs.readerToolbar.$el;
        if (toolbar) {
            this.toolbarResizeObserver = new ResizeObserver(() => {
                if (toolbar.offsetHeight)
                    this.readerToolbarHeight = toolbar.offsetHeight;
            });
            this.toolbarResizeObserver.observe(toolbar);
        }
    }

    detachScrollerObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.toolbarResizeObserver) {
            this.toolbarResizeObserver.disconnect();
            this.toolbarResizeObserver = null;
        }
    }

    suspendViewportRefreshForVisibility() {
        this.viewportResumePending = true;
        this.viewportResumeNeedsCalibration = true;
        this.viewportResumeGuardUntil = 0;
        if (this.viewportResumeTimer) {
            clearTimeout(this.viewportResumeTimer);
            this.viewportResumeTimer = null;
        }
        if (this.viewportRefreshFrame) {
            cancelAnimationFrame(this.viewportRefreshFrame);
            this.viewportRefreshFrame = 0;
        }
        if (this.pagedViewportFrame) {
            cancelAnimationFrame(this.pagedViewportFrame);
            this.pagedViewportFrame = 0;
            this.pagedViewportBuildQueued = false;
        }
    }

    resumeViewportRefreshAfterVisibility() {
        // Mobile browsers restore their system bars in several steps after the
        // screen is unlocked. Keep the last committed page geometry until that
        // burst becomes quiet instead of paginating every intermediate height.
        this.viewportResumePending = true;
        this.viewportResumeNeedsCalibration = true;
        this.viewportResumeGuardUntil = Date.now() + 520;
        this.scheduleDeferredViewportRefresh();
    }

    scheduleDeferredViewportRefresh(delayMs = 0) {
        if (this.viewportResumeTimer)
            clearTimeout(this.viewportResumeTimer);

        const remainingGuard = Math.max(0, this.viewportResumeGuardUntil - Date.now());
        const waitMs = Math.max(80, remainingGuard, Math.round(Number(delayMs || 0) || 0));
        this.viewportResumeTimer = setTimeout(() => {
            this.viewportResumeTimer = null;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
                return;

            const remaining = Math.max(0, this.viewportResumeGuardUntil - Date.now());
            if (remaining > 0) {
                this.scheduleDeferredViewportRefresh(remaining);
                return;
            }

            const shouldRefresh = this.viewportResumePending;
            const calibrate = this.viewportResumeNeedsCalibration;
            this.viewportResumePending = false;
            this.viewportResumeNeedsCalibration = false;
            this.viewportResumeGuardUntil = 0;
            if (shouldRefresh)
                this.scheduleViewportRefresh({calibrate});
        }, waitMs);
    }

    deferViewportRefreshForVisibility(calibrate = true) {
        const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
        const guarded = Date.now() < (Number(this.viewportResumeGuardUntil || 0) || 0);
        if (!hidden && !guarded)
            return false;

        this.viewportResumePending = true;
        this.viewportResumeNeedsCalibration = this.viewportResumeNeedsCalibration || !!calibrate;
        if (guarded) {
            // Debounce the tail of the visualViewport/browser-toolbar resize
            // burst, while keeping a firm initial guard after visibility resumes.
            this.viewportResumeGuardUntil = Math.max(this.viewportResumeGuardUntil, Date.now() + 220);
            this.scheduleDeferredViewportRefresh();
        }
        return true;
    }

    scheduleViewportRefresh({calibrate = true} = {}) {
        if (typeof window === 'undefined')
            return;
        if (this.deferViewportRefreshForVisibility(calibrate))
            return;

        if (this.isPagedMode)
            this.bottomClipViewportActivityAt = Date.now();
        if (this.isPagedMode)
            this.resetBottomClipCalibrationSample();
        if (calibrate)
            this.requestBottomClipCalibration();

        if (this.compactChromePagedBuildPending && this.isPagedMode)
            this.cancelCompactChromeBuildPendingClear();
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        if (this.viewportRefreshFrame)
            return;

        this.viewportRefreshFrame = requestAnimationFrame(() => {
            this.viewportRefreshFrame = 0;
            if (this.deferViewportRefreshForVisibility(calibrate))
                return;
            this.updateScrollerViewport();
            this.$nextTick(() => this.flushPendingReaderAnchorJump());
        });
    }

    updateScrollerViewport() {
        // The compact settings sheet temporarily consumes most of the flex
        // viewport. It is an overlay, not a new canonical page size.
        if (this.isCompactLayout && this.isPagedMode && this.controlsOpen)
            return;

        const scroller = (this.$refs ? this.$refs.scroller : null);
        const previousViewportWidth = Math.round(Number(this.scrollerViewportWidth || 0) || 0);
        const previousViewportHeight = Math.round(Number(this.scrollerViewportHeight || 0) || 0);
        this.scrollerViewportWidth = ((scroller && scroller.clientWidth) || 0);
        this.scrollerViewportHeight = ((scroller && scroller.clientHeight) || 0);
        if (this.isPagedMode) {
            const nextViewportWidth = Math.round(Number(this.scrollerViewportWidth || 0) || 0);
            const nextViewportHeight = Math.round(Number(this.scrollerViewportHeight || 0) || 0);
            this.syncBottomClipCompensationGeometry();
            // loadReader owns the initial pagination pass. Viewport callbacks fired by
            // its placeholder/status UI must not start a second build against the
            // same measurement node, but a real size change still invalidates it.
            if (this.loading || this.bookPreparing) {
                if (
                    this.pagedBuildInProgress
                    && nextViewportWidth > 0
                    && nextViewportHeight > 0
                    && (
                        nextViewportWidth !== previousViewportWidth
                        || nextViewportHeight !== previousViewportHeight
                    )
                )
                    this.pagedBuildNeedsRefresh = true;
                return;
            }

            const signature = this.getPagedLayoutSignature();
            const calibrationKey = this.getBottomClipCompensationGeometryKey();
            if (
                this.pagedPages.length
                && signature
                && signature === this.pagedLayoutSignature
                && calibrationKey === this.pagedCommittedCalibrationKey
            ) {
                if (this.compactChromePagedBuildPending)
                    this.touchCompactChromeBuildActivity();
                if (this.bottomClipCalibrationPending)
                    this.scheduleBottomClipCalibration();
                return;
            }

            if (this.pagedBuildInProgress) {
                const geometrySignature = this.getPagedGeometrySignature();
                if (
                    signature
                    && geometrySignature
                    && signature === this.pagedBuildSignature
                    && geometrySignature === this.pagedBuildGeometrySignature
                )
                    return;
                this.pagedBuildNeedsRefresh = true;
                return;
            }

            this.capturePendingReflowAnchor(false, {preferStable: true});
            if (this.compactChromePagedBuildPending)
                this.touchCompactChromeBuildActivity();
            this.schedulePagedViewportBuild();
            return;
        }
        this.applyVerticalSectionAlignment();
    }

    schedulePagedViewportBuild() {
        if (typeof window === 'undefined')
            return;
        if (this.pagedBuildInProgress) {
            this.pagedBuildNeedsRefresh = true;
            return;
        }

        if (this.pagedViewportBuildQueued)
            return;

        if (this.compactChromePagedBuildPending && this.isPagedMode)
            this.cancelCompactChromeBuildPendingClear();
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        if (this.pagedViewportFrame) {
            cancelAnimationFrame(this.pagedViewportFrame);
            this.pagedViewportFrame = 0;
        }

        this.pagedViewportBuildQueued = true;
        const scheduledBuildVersion = this.pagedBuildJobId;
        this.$nextTick(() => {
            this.pagedViewportFrame = requestAnimationFrame(async() => {
                this.pagedViewportFrame = 0;
                if (!this.isPagedMode) {
                    this.pagedViewportBuildQueued = false;
                    return;
                }

                let retryViewportBuild = false;
                try {
                    await this.waitForStablePagedStage();
                    if (this.deferViewportRefreshForVisibility(true))
                        return;
                    if (
                        !this.isPagedMode
                        || this.loading
                        || this.bookPreparing
                        || scheduledBuildVersion !== this.pagedBuildJobId
                    )
                        return;

                    // A build may have started while the queued frame was waiting for
                    // fonts/layout. Let that owner finish instead of sharing pageMeasure.
                    if (this.pagedBuildInProgress) {
                        this.pagedBuildNeedsRefresh = true;
                        return;
                    }

                    // The viewport can return to its last committed geometry
                    // while this job is waiting for the stage to settle (for
                    // example after a quick tablet rotation there and back).
                    // In that case the existing pages are already correct and
                    // starting another full pagination pass would be redundant.
                    const settledSignature = this.getPagedLayoutSignature();
                    const settledCalibrationKey = this.getBottomClipCompensationGeometryKey();
                    if (
                        this.pagedPages.length
                        && settledSignature
                        && settledSignature === this.pagedLayoutSignature
                        && settledCalibrationKey === this.pagedCommittedCalibrationKey
                    )
                        return;

                    const viewportBuildJobId = ++this.pagedBuildJobId;
                    const buildCommitted = await this.buildPagedPagesChunked(viewportBuildJobId);
                    if (viewportBuildJobId !== this.pagedBuildJobId)
                        return;
                    if (!buildCommitted) {
                        const measureHost = (this.$refs ? this.$refs.pageMeasure : null);
                        retryViewportBuild = !!(
                            measureHost
                            && measureHost.querySelector('.reader-html')
                        );
                        return;
                    }
                    if (this.restorePending)
                        this.scheduleRestoreProgressRetry();
                    else if (this.restorePendingReflowAnchor())
                        this.captureStableReaderStatus(true);
                    else
                        this.syncPagedProgress(false);
                    if (this.bottomClipCalibrationPending)
                        this.scheduleBottomClipCalibration();
                } finally {
                    this.pagedViewportBuildQueued = false;
                    if (
                        retryViewportBuild
                        && this.isPagedMode
                        && !this.loading
                        && !this.bookPreparing
                    )
                        this.schedulePagedViewportBuild();
                }
            });
        });
    }

    async waitForPagedBuildIdle(timeoutMs = 1600) {
        const startedAt = Date.now();
        while (this.pagedBuildInProgress && (Date.now() - startedAt) < timeoutMs)
            await this.waitForAnimationFrames(1);
        return !this.pagedBuildInProgress;
    }

    cancelCompactChromeBuildPendingClear() {
        if (!this.compactChromeBuildSettleTimer)
            return;

        clearTimeout(this.compactChromeBuildSettleTimer);
        this.compactChromeBuildSettleTimer = null;
    }

    clearCompactChromeStatusHold() {
        if (this.compactChromeStatusHoldTimer) {
            clearTimeout(this.compactChromeStatusHoldTimer);
            this.compactChromeStatusHoldTimer = null;
        }
        this.compactChromeStatusHold = false;
        this.compactChromeStatusHoldUntil = 0;
    }

    beginCompactChromeStatusHold(delayMs = 2600) {
        const safeDelay = Math.max(1200, Math.round(Number(delayMs || 0) || 0));
        const nextUntil = Date.now() + safeDelay;
        this.compactChromeStatusHoldUntil = Math.max(this.compactChromeStatusHoldUntil || 0, nextUntil);
        this.compactChromeStatusHold = true;
        if (this.compactChromeStatusHoldTimer)
            clearTimeout(this.compactChromeStatusHoldTimer);
        const waitMs = Math.max(1200, this.compactChromeStatusHoldUntil - Date.now());
        this.compactChromeStatusHoldTimer = setTimeout(() => {
            this.compactChromeStatusHoldTimer = null;
            this.compactChromeStatusHold = false;
            this.compactChromeStatusHoldUntil = 0;
        }, waitMs);
    }

    touchCompactChromeBuildActivity() {
        this.compactChromeBuildLastActivityAt = Date.now();
        if (this.compactChromeStatusHold)
            this.beginCompactChromeStatusHold(2600);
    }

    scheduleCompactChromeBuildPendingClear(delayMs = 420) {
        this.cancelCompactChromeBuildPendingClear();
        const quietWindowMs = 900;
        this.compactChromeBuildSettleTimer = setTimeout(() => {
            this.compactChromeBuildSettleTimer = null;
            const elapsedSinceActivity = Math.max(0, Date.now() - (this.compactChromeBuildLastActivityAt || 0));
            const hasQueuedWork = !!(
                this.layoutRefreshing
                || this.viewportRefreshFrame
                || this.pagedViewportFrame
                || this.pagedBuildInProgress
                || this.pagedBuildNeedsRefresh
                || this.compactChromeAwaitingCalibration
                || this.bottomClipCalibrationPending
                || this.bottomCalibrationFrame
                || this.bottomCalibrationTimer
            );
            if (hasQueuedWork || elapsedSinceActivity < quietWindowMs) {
                const nextDelay = Math.max(delayMs, quietWindowMs - elapsedSinceActivity, 140);
                this.scheduleCompactChromeBuildPendingClear(nextDelay);
                return;
            }
            this.compactChromePagedBuildPending = false;
            this.compactChromeAwaitingCalibration = false;
            this.compactChromeInitialTotalPages = 0;
            this.compactChromeBuildLastActivityAt = 0;
            this.clearCompactChromeStatusHold();
        }, Math.max(120, Math.round(Number(delayMs || 0) || 0)));
    }

    noteCompactChromeTotalPages() {
        if (!this.compactChromePagedBuildPending || !this.isPagedMode)
            return;

        const total = Math.max(1, Number(this.totalPages || 1) || 1);
        if (!this.compactChromeInitialTotalPages)
            this.compactChromeInitialTotalPages = total;

        if (total !== this.compactChromeInitialTotalPages) {
            this.compactChromeAwaitingCalibration = false;
            this.touchCompactChromeBuildActivity();
            this.scheduleCompactChromeBuildPendingClear(540);
        }
    }

    captureStableReaderStatus(force = false) {
        if (!force && this.stableReaderStatus.ready && (this.layoutRefreshing || this.isPagedBuildPending))
            return;

        const pageMeta = this.showPagedPageCounter ? `${this.currentPage}/${this.totalPages}` : '';
        const sectionMeta = (this.isCompactLayout ? '' : this.currentSectionTitle);
        this.stableReaderStatus = {
            ready: true,
            progressPercent: this.progressPercent,
            currentPage: this.currentPage,
            totalPages: this.totalPages,
            pageMeta,
            sectionMeta,
        };
    }

    beginLayoutRefresh(reason = 'default') {
        if (this.layoutRefreshTimer) {
            clearTimeout(this.layoutRefreshTimer);
            this.layoutRefreshTimer = null;
        }
        this.captureStableReaderStatus();
        this.layoutRefreshStartedAt = Date.now();
        this.layoutRefreshReason = String(reason || 'default');
        this.layoutRefreshing = true;
    }

    runAfterLayoutRefreshPaint(callback = () => {}) {
        this.$nextTick(() => {
            setTimeout(() => {
                let finished = false;
                let fallbackTimer = 0;
                const finish = () => {
                    if (finished)
                        return;
                    finished = true;
                    if (fallbackTimer) {
                        clearTimeout(fallbackTimer);
                        fallbackTimer = 0;
                    }
                    callback();
                };

                fallbackTimer = setTimeout(finish, (this.readerDebugEnabled ? 34 : 68));
                requestAnimationFrame(() => {
                    requestAnimationFrame(finish);
                });
            }, 0);
        });
    }

    afterLayoutRefreshPaint() {
        return new Promise((resolve) => {
            this.runAfterLayoutRefreshPaint(resolve);
        });
    }

    waitForAnimationFrames(count = 2) {
        const frames = Math.max(1, Math.round(Number(count || 0) || 0));
        return new Promise((resolve) => {
            const step = (remaining) => {
                if (remaining <= 0) {
                    resolve();
                    return;
                }

                let finished = false;
                let fallbackTimer = 0;
                const next = () => {
                    if (finished)
                        return;
                    finished = true;
                    if (fallbackTimer) {
                        clearTimeout(fallbackTimer);
                        fallbackTimer = 0;
                    }
                    step(remaining - 1);
                };

                fallbackTimer = setTimeout(next, (this.readerDebugEnabled ? 24 : 34));
                requestAnimationFrame(next);
            };
            step(frames);
        });
    }

    getPagedStageRect() {
        const stage = (this.$refs ? this.$refs.pageStage : null);
        if (!stage || typeof stage.getBoundingClientRect !== 'function')
            return {width: 0, height: 0};

        const rect = stage.getBoundingClientRect();
        return {
            width: Math.max(0, Math.round(rect.width || stage.clientWidth || 0)),
            height: Math.max(0, Math.round(rect.height || stage.clientHeight || 0)),
        };
    }

    syncMeasureHostToStage() {
        const measureHost = (this.$refs ? this.$refs.pageMeasure : null);
        const stageRect = this.getPagedStageRect();
        if (!measureHost || !stageRect.width || !stageRect.height)
            return stageRect;

        const measureWidth = Math.max(280, this.pageMeasureFrameWidth || stageRect.width);
        measureHost.style.width = `${measureWidth}px`;
        measureHost.style.maxWidth = `${measureWidth}px`;
        measureHost.style.minWidth = `${measureWidth}px`;
        measureHost.style.height = `${stageRect.height}px`;
        measureHost.style.minHeight = `${stageRect.height}px`;
        return Object.assign({}, stageRect, {measureWidth});
    }

    async waitForReaderFontsReady(timeoutMs = 1800) {
        if (typeof document === 'undefined' || !document.fonts || !document.fonts.ready)
            return;

        let timeoutId = 0;
        try {
            await Promise.race([
                document.fonts.ready,
                new Promise(resolve => {
                    timeoutId = setTimeout(resolve, Math.max(120, Math.round(Number(timeoutMs || 0) || 0)));
                }),
            ]);
        } catch (e) {
            // Font loading failures should not block reading.
        } finally {
            if (timeoutId)
                clearTimeout(timeoutId);
        }

        await this.waitForAnimationFrames(1);
    }

    async waitForStablePagedStage(requiredStableFrames = 2, timeoutMs = 480) {
        if (!this.isPagedMode)
            return {width: 0, height: 0};

        await this.waitForReaderFontsReady();

        const startedAt = Date.now();
        let stableFrames = 0;
        let lastKey = '';
        let lastRect = {width: 0, height: 0};

        while ((Date.now() - startedAt) < timeoutMs) {
            await this.$nextTick();
            await this.waitForAnimationFrames(1);

            lastRect = this.syncMeasureHostToStage();
            const nextKey = `${lastRect.width}x${lastRect.height}`;
            if (lastRect.width > 0 && lastRect.height > 0) {
                stableFrames = (nextKey === lastKey ? stableFrames + 1 : 1);
                lastKey = nextKey;
                if (stableFrames >= Math.max(1, requiredStableFrames))
                    return lastRect;
            }
        }

        return lastRect;
    }

    endLayoutRefresh(delayMs = 180) {
        if (this.layoutRefreshTimer)
            clearTimeout(this.layoutRefreshTimer);

        const elapsed = Math.max(0, Date.now() - (this.layoutRefreshStartedAt || 0));
        const minVisibleMs = 260;
        const waitMs = Math.max(delayMs, minVisibleMs - elapsed);
        this.layoutRefreshTimer = setTimeout(() => {
            this.layoutRefreshTimer = null;
            this.layoutRefreshing = false;
            this.layoutRefreshReason = '';
            this.captureStableReaderStatus(true);
            if (this.isPagedMode && this.bottomClipCalibrationPending)
                this.scheduleBottomClipCalibration();
        }, Math.max(0, waitMs));
    }

    scheduleImageLayoutRefresh() {
        if (typeof window === 'undefined')
            return;

        if (this.isCompactLayout && this.isPagedMode && this.pagedPages.length) {
            this.requestBottomClipCalibration();
            this.scheduleBottomClipCalibration();
            return;
        }

        this.beginLayoutRefresh();
        this.requestBottomClipCalibration();
        if (this.imageLayoutFrame)
            cancelAnimationFrame(this.imageLayoutFrame);

        this.imageLayoutFrame = requestAnimationFrame(() => {
            this.imageLayoutFrame = 0;
            this.runAfterLayoutRefreshPaint(() => {
                this.updateScrollerViewport();
                this.endLayoutRefresh(160);
            });
        });
    }

    async loadCoverIntrinsicSize(src = '') {
        const requestId = ++this.coverIntrinsicLoadId;
        const safeSrc = String(src || '').trim();
        const fallback = safeSrc
            ? {width: 140, height: 210}
            : {width: 0, height: 0};
        this.coverIntrinsicWidth = fallback.width;
        this.coverIntrinsicHeight = fallback.height;
        if (!safeSrc || typeof Image === 'undefined')
            return;

        const measured = await new Promise((resolve) => {
            const image = new Image();
            let settled = false;
            let timer = null;
            const cleanup = () => {
                clearTimeout(timer);
                image.removeEventListener('load', onLoad);
                image.removeEventListener('error', onError);
            };
            const finish = (size) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(size);
            };
            const onLoad = () => {
                const width = Math.round(Number(image.naturalWidth || 0) || 0);
                const height = Math.round(Number(image.naturalHeight || 0) || 0);
                finish(width > 0 && height > 0 ? {width, height} : fallback);
            };
            const onError = () => finish(fallback);

            image.addEventListener('load', onLoad);
            image.addEventListener('error', onError);
            timer = setTimeout(() => finish(fallback), 3000);
            image.src = safeSrc;
            if (image.complete)
                queueMicrotask(image.naturalWidth > 0 ? onLoad : onError);
        });

        if (
            requestId !== this.coverIntrinsicLoadId
            || safeSrc !== String(this.coverSrc || '').trim()
        )
            return;

        this.coverIntrinsicWidth = measured.width;
        this.coverIntrinsicHeight = measured.height;
    }

    handleReaderImageReady(event) {
        const img = event && event.target;
        // Измерительный лист пагинации ждёт свои картинки сам
        if (!img || img.tagName !== 'IMG' || img.closest('.reader-annotation-html, .reader-page-sheet--measure'))
            return;
        this.scheduleImageLayoutRefresh();
    }

    applyVerticalSectionAlignment() {
        const readerBody = (this.$refs ? this.$refs.readerBody : null);
        if (!readerBody)
            return;

        if (this.isPagedMode)
            return;

        const sections = Array.from(readerBody.querySelectorAll('.reader-section-block'));
        if (!sections.length)
            return;

        for (const section of sections)
            section.style.marginTop = '';

        if (!this.isVerticalPaged)
            return;

        const pageSize = Math.max(1, this.scrollerViewportHeight || this.pageMinHeight || 1);
        if (pageSize <= 1)
            return;

        const baseSpacing = 18;
        for (let index = 1; index < sections.length; index += 1) {
            const section = sections[index];
            const offsetTop = section.offsetTop;
            const remainder = offsetTop % pageSize;
            const extraSpacing = (remainder <= 2 ? 0 : (pageSize - remainder));
            section.style.marginTop = `${baseSpacing + extraSpacing}px`;
        }
    }
}
