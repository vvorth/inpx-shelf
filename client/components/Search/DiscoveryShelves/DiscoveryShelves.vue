<template>
    <div class="discovery-wrap q-mx-md q-mt-md q-mb-lg">
        <div class="discovery-page-head">
            <div class="discovery-page-copy">
                <div class="discovery-page-title">
                    {{ sectionTitle || $t('Витрина') }}
                </div>
                <div class="discovery-page-subtitle">
                    {{ $t('Подборки по вашей библиотеке и профилю чтения') }}
                </div>
            </div>

            <q-btn
                class="discovery-refresh-btn"
                color="primary"
                unelevated
                no-caps
                icon="la la-sync"
                :loading="loading"
                @click.stop.prevent="$emit('refresh-shelves')"
            >
                {{ $t('Обновить витрину') }}
            </q-btn>
        </div>

        <div class="discovery-toolbar">
            <q-btn
                unelevated
                no-caps
                class="discovery-toolbar-btn"
                :class="{'discovery-toolbar-btn--active': compactMode}"
                :icon="compactMode ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                @click.stop.prevent="$emit('toggle-compact')"
            >
                {{ compactMode ? $t('Обычные карточки') : $t('Компактные карточки') }}
            </q-btn>

            <q-btn
                v-if="personalMode"
                unelevated
                no-caps
                class="discovery-toolbar-btn"
                :class="{'discovery-toolbar-btn--active': unreadOnly}"
                :icon="unreadOnly ? 'la la-filter' : 'la la-book-open'"
                @click.stop.prevent="$emit('toggle-unread-only')"
            >
                {{ unreadOnly ? $t('Показывать все') : $t('Только непрочитанное') }}
            </q-btn>

            <q-btn
                v-if="personalMode"
                unelevated
                no-caps
                class="discovery-toolbar-btn"
                :class="{'discovery-toolbar-btn--active': tasteSetupOpen}"
                icon="la la-sliders-h"
                @click.stop.prevent="toggleTasteSetup"
            >
                {{ $t('Настроить вкусы') }}
            </q-btn>

            <q-select
                v-if="showExternalFilter && externalGenreOptions && externalGenreOptions.length > 1"
                :model-value="externalGenreUrl"
                class="discovery-genre-select"
                dense
                outlined
                emit-value
                map-options
                options-dense
                no-error-icon
                :loading="loading"
                :disable="loading"
                :label="$t('Жанр внешней витрины')"
                :options="externalGenreOptions"
                @update:model-value="$emit('set-external-genre', $event || '')"
            />

            <div v-if="showExternalPagination && externalPagination" class="discovery-filter-group">
                <q-btn
                    v-for="pageSize in [12, 24, 48]"
                    :key="pageSize"
                    unelevated
                    no-caps
                    class="discovery-toolbar-btn"
                    :class="{'discovery-toolbar-btn--active': externalPagination.perPage === pageSize}"
                    @click.stop.prevent="$emit('set-external-limit', pageSize)"
                >
                    {{ pageSize }}
                </q-btn>

            </div>
        </div>

        <section v-if="showTasteSetup" class="discovery-taste-panel">
            <div class="discovery-taste-copy">
                <div class="discovery-taste-title">{{ $t('Что вам нравится читать?') }}</div>
                <div class="discovery-taste-subtitle">
                    {{ $t('Выберите жанры, авторов и языки — это уточнит рекомендации даже для давно используемого профиля. Настройки можно изменить в любой момент.') }}
                </div>
            </div>
            <div class="discovery-taste-grid">
                <q-select
                    v-model="tasteGenres"
                    class="taste-genre-select"
                    outlined
                    dense
                    multiple
                    use-chips
                    use-input
                    clearable
                    counter
                    emit-value
                    map-options
                    options-dense
                    max-values="20"
                    input-debounce="0"
                    popup-content-style="height: min(420px, 58vh); min-height: min(420px, 58vh); max-height: min(420px, 58vh); overflow-y: auto"
                    :options="visibleTasteGenreOptions"
                    :label="$t('Любимые жанры')"
                    :hint="$t('Введите часть названия жанра')"
                    @clear="tasteGenres = []"
                    @filter="filterTasteGenres"
                >
                    <template #no-option>
                        <q-item>
                            <q-item-section class="text-grey-7">
                                {{ $t('Жанры не найдены') }}
                            </q-item-section>
                        </q-item>
                    </template>
                </q-select>
                <q-select
                    v-model="tasteAuthors"
                    outlined
                    dense
                    multiple
                    use-chips
                    use-input
                    clearable
                    counter
                    options-dense
                    new-value-mode="add-unique"
                    max-values="40"
                    input-debounce="250"
                    popup-content-style="height: min(320px, 46vh); min-height: min(320px, 46vh); max-height: min(320px, 46vh); overflow-y: auto"
                    :options="tasteAuthorOptions"
                    :loading="tasteAuthorsLoading"
                    :label="$t('Любимые авторы')"
                    :hint="$t('Начните вводить фамилию или имя')"
                    @clear="tasteAuthors = []"
                    @filter="filterTasteAuthors"
                    @filter-abort="abortTasteAuthorFilter"
                >
                    <template #no-option>
                        <q-item>
                            <q-item-section class="text-grey-7">
                                {{ tasteAuthorNoOptionsLabel }}
                            </q-item-section>
                        </q-item>
                    </template>
                </q-select>
                <q-select
                    v-model="tasteLanguages"
                    outlined
                    dense
                    multiple
                    use-chips
                    emit-value
                    map-options
                    :options="tasteLanguageOptions"
                    :label="$t('Языки книг')"
                />
                <q-select
                    v-model="tasteExplorationRatio"
                    outlined
                    dense
                    emit-value
                    map-options
                    :options="tasteExplorationOptions"
                    :label="$t('Сколько нового пробовать')"
                />
            </div>
            <div class="discovery-taste-actions">
                <q-btn color="primary" unelevated no-caps icon="la la-check" @click.stop.prevent="saveTaste">
                    {{ $t('Сохранить вкусы') }}
                </q-btn>
                <q-btn v-if="personalTasteNeedsSetup" flat no-caps @click.stop.prevent="dismissTasteSetup">
                    {{ $t('Не сейчас') }}
                </q-btn>
                <q-btn v-else flat no-caps @click.stop.prevent="tasteSetupOpen = false">
                    {{ $t('Закрыть') }}
                </q-btn>
            </div>
        </section>

        <div v-if="loading" class="discovery-loading-line">
            <q-icon class="la la-spinner icon-rotate" size="20px" />
            <span>{{ $t('Собираю витрину...') }}</span>
        </div>

        <div v-if="errorMessage" class="discovery-error">
            {{ errorMessage }}
        </div>

        <section
            v-for="shelf in safeShelves"
            :key="shelf.id || shelf.title"
            class="discovery-shelf"
        >
            <div class="discovery-head">
                <div class="discovery-head-copy">
                    <div class="discovery-kicker">
                        {{ shelfSourceLabel(shelf) }}
                    </div>
                    <div class="discovery-title">
                        {{ $tm(shelf.title) }}
                    </div>
                    <div v-if="shelf.subtitle" class="discovery-subtitle">
                        {{ $tm(shelf.subtitle) }}
                    </div>
                    <div class="discovery-meta">
                        <span v-if="shelf.updatedAt">{{ $t('Обновлено {time}', {time: formatUpdatedAt(shelf.updatedAt)}) }}</span>
                        <span v-if="shelf.discoveryStale" class="discovery-meta-warning">{{ $t('Показан кеш') }}</span>
                    </div>
                    <div v-if="shelf.discoveryRefreshError" class="discovery-meta-warning discovery-meta-warning--inline">
                        {{ shelf.discoveryRefreshError }}
                    </div>
                </div>

                <div class="discovery-head-actions">
                    <q-btn
                        v-if="shelf.canHide"
                        class="discovery-source-btn discovery-source-btn--hide"
                        unelevated
                        no-caps
                        icon="la la-eye-slash"
                        @click.stop.prevent="$emit('hide-shelf', shelf.id)"
                    >
                        {{ $t('Скрыть полку') }}
                    </q-btn>

                    <q-btn
                        v-if="shelf.sourceUrl"
                        class="discovery-source-btn"
                        unelevated
                        no-caps
                        icon="la la-external-link-alt"
                        @click.stop.prevent="openSource(shelf)"
                    >
                        {{ $t('Источник') }}
                    </q-btn>
                </div>
            </div>

            <div v-if="shelf.items && shelf.items.length" class="discovery-grid" :class="{'discovery-grid--list': bookCardListMode}">
                <BookView
                    v-for="book in shelf.items"
                    :key="book._uid || `${shelf.id}-${book.id}`"
                    :book="book"
                    mode="extended"
                    :genre-map="genreMap"
                    :show-read-link="showReadLink"
                    :show-discovery-dismiss="!!book.discoveryDismissible"
                    :discovery-dismiss-label="book.discoveryDismissLabel || $t('Неинтересно')"
                    :show-discovery-restore="!!book.discoveryRestoreable"
                    :discovery-restore-label="book.discoveryRestoreLabel || $t('Вернуть')"
                    :compact-discovery="compactMode"
                    @book-event="bookEvent"
                />
            </div>

            <div v-if="showLoadMore(shelf)" class="discovery-load-more">
                <q-btn
                    class="discovery-source-btn"
                    unelevated
                    no-caps
                    icon="la la-plus-circle"
                    :loading="loading"
                    :disable="loading"
                    @click.stop.prevent="loadMore(shelf)"
                >
                    {{ loadMoreLabel(shelf) }}
                </q-btn>
            </div>

            <div v-if="!shelf.items || !shelf.items.length" class="discovery-empty">
                {{ shelf.emptyMessage ? $tm(shelf.emptyMessage) : $t('Пока пусто.') }}
            </div>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import BaseList from '../BaseList';
