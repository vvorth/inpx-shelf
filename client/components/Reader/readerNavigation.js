//Переходы по книге: оглавление, аннотация и сноски, внутренние ссылки с возвратом к месту, соседняя глава,
//текущая глава по положению в тексте. Своего состояния нет: оглавление и точка возврата - поля Reader.
const readerTextAnchors = require('./readerTextAnchors');

export default class ReaderNavigation {
    get displayContents() {
        return this.contents.slice(0, 120);
    }

    get inlineContents() {
        return this.displayContents.slice(0, 12);
    }

    get hasContents() {
        return this.displayContents.length > 0;
    }

    get hasAnnotation() {
        return !!String(this.readerAnnotationHtml || '').trim();
    }

    get hasBookNotes() {
        return !!String(this.readerNotesAnchorId || '').trim();
    }

    get hasContentsMenu() {
        return this.hasContents || this.hasAnnotation || this.hasBookNotes;
    }

    get currentSectionTitle() {
        const current = this.contents.find((item) => item.id === this.currentSectionId);
        return (current ? current.title : '');
    }

    get currentSectionIndex() {
        return this.contents.findIndex((item) => item.id === this.currentSectionId);
    }

    get hasPrevSection() {
        return this.currentSectionIndex > 0;
    }

    get hasNextSection() {
        return this.currentSectionIndex >= 0 && this.currentSectionIndex < this.contents.length - 1;
    }

    toggleContentsDialog() {
        const nextOpen = !this.contentsDialogOpen;
        this.contentsPanelView = 'contents';
        this.contentsDialogOpen = nextOpen;
    }

    showReaderAnnotation() {
        if (this.hasAnnotation)
            this.contentsPanelView = 'annotation';
    }

    showReaderNotes() {
        if (!this.hasBookNotes)
            return;

        this.jumpToReaderAnchor(this.readerNotesAnchorId, {
            returnPoint: this.captureReaderNoteReturnPoint(),
        });
    }

    showContentsList() {
        this.contentsPanelView = 'contents';
    }

    closeContentsDialog() {
        this.contentsDialogOpen = false;
        this.contentsPanelView = 'contents';
    }

    toggleInlineContents() {
        this.inlineContentsVisible = !this.inlineContentsVisible;
    }

    handleReaderLinkClick(event) {
        const link = this.getReaderInternalLink(event && event.target);
        if (!link || link.closest('.reader-annotation-html'))
            return;

        event.preventDefault();
        event.stopPropagation();
        this.jumpToReaderAnchor(this.getReaderLinkTarget(link), {
            returnPoint: this.captureReaderNoteReturnPoint(),
        });
    }

    updateCurrentSectionFromScroll() {
        if (!this.$refs.scroller || !this.contents.length)
            return;

        if (this.isPagedMode) {
            const currentPage = this.pagedPages[this.currentPagedPageIndex] || null;
            const activeId = String((currentPage && currentPage.sectionId) || '').trim();
            this.currentSectionId = activeId || (this.contents[0] ? this.contents[0].id : '');
            return;
        }

        const scroller = this.$refs.scroller;
        const visibleTop = scroller.getBoundingClientRect().top + this.readerScrollTopInset;
        let activeId = this.currentSectionId;
        for (const item of this.contents) {
            const target = scroller.querySelector(`#${this.escapeCssId(item.id)}`);
            if (!target)
                continue;

            if (target.getBoundingClientRect().top - visibleTop <= 80) {
                activeId = item.id;
            } else {
                break;
            }
        }

        this.currentSectionId = activeId || (this.contents[0] ? this.contents[0].id : '');
    }

