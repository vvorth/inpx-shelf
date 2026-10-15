//Поиск по книге в режиме страниц: страницы с совпадениями, переход между ними, подсветка на открытой странице.
//Своего состояния нет: запрос и результаты - поля Reader (searchResults - markRaw, заменяется целиком).
import {markRaw} from 'vue';
const readerTextAnchors = require('./readerTextAnchors');

export default class ReaderSearch {
    renderPagedPageHtml(page = null, pageIndex = 0) {
        if (!page)
            return '';

        if (!this.searchQuery.trim() || !this.hasSearchResults)
            return page.html || '';

        const activeResult = this.searchResults[this.currentSearchResultIndex] || null;
        if (!activeResult || activeResult.pageIndex !== pageIndex)
            return page.html || '';

        return readerTextAnchors.highlightHtmlMatches(page.html || '', this.searchQuery);
    }

    get hasSearchResults() {
        return this.searchResults.length > 0;
    }

    get searchResultsLabel() {
        if (!this.hasSearchResults)
            return '';
        return `${this.currentSearchResultIndex + 1}/${this.searchResults.length} | ${this.uiText.readModePages} ${this.searchResults[this.currentSearchResultIndex].pageIndex + 1}`;
    }

    toggleSearchDialog() {
        if (!this.isPagedMode)
            return;

        this.searchDialogOpen = !this.searchDialogOpen;
    }

    rebuildSearchResults(resetIndex = false) {
        const query = String(this.searchQuery || '').trim().toLowerCase();
        if (!query || !this.isPagedMode || !this.pagedPages.length) {
            this.searchResults = [];
            this.currentSearchResultIndex = -1;
            return;
        }

        const results = [];
        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const text = this.getPagedPageText(this.pagedPages[index]).toLowerCase();
            if (text.includes(query))
                results.push({pageIndex: index});
        }

        this.searchResults = markRaw(results);
        if (!results.length) {
            this.currentSearchResultIndex = -1;
            return;
        }

        if (resetIndex || this.currentSearchResultIndex < 0 || this.currentSearchResultIndex >= results.length) {
            const nearestIndex = results.findIndex((item) => item.pageIndex >= this.currentPageIndex);
            this.currentSearchResultIndex = (nearestIndex >= 0 ? nearestIndex : 0);
            return;
        }

        const activePageIndex = (this.searchResults[this.currentSearchResultIndex] || {}).pageIndex;
        const nextCurrentIndex = results.findIndex((item) => item.pageIndex === activePageIndex);
        this.currentSearchResultIndex = (nextCurrentIndex >= 0 ? nextCurrentIndex : 0);
    }

    handleSearchInput() {
        this.rebuildSearchResults(true);
        if (this.hasSearchResults)
            this.goToSearchResult(this.currentSearchResultIndex, false);
    }

    goToSearchResult(index = 0, save = true) {
        if (!this.hasSearchResults)
            return;

        const safeIndex = Math.max(0, Math.min(this.searchResults.length - 1, index));
        this.currentSearchResultIndex = safeIndex;
        const result = this.searchResults[safeIndex];
        if (!result)
            return;

        this.setCurrentPagedPage(result.pageIndex, save);
    }

    jumpToNextSearchResult() {
        if (!this.hasSearchResults)
            return;

        const nextIndex = (this.currentSearchResultIndex + 1) % this.searchResults.length;
        this.goToSearchResult(nextIndex, true);
    }

    jumpToPrevSearchResult() {
        if (!this.hasSearchResults)
            return;

        const nextIndex = (this.currentSearchResultIndex <= 0 ? this.searchResults.length - 1 : this.currentSearchResultIndex - 1);
        this.goToSearchResult(nextIndex, true);
    }
}