import {t, tMessage, getLocale} from '../../../share/i18n';

class DiscoveryShelves extends BaseList {
    _props = {
        sectionTitle: String,
        compactMode: Boolean,
        personalMode: Boolean,
        profileKey: String,
        externalFilter: { type: String, default: 'books'},
        externalGenreOptions: { type: Array, default: () => []},
        externalGenreUrl: { type: String, default: ''},
        showExternalFilter: Boolean,
        externalPagination: Object,
        showExternalPagination: Boolean,
        unreadOnly: Boolean,
        list: Object,
        search: Object,
        extSearch: Object,
        genreMap: Object,
        shelves: Array,
        loading: Boolean,
        errorMessage: String,
    };

    tasteSetupOpen = false;
    tasteHandledProfileKey = null;
    tasteGenres = [];
    tasteGenreFilteredOptions = null;
    tasteAuthors = [];
    tasteAuthorOptions = [];
    tasteAuthorQuery = '';
    tasteAuthorSearchSeq = 0;
    tasteAuthorsLoading = false;
    tasteAuthorSearchFailed = false;
    tasteLanguages = [];
    tasteExplorationRatio = 0.15;

    refresh() {
    }

    get personalTasteShelf() {
        return (Array.isArray(this.shelves) ? this.shelves : [])
            .find(shelf => shelf && String(shelf.id || '') === 'similar-books') || {};
    }

