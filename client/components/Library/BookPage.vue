<template>
    <div class="page">
        <div class="page-body">
            <!-- в окне книги есть крестик; у страницы книги на телефоне нет другого пути назад -->
            <q-btn v-if="!dialogUid" class="book-back" flat dense no-caps icon="la la-arrow-left" @click="goBack">
                {{ $t('common.back') }}
            </q-btn>
            <div v-if="loading" class="page-empty page-empty--inline">
                {{ $t('author.loading') }}
            </div>
            <div v-else-if="error" class="page-empty">
                <div>{{ error }}</div>
                <q-btn color="primary" unelevated no-caps @click="$router.push('/search')">
                    {{ $t('book.goToCatalog') }}
                </q-btn>
            </div>

            <template v-else-if="book">
                <section class="book-hero">
                    <div class="book-hero-cover">
                        <BookCover :book="book" :progress="progress" :read="read" />
                    </div>

                    <div class="book-hero-main">
                        <h1 class="page-title">
                            {{ book.title || $t('common.untitled') }}
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
                            <span v-if="book.serno"> · {{ $t('bookCollection.book', {n: book.serno}) }}</span>
                        </div>

                        <div v-if="unavailable" class="book-unavailable">
                            <q-icon name="la la-exclamation-circle" size="18px" />
                            <span>{{ unavailable === 'disabled' ? $t('book.unavailableDisabled') : $t('book.unavailableMissing') }}</span>
                        </div>
                        <div v-else-if="book.del" class="book-unavailable">
                            <q-icon name="la la-exclamation-circle" size="18px" />
                            <span>{{ $t('book.deletedNotice') }}</span>
                        </div>

                        <div v-if="read" class="book-progress">
                            <span class="read-mark"><q-icon name="la la-check-circle" size="16px" />{{ $t('common.read') }}</span>
                        </div>
                        <div v-else-if="progress > 0 && progress < 1" class="book-progress">
                            <div class="progress">
                                <i :style="{width: `${percent}%`}" />
                            </div>
                            <span class="card-hint num">{{ $t('bookCollection.read', {n: percent}) }}</span>
                        </div>

                        <div v-if="unavailable" class="book-actions">
                            <q-btn v-if="signedIn" outline color="primary" no-caps icon="la la-bookmark" @click="readingListsDialogVisible = true">
                                {{ $t('book.list') }}
                            </q-btn>
                        </div>
                        <div v-else class="book-actions">
                            <q-btn color="primary" unelevated no-caps icon="la la-book-open" :loading="busy === 'readBook'" @click="act('readBook')">
                                {{ readLabel }}
                            </q-btn>

                            <q-btn outline color="primary" no-caps icon="la la-download" icon-right="la la-angle-down">
                                {{ $t('common.download') }}
                                <q-menu anchor="bottom left" self="top left">
                                    <div class="menu-list">
                                        <button v-close-popup type="button" class="menu-item" @click="act('download')">
                                            {{ originalLabel }}<span class="menu-item-meta num">{{ fileSize }}</span>
                                        </button>
                                        <button v-for="format in formats" :key="format" v-close-popup type="button" class="menu-item" @click="act('download', format)">
                                            {{ format.toUpperCase() }}<span class="menu-item-meta">{{ $t('book.converted') }}</span>
                                        </button>
                                        <div class="menu-sep" />
                                        <button v-close-popup type="button" class="menu-item" @click="act('copyLink')">
                                            {{ $t('book.copyLink') }}
                                        </button>
                                    </div>
                                </q-menu>
                            </q-btn>

                            <q-btn v-if="signedIn" outline color="primary" no-caps icon="la la-bookmark" @click="readingListsDialogVisible = true">
                                {{ $t('book.list') }}
                            </q-btn>

                            <q-btn v-if="config.telegramShareEnabled || config.emailShareEnabled" outline color="primary" no-caps icon="la la-paper-plane" icon-right="la la-angle-down">
                                {{ $t('book.send') }}
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

                            <q-btn v-if="signedIn" flat color="primary" no-caps :icon="read ? 'la la-undo' : 'la la-check'" @click="toggleRead">
                                {{ read ? $t('book.markAsUnread') : $t('book.markAsRead') }}
                            </q-btn>
                        </div>

                        <div v-if="inLists.length" class="card-hint">
                            {{ $t('book.inYourLists') }} {{ inLists.join(', ') }}
                        </div>

                        <dl class="book-meta">
                            <template v-if="genres.length">
                                <dt>{{ $t('common.genre') }}</dt>
                                <dd>
                                    <template v-for="(code, index) in genres" :key="code">
                                        <router-link :to="{path: '/search', query: {genre: code}}">
                                            {{ genreLabel(code) }}
                                        </router-link><span v-if="index < genres.length - 1">, </span>
                                    </template>
                                </dd>
                            </template>
                            <template v-if="book.lang">
                                <dt>{{ $t('search.language') }}</dt>
                                <dd>{{ book.lang }}</dd>
                            </template>
                            <template v-if="book.ext || fileSize">
                                <dt>{{ $t('opds.file') }}</dt>
                                <dd class="num">
                                    {{ [String(book.ext || '').toUpperCase(), fileSize].filter(Boolean).join(' · ') }}
                                </dd>
                            </template>
                            <template v-if="book.date">
                                <dt>{{ $t('book.added') }}</dt>
                                <dd class="num">
                                    {{ book.date }}
                                </dd>
                            </template>
                            <template v-if="sourceName">
                                <dt>{{ $t('common.source') }}</dt>
                                <dd>{{ sourceName }}</dd>
                            </template>
                            <template v-if="Number(book.librate) > 0">
                                <dt>{{ $t('common.rating') }}</dt>
                                <dd>{{ '★'.repeat(Number(book.librate)) }}{{ '☆'.repeat(Math.max(0, 5 - Number(book.librate))) }}</dd>
                            </template>
                            <template v-if="book.del">
                                <dt>{{ $t('reader.backgroundStatusSolid') }}</dt>
                                <dd>{{ $t('book.markedAsDeletedIn') }}</dd>
                            </template>
                        </dl>
                    </div>
                </section>

                <section v-if="replaceable" class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ $t('book.potentialReplacements') }}
                        </h2>
                    </div>
                    <div class="card-hint">
                        {{ replacements.length ? (unavailable ? $t('book.replacementsHint') : $t('book.deletedReplacementsHint')) : $t('book.noReplacements') }}
                    </div>
                    <ol v-if="shownReplacements.length" class="replacements">
                        <li v-for="item in shownReplacements" :key="item._uid" class="replacement">
                            <button type="button" class="replacement-cover" :aria-label="$t('book.view')" @click="peekUid = item._uid">
                                <BookCover :book="item" :progress="stateOf(item).percent || 0" :read="!!stateOf(item).read" small />
                            </button>
                            <div class="replacement-main">
                                <button type="button" class="replacement-title" @click="peekUid = item._uid">
                                    {{ item.title || $t('common.untitled') }}
                                </button>
                                <div class="replacement-line">
                                    {{ [bookAuthorsOf(item).join(', '), item.series ? `${item.series}${item.serno ? ` #${item.serno}` : ''}` : ''].filter(Boolean).join(' · ') }}
                                </div>
                                <div class="replacement-line replacement-line--muted num">
                                    {{ replacementMeta(item) }}
                                </div>
                            </div>
                            <div class="replacement-actions">
                                <q-btn flat dense no-caps color="primary" icon="la la-eye" @click="peekUid = item._uid">
                                    {{ $t('book.view') }}
                                </q-btn>
                                <q-btn v-if="signedIn" outline dense no-caps color="primary" icon="la la-exchange-alt" :loading="busy === `replace-${item._uid}`" @click="replaceWith(item)">
                                    {{ $t('book.useInstead') }}
                                </q-btn>
                            </div>
                        </li>
                    </ol>
                    <q-btn v-if="replacements.length > shownReplacements.length" class="other-languages" flat dense no-caps color="primary" @click="showOtherLanguages = true">
                        {{ $t('book.showOtherLanguages', {count: replacements.length - shownReplacements.length}) }}
                    </q-btn>
                </section>

                <section v-if="editions.length" class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ $t('book.otherEditions') }}
                        </h2>
                    </div>
                    <BookCollection v-if="shownEditions.length" :books="shownEditions" :states="states" view="rows" />
                    <q-btn v-if="editions.length > shownEditions.length" class="other-languages" flat dense no-caps color="primary" @click="showOtherLanguages = true">
                        {{ $t('book.showOtherLanguages', {count: editions.length - shownEditions.length}) }}
                    </q-btn>
                </section>

                <section v-if="!unavailable" class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ $t('reader.annotation') }}
                        </h2>
                    </div>
                    <div v-if="infoLoading" class="card-hint">
                        {{ $t('author.loading') }}
                    </div>
                    <div v-else-if="annotation.length" class="book-annotation">
                        <p v-for="(paragraph, index) in annotation" :key="index">
                            {{ paragraph }}
                        </p>
                    </div>
                    <div v-else-if="bookInfo && bookInfo.notFetched" class="card-hint">
                        <div>{{ $t('book.remoteNotFetched') }}</div>
                        <q-btn class="book-get-metadata" outline dense no-caps color="primary" icon="la la-download" @click="loadInfo(true)">
                            {{ $t('book.getMetadata') }}
                        </q-btn>
                    </div>
                    <div v-else class="card-hint">
                        {{ infoError || $t('book.noAnnotation') }}
                    </div>
                </section>

                <BookDetails v-if="!unavailable" :book="book" :book-info="bookInfo" :loading="infoLoading" @updated="onMetadataUpdated" />

                <section v-if="related.length" class="book-section">
                    <div class="card-head">
                        <h2 class="card-title">
                            {{ book.series ? $t('book.moreInThisSeries') : $t('book.moreByThisAuthor') }}
                        </h2>
                        <router-link :to="book.series ? seriesLink(book.series) : authorLink(authors[0])">
                            {{ $t('reader.readerHomeFilterAll') }}
                        </router-link>
                    </div>
                    <div class="book-grid">
                        <BookCard
                            v-for="item in related"
                            :key="item._uid"
                            :book="item"
                            :progress="stateOf(item).percent"
                            :read="!!stateOf(item).read"
                            :prefix="book.series && item.serno ? `#${item.serno}` : ''"
                            :meta="book.series ? '' : String(item.date || '').slice(0, 4)"
                        />
                    </div>
                </section>
            </template>
        </div>

        <AddToListDialog v-if="book" v-model="readingListsDialogVisible" :book="book" @changed="loadLists" />
        <BookPeekDialog v-model:uid="peekUid" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';
