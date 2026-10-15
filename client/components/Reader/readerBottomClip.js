//Подстройка нижнего края страницы в режиме страниц: замер живой страницы показывает, не обрезан ли текст внизу,
//и на этот запас (bottom clip compensation) уменьшается высота, под которую режутся страницы. Запас помнится
//по геометрии экрана, подстройка ждёт затишья после смены размера и перелистывания.
//Своего состояния нет: замеры и таймеры - поля Reader.

export default class ReaderBottomClip {
    get currentDynamicBottomClipCompensation() {
        return (this.isCompactLayout
            ? (Number(this.dynamicBottomClipCompensationCompact || 0) || 0)
            : (Number(this.dynamicBottomClipCompensationRegular || 0) || 0));
    }

    setCurrentDynamicBottomClipCompensation(value = 0) {
        const safeValue = Math.max(0, Math.round(Number(value || 0) || 0));
        if (this.isCompactLayout)
            this.dynamicBottomClipCompensationCompact = safeValue;
        else
            this.dynamicBottomClipCompensationRegular = safeValue;
        return safeValue;
    }

    getBottomClipCompensationGeometryKey() {
        if (!this.isPagedMode)
            return '';

        const viewportWidth = Math.round(Number(this.scrollerViewportWidth || 0) || 0);
        const viewportHeight = Math.round(Number(this.scrollerViewportHeight || 0) || 0);
        if (!viewportWidth || !viewportHeight)
            return '';

        return [
            (this.isCompactLayout ? 'compact' : 'regular'),
            Math.round(Number(this.pageFrameWidth || 0) || 0),
            Math.round(Number(this.pageMeasureFrameWidth || 0) || 0),
            Math.round(Number(this.pageMinHeight || 0) || 0),
            this.layoutSignatureForPreferences(this.activePreferences),
            this.readerSourceKey,
        ].join('|');
    }

    rememberBottomClipCompensation(key = '', value = 0) {
        const safeKey = String(key || '');
        if (!safeKey)
            return;

        const safeValue = Math.max(0, Math.round(Number(value || 0) || 0));
        if (this.bottomClipCompensationByGeometry.has(safeKey))
            this.bottomClipCompensationByGeometry.delete(safeKey);
        this.bottomClipCompensationByGeometry.set(safeKey, safeValue);
        while (this.bottomClipCompensationByGeometry.size > 8) {
            const oldestKey = this.bottomClipCompensationByGeometry.keys().next().value;
            this.bottomClipCompensationByGeometry.delete(oldestKey);
            this.bottomClipCalibrationAttemptsByGeometry.delete(oldestKey);
        }
    }

    resetBottomClipCalibrationSample() {
        this.bottomClipCalibrationSampleKey = '';
        this.bottomClipCalibrationSampleCount = 0;
        this.bottomClipCalibrationSampleOverflow = 0;
        this.bottomClipCalibrationSampleGeneration = 0;
    }

    syncBottomClipCompensationGeometry() {
        const nextKey = this.getBottomClipCompensationGeometryKey();
        if (!nextKey || nextKey === this.bottomClipCompensationGeometryKey)
            return false;

        const previousKey = this.bottomClipCompensationGeometryKey;
        if (this.bottomClipCompensationPendingKey)
            this.bottomClipCalibrationAttemptsByGeometry.delete(this.bottomClipCompensationPendingKey);
        else if (previousKey)
            this.bottomClipCalibrationAttemptsByGeometry.delete(previousKey);
        this.bottomClipCalibrationAttemptsByGeometry.delete(nextKey);
        this.bottomClipCompensationGeometryKey = nextKey;
        this.bottomClipCompensationPendingKey = '';
        this.bottomClipGeometryChangedAt = Date.now();
        this.resetBottomClipCalibrationSample();
        const storedValue = this.bottomClipCompensationByGeometry.has(nextKey)
            ? this.bottomClipCompensationByGeometry.get(nextKey)
            : 0;
        this.setCurrentDynamicBottomClipCompensation(storedValue);
        return true;
    }

    adjustDebugBottomCompensation(direction = 1) {
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.15, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const step = Math.max(8, Math.round(fontSize * lineHeight));
        const delta = (direction < 0 ? -step : step);

        if (this.isCompactLayout) {
            this.dynamicBottomClipCompensationCompact = Math.max(0, Math.min(240, (Number(this.dynamicBottomClipCompensationCompact || 0) || 0) + delta));
        } else {
            this.dynamicBottomClipCompensationRegular = Math.max(0, Math.min(320, (Number(this.dynamicBottomClipCompensationRegular || 0) || 0) + delta));
        }

        const geometryKey = this.getBottomClipCompensationGeometryKey();
        this.bottomClipCompensationGeometryKey = geometryKey || this.bottomClipCompensationGeometryKey;
        this.bottomClipCompensationPendingKey = '';
        this.rememberBottomClipCompensation(geometryKey, this.currentDynamicBottomClipCompensation);
        if (geometryKey)
            this.bottomClipCalibrationAttemptsByGeometry.set(geometryKey, 0);
        this.resetBottomClipCalibrationSample();
        this.reflowReaderLayout();
    }