    get personalTaste() {
        return (this.personalTasteShelf.discoveryTaste && typeof(this.personalTasteShelf.discoveryTaste) === 'object'
            ? this.personalTasteShelf.discoveryTaste
            : {});
    }

    get personalTasteNeedsSetup() {
        const profileKey = String(this.profileKey || '');
        return this.personalTasteShelf.discoveryNeedsTasteSetup === true
            && this.tasteHandledProfileKey !== profileKey;
    }

    get showTasteSetup() {
        return !!(this.personalMode && (this.tasteSetupOpen || this.personalTasteNeedsSetup));
    }

    get tasteGenreOptions() {
        const entries = (this.genreMap instanceof Map ? Array.from(this.genreMap.entries()) : Object.entries(this.genreMap || {}));
        return entries
            .map(([value, label]) => ({value: String(value || '').trim(), label: String(label || value || '').trim()}))
            .filter(item => item.value && item.label && !/^\?+$/.test(item.label))
            .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    }

    get visibleTasteGenreOptions() {
        return (Array.isArray(this.tasteGenreFilteredOptions)
            ? this.tasteGenreFilteredOptions
            : this.tasteGenreOptions);
    }

    get tasteLanguageOptions() {
        return [
            {label: t('Русский'), value: 'ru'},
            {label: t('Английский'), value: 'en'},
            {label: t('Украинский'), value: 'uk'},
            {label: t('Немецкий'), value: 'de'},
            {label: t('Французский'), value: 'fr'},
            {label: t('Испанский'), value: 'es'},
            {label: t('Итальянский'), value: 'it'},
        ];
    }

