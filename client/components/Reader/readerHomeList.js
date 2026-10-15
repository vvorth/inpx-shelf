//Стартовый экран читалки без книги (шаблон - ReaderHome.vue): книги профиля по состоянию чтения, поиск
//и сортировка, скрыть, вернуть, забыть книги, сброс всего прогресса. Своего состояния нет: список - поля Reader.
import {tm} from '../../share/i18n';
import {forgetBooks} from '../../share/bookActions';

export default class ReaderHomeList {
    get readerHomeCanLogin() {
        return !!this.readerProfileCanLogin;
    }

    //BookCover берёт обложку по _uid, а у списка читалки это bookUid
    readerHomeCoverBook(book) {
        return {_uid: book.bookUid, title: book.title, author: book.author, genre: book.genre};
    }

    get readerHomeAuthorized() {
        const current = this.currentSelectedProfile;
        return !!(current && !this.readerAnonymousProfile && (!current.requiresLogin || this.config.profileAuthorized));
    }

    get readerHomeSubtitle() {
        const current = this.currentSelectedProfile;
        if (!current)
            return this.uiText.profileSelectReaderHint;
        if (this.readerAnonymousProfile)
            return this.uiText.profileSelectReaderHint;
        if (this.readerProfileNeedsLogin)
            return this.uiText.profileLoginReaderHint;
        return current.name ? `${this.uiText.profile}: ${tm(current.name)}` : this.uiText.continueReading;
    }

    get readerHomeEmptyText() {
        if (!this.currentUserId || this.readerAnonymousProfile)
            return this.uiText.profileSelectReaderHint;
        if (this.readerProfileNeedsLogin)
            return this.uiText.profileLoginReaderHint;
        if (String(this.readerHomeSearch || '').trim())
            return this.uiText.readerHomeSearchEmptyText;
        if (this.readerHomeFilter === 'read')
            return this.uiText.readerHomeReadEmptyText;
        if (this.readerHomeFilter === 'hidden')
            return this.uiText.readerHomeHiddenEmptyText;
        return this.uiText.readerHomeEmptyText;
    }

    get readerHomeFilterOptions() {
        return [
            {value: 'reading', label: this.uiText.readerHomeFilterReading},
            {value: 'read', label: this.uiText.readerHomeFilterRead},
            {value: 'hidden', label: this.uiText.readerHomeFilterHidden},
            {value: 'all', label: this.uiText.readerHomeFilterAll},
        ];
    }

    get readerHomeSortOptions() {
        return [
            {value: 'updatedDesc', label: this.uiText.readerHomeSortUpdatedDesc},
            {value: 'updatedAsc', label: this.uiText.readerHomeSortUpdatedAsc},
            {value: 'titleAsc', label: this.uiText.readerHomeSortTitle},
            {value: 'authorAsc', label: this.uiText.readerHomeSortAuthor},
            {value: 'progressDesc', label: this.uiText.readerHomeSortProgressDesc},
            {value: 'progressAsc', label: this.uiText.readerHomeSortProgressAsc},
        ];
    }

    formatReaderHomePercent(value) {
        return Math.max(0, Math.min(100, Math.round((Number(value || 0) || 0) * 100)));
    }

