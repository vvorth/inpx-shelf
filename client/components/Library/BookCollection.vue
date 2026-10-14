<template>
    <div class="book-collection">
        <div v-if="view === 'covers'" class="covers-grid">
            <BookCard
                v-for="book in books"
                :key="keyOf(book)"
                :book="book"
                :progress="stateOf(book).percent || 0"
                :prefix="showSerno && book.serno ? `#${book.serno}` : ''"
                :meta="coverMeta ? coverMeta(book) : [editionsText(book), authorsOf(book).join(', ')].filter(Boolean).join(' · ')"
                @open="$emit('interaction', {book, type: 'open'})"
            />
        </div>

        <div v-else-if="view === 'cards'" class="cards-grid">
            <article v-for="book in books" :key="keyOf(book)" class="wide-card" :class="{'is-unavailable': book.unavailable}">
                <component :is="linkTag(book)" class="wide-card-cover" v-bind="linkAttrs(book)" @click="opened(book)">
                    <BookCover :book="book" :progress="coverProgress(book)" />
                </component>
                <div class="wide-card-body">
                    <component :is="linkTag(book)" class="book-title-link wide-card-title" v-bind="linkAttrs(book)" @click="opened(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('common.untitled') }}
                    </component>
                    <div class="book-line">
                        <template v-for="(name, index) in authorsOf(book)" :key="name">
                            <span v-if="isExternal(book)">{{ name }}</span>
                            <router-link v-else :to="authorLink(name)">
                                {{ name }}
                            </router-link><span v-if="index < authorsOf(book).length - 1">, </span>
                        </template>
                    </div>
                    <div v-if="book.series && !isExternal(book)" class="book-line">
                        <router-link :to="seriesLink(book.series)">
                            {{ book.series }}
                        </router-link><span v-if="book.serno" class="num"> · {{ $t('bookCollection.book', {n: book.serno}) }}</span>
                    </div>
                    <div v-if="genresOf(book)" class="book-line book-line--muted">
                        {{ genresOf(book) }}
                    </div>
                    <div v-if="!isExternal(book)" class="book-line book-line--muted num">
                        {{ fileLine(book) }}
                    </div>
                    <div class="wide-card-foot">
                        <span v-if="isExternal(book)" class="pill pill--warn">{{ $t('bookCard.notInTheLibrary') }}</span>
                        <span v-else-if="book.unavailable" class="pill pill--warn">{{ $t('bookCard.unavailable') }}</span>
                        <span v-else-if="stateOf(book).read" class="read-mark"><q-icon name="la la-check-circle" size="16px" />{{ $t('common.read') }}</span>
                        <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ $t('bookCollection.read', {n: Math.round(stateOf(book).percent * 100)}) }}</span>
                        <span v-if="!isExternal(book) && Number(book.librate) > 0" class="rating" :title="$t('common.rating')">{{ stars(book) }}</span>
                        <div class="foot-actions">
                            <BookQuickActions :book="book" :signed-in="signedIn" :in-list="!!stateOf(book).inList" @lists="openLists(book)" @used="$emit('interaction', {book, type: $event})" />
                        </div>
                    </div>
                </div>
            </article>
        </div>

        <ol v-else class="rows">
            <li v-for="book in books" :key="keyOf(book)" class="row-item" :class="{'is-unavailable': book.unavailable}">
                <component :is="linkTag(book)" class="row-cover" v-bind="linkAttrs(book)" @click="opened(book)">
                    <BookCover :book="book" :progress="coverProgress(book)" small />
                </component>
                <div class="row-main">
                    <component :is="linkTag(book)" class="book-title-link row-title" v-bind="linkAttrs(book)" @click="opened(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('common.untitled') }}
                    </component>
                    <div class="book-line">
                        <template v-for="(name, index) in authorsOf(book)" :key="name">
                            <span v-if="isExternal(book)">{{ name }}</span>
                            <router-link v-else :to="authorLink(name)">
                                {{ name }}
                            </router-link><span v-if="index < authorsOf(book).length - 1">, </span>
                        </template>
                        <template v-if="book.series && !isExternal(book)">
                            · <router-link :to="seriesLink(book.series)">
                                {{ book.series }}
                            </router-link><span v-if="book.serno"> #{{ book.serno }}</span>
                        </template>
                    </div>
                    <div class="book-line book-line--muted book-line--small num">
                        {{ [genresOf(book), isExternal(book) ? '' : fileLine(book)].filter(Boolean).join(' · ') }}
                    </div>
                </div>
                <div class="row-side">
                    <span v-if="isExternal(book)" class="pill pill--warn">{{ $t('bookCard.notInTheLibrary') }}</span>
                    <span v-else-if="book.unavailable" class="pill pill--warn">{{ $t('bookCard.unavailable') }}</span>
                    <span v-else-if="stateOf(book).read" class="read-mark"><q-icon name="la la-check-circle" size="16px" />{{ $t('common.read') }}</span>
                    <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ Math.round(stateOf(book).percent * 100) }}%</span>
                    <span v-if="!isExternal(book) && Number(book.librate) > 0" class="rating" :title="$t('common.rating')">{{ stars(book) }}</span>
                    <div class="row-actions">
                        <BookQuickActions :book="book" :signed-in="signedIn" :in-list="!!stateOf(book).inList" @lists="openLists(book)" @used="$emit('interaction', {book, type: $event})" />
                    </div>
                </div>
            </li>
        </ol>

        <AddToListDialog v-if="listsBook" v-model="listsDialogVisible" :book="listsBook" @changed="listsChanged" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCard from './BookCard.vue';