    get tasteAuthorNoOptionsLabel() {
        if (this.tasteAuthorsLoading)
            return t('Ищу авторов...');
        if (this.tasteAuthorSearchFailed)
            return t('Не удалось выполнить поиск');
        if (this.tasteAuthorQuery.length < 2)
            return t('Введите не менее двух букв');
        return t('Авторы не найдены');
    }

    get tasteExplorationOptions() {
        return [
            {label: t('Осторожно · 10%'), value: 0.1},
            {label: t('Сбалансированно · 15%'), value: 0.15},
            {label: t('Больше нового · 25%'), value: 0.25},
        ];
    }

    syncTasteEditor() {
        const taste = this.personalTaste;
        const allowedGenres = new Set(this.tasteGenreOptions.map(item => item.value));
        const savedGenres = Array.isArray(taste.genres) ? taste.genres.slice() : [];
        this.tasteGenres = (allowedGenres.size
            ? savedGenres.filter(genre => allowedGenres.has(genre))
            : savedGenres);
        this.tasteAuthors = this.normalizeTasteAuthors(taste.authors);
        this.tasteAuthorOptions = this.tasteAuthors.slice();
        this.tasteAuthorQuery = '';
        this.tasteAuthorSearchFailed = false;
        this.tasteLanguages = Array.isArray(taste.languages) ? taste.languages.slice() : [];
        this.tasteExplorationRatio = Number(taste.explorationRatio) || 0.15;
    }

    toggleTasteSetup() {
        this.tasteSetupOpen = !this.tasteSetupOpen;
        if (this.tasteSetupOpen)
            this.syncTasteEditor();
    }

    filterTasteGenres(value, update) {
        const normalize = input => String(input || '')
            .toLocaleLowerCase('ru-RU')
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();
        const terms = normalize(value).split(' ').filter(Boolean);
        update(() => {
            this.tasteGenreFilteredOptions = (!terms.length
                ? this.tasteGenreOptions
                : this.tasteGenreOptions.filter((item) => {
                    const searchable = normalize(`${item.label} ${item.value}`);
                    return terms.every(term => searchable.includes(term));
                }));
        });
    }

    normalizeTasteAuthors(values, limit = 40) {
        const result = [];
        const seen = new Set();
        for (const value of (Array.isArray(values) ? values : [])) {
            const authors = String(value || '').split(/[,;\n]/);
            for (const author of authors) {
                const normalized = author.replace(/\s+/g, ' ').trim();
                const key = normalized.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
                if (normalized && !seen.has(key)) {
                    seen.add(key);
                    result.push(normalized);
                }
            }
        }
        return result.slice(0, Math.max(0, Number(limit) || 40));
    }

