<template>
    <div class="page">
        <div class="page-body">
            <div v-if="loading" class="page-empty page-empty--inline">
                {{ $t('Загрузка...') }}
            </div>
            <div v-else-if="error" class="page-empty">
                <div>{{ error }}</div>
                <q-btn color="primary" unelevated no-caps @click="$router.push('/search')">
                    {{ $t('В каталог') }}
                </q-btn>
            </div>

            <template v-else-if="book">
                <section class="book-hero">
                    <div class="book-hero-cover">
                        <BookCover :book="book" :progress="progress" />
                    </div>

                    <div class="book-hero-main">
                        <h1 class="page-title">
                            {{ book.title || $t('Без названия') }}
                        </h1>
                        <div class="book-authors">
                            <template v-for="(name, index) in authors" :key="name">
                                <router-link :to="authorLink(name)">
                                    {{ name }}
                                </router-link><span v-if="index < authors.length - 1">, </span>
                            </template>
                        </div>
                        <div v-if="book.series" class="book-series">
                            <router-link :to="seriesLink(book.series)">
                                {{ book.series }}
                            </router-link>
                            <span v-if="book.serno"> · {{ $t('книга {n}', {n: book.serno}) }}</span>
                        </div>

                        <div v-if="progress > 0 && progress < 1" class="book-progress">
                            <div class="progress">
                                <i :style="{width: `${percent}%`}" />
                            </div>
                            <span class="card-hint num">{{ $t('Прочитано {n}%', {n: percent}) }}</span>
                        </div>

                        <div class="book-actions">
                            <q-btn color="primary" unelevated no-caps icon="la la-book-open" :loading="busy === 'readBook'" @click="act('readBook')">
                                {{ readLabel }}
                            </q-btn>

                            <q-btn outline color="primary" no-caps icon="la la-download" icon-right="la la-angle-down">
                                {{ $t('Скачать') }}
                                <q-menu anchor="bottom left" self="top left">
                                    <div class="menu-list">
                                        <button v-close-popup type="button" class="menu-item" @click="act('download')">
                                            {{ originalLabel }}<span class="menu-item-meta num">{{ fileSize }}</span>
                                        </button>
                                        <button v-for="format in formats" :key="format" v-close-popup type="button" class="menu-item" @click="act('download', format)">
                                            {{ format.toUpperCase() }}<span class="menu-item-meta">{{ $t('конвертация') }}</span>
                                        </button>
                                        <div class="menu-sep" />
                                        <button v-close-popup type="button" class="menu-item" @click="act('copyLink')">
                                            {{ $t('Скопировать ссылку') }}
                                        </button>
                                    </div>
                                </q-menu>
                            </q-btn>

                            <q-btn v-if="signedIn" outline color="primary" no-caps icon="la la-bookmark" @click="readingListsDialogVisible = true">
                                {{ $t('В список') }}
                            </q-btn>

                            <q-btn v-if="config.telegramShareEnabled || config.emailShareEnabled" outline color="primary" no-caps icon="la la-paper-plane" icon-right="la la-angle-down">
                                {{ $t('Отправить') }}
                                <q-menu anchor="bottom left" self="top left">
                                    <div class="menu-list">
                                        <template v-if="config.telegramShareEnabled">
                                            <button v-close-popup type="button" class="menu-item" @click="act('sendTelegram')">
                                                Telegram<span class="menu-item-meta">{{ book.ext }}</span>
                                            </button>
                                            <button v-for="format in formats" :key="`tg-${format}`" v-close-popup type="button" class="menu-item" @click="act('sendTelegram', format)">
                                                Telegram<span class="menu-item-meta">{{ format }}</span>
                                            </button>
                                        </template>
                                        <template v-if="config.emailShareEnabled">
                                            <button v-close-popup type="button" class="menu-item" @click="act('sendEmail')">
                                                Email<span class="menu-item-meta">{{ book.ext }}</span>
                                            </button>
                                            <button v-for="format in formats" :key="`mail-${format}`" v-close-popup type="button" class="menu-item" @click="act('sendEmail', format)">
                                                Email<span class="menu-item-meta">{{ format }}</span>
                                            </button>
                                        </template>
                                    </div>
                                </q-menu>
                            </q-btn>

                            <q-btn v-if="signedIn" flat color="primary" no-caps :icon="progress >= 1 ? 'la la-undo' : 'la la-check'" @click="toggleRead">
                                {{ progress >= 1 ? $t('Снять отметку') : $t('Прочитано') }}
                            </q-btn>
                        </div>

                        <div v-if="inLists.length" class="card-hint">
                            {{ $t('В ваших списках:') }} {{ inLists.join(', ') }}
                        </div>

                        <dl class="book-meta">
                            <template v-if="genres.length">
                                <dt>{{ $t('Жанр') }}</dt>
                                <dd>
                                    <template v-for="(code, index) in genres" :key="code">
                                        <router-link :to="{path: '/search', query: {genre: code}}">
                                            {{ genreLabel(code) }}
                                        </router-link><span v-if="index < genres.length - 1">, </span>
                                    </template>
                                </dd>
                            </template>
                            <template v-if="book.lang">
                                <dt>{{ $t('Язык') }}</dt>
                                <dd>{{ book.lang }}</dd>
                            </template>
                            <dt>{{ $t('Файл') }}</dt>
                            <dd class="num">
                                {{ [String(book.ext || '').toUpperCase(), fileSize].filter(Boolean).join(' · ') }}
                            </dd>
                            <template v-if="book.date">
                                <dt>{{ $t('Добавлена') }}</dt>
                                <dd class="num">
                                    {{ book.date }}
                                </dd>
                            </template>
                            <template v-if="sourceName">
                                <dt>{{ $t('Источник') }}</dt>
                                <dd>{{ sourceName }}</dd>
                            </template>
                            <template v-if="Number(book.librate) > 0">
                                <dt>{{ $t('Оценка') }}</dt>
                                <dd>{{ '★'.repeat(Number(book.librate)) }}{{ '☆'.repeat(Math.max(0, 5 - Number(book.librate))) }}</dd>
                            </template>
                            <template v-if="book.del">
                                <dt>{{ $t('Статус') }}</dt>
                                <dd>{{ $t('Помечена удалённой в библиотеке') }}</dd>
                            </template>
                        </dl>
                    </div>
                </section>

                <section class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ $t('Аннотация') }}
                        </h2>
                        <q-btn v-if="bookInfo" flat dense no-caps color="primary" icon="la la-info-circle" @click="bookInfoDialogVisible = true">
                            {{ admin ? $t('Подробнее и правка') : $t('Подробнее') }}
                        </q-btn>
                    </div>
                    <div v-if="infoLoading" class="card-hint">
                        {{ $t('Загрузка...') }}
                    </div>
                    <div v-else-if="annotation.length" class="book-annotation">
                        <p v-for="(paragraph, index) in annotation" :key="index">
                            {{ paragraph }}
                        </p>
                    </div>
                    <div v-else class="card-hint">
                        {{ infoError || $t('Аннотации нет.') }}
                    </div>
                </section>

                <section v-if="related.length" class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ book.series ? $t('Ещё в серии') : $t('Ещё у автора') }}
                        </h2>
                        <router-link :to="book.series ? seriesLink(book.series) : authorLink(authors[0])">
                            {{ $t('Все') }}
                        </router-link>
                    </div>
                    <div class="book-grid">
                        <BookCard
                            v-for="item in related"
                            :key="item._uid"
                            :book="item"
                            :progress="stateOf(item).percent"
                            :prefix="book.series && item.serno ? `#${item.serno}` : ''"
                            :meta="book.series ? '' : String(item.date || '').slice(0, 4)"
                        />
                    </div>
                </section>
            </template>
        </div>

        <AddToListDialog v-if="book" v-model="readingListsDialogVisible" :book="book" @update:model-value="onListsDialog" />
        <BookInfoDialog v-if="bookInfo" v-model="bookInfoDialogVisible" :book-info="bookInfo" :genre-map="genreMap" initial-tab="fb2" @navigate="onInfoNavigate" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';
