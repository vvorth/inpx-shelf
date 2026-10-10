<template>
    <div class="page">
        <div class="page-body">
            <header class="entity-head">
                <div class="entity-avatar">
                    {{ initials }}
                </div>
                <div class="entity-head-main">
                    <div class="page-eyebrow">
                        {{ $t('Автор') }}
                    </div>
                    <h1 class="page-title">
                        {{ name }}
                    </h1>
                    <div v-if="aliases.length" class="author-aliases">
                        {{ aliases.join(', ') }}
                    </div>
                    <div v-if="!loading && books.length" class="card-hint num">
                        {{ summary }}
                        <template v-if="hiddenCount">
                            · {{ $t('ещё {n} на других языках', {n: hiddenCount}) }}
                            <button type="button" class="link-btn" @click="showAllLanguages">
                                {{ $t('показать') }}
                            </button>
                        </template>
                    </div>
                </div>
            </header>

            <div v-if="loading" class="page-empty page-empty--inline">
                {{ $t('Загрузка...') }}
            </div>
            <div v-else-if="error" class="page-empty page-empty--inline">
                {{ error }}
            </div>
            <div v-else-if="!books.length" class="page-empty">
                <div>{{ $t('В библиотеке нет книг этого автора.') }}</div>
                <q-btn color="primary" unelevated no-caps @click="$router.push({path: '/search', query: {q: name}})">
                    {{ $t('Искать в каталоге') }}
                </q-btn>
            </div>

            <template v-else>
                <div class="author-tools">
                    <div v-if="languageCounts.length > 1" class="lang-chips">
                        <button
                            v-for="item in languageCounts"
                            :key="item.code"
                            type="button"
                            class="lang-chip"
                            :class="{'is-on': activeLanguages.all || activeLanguages.codes.has(item.code)}"
                            :aria-pressed="activeLanguages.all || activeLanguages.codes.has(item.code) ? 'true' : 'false'"
                            @click="toggleLanguage(item.code)"
                        >
                            {{ item.code.toUpperCase() }} <span class="num">{{ item.count }}</span>
                        </button>
                        <button v-if="!activeLanguages.all" type="button" class="link-btn" @click="showAllLanguages">
                            {{ $t('Все языки') }}
                        </button>
                        <button v-if="pageLanguages" type="button" class="link-btn" @click="pageLanguages = null">
                            {{ $t('Мои языки') }}
                        </button>
                    </div>

                    <div class="author-controls">
                        <q-input v-model="filterText" dense outlined clearable class="author-filter" :placeholder="$t('Найти у автора')">
                            <template #prepend>
                                <q-icon name="la la-search" size="16px" />
                            </template>
                        </q-input>
                        <q-btn-toggle
                            v-model="grouping"
                            :options="groupingOptions"
                            dense
                            no-caps
                            unelevated
                            toggle-color="primary"
                        />
                        <q-btn-toggle
                            :model-value="view"
                            :options="viewOptions"
                            dense
                            no-caps
                            unelevated
                            toggle-color="primary"
                            @update:model-value="$store.commit('setSettings', {bookView: $event})"
                        />
                        <q-btn flat dense no-caps icon="la la-angle-double-down" @click="setAll(true)">
                            {{ $t('Развернуть все') }}
                        </q-btn>
                        <q-btn flat dense no-caps icon="la la-angle-double-up" @click="setAll(false)">
                            {{ $t('Свернуть все') }}
                        </q-btn>
                    </div>
                </div>

                <div v-if="!visibleBooks.length" class="page-empty page-empty--inline">
                    {{ filterText ? $t('Ничего не найдено у этого автора.') : $t('Нет книг на выбранных языках.') }}
                </div>

                <section v-for="group in groups" :key="group.key" class="entity-group" :class="{'is-open': isOpen(group)}">
                    <div class="group-head">
                        <button type="button" class="group-toggle" :aria-expanded="isOpen(group) ? 'true' : 'false'" @click="toggleGroup(group)">
                            <q-icon :name="isOpen(group) ? 'la la-angle-down' : 'la la-angle-right'" size="16px" />
                            <span class="group-title">{{ group.title }}</span>
                            <span class="group-count num">{{ group.books.length }}</span>
                        </button>
                        <router-link v-if="group.series" class="group-link" :to="seriesLink(group.series)">
                            {{ $t('Страница серии') }}
                        </router-link>
                        <span v-if="groupRead(group)" class="card-hint num">{{ $t('{read} из {total} прочитано', {read: groupRead(group), total: group.books.length}) }}</span>
                        <router-link v-if="group.series && nextUnread(group) && groupRead(group)" class="group-next" :to="bookLink(nextUnread(group))">
                            {{ $t('Далее: {title}', {title: (nextUnread(group).serno ? `#${nextUnread(group).serno} ` : '') + nextUnread(group).title}) }}
                        </router-link>
                    </div>
                    <BookCollection
                        v-if="isOpen(group)"
                        :books="shownBooks(group)"
                        :states="states"
                        :view="view"
                        :show-serno="grouping === 'series'"
                        :cover-meta="bookMeta"
                    />
                    <button v-if="isOpen(group) && group.books.length > shownBooks(group).length" type="button" class="link-btn group-more" @click="showAllIn(group)">
                        {{ $t('Показать все {n}', {n: group.books.length}) }}
                    </button>
                </section>
            </template>
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
import {bookUid, bookAuthors} from '../../share/bookActions';
import {myLanguages, bookLang, languageMatches} from '../../share/languages';