    jumpToContent(id = '') {
        this.clearPendingReaderNavigationRestore({clearNoteReturn: true});
        this.closeContentsDialog();
        this.chromeHidden = false;
        if (!id)
            return;

        this.$nextTick(() => {
            this.currentSectionId = id;
            if (this.isPagedMode) {
                const pageIndex = this.getPageIndexForSection(id);
                this.setCurrentPagedPage((pageIndex >= 0 ? pageIndex : 0), true);
                return;
            }

            if (!this.$refs.scroller)
                return;

            const scroller = this.$refs.scroller;
            const target = scroller.querySelector(`#${this.escapeCssId(id)}`);
            if (!target)
                return;

            const top = this.readerScrollTargetTop(scroller, target);
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    readerHtmlHasAnchor(id = '') {
        const safeId = String(id || '').trim();
        if (!safeId || !this.readerHtml || typeof document === 'undefined')
            return false;

        return !!readerTextAnchors.parseInertHtml(this.readerHtml).content.querySelector(`#${this.escapeCssId(safeId)}`);
    }

    handleReaderAnnotationClick(event) {
        const root = event && event.currentTarget;
        const link = event && event.target && event.target.closest
            ? event.target.closest('a[href], .reader-note-link')
            : null;
        if (!root || !link || !root.contains(link))
            return;

        const targetId = this.getReaderLinkTarget(link);
        if (!targetId)
            return;

        event.preventDefault();
        event.stopPropagation();
        const escapedId = this.escapeCssId(targetId);
        const readerTarget = this.$refs && this.$refs.scroller
            ? this.$refs.scroller.querySelector(`#${escapedId}`)
            : null;
        const readerPageIndex = this.isPagedMode ? this.findPagedPageIndexByAnchor(targetId) : -1;
        if (readerTarget || readerPageIndex >= 0 || this.readerHtmlHasAnchor(targetId)) {
            this.jumpToReaderAnchor(targetId, {
                returnPoint: this.captureReaderNoteReturnPoint(),
            });
            return;
        }

        const annotationTarget = root.querySelector(`#${escapedId}`);
        if (annotationTarget && typeof annotationTarget.scrollIntoView === 'function')
            annotationTarget.scrollIntoView({behavior: 'smooth', block: 'start'});
    }

    captureReaderNoteReturnPoint() {
        const scroller = (this.$refs ? this.$refs.scroller : null);
        return {
            paged: !!this.isPagedMode,
            pageIndex: this.currentPageIndex,
            spreadPageIndex: this.currentPagedPageIndex,
            pagedStep: this.pagedStep,
            scrollTop: scroller ? Math.max(0, scroller.scrollTop || 0) : 0,
            sectionId: String(this.currentSectionId || '').trim(),
        };
    }

    getReaderLinkTarget(link = null) {
        if (!link)
            return '';

        const dataTarget = String(link.getAttribute('data-reader-target') || '').trim();
        if (dataTarget)
            return dataTarget;

        const href = String(link.getAttribute('href') || '').trim();
        const hashIndex = href.lastIndexOf('#');
        if (hashIndex < 0)
            return '';

        const rawTarget = href.slice(hashIndex + 1).trim();
        if (!rawTarget)
            return '';

        try {
            return decodeURIComponent(rawTarget);
        } catch(e) {
            return rawTarget;
        }
    }

    getReaderInternalLink(target = null) {
        if (!target || !target.closest)
            return null;

        const link = target.closest('a[href], .reader-note-link');
        if (!link || !this.$refs || !this.$refs.page || !this.$refs.page.contains(link))
            return null;

        return this.getReaderLinkTarget(link) ? link : null;
    }

    jumpToReaderAnchor(id = '', options = {}) {
        const safeId = String(id || '').trim();
        if (!safeId)
            return;

        if (this.shouldDeferPagedAnchorJump()) {
            this.pendingReaderAnchorJump = {
                id: safeId,
                returnPoint: options.returnPoint || this.captureReaderNoteReturnPoint(),
            };
            return;
        }

        this.closeContentsDialog();
        this.chromeHidden = false;
        this.readerNoteReturnPoint = options.returnPoint || this.captureReaderNoteReturnPoint();

        this.$nextTick(() => {
            if (this.isPagedMode) {
                const pageIndex = this.findPagedPageIndexByAnchor(safeId);
                if (pageIndex >= 0) {
                    this.setCurrentPagedPage(pageIndex, false);
                }

                return;
            }

            if (!this.$refs.scroller)
                return;

            const scroller = this.$refs.scroller;
            const target = scroller.querySelector(`#${this.escapeCssId(safeId)}`);
            if (!target)
                return;

            const top = this.readerScrollTargetTop(scroller, target);
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    shouldDeferPagedAnchorJump() {
        return !!(
            this.isPagedMode
            && (
                this.bookPreparing
                || this.pagedBuildInProgress
                || this.pagedBuildNeedsRefresh
                || this.pagedViewportFrame
                || this.viewportRefreshFrame
            )
        );
    }

    flushPendingReaderAnchorJump() {
        const pending = this.pendingReaderAnchorJump;
        if (!pending || this.shouldDeferPagedAnchorJump())
            return;

        this.pendingReaderAnchorJump = null;
        this.jumpToReaderAnchor(pending.id, {
            returnPoint: pending.returnPoint || this.captureReaderNoteReturnPoint(),
        });
    }

    returnFromReaderNote() {
        const point = this.readerNoteReturnPoint;
        this.clearPendingReaderNavigationRestore({clearNoteReturn: true});
        if (!point)
            return;

        this.$nextTick(() => {
            if (point.paged || this.isPagedMode) {
                const pageIndex = Number.isFinite(Number(point.spreadPageIndex))
                    ? Number(point.spreadPageIndex)
                    : Number(point.pageIndex || 0);
                this.setCurrentPagedPage(pageIndex, false);
                if (point.sectionId)
                    this.currentSectionId = point.sectionId;
                return;
            }

            const scroller = (this.$refs ? this.$refs.scroller : null);
            if (!scroller)
                return;

            scroller.scrollTo({
                top: Math.max(0, Number(point.scrollTop || 0) || 0),
                behavior: 'smooth',
            });
            if (point.sectionId)
                this.currentSectionId = point.sectionId;
        });
    }

    jumpToAdjacentSection(delta = 0) {
        const index = this.currentSectionIndex;
        if (index < 0)
            return;

        const next = this.contents[index + delta];
        if (next)
            this.jumpToContent(next.id);
    }
}