    resetDebugBottomCompensation() {
        if (this.isCompactLayout)
            this.dynamicBottomClipCompensationCompact = 0;
        else
            this.dynamicBottomClipCompensationRegular = 0;

        const geometryKey = this.getBottomClipCompensationGeometryKey();
        this.bottomClipCompensationGeometryKey = geometryKey || this.bottomClipCompensationGeometryKey;
        this.bottomClipCompensationPendingKey = '';
        this.rememberBottomClipCompensation(geometryKey, 0);
        if (geometryKey)
            this.bottomClipCalibrationAttemptsByGeometry.set(geometryKey, 0);
        this.resetBottomClipCalibrationSample();
        this.reflowReaderLayout();
    }

    requestBottomClipCalibration() {
        this.bottomClipCalibrationPending = true;
    }

    scheduleBottomClipCalibrationRetry(delayMs = 220) {
        if (this.bottomCalibrationTimer)
            clearTimeout(this.bottomCalibrationTimer);
        this.bottomClipCalibrationPending = true;
        this.bottomCalibrationTimer = setTimeout(() => {
            this.bottomCalibrationTimer = null;
            this.scheduleBottomClipCalibration();
        }, Math.max(80, Math.round(Number(delayMs || 0) || 0)));
    }

    getBottomClipCalibrationQuietDelayMs() {
        const quietWindowMs = Math.max(320, this.pageAnimationDurationMs + 60);
        const lastLayoutActivityAt = Math.max(
            Number(this.bottomClipGeometryChangedAt || 0) || 0,
            Number(this.bottomClipViewportActivityAt || 0) || 0,
            Number(this.bottomClipPageActivityAt || 0) || 0,
            Number(this.pagedCommittedCalibrationAt || 0) || 0,
        );
        if (!lastLayoutActivityAt)
            return 0;

        return Math.max(0, quietWindowMs - Math.max(0, Date.now() - lastLayoutActivityAt));
    }

    scheduleBottomClipCalibration() {
        if (!this.isPagedMode || typeof window === 'undefined')
            return;

        if (this.bottomCalibrationTimer) {
            clearTimeout(this.bottomCalibrationTimer);
            this.bottomCalibrationTimer = null;
        }
        const quietDelayMs = this.getBottomClipCalibrationQuietDelayMs();
        if (quietDelayMs > 0) {
            this.scheduleBottomClipCalibrationRetry(quietDelayMs);
            return;
        }

        this.bottomClipCalibrationPending = false;
        if (this.compactChromePagedBuildPending) {
            this.compactChromeAwaitingCalibration = true;
            this.touchCompactChromeBuildActivity();
            this.beginCompactChromeStatusHold(4200);
        }
        if (this.bottomCalibrationFrame)
            cancelAnimationFrame(this.bottomCalibrationFrame);

        this.bottomCalibrationFrame = requestAnimationFrame(() => {
            this.bottomCalibrationFrame = requestAnimationFrame(() => {
                this.bottomCalibrationFrame = 0;
                this.calibrateDynamicBottomClipCompensation();
            });
        });
    }

    measureLivePageContentBottom(sheet, html) {
        if (!sheet || !html || typeof window === 'undefined')
            return null;

        const sheetRect = sheet.getBoundingClientRect();
        const sheetStyle = window.getComputedStyle(sheet);
        const paddingBottom = parseFloat(sheetStyle.paddingBottom || '0') || 0;
        const safeBottom = sheetRect.bottom - paddingBottom - 2;

        let maxBottom = -Infinity;

        const walker = document.createTreeWalker(
            html,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (node.nodeType === Node.TEXT_NODE)
                        return (String(node.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT);
                    return NodeFilter.FILTER_ACCEPT;
                },
            },
        );

        let current = walker.currentNode;
        while (current) {
            let rects = [];
            if (current.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(current);
                rects = Array.from(range.getClientRects());
                if (typeof range.detach === 'function')
                    range.detach();
            } else if (typeof current.getClientRects === 'function') {
                rects = Array.from(current.getClientRects());
            }

            for (const rect of rects) {
                if (!rect || rect.height <= 0)
                    continue;
                maxBottom = Math.max(maxBottom, rect.bottom);
            }

            current = walker.nextNode();
        }

