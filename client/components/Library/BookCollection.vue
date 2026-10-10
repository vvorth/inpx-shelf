<template>
    <div class="book-collection">
        <div v-if="view === 'covers'" class="covers-grid">
            <BookCard
                v-for="book in books"
                :key="keyOf(book)"
                :book="book"
                :progress="stateOf(book).percent || 0"
                :prefix="showSerno && book.serno ? `#${book.serno}` : ''"
                :meta="coverMeta ? coverMeta(book) : ''"
                @open="$emit('interaction', {book, type: 'open'})"
            />
        </div>

        <div v-else-if="view === 'cards'" class="cards-grid">
            <article v-for="book in books" :key="keyOf(book)" class="wide-card">
                <component :is="linkTag(book)" class="wide-card-cover" v-bind="linkAttrs(book)" @click="opened(book)">
                    <BookCover :book="book" :progress="stateOf(book).percent || 0" />
                </component>
                <div class="wide-card-body">
                    <component :is="linkTag(book)" class="book-title-link wide-card-title" v-bind="linkAttrs(book)" @click="opened(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('Без названия') }}
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
                        </router-link><span v-if="book.serno" class="num"> · {{ $t('книга {n}', {n: book.serno}) }}</span>
                    </div>
                    <div v-if="genresOf(book)" class="book-line book-line--muted">
                        {{ genresOf(book) }}
                    </div>
                    <div v-if="!isExternal(book)" class="book-line book-line--muted num">
                        {{ fileLine(book) }}
                    </div>
                    <div v-if="discovery && reasonOf(book)" class="reason" :class="{'reason--explore': book.discoveryExploration}">
                        <q-icon :name="book.discoveryExploration ? 'la la-compass' : 'la la-lightbulb'" size="15px" />
                        <span>{{ reasonOf(book) }}</span>
                    </div>
                    <div class="wide-card-foot">
                        <span v-if="isExternal(book)" class="pill pill--warn">{{ $t('Нет в библиотеке') }}</span>
                        <span v-else-if="stateOf(book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                        <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ $t('Прочитано {n}%', {n: Math.round(stateOf(book).percent * 100)}) }}</span>
                        <span v-else-if="Number(book.librate) > 0" class="rating" :title="$t('Оценка')">{{ stars(book) }}</span>
                        <span class="foot-spacer" />
                        <BookQuickActions :book="book" :signed-in="signedIn" @lists="openLists(book)" @used="$emit('interaction', {book, type: $event})" />
                        <BookFeedbackMenu v-if="feedbackFor(book)" :restore="!!book.discoveryRestoreable" @feedback="$emit('feedback', {book, kind: $event})" @restore="$emit('restore', book)" />
                    </div>
                </div>
            </article>
        </div>

        <ol v-else class="rows">
            <li v-for="book in books" :key="keyOf(book)" class="row-item">
                <component :is="linkTag(book)" class="row-cover" v-bind="linkAttrs(book)" @click="opened(book)">
                    <BookCover :book="book" :progress="stateOf(book).percent || 0" small />
                </component>
                <div class="row-main">
                    <component :is="linkTag(book)" class="book-title-link row-title" v-bind="linkAttrs(book)" @click="opened(book)">
                        <span v-if="showSerno && book.serno" class="serno num">#{{ book.serno }}</span>{{ book.title || $t('Без названия') }}
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
                    <div v-if="discovery && reasonOf(book)" class="reason reason--small" :class="{'reason--explore': book.discoveryExploration}">
                        <q-icon :name="book.discoveryExploration ? 'la la-compass' : 'la la-lightbulb'" size="14px" />
                        <span>{{ reasonOf(book) }}</span>
                    </div>
                </div>
                <div class="row-side">
                    <span v-if="isExternal(book)" class="pill pill--warn">{{ $t('Нет в библиотеке') }}</span>
                    <span v-else-if="stateOf(book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                    <span v-else-if="stateOf(book).percent > 0" class="pill num">{{ Math.round(stateOf(book).percent * 100) }}%</span>
                    <span v-else-if="Number(book.librate) > 0" class="rating" :title="$t('Оценка')">{{ stars(book) }}</span>
                    <div class="row-actions">
                        <BookQuickActions :book="book" :signed-in="signedIn" @lists="openLists(book)" @used="$emit('interaction', {book, type: $event})" />
                        <BookFeedbackMenu v-if="feedbackFor(book)" :restore="!!book.discoveryRestoreable" @feedback="$emit('feedback', {book, kind: $event})" @restore="$emit('restore', book)" />
                    </div>
                </div>
            </li>
        </ol>

        <AddToListDialog v-if="listsBook" v-model="listsDialogVisible" :book="listsBook" @changed="$emit('interaction', {book: listsBook, type: 'save'})" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCard from './BookCard.vue';
import BookCover from './BookCover.vue';
import BookQuickActions from './BookQuickActions.vue';
import BookFeedbackMenu from './BookFeedbackMenu.vue';
import {isExternalOnly, discoveryReason} from '../../share/discovery';
import AddToListDialog from './AddToListDialog.vue';

import {isSignedIn} from '../../share/session';
import {bookAuthors, bookUid} from '../../share/bookActions';
import {loadGenres, genreName, bookGenres} from '../../share/genres';

const componentOptions = {
    emits: ['interaction', 'feedback', 'restore'],
    components: {
        BookCard,
        BookCover,
        BookQuickActions,
        BookFeedbackMenu,
        AddToListDialog,
    },
};

//Список книг в одном из трёх видов. Используется везде, где показываются книги:
//поиск, страница автора, витрины. События interaction/feedback/restore нужны витринам.
class BookCollection {
    _options = componentOptions;
    _props = {
        books: {type: Array, required: true},
        states: {type: Object, default: () => ({})},
        view: {type: String, default: 'covers'},
        showSerno: Boolean,
        coverMeta: {type: Function, default: null},
        //витрина: причины рекомендаций и отзывы на них
        discovery: Boolean,
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
            : {to: this.bookLink(book)});
    }

    opened(book) {
        this.$emit('interaction', {book, type: 'open'});
    }

    reasonOf(book) {
        void this.genresReady;
        return discoveryReason(book);
    }

    feedbackFor(book) {
        return !!(this.discovery && this.signedIn && (book.discoveryDismissible || book.discoveryRestoreable));
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

.reason {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 4px;
    color: var(--app-primary);
    font-size: 12px;
    line-height: 1.35;
}

.reason--explore {
    color: var(--app-accent);
}

.reason--small {
    margin-top: 2px;
}

.reason span {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
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
