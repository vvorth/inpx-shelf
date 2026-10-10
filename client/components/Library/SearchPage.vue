<template>
    <div class="page">
        <div class="page-body search-body">
            <div v-if="searchDisabled" class="card">
                <h2 class="card-title">
                    {{ $t('Поиск по каталогу выключен') }}
                </h2>
                <div class="card-hint">
                    {{ $t('Индекс каталога отключён параметром INPX_CATALOG_SEARCH=false (catalogSearch в config.json). Книги по-прежнему доступны на страницах авторов и серий, в витринах и в OPDS.') }}
                </div>
            </div>
            <div v-else-if="notReady" class="card index-progress">
                <h2 class="card-title">
                    {{ $t('Готовлю поиск') }}
                </h2>
                <div class="card-hint">
                    {{ $t('После обновления библиотеки сервер строит поисковый индекс: читает все книги и составляет словарь для поиска с опечатками. На большой библиотеке это занимает несколько минут, страница обновится сама.') }}
                </div>
                <q-linear-progress rounded size="8px" :value="indexProgress" :indeterminate="!indexProgress" color="primary" />
                <div class="card-hint num">
                    {{ indexProgress ? $t('Готово {n}%', {n: Math.round(indexProgress * 100)}) : $t('Подготовка...') }}
                </div>
            </div>

            <div v-else class="search-layout" :class="{'search-layout--names': tab !== 'books'}">
                <aside v-if="tab === 'books'" class="facets" :class="{'facets--open': facetsOpen}">
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

                    <nav class="tabs" :aria-label="$t('Что искать')">
                        <button type="button" class="tab" :class="{'is-active': tab === 'books'}" @click="setTab('books')">
                            {{ $t('Книги') }}<span v-if="result" class="tab-count num">{{ total.toLocaleString() }}</span>
                        </button>
                        <button type="button" class="tab" :class="{'is-active': tab === 'authors'}" @click="setTab('authors')">
                            {{ $t('Авторы') }}<span v-if="namesTotals.author !== null" class="tab-count num">{{ namesTotals.author.toLocaleString() }}</span>
                        </button>
                        <button type="button" class="tab" :class="{'is-active': tab === 'series'}" @click="setTab('series')">
                            {{ $t('Серии') }}<span v-if="namesTotals.series !== null" class="tab-count num">{{ namesTotals.series.toLocaleString() }}</span>
                        </button>
                    </nav>

                    <template v-if="tab !== 'books'">
                        <div v-if="namesLoading && !names.items.length" class="page-empty page-empty--inline">
                            {{ $t('Ищу...') }}
                        </div>
                        <div v-else-if="!names.items.length" class="page-empty page-empty--inline">
                            {{ tab === 'authors' ? $t('Авторы не найдены.') : $t('Серии не найдены.') }}
                        </div>
                        <ol v-else class="name-list" :class="{'is-loading': namesLoading}">
                            <li v-for="item in names.items" :key="item.name">
                                <router-link class="name-row" :to="tab === 'authors' ? `/author/${encodeURIComponent(item.name)}` : `/series/${encodeURIComponent(item.name)}`">
                                    <span class="entity-avatar" :class="{'entity-avatar--series': tab === 'series'}">
                                        <q-icon v-if="tab === 'series'" name="la la-layer-group" size="18px" />
                                        <template v-else>{{ initials(item.name) }}</template>
                                    </span>
                                    <span class="entity-copy">
                                        <span class="entity-name">{{ item.name }}</span>
                                        <span v-if="item.alias" class="entity-meta">{{ item.alias }}</span>
                                    </span>
                                    <span class="name-count num">{{ $t('Книг: {n}', {n: item.books}) }}</span>
                                </router-link>
                            </li>
                        </ol>
                        <nav v-if="namesPageCount > 1" class="pager" :aria-label="$t('Страницы')">
                            <q-btn flat dense no-caps icon="la la-angle-left" :disable="page <= 1" @click="setQuery({page: page > 2 ? String(page - 1) : undefined})">
                                {{ $t('Назад') }}
                            </q-btn>
                            <span class="num">{{ $t('Страница {page} из {count}', {page, count: namesPageCount}) }}</span>
                            <q-btn flat dense no-caps icon-right="la la-angle-right" :disable="page >= namesPageCount" @click="setQuery({page: String(page + 1)})">
                                {{ $t('Дальше') }}
                            </q-btn>
                        </nav>
                    </template>

                    <template v-else>
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
                                <span class="entity-meta">{{ [item.alias || $t('Автор'), $t('Книг: {n}', {n: item.books})].join(' · ') }}</span>
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

                    <div v-if="result && page === 1 && (namesTotals.author > result.authors.length || namesTotals.series > result.series.length) && (result.authors.length || result.series.length)" class="entities-more">
                        <button v-if="namesTotals.author > result.authors.length" type="button" class="link-btn" @click="setTab('authors')">
                            {{ $t('Все авторы ({n})', {n: namesTotals.author}) }}
                        </button>
                        <button v-if="namesTotals.series > result.series.length" type="button" class="link-btn" @click="setTab('series')">
                            {{ $t('Все серии ({n})', {n: namesTotals.series}) }}
                        </button>
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

                    <BookCollection v-else :class="{'is-loading': loading}" :books="books" :states="states" :view="view" />

                    <nav v-if="pageCount > 1" class="pager" :aria-label="$t('Страницы')">
                        <q-btn flat dense no-caps icon="la la-angle-left" :disable="page <= 1" @click="setQuery({page: page > 2 ? String(page - 1) : undefined})">
                            {{ $t('Назад') }}
                        </q-btn>
                        <span class="num">{{ $t('Страница {page} из {count}', {page, count: pageCount}) }}</span>
                        <q-btn flat dense no-caps icon-right="la la-angle-right" :disable="page >= pageCount" @click="setQuery({page: String(page + 1)})">
                            {{ $t('Дальше') }}
                        </q-btn>
                    </nav>
                    </template>

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
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCollection from './BookCollection.vue';
import {bookView, bookViewOptions} from '../../share/bookView';

