//Место чтения при перестройке разметки (смена настроек, размера окна, режима): якорь - текст или картинка
//в левом верхнем углу экрана - запоминается до перестройки, после неё к нему возвращаемся и коротко подсвечиваем.
//Своего состояния нет: якоря и таймеры - поля Reader.
const readerTextAnchors = require('./readerTextAnchors');
const readerScrollAnchor = require('../../share/readerScrollAnchor');

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
        this.pendingPagedNavigation = null;
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
        //прежнее место ещё не вернули (идёт разбивка): на экране не оно, а якорь и есть место чтения
        if (this.restorePending && this.pendingReflowAnchor)
            return this.pendingReflowAnchor;
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
        //страница открыта по месту из ленты и её не листали: то же место, иначе возврат в ленту уводит к началу страницы
        const stable = this.stableReaderReflowAnchor;
        if (stable && stable.mode === 'scroll' && stable.pageIndex === pageIndex)
            return this.cloneReaderReflowAnchor(stable);
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
            percent: pageIndex / Math.max(1, this.totalPagedLogicalPages - 1),
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
        if (readerScrollAnchor.keepsPlace(this.stableReaderReflowAnchor, scroller.scrollTop))
            return this.cloneReaderReflowAnchor(this.stableReaderReflowAnchor);

        //первая строка под панелью: узел с наименьшим top нашёлся бы выше экрана, вплоть до начала книги
        const contentRoot = scroller.querySelector('.reader-html');
        const readingTop = this.getScrollReadingTop(scroller);
        const rootRect = contentRoot ? contentRoot.getBoundingClientRect() : null;
        const position = rootRect && readerTextAnchors.findReaderTextPositionBelow(contentRoot,
            Math.max(rootRect.left, scroller.getBoundingClientRect().left) + 1, readingTop, scroller.getBoundingClientRect().bottom);
        const textSnippet = position ? readerTextAnchors.getReaderTextSnippetFromPosition(contentRoot, position.node, position.offset) : '';
        const sectionId = String(this.currentSectionId || '').trim();
        //на экране нет текста (картинка во весь экран): хотя бы та же глава
        if (!textSnippet)
            return {mode: 'scroll', sectionId, id: '', textSnippet: '', scrollTop: Math.round(scroller.scrollTop)};

        const nodes = readerTextAnchors.getReaderTextNodes(contentRoot);
        const lengths = nodes.map(node => node.nodeValue.length);
        const textOffset = readerScrollAnchor.textOffset(lengths, nodes.indexOf(position.node), position.offset);
        return {
            mode: 'scroll',
            sectionId,
            id: readerTextAnchors.getReaderNodeAnchorId(position.node.parentElement),
            textSnippet,
            textOffset,
            percent: readerScrollAnchor.textPercent(lengths, textOffset),
            lineTop: Math.round(position.top - readingTop),
            scrollTop: Math.round(scroller.scrollTop),
        };
    }

    getScrollReadingTop(scroller) {
        return scroller.getBoundingClientRect().top + this.readerScrollTopInset;
    }

    //Символ якоря в разметке ленты: по смещению, если текст там тот же, иначе (якорь из режима страниц) по фрагменту
    findScrollAnchorTextPosition(scroller, anchor = null) {
        const contentRoot = scroller ? scroller.querySelector('.reader-html') : null;
        const textSnippet = String((anchor && anchor.textSnippet) || '');
        if (!contentRoot || !textSnippet || textSnippet.startsWith('image:'))
            return null;

        const nodes = readerTextAnchors.getReaderTextNodes(contentRoot);
        const lengths = nodes.map(node => node.nodeValue.length);
        let position = (anchor.mode === 'scroll' ? readerScrollAnchor.textPosition(lengths, anchor.textOffset) : null);
        let text = (position ? readerTextAnchors.getReaderTextSnippetFromPosition(contentRoot, nodes[position.index], position.offset) : '');
        if (!position || text.slice(0, 48) !== textSnippet.slice(0, 48)) {
            //фрагмент ищем около той же доли книги: короткие фразы в книге повторяются
            const near = readerScrollAnchor.percentPosition(lengths, anchor.percent);
            const from = Math.max(0, (near ? near.index : 0) - 400);
            const found = readerScrollAnchor.findText(nodes.slice(from, from + 800).map(node => node.nodeValue), textSnippet, (near ? near.index : 0) - from);
            if (!found)
                return null;
            position = {index: from + found.index, offset: found.offset};
            text = readerTextAnchors.getReaderTextSnippetFromPosition(contentRoot, nodes[position.index], found.offset);
        }

        const textOffset = readerScrollAnchor.textOffset(lengths, position.index, position.offset);
        return {
            node: nodes[position.index],
            offset: position.offset,
            textOffset,
            percent: readerScrollAnchor.textPercent(lengths, textOffset),
            textSnippet: text,
        };
    }

    //Ставит символ якоря на ту же высоту под панелью. Прокрутка самой читалкой - не чтение (restoredScrollTop)
    restoreScrollTextAnchor(scroller, anchor = null) {
        const position = this.findScrollAnchorTextPosition(scroller, anchor);
        const rect = position && readerTextAnchors.getReaderTextRect(position.node, position.offset);
        if (!rect)
            return false;

        scroller.scrollTop += rect.top - (this.getScrollReadingTop(scroller) + (Number(anchor.lineTop) || 0));
        this.restoredScrollTop = scroller.scrollTop;
        this.rememberStableReaderReflowAnchor({
            mode: 'scroll',
            sectionId: anchor.sectionId,
            id: anchor.id,
            textSnippet: position.textSnippet,
            textOffset: position.textOffset,
            percent: position.percent,
            lineTop: Number(anchor.lineTop) || 0,
            scrollTop: Math.round(scroller.scrollTop),
        });
        return true;
    }

    //Лента после смены размера окна, панели или картинки: место не сдвигается, если читатель не прокручивал
    restoreStableScrollReflowAnchor() {
        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (this.isPagedMode || this.loading || !scroller || !scroller.clientHeight
            || !readerScrollAnchor.keepsPlace(this.stableReaderReflowAnchor, scroller.scrollTop))
            return;

        if (this.restoreScrollTextAnchor(scroller, this.stableReaderReflowAnchor))
            this.updateCurrentSectionFromScroll();
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

        if (this.isPagedMode) {
            const scrollAnchor = (anchor.mode !== 'paged' ? anchor : null);
            //якорь из ленты (сменился режим, у e-ink он свой): смещения ленты к страницам не подходят, ищем по тексту
            if (scrollAnchor) {
                anchor = {
                    mode: 'paged',
                    pageIndex: Math.round((Number(anchor.percent) || 0) * Math.max(0, this.totalPagedLogicalPages - 1)),
                    sectionId: anchor.sectionId,
                    id: anchor.id,
                    textSnippet: anchor.textSnippet,
                };
            }
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
            if (scrollAnchor && scrollAnchor.textSnippet)
                this.stableReaderReflowAnchor = Object.assign({}, scrollAnchor, {pageIndex: this.getPagedAnchorPageIndex()});
            return true;
        }

        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (!scroller)
            return false;
        if (this.restoreScrollTextAnchor(scroller, anchor)) {
            this.updateCurrentSectionFromScroll();
            return true;
        }

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
        if (this.isPagedMode) {
            const sheet = this.getActiveLivePagedSheet();
            const anchorSheet = this.getPagedAnchorSheet(sheet);
            target = this.findReaderReflowHighlightTarget(anchorSheet, anchor);
        } else {
            const scroller = (this.$refs ? this.$refs.scroller : null);
            const position = this.findScrollAnchorTextPosition(scroller, anchor);
            target = (position
                ? (position.node.parentElement.closest('p') || position.node.parentElement)
                : this.findReaderReflowHighlightTarget(scroller, anchor));
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

        //в ленте нечего перестраивать: место возвращаем сразу, а не после закрытия панели
        if (immediate || !this.controlsOpen || !this.isPagedMode) {
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