import BookCover from './BookCover.vue';
import BookQuickActions from './BookQuickActions.vue';
import {isExternalOnly} from '../../share/discovery';
import AddToListDialog from './AddToListDialog.vue';

import {isSignedIn} from '../../share/session';
import {bookAuthors, bookUid, bookRoute, librarySourceName} from '../../share/bookActions';
import {loadGenres, genreName, bookGenres} from '../../share/genres';

const componentOptions = {
    emits: ['interaction'],
    watch: {
        //страница перечитала состояния - поправки после окна списков больше не нужны
        states() {
            this.changedStates = {};
        },
    },
    components: {
        BookCard,
        BookCover,
        BookQuickActions,
        AddToListDialog,
    },
};

//Список книг в одном из трёх видов. Используется везде, где показываются книги:
//поиск, страница автора, витрины. Событие interaction нужно витринам.
class BookCollection {
    _options = componentOptions;
    _props = {
        books: {type: Array, required: true},
        states: {type: Object, default: () => ({})},
        view: {type: String, default: 'covers'},
        showSerno: Boolean,
        coverMeta: {type: Function, default: null},
    };

    genresReady = 0;
    //состояния книг, обновлённые после правки списков в окне: поверх states от страницы
    changedStates = {};
    listsBook = null;
    listsDialogVisible = false;

    created() {
        loadGenres(this.$root.api).then(() => this.genresReady++).catch(() => {});
    }

    get signedIn() {
        return isSignedIn(this.$store.state.config);
    }

    keyOf(book) {
        return book._uid || book.discoveryUrl || `${book.title}-${book.author}`;
    }

    isExternal(book) {
        return isExternalOnly(book);
    }

    linkTag(book) {
        return (this.isExternal(book) ? 'a' : 'router-link');
    }

    linkAttrs(book) {
        return (this.isExternal(book)
            ? {href: book.discoveryUrl || undefined, target: '_blank', rel: 'noopener'}
            : {to: bookRoute(book)});
    }

    opened(book) {
        this.$emit('interaction', {book, type: 'open'});
    }

    stateOf(book) {
        const uid = bookUid(book);
        return this.changedStates[uid] || this.states[uid] || {};
    }