import BookCard from './BookCard.vue';
import BookCollection from './BookCollection.vue';
import AddToListDialog from './AddToListDialog.vue';
import BookDetails from './BookDetails.vue';
import BookPeekDialog from './BookPeekDialog.vue';
import Fb2Parser from '../../../server/core/fb2/Fb2Parser';

import {t, tm} from '../../share/i18n';
import {isSignedIn, profileKey} from '../../share/session';
import {runBookAction, markBookRead, conversionFormats, bookAuthors, bookUid, canReadOnline, loadBookStates, librarySourceName} from '../../share/bookActions';
import {loadGenres, genreName, bookGenres} from '../../share/genres';
import {myLanguages, languageMatches, bookLang} from '../../share/languages';

const componentOptions = {
    components: {
        BookCover,
        BookCard,
        BookCollection,
        AddToListDialog,
        BookDetails,
        BookPeekDialog,
    },
    watch: {
        //переход по ссылке из окна поверх книги закрывает его
        '$route.fullPath'() {
            this.peekUid = '';
        },
        '$route.params.uid'() {
            if (!this.dialogUid && this.$route.path.startsWith('/book/'))
                this.load();
        },
        dialogUid() {
            this.load();
        },
        //вход, выход или другой профиль: отметки и списки прежнего не показываем (страница жива и в фоне)
        profileKey() {
            this.states = {};
            this.inLists = [];
            if (!this.book)
                return;
            this.loadLists();
            this.loadStates([this.book, ...this.editions, ...this.replacements, ...this.related]).catch(() => {});
        },
    },
};