import BookCard from './BookCard.vue';
import AddToListDialog from './AddToListDialog.vue';
import BookInfoDialog from '../Search/BookInfoDialog/BookInfoDialog.vue';
import Fb2Parser from '../../../server/core/fb2/Fb2Parser';

import {t, tMessage} from '../../share/i18n';
import {isSignedIn, isAdmin} from '../../share/session';
import {runBookAction, markBooksRead, conversionFormats, bookAuthors, bookUid, canReadOnline} from '../../share/bookActions';
import {loadGenres, genreName, bookGenres} from '../../share/genres';
import {myLanguages, languageMatches, bookLang} from '../../share/languages';

const componentOptions = {
    components: {
        BookCover,
        BookCard,
        AddToListDialog,
        BookInfoDialog,
    },
    watch: {
        '$route.params.uid'() {
            if (this.$route.path.startsWith('/book/'))
                this.load();
        },
    },
};

class BookPage {
    _options = componentOptions;

    book = null;
    loading = false;
    error = '';
    busy = '';
    states = {};
    inLists = [];
    related = [];
    bookInfo = null;
    infoLoading = false;
    infoError = '';
    annotation = [];
    genresReady = 0;
    readingListsDialogVisible = false;
    bookInfoDialogVisible = false;
    loadedUid = '';