//до стольки книг (после фильтра языков) все разделы открыты сразу
const expandAllLimit = 40;
//большие разделы показывают первые книги и кнопку «Показать все»
const groupPreview = 24;
const sectionsStorageKey = 'inpx-web-author-sections';

function readSections() {
    try {
        return JSON.parse(localStorage.getItem(sectionsStorageKey) || '{}') || {};
    } catch (e) {
        return {};
    }
}

function writeSections(author, state) {
    try {
        const all = readSections();
        delete all[author];
        all[author] = state;
        //помним последних 50 авторов
        const keys = Object.keys(all);
        for (const key of keys.slice(0, Math.max(0, keys.length - 50)))
            delete all[key];
        localStorage.setItem(sectionsStorageKey, JSON.stringify(all));
    } catch (e) {
        //без localStorage разделы просто не запоминаются
    }
}

const componentOptions = {
    components: {
        BookCollection,
    },
    watch: {
        '$route.params.name'() {
            if (this.$route.path.startsWith('/author/'))
                this.load();
        },
        grouping(value) {
            this.openState = (value === 'series' ? Object.assign({}, readSections()[this.name] || {}) : {});
            this.expandedGroups = {};
        },
    },
};

class AuthorPage {
    _options = componentOptions;

    books = [];
    aliases = [];
    states = {};
    loading = false;
    error = '';
    loadedName = '';
    pageLanguages = null;
    filterText = '';
    grouping = 'series';
    openState = {};
    expandedGroups = {};

    created() {
        this.api = this.$root.api;
    }

    activated() {
        if (this.name !== this.loadedName)
            this.load();
        this.$root.setAppTitle(this.name);
    }

    get name() {
        return String(this.$route.params.name || '');
    }

    get initials() {
        return initials(this.name);
    }

    get view() {
        return bookView(this.$store.state.settings);
    }

    get viewOptions() {
        return bookViewOptions();
    }

    get myLanguages() {
        return myLanguages(this.$store.state.config, this.$store.state.settings);
    }

    //языки страницы: свой выбор на этой странице или «Мои языки»
    get activeLanguages() {
        return this.pageLanguages || this.myLanguages;
    }