import {t, tMessage} from '../../share/i18n';
import {isSignedIn, initials} from '../../share/session';
import {bookUid} from '../../share/bookActions';
import {loadGenres, genreName} from '../../share/genres';
import {myLanguages, allLanguages, languageName} from '../../share/languages';

const listFields = ['lang', 'ext', 'genre', 'source', 'librate'];
const facetVisible = 6;

const componentOptions = {
    components: {
        BookCollection,
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
    names = {items: [], total: 0};
    namesLoading = false;
    namesTotals = {author: null, series: null};
    namesTotalsKey = null;
    facetsOpen = false;
    expanded = {};
    genresReady = 0;
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
        return bookView(this.settings);
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

    get searchDisabled() {
        return (this.config.catalogSearch || {}).enabled === false;
    }

    get tab() {
        return (['authors', 'series'].includes(this.query.tab) ? this.query.tab : 'books');
    }

    get namesPageCount() {
        return Math.ceil((this.names.total || 0) / this.limit);
    }

    setTab(tab) {
        this.setQuery({tab: (tab === 'books' ? undefined : tab), page: undefined});
    }

    //число авторов и серий по запросу - для подписей вкладок
    async loadNameTotals(q) {
        const key = q;
        this.namesTotalsKey = key;
        try {
            const [authors, series] = await Promise.all([
                this.api.catalogNames('author', q, 0, 1),
                this.api.catalogNames('series', q, 0, 1),
            ]);
            if (this.namesTotalsKey === key)
                this.namesTotals = {author: authors.total, series: series.total};
        } catch (e) {
            //подписи вкладок не обязательны; при следующей загрузке попробуем снова (например, когда индекс достроится)
            if (this.namesTotalsKey === key)
                this.namesTotalsKey = null;
        }
    }

    async loadNames(seq) {
        this.namesLoading = true;
        try {
            const result = await this.api.catalogNames(this.tab === 'authors' ? 'author' : 'series', this.q, (this.page - 1) * this.limit, this.limit);
            if (seq === this.requestSeq)
                this.names = result;
        } catch (e) {
            if (String(e.message).includes('catalog_index_not_ready')) {
                this.notReady = true;
                this.schedulePoll();
            }
        } finally {
            if (seq === this.requestSeq)
                this.namesLoading = false;
        }
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
        return bookViewOptions();
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
        this.$router.replace({path: '/search', query});
    }

    setView(view) {
        this.$store.commit('setSettings', {bookView: view});
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    initials(name) {
        return initials(name);
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
        if (this.searchDisabled) {
            this.loading = false;
            return;
        }
        if (this.namesTotalsKey !== this.q)
            this.loadNameTotals(this.q);
        const booksTab = (this.tab === 'books');
        if (!booksTab)
            this.loadNames(seq);
        try {
            //на вкладках авторов и серий нужен только счётчик книг для подписи вкладки
            const result = await this.api.catalogSearch({
                q: this.q,
                filters: this.filters,
                sort: this.sort,
                offset: (booksTab ? (this.page - 1) * this.limit : 0),
                limit: (booksTab ? this.limit : 1),
                facets: booksTab,
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


.link-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--app-link);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}

.search-layout--names {
    grid-template-columns: minmax(0, 1fr);
}

.index-progress {
    max-width: 640px;
}

.tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--app-border);
}

.tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: -1px;
    padding: 8px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--app-muted);
    font: inherit;
    cursor: pointer;
}

.tab.is-active {
    border-bottom-color: var(--app-primary);
    color: var(--app-text);
    font-weight: 600;
}

.tab-count {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 400;
}

.entities-more {
    display: flex;
    gap: 16px;
    font-size: 13px;
}

.name-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.name-list li + li {
    border-top: 1px solid var(--app-border);
}

.name-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
    color: var(--app-text) !important;
    text-decoration: none;
}

.name-row:hover {
    background: var(--app-surface-3);
}

.name-row .entity-copy {
    flex: 1;
}

.name-count {
    color: var(--app-muted);
    font-size: 12px;
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















.is-loading {
    opacity: 0.6;
    transition: opacity 0.15s;
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

}
</style>