    async filterTasteAuthors(value, update) {
        const query = String(value || '').replace(/\s+/g, ' ').trim();
        const requestSeq = ++this.tasteAuthorSearchSeq;
        this.tasteAuthorQuery = query;
        this.tasteAuthorSearchFailed = false;

        if (query.length < 2) {
            this.tasteAuthorsLoading = false;
            update(() => {
                this.tasteAuthorOptions = this.tasteAuthors.slice();
            });
            return;
        }

        this.tasteAuthorsLoading = true;
        try {
            const response = await this.api.search('author', {
                author: query,
                del: '0',
                limit: 30,
                offset: 0,
            });
            if (requestSeq !== this.tasteAuthorSearchSeq)
                return;

            update(() => {
                const found = (response && Array.isArray(response.found) ? response.found : [])
                    .map(item => String(item.author || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                this.tasteAuthorOptions = this.normalizeTasteAuthors(this.tasteAuthors.concat(found), 70);
                this.tasteAuthorsLoading = false;
            });
        } catch (e) {
            if (requestSeq !== this.tasteAuthorSearchSeq)
                return;
            update(() => {
                this.tasteAuthorOptions = [];
                this.tasteAuthorsLoading = false;
                this.tasteAuthorSearchFailed = true;
            });
        }
    }

    abortTasteAuthorFilter() {
        this.tasteAuthorSearchSeq++;
        this.tasteAuthorsLoading = false;
    }

    saveTaste() {
        const allowedGenres = new Set(this.tasteGenreOptions.map(item => item.value));
        const authors = this.normalizeTasteAuthors(this.tasteAuthors);
        this.$emit('save-taste', {
            genres: (Array.isArray(this.tasteGenres)
                ? this.tasteGenres.filter(genre => allowedGenres.has(genre))
                : []),
            authors,
            languages: this.tasteLanguages,
            explorationRatio: this.tasteExplorationRatio,
            completedAt: new Date().toISOString(),
        });
        this.tasteHandledProfileKey = String(this.profileKey || '');
        this.tasteSetupOpen = false;
    }

    dismissTasteSetup() {
        this.$emit('dismiss-taste');
        this.tasteHandledProfileKey = String(this.profileKey || '');
        this.tasteSetupOpen = false;
    }

    bookEvent(event) {
        if (event && event.action === 'discoveryFeedback') {
            this.$emit('feedback-book', {
                book: event.book,
                kind: event.format || 'not_interested',
            });
            return;
        }

        if (event && event.action === 'discoveryDismiss') {
            this.$emit('dismiss-book', event.book);
            return;
        }

        if (event && event.action === 'discoveryRestore') {
            this.$emit('restore-book', event.book);
            return;
        }

        const interactionTypes = {
            bookInfo: 'open',
            readBook: 'start',
            readingList: 'save',
            download: 'download',
        };
        if (event && interactionTypes[event.action] && event.book && event.book.discoveryShelfId) {
            this.$emit('discovery-interaction', {
                book: event.book,
                type: interactionTypes[event.action],
            });
        }

        super.bookEvent(event);
    }

    loadMore(shelf = {}) {
        if (String(shelf.id || '') === 'similar-books') {
            this.$emit('load-more-recommendations');
            return;
        }

        this.$emit('load-more-external');
    }

    get safeShelves() {
        return (Array.isArray(this.shelves) ? this.shelves : []);
    }

    showLoadMore(shelf = {}) {
        const isExternalMore = !!(
            this.showExternalPagination
            && this.externalPagination
            && this.externalPagination.canNext
            && shelf
            && shelf.source === 'external'
            && Array.isArray(shelf.items)
            && shelf.items.length
        );

        const isSimilarMore = !!(
            this.personalMode
            && shelf
            && String(shelf.id || '') === 'similar-books'
            && shelf.discoveryHasMore === true
            && Array.isArray(shelf.items)
            && shelf.items.length
        );

        return isExternalMore || isSimilarMore;
    }

    loadMoreLabel(shelf = {}) {
        if (String(shelf.id || '') === 'similar-books')
            return t('Ещё рекомендации');
        return t('Загрузить ещё');
    }

    shelfSourceLabel(shelf = {}) {
        if (shelf.sourceName)
            return tMessage(shelf.sourceName);
        if (shelf.source === 'external')
            return t('Внешний источник');
        return t('Локальная библиотека');
    }

    formatUpdatedAt(value) {
        const date = new Date(Number(value) || value);
        if (Number.isNaN(date.getTime()))
            return '';

        return date.toLocaleString(getLocale(), {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    openSource(shelf = {}) {
        if (shelf.sourceUrl)
            window.open(shelf.sourceUrl, '_blank');
    }
}

export default vueComponent(DiscoveryShelves);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.discovery-wrap {
    position: relative;
}

.discovery-page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
}

.discovery-page-copy {
    min-width: 0;
}

.discovery-page-title {
    color: var(--app-text);
    font-size: 32px;
    font-weight: 800;
    line-height: 1.05;
}

.discovery-page-subtitle {
    margin-top: 6px;
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
}

.discovery-refresh-btn {
    flex-shrink: 0;
}

.discovery-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
}

.discovery-filter-group {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
}

.discovery-toolbar-btn {
    color: var(--app-text);
    border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface) 88%, var(--app-surface-2) 12%);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--app-surface-3) 30%, white 70%) inset;
    font-weight: 600;
}

.discovery-toolbar-btn:hover {
    background: color-mix(in srgb, var(--app-surface) 72%, var(--app-surface-2) 28%);
    border-color: color-mix(in srgb, var(--app-border) 92%, var(--app-primary) 8%);
}