    created() {
        this.api = this.$root.api;
    }

    activated() {
        if (this.uid !== this.loadedUid)
            this.load();
        else if (this.book)
            this.$root.setAppTitle(this.book.title);
    }

    get uid() {
        return String(this.$route.params.uid || '');
    }

    get config() {
        return this.$store.state.config;
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get admin() {
        return isAdmin(this.config);
    }

    get authors() {
        return bookAuthors(this.book || {});
    }

    get genres() {
        return bookGenres(this.book || {});
    }

    get genreMap() {
        //BookInfoDialog ждёт Map код -> название
        void this.genresReady;
        return new Map(this.genres.map(code => [code, genreName(code)]));
    }

    get formats() {
        return conversionFormats(this.config, this.book || {});
    }

    get progress() {
        return this.stateOf(this.book || {}).percent || 0;
    }

    get percent() {
        return Math.round(this.progress * 100);
    }

    get readLabel() {
        if (!canReadOnline(this.config, this.book || {}))
            return t('Читать');
        if (this.progress > 0 && this.progress < 1)
            return t('Продолжить · {n}%', {n: this.percent});
        return this.progress >= 1 ? t('Читать снова') : t('Читать');
    }

    get originalLabel() {
        const ext = String((this.book && this.book.ext) || '').toUpperCase();
        return this.$store.state.settings.downloadAsZip ? `${ext} (zip)` : ext;
    }

    get fileSize() {
        const size = Number((this.book && this.book.size) || 0);
        if (!(size > 0))
            return '';
        return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
    }

    get sourceName() {
        const sources = Array.isArray(this.config.librarySources) ? this.config.librarySources : [];
        if (sources.length < 2 || !this.book || !this.book.sourceId)
            return '';
        const source = sources.find(item => item.id === this.book.sourceId);
        return source ? source.name : this.book.sourceId;
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    genreLabel(code) {
        void this.genresReady;
        return genreName(code);
    }

    authorLink(name) {
        return `/author/${encodeURIComponent(name || '')}`;
    }

    seriesLink(name) {
        return `/series/${encodeURIComponent(name || '')}`;
    }

    async load() {
        const uid = this.uid;
        if (!uid)
            return;

        this.loadedUid = uid;
        this.loading = true;
        this.error = '';
        this.book = null;
        this.bookInfo = null;
        this.annotation = [];
        this.infoError = '';
        this.related = [];
        this.inLists = [];
        this.states = {};
        try {
            const result = await this.api.getBook(uid);
            if (uid !== this.uid)
                return;
            this.book = result.book;
            this.$root.setAppTitle(this.book.title);
        } catch (e) {
            this.error = tMessage(e.message);
            return;
        } finally {
            this.loading = false;
        }

        loadGenres(this.api).then(() => this.genresReady++).catch(() => {});
        this.loadInfo();
        this.loadRelated();
        this.loadLists();
    }

    async loadStates(books) {
        if (!this.signedIn)
            return;
        try {
            const result = await this.api.getBookStates(books.map(bookUid));
            this.states = Object.assign({}, this.states, (result && result.states) || {});
        } catch (e) {
            //прогресс не обязателен для страницы
        }
    }

    async loadLists() {
        if (!this.signedIn)
            return;
        try {
            const result = await this.api.getReadingLists(bookUid(this.book));
            this.inLists = ((result && result.lists) || []).filter(list => list.containsBook).map(list => list.name);
        } catch (e) {
            this.inLists = [];
        }
    }

    async loadRelated() {
        const book = this.book;
        try {
            let books;
            if (book.series) {
                books = (await this.api.getSeriesBookList(book.series)).books || [];
                books.sort((a, b) => (Number(a.serno) || 0) - (Number(b.serno) || 0));
            } else if (this.authors.length) {
                books = (await this.api.getAuthorBooksByName(this.authors[0])).books || [];
            }
            if (book !== this.book)
                return;
            //«Мои языки» плюс язык самой книги: у английской книги видна английская серия
            const languages = myLanguages(this.$store.state.config, this.$store.state.settings);
            const allowed = (item) => languages.all || languageMatches(item, languages) || bookLang(item) === bookLang(book);
            this.related = (books || []).filter(item => !item.del && bookUid(item) !== bookUid(book) && allowed(item)).slice(0, 12);
            await this.loadStates([book, ...this.related]);
        } catch (e) {
            this.related = [];
            await this.loadStates([book]);
        }
    }

    async loadInfo() {
        const book = this.book;
        this.infoLoading = true;
        try {
            const response = await this.api.getBookInfo(bookUid(book));
            if (book !== this.book)
                return;
            const bookInfo = response.bookInfo;
            this.bookInfo = bookInfo;
            this.annotation = this.extractAnnotation(bookInfo);
        } catch (e) {
            //подробности ошибки (пути на сервере) читателю не нужны
            this.infoError = t('Не удалось открыть файл книги, аннотация недоступна.');
        } finally {
            this.infoLoading = false;
        }
    }

    //Аннотация как обычный текст по абзацам: без v-html
    extractAnnotation(bookInfo) {
        if (!bookInfo || !bookInfo.fb2)
            return [];
        try {
            const info = new Fb2Parser(bookInfo.fb2).bookInfo();
            const html = info.titleInfo && info.titleInfo.annotationHtml;
            if (!html)
                return [];
            const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
            const blocks = [...doc.body.querySelectorAll('p, div > *')].map(node => node.textContent.replace(/\s+/g, ' ').trim());
            const paragraphs = blocks.filter(Boolean);
            return paragraphs.length ? paragraphs : [doc.body.textContent.replace(/\s+/g, ' ').trim()].filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    async act(action, format = '') {
        this.busy = action;
        try {
            await runBookAction(this, this.book, action, format);
        } finally {
            this.busy = '';
        }
    }

    async toggleRead() {
        const read = !(this.progress >= 1);
        if (await markBooksRead(this, [bookUid(this.book)], read))
            await this.loadStates([this.book]);
    }

    onListsDialog(visible) {
        this.readingListsDialogVisible = visible;
        if (!visible)
            this.loadLists();
    }

    onInfoNavigate(event) {
        if (!event || !event.value)
            return;
        this.bookInfoDialogVisible = false;
        if (event.type === 'author')
            this.$router.push(this.authorLink(event.value));
        else if (event.type === 'series')
            this.$router.push(this.seriesLink(event.value));
    }
}

export default vueComponent(BookPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-hero {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
}

.book-hero-cover {
    max-width: 200px;
}

.book-hero-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
}

.book-authors {
    font-size: 16px;
}

.book-series {
    color: var(--app-muted);
}

.book-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 360px;
}

.book-progress .progress {
    flex: 1;
}

.book-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.book-meta {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 16px;
    margin: 4px 0 0;
    font-size: 13px;
}

.book-meta dt {
    color: var(--app-muted);
}

.book-meta dd {
    margin: 0;
}

.book-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.book-annotation {
    max-width: 68ch;
    font-family: var(--app-font-serif);
    font-size: 16px;
    line-height: 1.6;
}

.book-annotation p {
    margin: 0 0 0.8em;
}

.book-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 18px;
}

.menu-list {
    display: flex;
    flex-direction: column;
    min-width: 220px;
    padding: 6px 0;
}

.menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border: 0;
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.menu-item:hover {
    background: var(--app-surface-3);
}

.menu-item-meta {
    margin-left: auto;
    color: var(--app-muted);
    font-size: 12px;
}

.menu-sep {
    height: 1px;
    margin: 6px 0;
    background: var(--app-border);
}

@media (max-width: 899px) {
    .book-hero {
        grid-template-columns: 120px minmax(0, 1fr);
        gap: 16px;
    }

    .book-grid {
        grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
        gap: 12px;
    }
}
</style>
