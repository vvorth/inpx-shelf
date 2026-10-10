<template>
    <div class="book-collection">
        <div v-if="view === 'covers'" class="covers-grid">
            <BookCard
                v-for="book in books"
                :key="book._uid"
                :book="book"
                :progress="stateOf(book).percent || 0"
                :prefix="showSerno && book.serno ? `#${book.serno}` : ''"
                :meta="coverMeta ? coverMeta(book) : ''"
            />
        </div>

        <div v-else-if="view === 'cards'" class="cards-grid">
            <article v-for="book in books" :key="book._uid" class="wide-card">
                <router-link class="wide-card-cover" :to="bookLink(book)">
                    <BookCover :book="book" :progress="stateOf(book).percent || 0" />
                </router-link>
                <div class="wide-card-body">
                    <router-link class="book-title-link wide-card-title" :to="bookLink(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('Без названия') }}
                    </router-link>
                    <div class="book-line">
                        <template v-for="(name, index) in authorsOf(book)" :key="name">
                            <router-link :to="authorLink(name)">
                                {{ name }}
                            </router-link><span v-if="index < authorsOf(book).length - 1">, </span>
                        </template>
                    </div>
                    <div v-if="book.series" class="book-line">
                        <router-link :to="seriesLink(book.series)">
                            {{ book.series }}
                        </router-link><span v-if="book.serno" class="num"> · {{ $t('книга {n}', {n: book.serno}) }}</span>
                    </div>
                    <div v-if="genresOf(book)" class="book-line book-line--muted">
                        {{ genresOf(book) }}
                    </div>
                    <div class="book-line book-line--muted num">
                        {{ fileLine(book) }}
                    </div>
                    <div class="wide-card-foot">
                        <span v-if="stateOf(book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                        <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ $t('Прочитано {n}%', {n: Math.round(stateOf(book).percent * 100)}) }}</span>
                        <span v-else-if="Number(book.librate) > 0" class="rating" :title="$t('Оценка')">{{ stars(book) }}</span>
                        <span class="foot-spacer" />
                        <BookQuickActions :book="book" :signed-in="signedIn" @lists="openLists(book)" />
                    </div>
                </div>
            </article>
        </div>

        <ol v-else class="rows">
            <li v-for="book in books" :key="book._uid" class="row-item">
                <router-link class="row-cover" :to="bookLink(book)">
                    <BookCover :book="book" :progress="stateOf(book).percent || 0" small />
                </router-link>
                <div class="row-main">
                    <router-link class="book-title-link row-title" :to="bookLink(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('Без названия') }}
                    </router-link>
                    <div class="book-line">
                        <template v-for="(name, index) in authorsOf(book)" :key="name">
                            <router-link :to="authorLink(name)">
                                {{ name }}
                            </router-link><span v-if="index < authorsOf(book).length - 1">, </span>
                        </template>
                        <template v-if="book.series">
                            · <router-link :to="seriesLink(book.series)">
                                {{ book.series }}
                            </router-link><span v-if="book.serno"> #{{ book.serno }}</span>
                        </template>
                    </div>
                    <div class="book-line book-line--muted book-line--small num">
                        {{ [genresOf(book), fileLine(book)].filter(Boolean).join(' · ') }}
                    </div>
                </div>
                <div class="row-side">
                    <span v-if="stateOf(book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                    <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ Math.round(stateOf(book).percent * 100) }}%</span>
                    <span v-else-if="Number(book.librate) > 0" class="rating" :title="$t('Оценка')">{{ stars(book) }}</span>
                    <BookQuickActions class="row-actions" :book="book" :signed-in="signedIn" @lists="openLists(book)" />
                </div>
            </li>
        </ol>

        <ReadingListsDialog v-if="listsBook" v-model="listsDialogVisible" :book="listsBook" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCard from './BookCard.vue';
import BookCover from './BookCover.vue';
import BookQuickActions from './BookQuickActions.vue';
import ReadingListsDialog from '../Search/ReadingListsDialog/ReadingListsDialog.vue';

import {isSignedIn} from '../../share/session';
import {bookAuthors, bookUid} from '../../share/bookActions';
import {loadGenres, genreName, bookGenres} from '../../share/genres';

const componentOptions = {
    components: {
        BookCard,
        BookCover,
        BookQuickActions,
        ReadingListsDialog,
    },
};

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
    listsBook = null;
    listsDialogVisible = false;

    created() {
        loadGenres(this.$root.api).then(() => this.genresReady++).catch(() => {});
    }

    get signedIn() {
        return isSignedIn(this.$store.state.config);
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
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
        return [String(book.lang || '').toUpperCase(), String(book.ext || '').toUpperCase(), sizeText, book.date].filter(Boolean).join(' · ');
    }

    stars(book) {
        return '★'.repeat(Math.max(0, Math.min(5, Number(book.librate) || 0)));
    }

    bookLink(book) {
        return `/book/${encodeURIComponent(bookUid(book))}`;
    }

    authorLink(name) {
        return `/author/${encodeURIComponent(name)}`;
    }

    seriesLink(name) {
        return `/series/${encodeURIComponent(name)}`;
    }

    openLists(book) {
        this.listsBook = book;
        this.listsDialogVisible = true;
    }
}

export default vueComponent(BookCollection);
//-----------------------------------------------------------------------------
</script>

<style scoped>
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

.wide-card-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: auto;
    padding-top: 6px;
}

.foot-spacer {
    flex: 1;
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

    .row-actions {
        display: none;
    }
}
</style>
