//Место чтения при перестройке разметки (смена настроек, размера окна, режима): якорь - текст или картинка
//в левом верхнем углу экрана - запоминается до перестройки, после неё к нему возвращаемся и коротко подсвечиваем.
//Своего состояния нет: якоря и таймеры - поля Reader.
const readerTextAnchors = require('./readerTextAnchors');

export default class ReaderReflow {
    getPagedAnchorSheet(sheet = null) {
        if (!sheet || typeof sheet.querySelectorAll !== 'function' || typeof window === 'undefined')
            return sheet || null;
        if (!this.isDualPagedSpread)
            return sheet;

        const columns = Array.from(sheet.querySelectorAll('.reader-page-column-sheet:not(.reader-page-column-sheet--empty)'));
        if (!columns.length)
            return sheet;

        let bestColumn = null;
        let bestTop = Infinity;
        let bestLeft = Infinity;

        for (const column of columns) {
            if (!column || typeof column.getBoundingClientRect !== 'function')
                continue;

            const rect = column.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;

            const style = window.getComputedStyle(column);
            if (style.display === 'none' || style.visibility === 'hidden')
                continue;

            const top = Math.round(rect.top);
            const left = Math.round(rect.left);
            if (top < bestTop || (top === bestTop && left < bestLeft)) {
                bestColumn = column;
                bestTop = top;
                bestLeft = left;
            }
        }

        return bestColumn || columns[0] || sheet;
    }