    get languageCounts() {
        const counts = new Map();
        for (const book of this.books) {
            const code = bookLang(book) || '?';
            counts.set(code, (counts.get(code) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({code, count}));
    }

    get languageBooks() {
        return this.books.filter(book => languageMatches(book, this.activeLanguages));
    }

    get hiddenCount() {
        return this.books.length - this.languageBooks.length;
    }

    get visibleBooks() {
        const words = String(this.filterText || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
        if (!words.length)
            return this.languageBooks;
        return this.languageBooks.filter((book) => {
            const text = `${book.title} ${book.series} ${book.author}`.toLowerCase().replace(/ё/g, 'е');
            return words.every(word => text.includes(word));
        });
    }

    get summary() {
        const books = this.languageBooks;
        const series = new Set(books.map(book => book.series).filter(Boolean)).size;
        const loose = books.filter(book => !book.series).length;
        const read = books.filter(book => this.stateOf(book).read).length;
        const parts = [t('Книг: {n}', {n: books.length})];
        if (series)
            parts.push(t('серий: {n}', {n: series}));
        if (loose && series)
            parts.push(t('вне серий: {n}', {n: loose}));
        if (read)
            parts.push(t('прочитано: {n}', {n: read}));
        return parts.join(' · ');
    }

    get groupingOptions() {
        return [
            {label: t('По сериям'), value: 'series'},
            {label: t('По дате'), value: 'date'},
            {label: t('А–Я'), value: 'title'},
        ];
    }

    get groups() {
        const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), 'ru');
        const books = this.visibleBooks;
        if (this.grouping === 'title')
            return [{key: 'all', title: t('Все книги'), books: [...books].sort(byTitle)}];

        if (this.grouping === 'date') {
            const map = new Map();
            for (const book of books) {
                const year = String(book.date || '').substring(0, 4) || '—';
                if (!map.has(year))
                    map.set(year, {key: `y-${year}`, title: t('Поступили в {year}', {year}), books: []});
                map.get(year).books.push(book);
            }
            const groups = [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
            groups.forEach(group => group.books.sort((a, b) => String(b.date).localeCompare(String(a.date)) || byTitle(a, b)));
            return groups;
        }

        //серии по алфавиту, книги без серии в конце; внутри серии - по номеру
        const map = new Map();
        for (const book of books) {
            const key = book.series || '';
            if (!map.has(key))
                map.set(key, {key: key ? `s-${key}` : 'loose', series: key, title: key || t('Вне серий'), books: []});
            map.get(key).books.push(book);
        }
        const groups = [...map.values()];
        for (const group of groups)
            group.books.sort((a, b) => (Number(a.serno) || 0) - (Number(b.serno) || 0) || byTitle(a, b));
        groups.sort((a, b) => (!a.series) - (!b.series) || a.series.localeCompare(b.series, 'ru'));
        return groups;
    }

    //по умолчанию всё открыто, если книг немного; поиск у автора тоже открывает всё
    isOpen(group) {
        if (this.filterText)
            return true;
        if (Object.prototype.hasOwnProperty.call(this.openState, group.key))
            return this.openState[group.key];
        return this.visibleBooks.length <= expandAllLimit || this.groups.length === 1;
    }

    toggleGroup(group) {
        this.openState = Object.assign({}, this.openState, {[group.key]: !this.isOpen(group)});
        this.rememberSections();
    }

    setAll(open) {
        this.openState = Object.fromEntries(this.groups.map(group => [group.key, open]));
        this.rememberSections();
    }

    rememberSections() {
        if (this.grouping === 'series')
            writeSections(this.name, this.openState);
    }

    shownBooks(group) {
        return (this.expandedGroups[group.key] || this.filterText ? group.books : group.books.slice(0, groupPreview));
    }

    showAllIn(group) {
        this.expandedGroups = Object.assign({}, this.expandedGroups, {[group.key]: true});
    }

    toggleLanguage(code) {
        const current = this.activeLanguages;
        const codes = new Set(current.all ? [] : current.list);
        if (current.all) {
            //из «всех языков» щелчок оставляет один язык
            codes.add(code);
        } else if (codes.has(code)) {
            codes.delete(code);
        } else {
            codes.add(code);
        }
        this.pageLanguages = (codes.size ? {all: false, codes, list: [...codes]} : {all: true, codes: new Set(), list: []});
    }

    showAllLanguages() {
        this.pageLanguages = {all: true, codes: new Set(), list: []};
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    groupRead(group) {
        return group.books.filter(book => this.stateOf(book).read).length;
    }

    nextUnread(group) {
        return group.books.find(book => !this.stateOf(book).read) || null;
    }

    bookMeta(book) {
        const coauthors = bookAuthors(book).filter(author => author.toLowerCase() !== this.name.toLowerCase());
        const lang = (this.activeLanguages.all || this.activeLanguages.list.length > 1 ? String(book.lang || '').toUpperCase() : '');
        return [lang, coauthors.length ? t('Соавторы: {names}', {names: coauthors.join(', ')}) : ''].filter(Boolean).join(' · ');
    }

    seriesLink(series) {
        return `/series/${encodeURIComponent(series)}`;
    }

    bookLink(book) {
        return `/book/${encodeURIComponent(bookUid(book))}`;
    }

    async load() {
        const name = this.name;
        this.loadedName = name;
        this.loading = true;
        this.error = '';
        this.books = [];
        this.states = {};
        this.pageLanguages = null;
        this.filterText = '';
        this.grouping = 'series';
        this.expandedGroups = {};
        this.openState = Object.assign({}, readSections()[name] || {});
        this.aliases = [];
        this.api.getAuthorAliases(name)
            .then((result) => {
                if (name === this.name)
                    this.aliases = (result && result.aliases) || [];
            })
            .catch(() => {});
        try {
            const result = await this.api.getAuthorBooksByName(name);
            if (name !== this.name)
                return;
            const showDeleted = !!this.$store.state.settings.showDeleted;
            this.books = (result.books || []).filter(book => showDeleted || !book.del);
        } catch (e) {
            this.error = tMessage(e.message);
        } finally {
            this.loading = false;
        }

        if (this.books.length && isSignedIn(this.$store.state.config)) {
            try {
                const result = await this.api.getBookStates(this.books.map(bookUid));
                this.states = (result && result.states) || {};
            } catch (e) {
                this.states = {};
            }
        }
    }
}

export default vueComponent(AuthorPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.entity-head {
    display: flex;
    align-items: center;
    gap: 18px;
}

.entity-head-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.entity-avatar {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    flex: none;
    border-radius: 50%;
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-family: var(--app-font-serif);
    font-size: 26px;
    font-weight: 600;
}

.author-aliases {
    color: var(--app-muted);
    font-family: var(--app-font-serif);
    font-size: 16px;
}

.link-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--app-link);
    font: inherit;
    cursor: pointer;
}

.author-tools {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.lang-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
}

.lang-chip {
    padding: 3px 10px;
    border: 1px solid var(--app-border);
    border-radius: 99px;
    background: none;
    color: var(--app-muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}

.lang-chip.is-on {
    border-color: var(--app-primary);
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-weight: 600;
}

.author-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
}

.author-filter {
    width: 260px;
    max-width: 100%;
}

.entity-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--app-border);
}

.group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
}

.group-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.group-title {
    font-size: 16px;
    font-weight: 600;
}

.group-count {
    padding: 0 8px;
    border-radius: 99px;
    background: var(--app-surface-3);
    color: var(--app-muted);
    font-size: 12px;
}

.group-link,
.group-next {
    font-size: 13px;
}

.group-more {
    align-self: flex-start;
    font-size: 13px;
}


@media (max-width: 899px) {
    .entity-avatar {
        width: 52px;
        height: 52px;
        font-size: 20px;
    }

}
</style>
