<template>
    <div class="page">
        <div class="page-body search-body">
            <div v-if="notReady" class="card">
                <h2 class="card-title">
                    {{ $t('Поиск готовится') }}
                </h2>
                <div class="card-hint">
                    {{ $t('Индекс каталога строится, это занимает несколько минут после обновления библиотеки.') }}
                    <span v-if="indexProgress" class="num">{{ Math.round(indexProgress * 100) }}%</span>
                </div>
                <div class="card-actions">
                    <q-btn outline color="primary" no-caps @click="$router.push(classicLink)">
                        {{ $t('Поиск по полям') }}
                    </q-btn>
                </div>
            </div>

            <div v-else class="search-layout">
                <aside class="facets" :class="{'facets--open': facetsOpen}">
                    <div class="facets-head">
                        <h2 class="card-title">
                            {{ $t('Фильтры') }}
                        </h2>
                        <button v-if="customFilterCount" type="button" class="link-btn" @click="clearFilters">
                            {{ $t('Сбросить') }}
                        </button>
                    </div>

                    <div v-for="group in facetGroups" :key="group.field" class="facet">
                        <div class="facet-title">
                            {{ group.label }}
                        </div>
                        <label v-for="option in group.visible" :key="option.value" class="facet-option">
                            <input
                                :type="group.single ? 'radio' : 'checkbox'"
                                :name="`facet-${group.field}`"
                                :checked="isSelected(group.field, option.value)"
                                @change="toggleFilter(group.field, option.value, group.single)"
                            />
                            <span class="facet-label">{{ option.label }}</span>
                            <span class="facet-count num">{{ option.count.toLocaleString() }}</span>
                        </label>
                        <button v-if="group.options.length > group.visible.length" type="button" class="link-btn facet-more" @click="expanded[group.field] = true">
                            {{ $t('Ещё {n}', {n: group.options.length - group.visible.length}) }}
                        </button>
                    </div>

                    <div class="facet">
                        <label class="facet-option">
                            <input type="checkbox" :checked="hideCopies" @change="setQuery({copies: hideCopies ? undefined : '1'})" />
                            <span class="facet-label">{{ $t('Скрыть копии') }}</span>
                        </label>
                    </div>

                    <router-link class="facets-classic" :to="classicLink">
                        {{ $t('Поиск по полям и списки авторов') }}
                    </router-link>
                </aside>

                <section class="results">
                    <div class="results-head">
                        <div>
                            <h1 class="page-title">
                                {{ q ? $t('Поиск: «{q}»', {q}) : $t('Все книги') }}
                            </h1>
                            <div class="card-hint num">
                                {{ loading && !result ? $t('Ищу...') : $t('Найдено книг: {n}', {n: total.toLocaleString()}) }}
                                <template v-if="hiddenByLanguage">
                                    · {{ $t('ещё {n} на других языках', {n: hiddenByLanguage.toLocaleString()}) }}
                                    <button type="button" class="link-btn" @click="showAllLanguages">
                                        {{ $t('показать') }}
                                    </button>
                                </template>
                            </div>
                        </div>
                        <div class="results-tools">
                            <q-btn class="facets-toggle" outline dense no-caps icon="la la-filter" @click="facetsOpen = !facetsOpen">
                                {{ $t('Фильтры') }}<span v-if="customFilterCount" class="num">&nbsp;· {{ customFilterCount }}</span>
                            </q-btn>
                            <q-select
                                :model-value="sort"
                                :options="sortOptions"
                                dense
                                outlined
                                emit-value
                                map-options
                                options-dense
                                class="sort-select"
                                :aria-label="$t('Сортировка')"
                                @update:model-value="setQuery({sort: $event, page: undefined})"
                            />
                            <q-btn-toggle
                                :model-value="view"
                                :options="viewOptions"
                                dense
                                no-caps
                                unelevated
                                toggle-color="primary"
                                @update:model-value="setView"
                            />
                        </div>
                    </div>

                    <div v-if="result && result.corrected" class="notice">
                        <div>
                            {{ result.layout ? $t('Похоже, запрос набран в другой раскладке. Показаны результаты для') : $t('Показаны результаты для') }}
                            <router-link :to="{path: '/search', query: Object.assign({}, $route.query, {q: result.corrected, page: undefined})}">
                                <b>{{ result.corrected }}</b>
                            </router-link>.
                        </div>
                    </div>

                    <div v-if="activeChips.length" class="chips">
                        <button v-for="chip in activeChips" :key="`${chip.field}-${chip.value}`" type="button" class="chip" @click="toggleFilter(chip.field, chip.value)">
                            {{ chip.label }}<q-icon name="la la-times" size="12px" />
                        </button>
                    </div>

                    <div v-if="result && (result.authors.length || result.series.length) && page === 1" class="entities">
                        <router-link v-for="item in result.authors" :key="`a-${item.name}`" class="entity" :to="`/author/${encodeURIComponent(item.name)}`">
                            <span class="entity-avatar">{{ initials(item.name) }}</span>
                            <span class="entity-copy">
                                <span class="entity-name">{{ item.name }}</span>
                                <span class="entity-meta">{{ $t('Автор') }} · {{ $t('Книг: {n}', {n: item.books}) }}</span>
                            </span>
                        </router-link>
                        <router-link v-for="item in result.series" :key="`s-${item.name}`" class="entity" :to="`/series/${encodeURIComponent(item.name)}`">
                            <span class="entity-avatar entity-avatar--series"><q-icon name="la la-layer-group" size="18px" /></span>
                            <span class="entity-copy">
                                <span class="entity-name">{{ item.name }}</span>
                                <span class="entity-meta">{{ $t('Серия') }} · {{ $t('Книг: {n}', {n: item.books}) }}</span>
                            </span>
                        </router-link>
                    </div>

                    <div v-if="error" class="page-empty page-empty--inline">
                        {{ error }}
                    </div>
                    <div v-else-if="result && !books.length" class="page-empty">
                        <div>{{ activeChips.length ? $t('Ничего не найдено с этими фильтрами.') : $t('Ничего не найдено.') }}</div>
                        <q-btn v-if="hiddenByLanguage" outline color="primary" no-caps @click="showAllLanguages">
                            {{ $t('Показать на всех языках') }}
                        </q-btn>
                        <q-btn v-else-if="customFilterCount" outline color="primary" no-caps @click="clearFilters">
                            {{ $t('Сбросить фильтры') }}
                        </q-btn>
                    </div>

                    <div v-else-if="view === 'grid'" class="book-grid" :class="{'is-loading': loading}">
                        <BookCard v-for="book in books" :key="book._uid" :book="book" :progress="stateOf(book).percent || 0" />
                    </div>

                    <ol v-else class="result-list" :class="{'is-loading': loading}">
                        <li v-for="book in books" :key="book._uid" class="result-row">
                            <router-link class="result-cover" :to="bookLink(book)">
                                <BookCover :book="book" :progress="stateOf(book).percent || 0" small />
                            </router-link>
                            <div class="result-main">
                                <router-link class="result-title" :to="bookLink(book)">
                                    {{ book.title || $t('Без названия') }}
                                </router-link>
                                <div class="result-meta">
                                    <template v-for="(name, index) in authorsOf(book)" :key="name">
                                        <router-link :to="`/author/${encodeURIComponent(name)}`">
                                            {{ name }}
                                        </router-link><span v-if="index < authorsOf(book).length - 1">, </span>
                                    </template>
                                    <template v-if="book.series">
                                        · <router-link :to="`/series/${encodeURIComponent(book.series)}`">
                                            {{ book.series }}
                                        </router-link><span v-if="book.serno"> #{{ book.serno }}</span>
                                    </template>
                                </div>
                                <div class="result-meta result-meta--small num">
                                    {{ fileLine(book) }}
                                </div>
                            </div>
                            <div class="result-side">
                                <span v-if="stateOf(book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                                <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ Math.round(stateOf(book).percent * 100) }}%</span>
                                <span v-else-if="Number(book.librate) > 0" class="result-rating" :title="$t('Оценка')">{{ '★'.repeat(Number(book.librate)) }}</span>
                                <div class="result-actions">
                                    <q-btn flat dense round icon="la la-book-open" :aria-label="$t('Читать')" @click="act(book, 'readBook')">
                                        <q-tooltip>{{ $t('Читать') }}</q-tooltip>
                                    </q-btn>
                                    <q-btn flat dense round icon="la la-download" :aria-label="$t('Скачать')" @click="act(book, 'download')">
                                        <q-tooltip>{{ $t('Скачать {ext}', {ext: String(book.ext || '').toUpperCase()}) }}</q-tooltip>
                                    </q-btn>
                                    <q-btn v-if="signedIn" flat dense round icon="la la-bookmark" :aria-label="$t('В список')" @click="openLists(book)">
                                        <q-tooltip>{{ $t('В список') }}</q-tooltip>
                                    </q-btn>
                                </div>
                            </div>
                        </li>
                    </ol>

                    <nav v-if="pageCount > 1" class="pager" :aria-label="$t('Страницы')">
                        <q-btn flat dense no-caps icon="la la-angle-left" :disable="page <= 1" @click="setQuery({page: page > 2 ? String(page - 1) : undefined})">
                            {{ $t('Назад') }}
                        </q-btn>
                        <span class="num">{{ $t('Страница {page} из {count}', {page, count: pageCount}) }}</span>
                        <q-btn flat dense no-caps icon-right="la la-angle-right" :disable="page >= pageCount" @click="setQuery({page: String(page + 1)})">
                            {{ $t('Дальше') }}
                        </q-btn>
                    </nav>

                    <details class="syntax-help">
                        <summary>{{ $t('Точный поиск') }}</summary>
                        <div class="card-hint">
                            {{ $t('В строке поиска можно уточнять поля:') }}
                        </div>
                        <ul class="card-hint">
                            <li><code>author:стругацк</code> — {{ $t('автор начинается со слова') }}</li>
                            <li><code>title:="пикник на обочине"</code> — {{ $t('точное название') }}</li>
                            <li><code>series:дозор</code>, <code>lang:ru</code>, <code>ext:epub</code>, <code>genre:sf_social</code></li>
                            <li><code>-genre:det_classic</code> — {{ $t('исключить жанр') }}</li>
                        </ul>
                    </details>
                </section>
            </div>
        </div>

        <ReadingListsDialog v-if="listsBook" v-model="listsDialogVisible" :book="listsBook" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';