class BookPage {
    _options = componentOptions;
    _props = {
        //книга в окне поверх страницы (BookDialog), иначе - из адреса /book/:uid
        dialogUid: {type: String, default: ''},
    };

    book = null;
    loading = false;
    error = '';
    busy = '';
    states = {};
    inLists = [];
    related = [];
    editions = [];
    //недоступная книга: возможные замены из включённых библиотек и книга, открытая поверх для просмотра
    replacements = [];
    //издания и замены на языках не из «Моих языков» и не на языке самой книги - по кнопке
    showOtherLanguages = false;
    peekUid = '';
    bookInfo = null;
    infoLoading = false;
    infoError = '';
    annotation = [];
    genresReady = 0;
    readingListsDialogVisible = false;
    loadedUid = '';

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        if (this.dialogUid)
            this.load();
    }

    activated() {
        if (this.uid !== this.loadedUid)
            this.load();
        else if (this.book)
            this.$root.setAppTitle(this.book.title);
    }

    get uid() {
        return this.dialogUid || String(this.$route.params.uid || '');
    }

    get config() {
        return this.$store.state.config;
    }

    get profileKey() {
        return profileKey(this.config);
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get authors() {
        return bookAuthors(this.book || {});
    }

    get genres() {
        return bookGenres(this.book || {});
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

    get read() {
        return !!this.stateOf(this.book || {}).read;
    }

    get readLabel() {
        if (!canReadOnline(this.config, this.book || {}))
            return t('common.readBook');
        if (this.read || this.progress >= 1)
            return t('book.readAgain');
        return (this.progress > 0 ? t('book.continue', {n: this.percent}) : t('common.readBook'));
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

    //'disabled' - библиотека книги выключена, 'missing' - книги нет в подключённых библиотеках
    get unavailable() {
        return (this.book && this.book.unavailable) || '';
    }

    //недоступная или помеченная удалённой: читатель может перейти на другую книгу со списками и прогрессом
    get replaceable() {
        return !!(this.unavailable || (this.book && this.book.del));
    }

    bookAuthorsOf(book) {
        return bookAuthors(book);
    }

    replacementMeta(book) {
        const size = Number(book.size || 0);
        const sizeText = (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : (size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : ''));
        return [String(book.lang || '').toUpperCase(), String(book.ext || '').toUpperCase(), sizeText, book.date || '',
            book.sourceName || librarySourceName(this.config, book)].filter(Boolean).join(' · ');
    }

    //Читатель сам выбирает замену: его списки, прогресс и закладки переходят к выбранной книге
    async replaceWith(item) {
        const confirmed = await this.$root.stdDialog.confirm(t('book.replaceConfirm', {from: this.book.title || ''}), t('book.replaceTitle'));
        if (!confirmed)
            return;

        this.busy = `replace-${item._uid}`;
        try {
            const result = await this.api.replaceListedBook(bookUid(this.book), item._uid);
            this.$root.notify.success(t('book.replaced'));
            const uid = (result && result.bookUid) || item._uid;
            if (this.dialogUid)
                this.$router.replace({path: this.$route.path, query: Object.assign({}, this.$route.query, {book: uid}), hash: this.$route.hash});
            else
                this.$router.replace(`/book/${encodeURIComponent(uid)}`);
        } catch (e) {
            this.$root.stdDialog.alert(tm(e.message), t('common.error'));
        } finally {
            this.busy = '';
        }
    }

    get sourceName() {
        return (this.book ? librarySourceName(this.config, this.book) : '');
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    genreLabel(code) {
        void this.genresReady;
        return genreName(code);
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
        this.editions = [];
        this.replacements = [];
        this.showOtherLanguages = false;
        this.peekUid = '';
        this.inLists = [];
        this.states = {};
        try {
            const result = await this.api.getBook(uid);
            if (uid !== this.loadedUid)
                return;
            this.book = result.book;
            this.editions = result.editions || [];
            this.replacements = result.replacements || [];
            if (!this.dialogUid)
                this.$root.setAppTitle(this.book.title);
        } catch (e) {
            if (uid === this.loadedUid)
                this.error = tm(e.message);
            return;
        } finally {
            //ответ на устаревший запрос не снимает загрузку текущего
            if (uid === this.loadedUid)
                this.loading = false;
        }

        loadGenres(this.api).then(() => this.genresReady++).catch(() => {});
        this.loadLists();
        //недоступную книгу не открыть: ни аннотации, ни похожих, только состояния замен
        if (this.unavailable) {
            this.loadStates([this.book, ...this.replacements]).catch(() => {});
            return;
        }
        this.loadInfo();
        this.loadRelated();
    }

    async loadStates(books) {
        if (this.signedIn)
            this.states = Object.assign({}, this.states, await loadBookStates(this.api, books));
    }

    async loadLists() {
        const book = this.book;
        if (!this.signedIn || !book)
            return;
        let inLists = [];
        try {
            const result = await this.api.getReadingLists(bookUid(book));
            inLists = ((result && result.lists) || []).filter(list => list.containsBook).map(list => list.name);
        } catch (e) {
            //списки не обязательны для страницы
        }
        if (book === this.book)
            this.inLists = inLists;
    }

    //«Мои языки» плюс язык самой книги, как у похожих книг: новая редакция книги видна, даже если её языка нет в «Моих языках»
    inMyLanguages(item) {
        const languages = myLanguages(this.$store.state.config, this.$store.state.settings);
        return languages.all || languageMatches(item, languages) || bookLang(item) === bookLang(this.book);
    }

    get shownReplacements() {
        return (this.showOtherLanguages ? this.replacements : this.replacements.filter(item => this.inMyLanguages(item)));
    }

    get shownEditions() {
        return (this.showOtherLanguages ? this.editions : this.editions.filter(item => this.inMyLanguages(item)));
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
            this.related = (books || []).filter(item => !item.del && bookUid(item) !== bookUid(book) && this.inMyLanguages(item)).slice(0, 12);
            await this.loadStates([book, ...this.editions, ...this.replacements, ...this.related]);
        } catch (e) {
            this.related = [];
            await this.loadStates([book, ...this.editions, ...this.replacements]);
        }
    }

    //книга удалённой библиотеки скачивается только кнопкой «Получить метаданные» (fetchRemote)
    async loadInfo(fetchRemote = false) {
        const book = this.book;
        this.infoLoading = true;
        this.infoError = '';
        try {
            const response = await this.api.getBookInfo(bookUid(book), {fetchRemote});
            if (book !== this.book)
                return;
            const bookInfo = response.bookInfo;
            this.bookInfo = bookInfo;
            this.annotation = this.extractAnnotation(bookInfo);
        } catch (e) {
            //подробности ошибки (пути на сервере) читателю не нужны
            if (book === this.book)
                this.infoError = t('book.couldNotOpenThe');
        } finally {
            if (book === this.book)
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

    //назад по истории приложения; открыта прямой ссылкой - в каталог
    goBack() {
        if ((window.history.state || {}).back)
            this.$router.back();
        else
            this.$router.push('/search');
    }

    async toggleRead() {
        const read = !this.read;
        if (await markBookRead(this, bookUid(this.book), read))
            await this.loadStates([this.book]);
    }

    onMetadataUpdated(fields) {
        Object.assign(this.book, fields);
        this.$root.setAppTitle(this.book.title);
    }
}

export default vueComponent(BookPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-back {
    align-self: flex-start;
    margin: -8px 0 -8px -8px;
}

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

.book-unavailable {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 68ch;
    color: var(--app-muted);
}

.other-languages {
    margin-top: 8px;
}

.replacements {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.replacement {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
}

.replacement-cover,
.replacement-title {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.replacement-title {
    font-weight: 600;
}

.replacement-title:hover {
    text-decoration: underline;
}

.replacement-main {
    min-width: 0;
}

.replacement-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.replacement-line--muted {
    color: var(--app-muted);
    font-size: 12px;
}

.replacement-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
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

.book-get-metadata {
    margin-top: 8px;
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
    .replacement {
        grid-template-columns: 40px minmax(0, 1fr);
    }

    .replacement-actions {
        grid-column: 2;
        justify-content: flex-start;
    }

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