    //в карточках и строках прочитанное отмечено рядом с текстом: галочка на обложке не нужна
    coverProgress(book) {
        const state = this.stateOf(book);
        return (state.read ? 0 : state.percent || 0);
    }

    authorsOf(book) {
        return bookAuthors(book);
    }

    genresOf(book) {
        void this.genresReady;
        return bookGenres(book).slice(0, 3).map(code => genreName(code)).join(', ');
    }

    fileLine(book) {
        const size = Number(book.size || 0);
        const sizeText = (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : (size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : ''));
        //библиотека - последней: самое неважное в строке
        return [String(book.lang || '').toUpperCase(), String(book.ext || '').toUpperCase(), sizeText, this.editionsText(book),
            librarySourceName(this.$store.state.config, book)].filter(Boolean).join(' · ');
    }

    //с флажком «Скрыть копии» поиск объединяет издания одного произведения в одну книгу: остальные - на её странице
    editionsText(book) {
        return (book.editions > 1 ? this.$t('bookCollection.editions', {n: book.editions}) : '');
    }

    stars(book) {
        return '★'.repeat(Math.max(0, Math.min(5, Number(book.librate) || 0)));
    }

    openLists(book) {
        this.listsBook = book;
        this.listsDialogVisible = true;
    }

    async listsChanged() {
        const book = this.listsBook;
        this.$emit('interaction', {book, type: 'save'});
        const uid = bookUid(book);
        try {
            const result = await this.$root.api.getBookStates([uid]);
            const state = (result && result.states && result.states[uid]) || {};
            this.changedStates = Object.assign({}, this.changedStates, {[uid]: Object.assign({}, this.stateOf(book), state, {inList: !!state.inList})});
        } catch (e) {
            //отметка закладки не обязательна
        }
    }
}

export default vueComponent(BookCollection);
//-----------------------------------------------------------------------------
</script>

<style scoped>
/* недоступная книга: бледная, открывается только её окно (замены, списки) */
.is-unavailable .row-cover,
.is-unavailable .wide-card-cover,
.is-unavailable .row-main,
.is-unavailable .wide-card-title {
    opacity: 0.5;
    filter: grayscale(1);
}

.covers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 18px;
}

.cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 14px;
}

.wide-card {
    display: flex;
    gap: 14px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.wide-card-cover {
    width: 96px;
    flex: none;
    align-self: flex-start;
}

.wide-card-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
}

.book-title-link {
    color: var(--app-text) !important;
    font-family: var(--app-font-serif);
    font-weight: 600;
    text-decoration: none;
}

.book-title-link:hover {
    color: var(--app-primary) !important;
}

.wide-card-title {
    margin-bottom: 2px;
    font-size: 16px;
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.serno {
    margin-right: 6px;
    color: var(--app-muted);
    font-family: inherit;
    font-weight: 500;
}

.book-line {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.book-line--muted {
    color: var(--app-muted);
}

.book-line--small {
    font-size: 12px;
}

/* в узкой карточке кнопки переносятся под метку, а не вылезают за край */
.wide-card-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-top: auto;
    padding-top: 6px;
}

.foot-actions {
    display: flex;
    align-items: center;
    margin-left: auto;
}

.row-actions {
    display: flex;
    align-items: center;
}

.rating {
    color: var(--app-accent);
    font-size: 12px;
    white-space: nowrap;
}

.rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.row-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--app-border);
}

.row-item:last-child {
    border-bottom: 0;
}

.row-cover {
    width: 44px;
    flex: none;
}

.row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.row-title {
    font-size: 15px;
}

.row-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: none;
}

@media (max-width: 899px) {
    .covers-grid {
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 12px;
    }

    .cards-grid {
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
    }

    .wide-card-cover {
        width: 76px;
    }

    .row-item {
        gap: 10px;
        padding: 10px;
    }

    .row-cover {
        width: 36px;
    }

    .row-actions :deep(.quick-actions) {
        display: none;
    }
}
</style>