import BookCard from './BookCard.vue';
import ReadingListsDialog from '../Search/ReadingListsDialog/ReadingListsDialog.vue';

import {t, tMessage} from '../../share/i18n';
import {isSignedIn, initials} from '../../share/session';
import {runBookAction, bookAuthors, bookUid} from '../../share/bookActions';
import {loadGenres, genreName} from '../../share/genres';
import {myLanguages, allLanguages, languageName} from '../../share/languages';

const listFields = ['lang', 'ext', 'genre', 'source', 'librate'];
const facetVisible = 6;

const componentOptions = {
    components: {
        BookCover,
        BookCard,
        ReadingListsDialog,
    },
    watch: {
        queryKey() {
            if (this.$route.path === '/search')
                this.load();
        },
        '$store.state.config.catalogSearch.ready'(ready) {
            if (ready && this.notReady && this.$route.path === '/search')
                this.load();
        },
    },
};

class SearchPage {
    _options = componentOptions;

    result = null;
    states = {};
    loading = false;
    error = '';
    notReady = false;
    facetsOpen = false;
    expanded = {};
    genresReady = 0;
    listsBook = null;
    listsDialogVisible = false;
    requestSeq = 0;
    pollTimer = null;
    loadedKey = '';

    created() {
        this.api = this.$root.api;
        loadGenres(this.api).then(() => this.genresReady++).catch(() => {});
    }