        if (!Number.isFinite(maxBottom))
            maxBottom = sheetRect.top;

        return {
            sheetRect,
            safeBottom,
            textBottom: maxBottom,
            overflow: Math.ceil(maxBottom - safeBottom),
        };
    }

    getActiveLivePagedSheet() {
        const readerBody = (this.$refs ? this.$refs.readerBody : null);
        if (!readerBody || typeof window === 'undefined')
            return null;

        const liveSheets = Array.from(readerBody.querySelectorAll('.reader-page-sheet--live'));
        if (!liveSheets.length)
            return null;

        const currentIndex = String(this.currentPageIndex);
        const matchingSheets = liveSheets.filter((sheet) => String(sheet.dataset.pageIndex || '') === currentIndex);
        const candidates = (matchingSheets.length ? matchingSheets : liveSheets);

        let bestSheet = null;
        let bestScore = -Infinity;

        for (const sheet of candidates) {
            const rect = (typeof sheet.getBoundingClientRect === 'function' ? sheet.getBoundingClientRect() : null);
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;

            const style = window.getComputedStyle(sheet);
            if (style.display === 'none' || style.visibility === 'hidden')
                continue;

            const opacity = Math.max(0, Math.min(1, parseFloat(style.opacity || '1') || 0));
            const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth || rect.right) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight || rect.bottom) - Math.max(rect.top, 0));
            const visibleArea = visibleWidth * visibleHeight;
            const score = visibleArea * Math.max(0.15, opacity);

            if (score > bestScore) {
                bestScore = score;
                bestSheet = sheet;
            }
        }

        return (bestSheet || candidates[0] || null);
    }

    completeCompactChromeCalibration() {
        this.compactChromeAwaitingCalibration = false;
        if (!this.compactChromePagedBuildPending)
            return;

        this.touchCompactChromeBuildActivity();
        this.scheduleCompactChromeBuildPendingClear(720);
    }

    calibrateDynamicBottomClipCompensation() {
        if (!this.isPagedMode || typeof window === 'undefined' || typeof document === 'undefined') {
            this.resetBottomClipCalibrationSample();
            this.completeCompactChromeCalibration();
            return;
        }
        if (
            this.loading
            || this.bookPreparing
            || this.controlsOpen
            || this.pagedBuildInProgress
            || this.pagedViewportBuildQueued
            || this.viewportRefreshFrame
        ) {
            this.resetBottomClipCalibrationSample();
            this.bottomClipCalibrationPending = true;
            return;
        }
        if (this.layoutRefreshing) {
            this.resetBottomClipCalibrationSample();
            this.bottomClipCalibrationPending = true;
            if (this.bottomCalibrationFrame)
                cancelAnimationFrame(this.bottomCalibrationFrame);
            this.bottomCalibrationFrame = requestAnimationFrame(() => {
                this.bottomCalibrationFrame = 0;
                this.scheduleBottomClipCalibration();
            });
            return;
        }
        const quietDelayMs = this.getBottomClipCalibrationQuietDelayMs();
        if (quietDelayMs > 0) {
            this.resetBottomClipCalibrationSample();
            this.scheduleBottomClipCalibrationRetry(quietDelayMs);
            return;
        }

        const geometryKey = this.getBottomClipCompensationGeometryKey();
        if (!geometryKey) {
            this.resetBottomClipCalibrationSample();
            this.completeCompactChromeCalibration();
            return;
        }
        if (this.syncBottomClipCompensationGeometry()) {
            this.bottomClipCalibrationPending = true;
            this.updateScrollerViewport();
            return;
        }
        const currentLayoutSignature = this.getPagedLayoutSignature();
        if (
            !this.pagedPages.length
            || !this.pagedLayoutSignature
            || currentLayoutSignature !== this.pagedLayoutSignature
            || geometryKey !== this.pagedCommittedCalibrationKey
        ) {
            this.resetBottomClipCalibrationSample();
            this.bottomClipCalibrationPending = true;
            this.updateScrollerViewport();
            return;
        }

        const sheet = this.getActiveLivePagedSheet();
        const html = (sheet ? sheet.querySelector('.reader-html') : null);
        if (!sheet || !html || typeof document.createRange !== 'function') {
            this.resetBottomClipCalibrationSample();
            this.completeCompactChromeCalibration();
            return;
        }

        const metrics = this.measureLivePageContentBottom(sheet, html);
        if (!metrics) {
            this.resetBottomClipCalibrationSample();
            this.completeCompactChromeCalibration();
            return;
        }

        if (this.readerDebugEnabled) {
            this.readerDebug = Object.assign({}, this.readerDebug, {
                liveSheetHeight: Math.round(metrics.sheetRect.height),
                liveSafeBottom: Math.round(metrics.safeBottom),
                liveTextBottom: Math.round(metrics.textBottom),
                liveOverflowPx: Math.round(metrics.overflow),
            });
        }

        if (!this.isCompactLayout) {
            this.bottomClipCompensationPendingKey = '';
            this.rememberBottomClipCompensation(geometryKey, this.currentDynamicBottomClipCompensation);
            this.bottomClipCalibrationAttemptsByGeometry.delete(geometryKey);
            this.resetBottomClipCalibrationSample();
            this.completeCompactChromeCalibration();
            return;
        }

        const overflow = metrics.overflow;
        const currentDynamic = this.currentDynamicBottomClipCompensation;
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.15, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const linePx = Math.max(18, Math.round(fontSize * lineHeight));
        const increaseTolerance = Math.max(6, Math.round(linePx * 0.22));
        const configuredMaxDynamicCompensation = Math.max(
            linePx * 2,
            Math.round(linePx * (this.isCompactLayout ? 3.8 : 4.6)),
        );
        const measuredAvailableHeight = this.pagedMeasureAvailableHeight;
        const appliedDynamicCompensation = this.pagedAppliedBottomClipCompensation;
        const rawMeasureHeight = measuredAvailableHeight + appliedDynamicCompensation;
        const maxDynamicCompensation = Math.min(
            configuredMaxDynamicCompensation,
            (rawMeasureHeight > 0 ? Math.max(0, rawMeasureHeight - 1) : configuredMaxDynamicCompensation),
        );

        if (currentDynamic > maxDynamicCompensation) {
            this.setCurrentDynamicBottomClipCompensation(maxDynamicCompensation);
            this.bottomClipCompensationPendingKey = geometryKey;
            this.resetBottomClipCalibrationSample();
            this.reflowReaderLayout();
            return;
        }

        if (overflow > increaseTolerance && overflow <= 160) {
            const sampleKey = [geometryKey, this.pagedLayoutSignature, this.currentPageIndex].join('|');
            const sampleTolerance = Math.max(4, Math.round(linePx * 0.18));
            const matchingSample = !!(
                sampleKey === this.bottomClipCalibrationSampleKey
                && this.bottomClipCalibrationSampleGeneration === this.pagedCommittedCalibrationGeneration
                && Math.abs(overflow - this.bottomClipCalibrationSampleOverflow) <= sampleTolerance
            );
            if (matchingSample)
                this.bottomClipCalibrationSampleCount += 1;
            else {
                this.bottomClipCalibrationSampleKey = sampleKey;
                this.bottomClipCalibrationSampleCount = 1;
                this.bottomClipCalibrationSampleGeneration = this.pagedCommittedCalibrationGeneration;
            }
            this.bottomClipCalibrationSampleOverflow = overflow;
            if (this.bottomClipCalibrationSampleCount < 2) {
                this.scheduleBottomClipCalibrationRetry(180);
                return;
            }

            this.resetBottomClipCalibrationSample();
            const attempts = Math.max(0, Number(this.bottomClipCalibrationAttemptsByGeometry.get(geometryKey) || 0) || 0);
            if (attempts >= 3) {
                this.bottomClipCompensationPendingKey = '';
                this.rememberBottomClipCompensation(geometryKey, currentDynamic);
                this.bottomClipCalibrationAttemptsByGeometry.delete(geometryKey);
                this.completeCompactChromeCalibration();
                return;
            }
            const nextValue = Math.min(maxDynamicCompensation, currentDynamic + overflow + 2);
            if (nextValue === currentDynamic) {
                this.bottomClipCompensationPendingKey = '';
                this.rememberBottomClipCompensation(geometryKey, currentDynamic);
                this.bottomClipCalibrationAttemptsByGeometry.delete(geometryKey);
                this.completeCompactChromeCalibration();
                return;
            }

            this.setCurrentDynamicBottomClipCompensation(nextValue);
            this.bottomClipCompensationPendingKey = geometryKey;
            this.bottomClipCalibrationAttemptsByGeometry.set(geometryKey, attempts + 1);
            this.reflowReaderLayout();
            return;
        }

        this.bottomClipCompensationPendingKey = '';
        this.rememberBottomClipCompensation(geometryKey, currentDynamic);
        this.bottomClipCalibrationAttemptsByGeometry.delete(geometryKey);
        this.resetBottomClipCalibrationSample();
        this.completeCompactChromeCalibration();
    }
}