    async loadReaderHome() {
        if (this.isStandaloneMode || this.bookUid)
            return;

        // Устаревший ответ (сменился фильтр или открыта книга) не должен перезаписать состояние
        const jobId = ++this.readerHomeJobId;
        const isStale = () => (jobId !== this.readerHomeJobId || !!this.bookUid);
        this.readerHomeLoading = true;
        this.error = '';
        this.loading = false;
        this.bookPreparing = false;
        this.readerHtml = '';
        this.readerAnnotationHtml = '';
        this.readerNotesAnchorId = '';
        this.readerSearchText = '';
        this.contents = [];
        this.bookmarks = [];
        this.title = this.uiText.readerHomeTitle;
        this.authorLine = '';
        this.seriesLine = '';
        this.$root.setAppTitle(this.uiText.readerHomeTitle);

        try {
            const api = this.$root.api;
            if (api && typeof api.updateConfig === 'function')
                await api.updateConfig();
            if (isStale())
                return;

            if (api && typeof api.getUserReadingLibrary === 'function' && this.readerHomeAuthorized) {
                const result = await api.getUserReadingLibrary({
                    state: this.readerHomeFilter,
                    sort: this.readerHomeSort,
                    query: this.readerHomeSearch,
                    limit: 300,
                });
                if (isStale())
                    return;
                this.readerProgressGeneration = Math.max(0, parseInt(result && result.progressGeneration, 10) || 0);
                this.readerHomeCounters = Object.assign({all: 0, reading: 0, read: 0, hidden: 0}, result.counters || {});
                this.readerHomeBooks = Array.isArray(result.items)
                    ? result.items.filter((book) => String(book.bookUid || '').trim())
                    : [];
            } else {
                const current = this.$store.state.config.currentUserProfile || {};
                this.readerHomeCounters = {all: 0, reading: 0, read: 0, hidden: 0};
                this.readerHomeBooks = Array.isArray(current.currentReading)
                    ? current.currentReading.filter((book) => String(book.bookUid || '').trim())
                    : [];
                this.readerHomeCounters.reading = this.readerHomeBooks.length;
                this.readerHomeCounters.all = this.readerHomeBooks.length;
            }
        } catch (e) {
            if (!isStale())
                this.error = tm(e.message || String(e));
        } finally {
            if (jobId === this.readerHomeJobId)
                this.readerHomeLoading = false;
        }
    }

    openReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        this.$router.push({path: '/reader', query: {bookUid}});
    }

    setReaderHomeFilter(value = 'reading') {
        const nextValue = String(value || 'reading').trim();
        if (this.readerHomeFilter === nextValue)
            return;

        this.readerHomeFilter = nextValue;
        this.loadReaderHome();// no await
    }

    async removeReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.removeReadingConfirm.replace('{title}', String(book.title || this.uiText.untitledBook)),
            this.uiText.readerHomeTitle,
        );
        if (!confirmed)
            return;

        try {
            await this.$root.api.updateReaderProgress(bookUid, {
                hidden: true,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
                generation: this.readerProgressGeneration,
            });
            await this.loadReaderHome();
            this.$root.notify.success(this.uiText.removeReadingSuccess, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message || String(e), this.uiText.error);
        }
    }

    async restoreReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        try {
            await this.$root.api.updateReaderProgress(bookUid, {
                hidden: false,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
                generation: this.readerProgressGeneration,
            });
            await this.loadReaderHome();
            this.$root.notify.success(this.uiText.restoreReadingSuccess, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message || String(e), this.uiText.error);
        }
    }

    async forgetReaderHomeBooks(books = []) {
        if (await forgetBooks(this, books, {dialogClass: 'std-dialog-card--reader', dialogStyle: this.readerDialogStyle}))
            await this.loadReaderHome();
    }

    async resetReaderHomeProgress() {
        if (this.readerHomeResetting || !(Number(this.readerHomeCounters.all || 0) > 0))
            return;

        const profile = this.currentSelectedProfile || {};
        const profileName = String(profile.name || profile.login || this.uiText.profile).trim();
        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.resetReaderProgressConfirm.replace('{profile}', profileName),
            this.uiText.resetReaderProgress,
            {
                dialogClass: 'std-dialog-card--reader',
                dialogStyle: this.readerDialogStyle,
                okLabel: this.uiText.resetReaderProgressAction,
            },
        );
        if (!confirmed)
            return;

        this.readerHomeResetting = true;
        try {
            const result = await this.$root.api.clearReaderProgress();
            this.readerProgressGeneration = Math.max(0, parseInt(result && result.generation, 10) || 0);
            this.clearStoredReaderProgress('', {
                all: true,
                bookUids: Array.isArray(result && result.bookUids) ? result.bookUids : [],
            });
            await this.loadReaderHome();
            this.$root.notify.success(this.uiText.resetReaderProgressSuccess, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message || String(e), this.uiText.error);
        } finally {
            this.readerHomeResetting = false;
        }
    }
}