.discovery-toolbar-btn--active {
    color: color-mix(in srgb, var(--app-text) 82%, var(--app-primary) 18%);
    border-color: color-mix(in srgb, var(--app-border) 58%, var(--app-primary) 42%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 84%, var(--app-primary) 16%) 0%,
        color-mix(in srgb, var(--app-surface) 82%, var(--app-primary) 18%) 100%
    );
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary) 22%, transparent) inset;
}

.discovery-genre-select {
    min-width: 220px;
}

.discovery-genre-select :deep(.q-field__control) {
    border-radius: 14px;
    background: color-mix(in srgb, var(--app-surface) 90%, var(--app-surface-2) 10%);
}

.discovery-error {
    margin-bottom: 16px;
    padding: 14px 16px;
    border: 1px solid rgba(194, 88, 62, 0.28);
    border-radius: 18px;
    background: rgba(194, 88, 62, 0.08);
    color: var(--app-text);
    font-weight: 600;
}

.discovery-taste-panel {
    margin-bottom: 22px;
    padding: 18px;
    border: 1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border) 72%);
    border-radius: 20px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--app-surface) 88%, var(--app-primary) 12%), var(--app-surface));
}

.discovery-taste-title {
    color: var(--app-text);
    font-size: 18px;
    font-weight: 800;
}

.discovery-taste-subtitle {
    margin-top: 4px;
    color: var(--app-muted);
    font-size: 13px;
    font-weight: 600;
}

.discovery-taste-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
}

.discovery-taste-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
}

.discovery-loading-line {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    color: var(--app-muted);
    font-weight: 700;
}

.discovery-shelf + .discovery-shelf {
    margin-top: 26px;
}

.discovery-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
}

.discovery-head-copy {
    min-width: 0;
}

.discovery-head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.discovery-kicker {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.discovery-title {
    margin-top: 4px;
    color: var(--app-text);
    font-size: 28px;
    font-weight: 800;
    line-height: 1.05;
}

.discovery-subtitle {
    margin-top: 6px;
    color: var(--app-muted);
    font-size: 14px;
    line-height: 1.35;
}

.discovery-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 8px;
    color: var(--app-muted);
    font-size: 13px;
    font-weight: 600;
}

.discovery-meta-warning {
    color: #a5522d;
}

.discovery-meta-warning--inline {
    margin-top: 6px;
    font-size: 13px;
    font-weight: 600;
}

.discovery-source-btn {
    flex-shrink: 0;
    color: var(--app-text);
    border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface) 88%, var(--app-surface-2) 12%);
    font-weight: 600;
}

.discovery-source-btn:hover {
    border-color: color-mix(in srgb, var(--app-border) 92%, var(--app-primary) 8%);
    background: color-mix(in srgb, var(--app-surface) 72%, var(--app-surface-2) 28%);
}

.discovery-source-btn--hide {
    color: color-mix(in srgb, var(--app-text) 74%, var(--app-danger) 26%);
    border-color: color-mix(in srgb, var(--app-border) 66%, var(--app-danger) 34%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 84%, var(--app-danger) 16%) 0%,
        color-mix(in srgb, var(--app-surface) 86%, var(--app-danger) 14%) 100%
    );
}

.discovery-source-btn--hide:hover {
    border-color: color-mix(in srgb, var(--app-border) 54%, var(--app-danger) 46%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 74%, var(--app-danger) 26%) 0%,
        color-mix(in srgb, var(--app-surface) 78%, var(--app-danger) 22%) 100%
    );
}

.discovery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 18px;
    align-items: stretch;
}

.discovery-grid--list {
    grid-template-columns: 1fr;
    gap: 8px;
}

.discovery-load-more {
    display: flex;
    justify-content: center;
    margin-top: 18px;
}

.discovery-empty {
    padding: 16px 18px;
    border: 1px dashed var(--app-border);
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.44);
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
}

@media (max-width: 760px) {
    .discovery-wrap {
        margin-top: 10px;
    }

    .discovery-page-head {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }

    .discovery-head {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }

    .discovery-page-title {
        font-size: 24px;
    }

    .discovery-title {
        font-size: 22px;
    }

    .discovery-taste-grid {
        grid-template-columns: 1fr;
    }

    .discovery-grid {
        grid-template-columns: 1fr;
        gap: 12px;
    }
}
</style>
