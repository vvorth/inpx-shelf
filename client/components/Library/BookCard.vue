<template>
    <router-link class="book-card" :to="bookLink(book)">
        <BookCover :book="book" :progress="progress" />
        <span class="book-card-title">
            <span v-if="prefix" class="book-card-prefix">{{ prefix }}</span>{{ book.title || $t('Без названия') }}
        </span>
        <span v-if="meta || author" class="book-card-meta">{{ meta || author }}</span>
    </router-link>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';

import {bookAuthors, bookUid} from '../../share/bookActions';

const componentOptions = {
    components: {
        BookCover,
    },
};

class BookCard {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        progress: {type: Number, default: 0},
        meta: {type: String, default: ''},
        prefix: {type: String, default: ''},
    };

    get author() {
        return bookAuthors(this.book).join(', ');
    }

    bookLink(book) {
        return `/book/${encodeURIComponent(bookUid(book))}`;
    }
}

export default vueComponent(BookCard);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    color: var(--app-text) !important;
    text-decoration: none;
}

.book-card:hover .book-card-title {
    color: var(--app-primary);
}

.book-card-title {
    font-weight: 500;
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.book-card-prefix {
    margin-right: 4px;
    color: var(--app-muted);
    font-variant-numeric: tabular-nums;
}

.book-card-meta {
    color: var(--app-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
