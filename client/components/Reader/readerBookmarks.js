//Мои места: закладки и заметки (закладка с текстом заметки), окно «Мои места» и переход к закладке.
//Своего состояния нет: закладки, черновик и открытые окна - поля Reader.
import {t, formatDateTime} from '../../share/i18n';

export default class ReaderBookmarks {
    get hasBookmarks() {
        return this.bookmarks.length > 0;
    }

    get hasReaderPlaces() {
        return this.hasSavedProgress || this.hasBookmarks;
    }

    get defaultPlacesTab() {
        if (this.hasSavedProgress)
            return 'progress';
        if (this.plainBookmarks.length)
            return 'bookmarks';
        if (this.noteBookmarks.length)
            return 'notes';
        return 'progress';
    }

    get plainBookmarks() {
        return this.bookmarks.filter((item) => !String(item.note || '').trim());
    }

    get noteBookmarks() {
        return this.bookmarks.filter((item) => String(item.note || '').trim());
    }

    openPlacesDialog(tab = '') {
        this.currentPlacesTab = (tab || this.defaultPlacesTab);
        this.bookmarksDialogOpen = true;
    }

    async addCurrentBookmark() {
        if (!await this.ensureReaderProfileReady())
            return;

        const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
        if (selection) {
            this.bookmarkDraft = {
                title: this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
                excerpt: selection,
                note: '',
                percent: Number(this.progress.percent || 0) || 0,
                sectionId: this.currentSectionId || '',
            };
            this.bookmarkComposerOpen = true;
            return;
        }

        await this.saveBookmark({
            title: this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
            excerpt: '',
            note: '',
            percent: Number(this.progress.percent || 0) || 0,
            sectionId: this.currentSectionId || '',
        });
    }

    async saveBookmark(bookmark = {}, successText = this.uiText.bookmarkAdded) {
        const api = this.$root.api;
        if (!api || !this.bookUid)
            return;

        try {
            const response = await api.addReaderBookmark(this.bookUid, bookmark);
            this.bookmarks = Array.isArray(response.bookmarks) ? response.bookmarks : this.bookmarks;
            this.currentPlacesTab = (String(bookmark.note || '').trim() ? 'notes' : 'bookmarks');
            this.$root.notify.success(successText, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.error);
        }
    }

    async saveBookmarkDraft(mode = 'bookmark') {
        const note = (mode === 'note' ? String(this.bookmarkDraft.note || '').trim() : '');
        await this.saveBookmark({
            title: this.bookmarkDraft.title || this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
            excerpt: this.bookmarkDraft.excerpt || '',
            note,
            percent: Number(this.bookmarkDraft.percent || 0) || 0,
            sectionId: this.bookmarkDraft.sectionId || '',
        }, mode === 'note' ? this.uiText.noteSaved : this.uiText.bookmarkAdded);
        this.bookmarkComposerOpen = false;
        this.bookmarkDraft = {
            title: '',
            excerpt: '',
            note: '',
            percent: 0,
            sectionId: '',
        };
        this.openPlacesDialog(mode === 'note' ? 'notes' : 'bookmarks');
    }

    async removeBookmark(bookmarkId = '') {
        const api = this.$root.api;
        if (!api || !this.bookUid || !bookmarkId)
            return;

        try {
            const response = await api.deleteReaderBookmark(this.bookUid, bookmarkId);
            this.bookmarks = Array.isArray(response.bookmarks) ? response.bookmarks : [];
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    jumpToBookmark(bookmark = {}) {
        this.clearPendingReaderNavigationRestore({clearNoteReturn: true});
        this.bookmarksDialogOpen = false;
        this.chromeHidden = false;
        if (!this.$refs.scroller)
            return;

        this.$nextTick(() => {
            const scroller = this.$refs.scroller;
            const percent = Math.max(0, Math.min(1, Number(bookmark.percent || 0) || 0));
            // Доля книги считается по всем страницам: пока остальные размечаются в фоне, переход ждёт
            if (this.isPagedMode && this.pagedPagesPartial && (percent > 0 || !String(bookmark.sectionId || '').trim())) {
                this.pendingPagedNavigation = () => this.jumpToBookmark(bookmark);
                return;
            }

            if (percent > 0) {
                if (this.isPagedMode) {
                    this.setCurrentPagedPage(Math.round((this.totalPagedLogicalPages - 1) * percent), true);
                    return;
                }

                const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const top = maxScroll * percent;
                scroller.scrollTo({top, behavior: 'smooth'});
                return;
            }

            const sectionId = String(bookmark.sectionId || '').trim();
            if (sectionId) {
                this.jumpToContent(sectionId);
                return;
            }

            if (this.isPagedMode) {
                this.setCurrentPagedPage(Math.round((this.totalPagedLogicalPages - 1) * percent), true);
                return;
            }

            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            const top = maxScroll * percent;
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    formatBookmarkDate(value = '') {
        return formatDateTime(value);
    }
}