    activated() {
        this.$root.setAppTitle(this.q ? t('Поиск: «{q}»', {q: this.q}) : t('Поиск'));
        if (this.queryKey !== this.loadedKey)
            this.load();
    }

    deactivated() {
        clearTimeout(this.pollTimer);
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get query() {
        return this.$route.query || {};
    }

    //ключ запроса учитывает «Мои языки»: их смена перезапускает поиск
    get queryKey() {
        return JSON.stringify([this.query, this.filters.lang]);
    }

    get q() {
        return String(this.query.q || '');
    }

    get filters() {
        const result = {added: String(this.query.added || '')};
        for (const field of listFields)
            result[field] = String(this.query[field] || '').split(',').map(value => value.trim()).filter(Boolean);
        //без явного выбора язык берётся из «Моих языков»; lang=* - все языки
        if (this.query.lang === undefined) {
            const languages = myLanguages(this.config, this.settings);
            result.lang = (languages.all ? [] : languages.list);
        } else if (this.query.lang === allLanguages) {
            result.lang = [];
        }
        return result;
    }

    get langFromProfile() {
        return this.query.lang === undefined && this.filters.lang.length > 0;
    }

    //сколько книг по запросу есть на других языках
    get hiddenByLanguage() {
        if (!this.langFromProfile || !this.result)
            return 0;
        const selected = new Set(this.filters.lang);
        return ((this.result.facets && this.result.facets.lang) || [])
            .filter(([code]) => !selected.has(String(code).toLowerCase()))
            .reduce((sum, [, count]) => sum + count, 0);
    }

    get customFilterCount() {
        return this.activeChips.filter(chip => !(chip.field === 'lang' && this.langFromProfile)).length;
    }

    showAllLanguages() {
        this.setQuery({lang: allLanguages, page: undefined});
    }

    get hideCopies() {
        return this.query.copies === '1';
    }

    get sort() {
        return String(this.query.sort || (this.q ? 'relevance' : 'date'));
    }

    get view() {
        return String(this.query.view || this.settings.searchView || 'list');
    }

    get page() {
        return Math.max(1, parseInt(this.query.page, 10) || 1);
    }

    get limit() {
        return Math.max(10, Math.min(100, parseInt(this.settings.limit, 10) || 20));
    }

    get total() {
        return (this.result ? this.result.total : 0);
    }

    get pageCount() {
        return Math.ceil(this.total / this.limit);
    }

    get books() {
        return (this.result ? this.result.books : []);
    }

    get indexProgress() {
        return Number((this.config.catalogSearch || {}).progress || 0);
    }

    get classicLink() {
        return (this.q ? {path: '/author', query: {author: this.q}} : '/author');
    }

    get sortOptions() {
        const options = [
            {label: t('Сначала новые'), value: 'date'},
            {label: t('По названию'), value: 'title'},
            {label: t('По автору'), value: 'author'},
            {label: t('По оценке'), value: 'rating'},
        ];
        if (this.q)
            options.unshift({label: t('По релевантности'), value: 'relevance'});
        return options;
    }

    get viewOptions() {
        return [
            {icon: 'la la-list', value: 'list', attrs: {'aria-label': t('Списком')}},
            {icon: 'la la-th-large', value: 'grid', attrs: {'aria-label': t('Обложками')}},
        ];
    }

    optionLabel(field, value) {
        void this.genresReady;
        if (field === 'genre')
            return genreName(value);
        if (field === 'lang')
            return languageName(value);
        if (field === 'ext')
            return String(value).toUpperCase();
        if (field === 'librate')
            return (Number(value) > 0 ? '★'.repeat(Number(value)) : t('Без оценки'));
        if (field === 'source') {
            const source = (this.config.librarySources || []).find(item => item.id === value);
            return source ? source.name : value;
        }
        if (field === 'added')
            return {'7d': t('За неделю'), '30d': t('За месяц'), '365d': t('За год')}[value] || value;
        return value;
    }

    get facetGroups() {
        const facets = (this.result && this.result.facets) || {};
        const groups = [
            {field: 'lang', label: t('Язык')},
            {field: 'genre', label: t('Жанр')},
            {field: 'ext', label: t('Формат')},
            {field: 'added', label: t('Поступления'), single: true},
            {field: 'librate', label: t('Оценка')},
        ];
        if ((this.config.librarySources || []).filter(item => item.enabled !== false).length > 1)
            groups.push({field: 'source', label: t('Источник')});

        return groups.map((group) => {
            let options = (facets[group.field] || []).map(([value, count]) => ({value, count, label: this.optionLabel(group.field, value)}));
            if (group.field === 'librate')
                options.sort((a, b) => Number(b.value) - Number(a.value));
            //выбранные значения видны всегда, даже с нулём
            for (const value of (group.field === 'added' ? [this.filters.added].filter(Boolean) : this.filters[group.field])) {
                if (!options.some(option => option.value === value))
                    options.unshift({value, count: 0, label: this.optionLabel(group.field, value)});
            }
            if (group.field === 'added')
                options = options.filter(option => option.count > 0 || option.value === this.filters.added);
            const visible = (this.expanded[group.field] ? options : options.slice(0, facetVisible));
            return Object.assign({}, group, {options, visible});
        }).filter(group => group.options.length);
    }

    get activeChips() {
        const chips = [];
        for (const field of listFields) {
            for (const value of this.filters[field])
                chips.push({field, value, label: this.optionLabel(field, value)});
        }
        if (this.filters.added)
            chips.push({field: 'added', value: this.filters.added, label: this.optionLabel('added', this.filters.added)});
        return chips;
    }

    isSelected(field, value) {
        return (field === 'added' ? this.filters.added === value : this.filters[field].includes(value));
    }

    setQuery(patch) {
        const query = Object.assign({}, this.query, patch);
        for (const key of Object.keys(query)) {
            if (query[key] === undefined || query[key] === '')
                delete query[key];
        }
        this.$router.replace({path: '/search', query});
    }

    toggleFilter(field, value, single = false) {
        if (field === 'added' || single) {
            this.setQuery({[field]: (this.filters.added === value ? undefined : value), page: undefined});
            return;
        }
        const values = new Set(this.filters[field]);
        if (values.has(value))
            values.delete(value);
        else
            values.add(value);
        //снятый последний язык означает «все языки», а не возврат к «Моим языкам»
        const joined = [...values].join(',');
        this.setQuery({[field]: (field === 'lang' && !joined ? allLanguages : joined), page: undefined});
    }

    clearFilters() {
        const query = {};
        if (this.q)
            query.q = this.q;
        if (this.query.sort)
            query.sort = this.query.sort;
        if (this.query.view)
            query.view = this.query.view;
        this.$router.replace({path: '/search', query});
    }

    setView(view) {
        this.$store.commit('setSettings', {searchView: view});
        this.setQuery({view});
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    initials(name) {
        return initials(name);
    }

    authorsOf(book) {
        return bookAuthors(book);
    }

    bookLink(book) {
        return `/book/${encodeURIComponent(bookUid(book))}`;
    }

    fileLine(book) {
        const size = Number(book.size || 0);
        const sizeText = (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : (size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : ''));
        const genre = String(book.genre || '').split(',').filter(Boolean).slice(0, 2).map(code => this.optionLabel('genre', code)).join(', ');
        return [genre, book.lang, String(book.ext || '').toUpperCase(), sizeText, book.date].filter(Boolean).join(' · ');
    }

    async load() {
        if (this.$route.path !== '/search')
            return;

        const key = this.queryKey;
        const seq = ++this.requestSeq;
        this.loadedKey = key;
        this.loading = true;
        this.error = '';
        this.$root.setAppTitle(this.q ? t('Поиск: «{q}»', {q: this.q}) : t('Поиск'));
        try {
            const result = await this.api.catalogSearch({
                q: this.q,
                filters: this.filters,
                sort: this.sort,
                offset: (this.page - 1) * this.limit,
                limit: this.limit,
                hideCopies: this.hideCopies,
                showDeleted: !!this.settings.showDeleted,
            });
            if (seq !== this.requestSeq)
                return;
            this.notReady = false;
            this.result = result;
            this.loadStates(result.books);
        } catch (e) {
            if (seq !== this.requestSeq)
                return;
            if (String(e.message).includes('catalog_index_not_ready')) {
                this.notReady = true;
                this.schedulePoll();
            } else {
                this.error = tMessage(e.message);
            }
        } finally {
            if (seq === this.requestSeq)
                this.loading = false;
        }
    }

    //индекс ещё строится: обновляем статус, пока не будет готов
    schedulePoll() {
        clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(async() => {
            if (this.$route.path !== '/search')
                return;
            await this.api.updateConfig({skipProfileLogin: true}).catch(() => {});
            if ((this.config.catalogSearch || {}).ready)
                this.load();
            else
                this.schedulePoll();
        }, 5000);
    }

    async loadStates(books) {
        if (!this.signedIn || !books.length)
            return;
        try {
            const result = await this.api.getBookStates(books.map(bookUid));
            this.states = Object.assign({}, this.states, (result && result.states) || {});
        } catch (e) {
            //отметки прочитанного не обязательны
        }
    }

    act(book, action) {
        runBookAction(this, book, action);
    }

    openLists(book) {
        this.listsBook = book;
        this.listsDialogVisible = true;
    }
}

export default vueComponent(SearchPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.search-body {
    max-width: 1280px;
}

.search-layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
}

.facets {
    display: flex;
    flex-direction: column;
    gap: 18px;
    position: sticky;
    top: 0;
}

.facets-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
}

.facet {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.facet-title {
    margin-bottom: 4px;
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.facet-option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    cursor: pointer;
}

.facet-option input {
    accent-color: var(--app-primary);
}

.facet-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.facet-count {
    color: var(--app-muted);
    font-size: 12px;
}

.facet-more {
    align-self: flex-start;
    margin-top: 2px;
}

.facets-classic {
    font-size: 13px;
}

.link-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--app-link);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}