    getPagedAnchorPageIndex() {
        const rawIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Math.round(Number(this.currentPageIndex || 0) || 0)));
        return rawIndex;
    }

    cloneReaderReflowAnchor(anchor = null) {
        if (!anchor || typeof anchor !== 'object')
            return null;

        return Object.assign({}, anchor);
    }

    rememberStableReaderReflowAnchor(anchor = null) {
        const safeAnchor = this.cloneReaderReflowAnchor(anchor);
        if (!safeAnchor || !String(safeAnchor.textSnippet || '').trim())
            return;

        this.stableReaderReflowAnchor = safeAnchor;
    }

    clearPendingReaderNavigationRestore({clearNoteReturn = false} = {}) {
        this.pendingReflowAnchor = null;
        this.stableReaderReflowAnchor = null;
        this.reflowPageStartOverride = null;
        this.pendingReaderAnchorJump = null;
        this.restorePending = false;
        this.restoreFromSavedProgress = false;
        if (this.restoreProgressFrame && typeof cancelAnimationFrame === 'function')
            cancelAnimationFrame(this.restoreProgressFrame);
        this.restoreProgressFrame = 0;
        this.clearReaderReflowAnchorHighlight();
        if (clearNoteReturn)
            this.readerNoteReturnPoint = null;
    }

    capturePendingReflowAnchor(force = false, {preferStable = false} = {}) {
        if (!this.bookUid)
            return null;
        if (!force && this.pendingReflowAnchor)
            return this.pendingReflowAnchor;

        const anchor = this.captureReaderReflowAnchor();
        if (anchor) {
            this.pendingReflowAnchor = anchor;
            this.rememberStableReaderReflowAnchor(anchor);
            return this.pendingReflowAnchor;
        }
        if (!force && preferStable && this.stableReaderReflowAnchor) {
            this.pendingReflowAnchor = this.cloneReaderReflowAnchor(this.stableReaderReflowAnchor);
            return this.pendingReflowAnchor;
        }
        return this.pendingReflowAnchor;
    }

    captureReaderReflowAnchor() {
        if (this.isPagedMode)
            return this.capturePagedReflowAnchor();

        return this.captureScrollReflowAnchor();
    }

    capturePagedReflowAnchor() {
        const pageIndex = this.getPagedAnchorPageIndex();
        const page = this.pagedPages[pageIndex] || null;
        const sheet = this.getActiveLivePagedSheet();
        const anchorSheet = this.getPagedAnchorSheet(sheet);
        const contentRoot = (anchorSheet && anchorSheet.querySelector('.reader-page-content, .reader-html')) || null;
        const caretAnchor = this.captureTopLeftReaderTextAnchor(contentRoot);
        const focusNode = this.findTopLeftReaderContentNode(contentRoot);
        const focusId = caretAnchor.id || readerTextAnchors.getReaderNodeAnchorId(focusNode);
        const focusText = caretAnchor.textSnippet
            || readerTextAnchors.getReaderNodeTextSnippet(focusNode)
            || readerTextAnchors.getReaderNodeImageAnchor(focusNode)
            || this.getPagedVisibleTextSnippet(anchorSheet)
            || this.getPagedVisibleImageAnchor(anchorSheet);
        const textOffset = Number(caretAnchor.textOffset) >= 0
            ? caretAnchor.textOffset
            : this.getPagedTextOffsetForSnippet(focusText, pageIndex);

        return {
            mode: 'paged',
            pageIndex,
            spreadMode: this.isDualPagedSpread ? 'dual' : 'single',
            sectionId: String((page && page.sectionId) || this.currentSectionId || '').trim(),
            id: focusId,
            textSnippet: focusText,
            textOffset,
        };
    }

    captureTopLeftReaderTextAnchor(root = null) {
        if (!root || typeof document === 'undefined' || typeof window === 'undefined' || typeof document.createRange !== 'function')
            return {};

        const textPosition = readerTextAnchors.findTopLeftReaderTextPosition(root);
        if (!textPosition || !textPosition.node)
            return {};

        const textSnippet = readerTextAnchors.getReaderTextSnippetFromPosition(root, textPosition.node, textPosition.offset);
        if (!textSnippet)
            return {};

        return {
            id: readerTextAnchors.getReaderNodeAnchorId(textPosition.node.parentElement),
            textSnippet,
            textOffset: this.getPagedTextOffsetForSnippet(textSnippet, this.getPagedAnchorPageIndex()),
        };
    }

    captureScrollReflowAnchor() {
        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (!scroller)
            return null;

        const contentRoot = scroller.querySelector('.reader-html');
        const focusNode = this.findTopLeftReaderContentNode(contentRoot);
        const focusId = readerTextAnchors.getReaderNodeAnchorId(focusNode);
        const focusText = readerTextAnchors.getReaderNodeTextSnippet(focusNode);

        return {
            mode: 'scroll',
            sectionId: String(this.currentSectionId || '').trim(),
            id: focusId,
            textSnippet: focusText,
            scrollTop: Math.max(0, Number(scroller.scrollTop || 0) || 0),
        };
    }

    findTopLeftReaderContentNode(root = null) {
        if (!root || typeof root.querySelectorAll !== 'function' || typeof window === 'undefined')
            return null;

        const nodes = [root].concat(Array.from(root.querySelectorAll('*')));
        let bestNode = null;
        let bestTop = Infinity;
        let bestLeft = Infinity;

        for (const node of nodes) {
            if (!node || typeof node.getBoundingClientRect !== 'function')
                continue;
            if (node === root)
                continue;
            if (readerTextAnchors.isReaderHighlightContainerNode(node))
                continue;

            const rect = node.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;

            const hasId = !!readerTextAnchors.getReaderNodeAnchorId(node);
            const text = readerTextAnchors.normalizeReaderSearchText(node.textContent || '');
            const hasReadableText = text.length >= 12;
            const hasImage = !!(typeof node.querySelector === 'function' && node.querySelector('img'));
            if (!hasId && !hasReadableText && !hasImage)
                continue;

            const top = Math.round(rect.top);
            const left = Math.round(rect.left);
            if (top < bestTop || (top === bestTop && left < bestLeft)) {
                bestNode = node;
                bestTop = top;
                bestLeft = left;
            }
        }

        return bestNode;
    }

    getPagedVisibleTextSnippet(sheet = null) {
        const pageIndex = this.getPagedAnchorPageIndex();
        const modelText = this.getPagedPageSearchText(pageIndex);

        if (sheet && typeof sheet.querySelector === 'function') {
            const anchorSheet = this.getPagedAnchorSheet(sheet);
            const contentRoots = Array.from(anchorSheet.querySelectorAll('.reader-html')).slice(0, 1);
            const text = readerTextAnchors.normalizeReaderSearchText(contentRoots.map(node => (node && (node.innerText || node.textContent)) || '').filter(Boolean).join(' '));
            if (text && (text.length >= 24 || text.length >= modelText.length))
                return text.slice(0, 240);
        }

        if (!modelText)
            return '';

        return modelText.slice(0, 240);
    }

    getPagedVisibleImageAnchor(sheet = null) {
        if (!sheet || typeof sheet.querySelector !== 'function')
            return '';

        const anchorSheet = this.getPagedAnchorSheet(sheet);
        const image = anchorSheet.querySelector('.reader-html img, img');
        if (!image)
            return '';

        return readerTextAnchors.normalizeReaderImageAnchor(image.getAttribute('src') || image.currentSrc || image.src || '');
    }

    restorePendingReflowAnchor() {
        const anchor = this.pendingReflowAnchor;
        if (!anchor)
            return false;

        const restored = this.restoreReaderReflowAnchor(anchor);
        if (restored) {
            this.scheduleReaderReflowAnchorHighlight(anchor);
            this.pendingReflowAnchor = null;
        }
        return restored;
    }

    restoreReaderReflowAnchor(anchor = null) {
        if (!anchor)
            return false;

        if (anchor.mode === 'paged') {
            let pageIndex = -1;
            if (pageIndex < 0 && anchor.textSnippet)
                pageIndex = this.findPagedPageIndexByTextSnippet(anchor.textSnippet, anchor.pageIndex);
            if (pageIndex < 0 && Number(anchor.textOffset) >= 0)
                pageIndex = this.findPagedPageIndexByTextOffset(anchor.textOffset);
            if (pageIndex < 0 && Number(anchor.textOffset) >= 0)
                pageIndex = this.findPagedPageIndexByPageStartOffset(anchor.textOffset);
            if (pageIndex < 0 && anchor.id)
                pageIndex = this.findPagedPageIndexByAnchor(anchor.id);
            if (pageIndex < 0 && anchor.sectionId)
                pageIndex = this.getPageIndexForSection(anchor.sectionId);
            if (pageIndex < 0)
                pageIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Number(anchor.pageIndex || 0) || 0));

            if (anchor.spreadMode === 'dual' && this.isDualPagedSpread) {
                const rawIndex = Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Math.round(Number(pageIndex || 0) || 0)));
                const previousIndex = this.currentPageIndex;
                this.pageTurnDirection = (rawIndex < this.currentPageIndex ? -1 : 1);
                this.currentPageIndex = rawIndex;
                if (rawIndex !== previousIndex) {
                    this.bottomClipPageActivityAt = Date.now();
                    this.resetBottomClipCalibrationSample();
                }
                this.setReflowPageStartOverride(rawIndex, anchor);
                this.syncPagedProgress(false);
            } else {
                this.setReflowPageStartOverride(pageIndex, anchor);
                this.setCurrentPagedPage(pageIndex, false);
            }
            return true;
        }

        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (!scroller)
            return false;

        let target = null;
        if (anchor.id)
            target = scroller.querySelector(`#${this.escapeCssId(anchor.id)}`);
        if (!target && anchor.textSnippet)
            target = readerTextAnchors.findReaderNodeByTextSnippet(scroller.querySelector('.reader-html'), anchor.textSnippet);
        if (!target && anchor.sectionId)
            target = scroller.querySelector(`#${this.escapeCssId(anchor.sectionId)}`);

        scroller.scrollTop = (target
            ? this.readerScrollTargetTop(scroller, target)
            : Math.max(0, Number(anchor.scrollTop || 0) || 0));
        this.restoredScrollTop = scroller.scrollTop;
        this.updateCurrentSectionFromScroll();
        return true;
    }

    setReflowPageStartOverride(pageIndex = -1, anchor = null) {
        const textSnippet = String((anchor && anchor.textSnippet) || '').trim();
        if (!this.isPagedMode || !textSnippet || textSnippet.startsWith('image:') || Number(pageIndex) < 0) {
            this.reflowPageStartOverride = null;
            return;
        }

        this.reflowPageStartOverride = {
            pageIndex: Math.max(0, Math.min(this.totalPagedLogicalPages - 1, Math.round(Number(pageIndex || 0) || 0))),
            textSnippet,
        };
    }

    async scheduleReaderReflowAnchorHighlight(anchor = null) {
        if (!anchor || typeof window === 'undefined')
            return;

        await this.$nextTick();
        for (let attempt = 0; attempt < 12; attempt += 1) {
            await this.waitForAnimationFrames(2);
            if (this.highlightReaderReflowAnchor(anchor))
                return;
            await new Promise(resolve => setTimeout(resolve, 180));
        }
    }

    highlightReaderReflowAnchor(anchor = null) {
        this.clearReaderReflowAnchorHighlight();
        if (!anchor || typeof document === 'undefined')
            return false;

        let target = null;
        if (anchor.mode === 'paged') {
            const sheet = this.getActiveLivePagedSheet();
            const anchorSheet = this.getPagedAnchorSheet(sheet);
            target = this.findReaderReflowHighlightTarget(anchorSheet, anchor);
        } else {
            const scroller = (this.$refs ? this.$refs.scroller : null);
            target = this.findReaderReflowHighlightTarget(scroller, anchor);
        }

        if (!target || !target.classList)
            return false;

        target.classList.add('reader-reflow-anchor-highlight');
        this.reflowAnchorHighlightTimer = setTimeout(() => {
            if (target && target.classList)
                target.classList.remove('reader-reflow-anchor-highlight');
            if (this.reflowAnchorHighlightTimer)
                this.reflowAnchorHighlightTimer = null;
        }, 4200);
        return true;
    }

    clearReaderReflowAnchorHighlight() {
        if (this.reflowAnchorHighlightTimer) {
            clearTimeout(this.reflowAnchorHighlightTimer);
            this.reflowAnchorHighlightTimer = null;
        }

        if (typeof document === 'undefined')
            return;

        document.querySelectorAll('.reader-reflow-anchor-highlight').forEach((node) => {
            if (node && node.classList)
                node.classList.remove('reader-reflow-anchor-highlight');
        });
    }

    findReaderReflowHighlightTarget(root = null, anchor = {}) {
        if (!root || typeof root.querySelector !== 'function')
            return null;

        let target = null;
        if (anchor.id)
            target = root.querySelector(`#${this.escapeCssId(anchor.id)}`);
        if (!target && anchor.textSnippet)
            target = readerTextAnchors.findReaderNodeByTextSnippet(root.querySelector('.reader-html') || root, anchor.textSnippet);
        if (!target && anchor.textSnippet && String(anchor.textSnippet || '').startsWith('image:'))
            target = readerTextAnchors.findReaderNodeByImageAnchor(root, anchor.textSnippet);
        if (!target && anchor.sectionId)
            target = root.querySelector(`#${this.escapeCssId(anchor.sectionId)}`);

        return target;
    }

    reflowReaderLayout() {
        this.clearSpacingReflowTimer();
        this.readerSettingsReflowPending = false;
        this.pagedLayoutSignature = '';
        if (this.isPagedMode && this.isCompactLayout && this.compactChromeHidden) {
            this.compactChromePagedBuildPending = true;
            this.beginCompactChromeStatusHold(2600);
            this.touchCompactChromeBuildActivity();
        }
        this.capturePendingReflowAnchor(!this.pendingReflowAnchor);
        this.beginLayoutRefresh();
        this.restorePending = true;
        this.restoreFromSavedProgress = false;
        this.requestBottomClipCalibration();
        this.runAfterLayoutRefreshPaint(() => {
            this.updateScrollerViewport();
            requestAnimationFrame(() => {
                this.restoreProgress();
                this.endLayoutRefresh(220);
            });
        });
    }

    requestReaderSettingsReflow({previewSpacing = false, immediate = false} = {}) {
        if (!this.bookUid) {
            this.readerSettingsReflowPending = false;
            return;
        }

        if (immediate || !this.controlsOpen) {
            this.reflowReaderLayout();
            return;
        }

        this.clearSpacingReflowTimer();
        this.readerSettingsReflowPending = true;
        this.capturePendingReflowAnchor(!this.pendingReflowAnchor);
        if (previewSpacing)
            this.applyLiveSpacingPreview();
    }

    applyPendingReaderSettingsReflow() {
        if (!this.readerSettingsReflowPending)
            return;

        this.reflowReaderLayout();
    }

    applyLiveSpacingPreview() {
        if (!this.bookUid || !this.isPagedMode)
            return;

        this.capturePendingReflowAnchor();
    }

    clearSpacingReflowTimer() {
        if (this.spacingReflowTimer) {
            clearTimeout(this.spacingReflowTimer);
            this.spacingReflowTimer = null;
        }
    }

    showPagePaddingPreview(edge = '') {
        const safeEdge = ['top', 'bottom', 'left', 'right'].includes(edge) ? edge : '';
        if (!safeEdge)
            return;

        this.pagePaddingPreviewEdge = safeEdge;
        if (this.pagePaddingPreviewTimer)
            clearTimeout(this.pagePaddingPreviewTimer);
        this.pagePaddingPreviewTimer = setTimeout(() => {
            this.pagePaddingPreviewTimer = null;
            this.pagePaddingPreviewEdge = '';
        }, 1800);
    }
}