.results {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
}

.results-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
}

.results-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.sort-select {
    min-width: 190px;
}

.facets-toggle {
    display: none;
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 0;
    border-radius: 99px;
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}

.entities {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.entity {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    max-width: 360px;
    padding: 8px 12px 8px 8px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
    color: var(--app-text) !important;
    text-decoration: none;
}

.entity:hover {
    border-color: var(--app-primary);
}

.entity-avatar {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 50%;
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-family: var(--app-font-serif);
    font-weight: 600;
}

.entity-avatar--series {
    border-radius: var(--app-radius);
}

.entity-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.entity-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.entity-meta {
    color: var(--app-muted);
    font-size: 12px;
}

.result-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.is-loading {
    opacity: 0.6;
    transition: opacity 0.15s;
}

.result-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--app-border);
}

.result-row:last-child {
    border-bottom: 0;
}

.result-cover {
    width: 44px;
    flex: none;
}

.result-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.result-title {
    color: var(--app-text) !important;
    font-family: var(--app-font-serif);
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
}

.result-title:hover {
    color: var(--app-primary) !important;
}

.result-meta {
    color: var(--app-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
}

.result-meta--small {
    font-size: 12px;
}

.result-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: none;
}

.result-rating {
    color: var(--app-accent);
    font-size: 12px;
}

.result-actions {
    display: flex;
    gap: 2px;
}

.book-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 18px;
}

.pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
}

.syntax-help {
    margin-top: 8px;
    color: var(--app-muted);
}

.syntax-help summary {
    cursor: pointer;
    font-size: 13px;
}

.syntax-help code {
    font-size: 12px;
}

@media (max-width: 899px) {
    .search-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
    }

    .facets {
        display: none;
        position: static;
        padding: 14px;
        border: 1px solid var(--app-border);
        border-radius: var(--app-radius);
        background: var(--app-surface);
    }

    .facets--open {
        display: flex;
    }

    .facets-toggle {
        display: inline-flex;
    }

    .result-row {
        gap: 10px;
        padding: 10px;
    }

    .result-cover {
        width: 36px;
    }

    .result-actions {
        display: none;
    }

    .book-grid {
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 12px;
    }
}
</style>
