<template>
    <div class="page">
        <div class="page-body">
            <header class="page-head">
                <div>
                    <div class="page-eyebrow">
                        {{ $t('Серия') }}
                    </div>
                    <h1 class="page-title">
                        {{ name }}
                    </h1>
                    <div v-if="authors.length" class="series-authors">
                        <template v-for="(author, index) in authors" :key="author">
                            <router-link :to="`/author/${encodeURIComponent(author)}`">
                                {{ author }}
                            </router-link><span v-if="index < authors.length - 1">, </span>
                        </template>
                    </div>
                    <div v-if="books.length" class="card-hint num">
                        {{ summary }}
                    </div>
                </div>
                <div v-if="books.length" class="page-actions">
                    <q-btn v-if="nextBook" color="primary" unelevated no-caps icon="la la-book-open" @click="openBook(nextBook)">
                        {{ readCount ? $t('Читать дальше: #{n}', {n: nextBook.serno || '?'}) : $t('Начать с первой') }}
                    </q-btn>
                    <q-btn v-if="signedIn" outline color="primary" no-caps icon="la la-bookmark" @click="readingListsDialogVisible = true">
                        {{ $t('В список') }}
                    </q-btn>
                    <q-btn v-if="signedIn" flat color="primary" no-caps :icon="allRead ? 'la la-undo' : 'la la-check-double'" @click="toggleSeriesRead">
                        {{ allRead ? $t('Снять отметки') : $t('Отметить серию прочитанной') }}
                    </q-btn>
                </div>
            </header>

            <div v-if="loading" class="page-empty page-empty--inline">
                {{ $t('Загрузка...') }}
            </div>
            <div v-else-if="error" class="page-empty page-empty--inline">
                {{ error }}
            </div>
            <div v-else-if="!books.length" class="page-empty page-empty--inline">
                {{ $t('В библиотеке нет книг этой серии.') }}
            </div>

            <ol v-else class="series-list">
                <li v-for="row in rows" :key="row.key" class="series-row" :class="{'series-row--missing': !row.book}">
                    <span class="series-no num">{{ row.no || '—' }}</span>
                    <template v-if="row.book">
                        <router-link class="series-cover" :to="bookLink(row.book)">
                            <BookCover :book="row.book" :progress="stateOf(row.book).percent || 0" small />
                        </router-link>
                        <div class="series-main">
                            <router-link class="series-title" :to="bookLink(row.book)">
                                {{ row.book.title || $t('Без названия') }}
                            </router-link>
                            <div class="card-hint">
                                {{ bookMeta(row.book) }}
                            </div>
                        </div>
                        <span v-if="stateOf(row.book).read" class="pill pill--accent">{{ $t('Прочитано') }}</span>
                        <span v-else-if="stateOf(row.book).percent > 0" class="pill num">{{ Math.round(stateOf(row.book).percent * 100) }}%</span>
                    </template>
                    <div v-else class="series-main card-hint">
                        {{ $t('Этой книги нет в библиотеке') }}
                    </div>
                </li>
            </ol>
        </div>

        <ReadingListsDialog v-if="books.length" v-model="readingListsDialogVisible" :book="books[0]" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';
import ReadingListsDialog from '../Search/ReadingListsDialog/ReadingListsDialog.vue';

import {t, tMessage} from '../../share/i18n';
import {isSignedIn} from '../../share/session';
import {bookUid, bookAuthors} from '../../share/bookActions';

const componentOptions = {
    components: {
        BookCover,
        ReadingListsDialog,
    },
    watch: {
        '$route.params.name'() {
            if (this.$route.path.startsWith('/series/'))
                this.load();
        },
    },
};

class SeriesPage {
    _options = componentOptions;

    books = [];
    states = {};
    loading = false;
    error = '';
    loadedName = '';
    readingListsDialogVisible = false;

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

    get signedIn() {
        return isSignedIn(this.$store.state.config);
    }

    get authors() {
        const counts = new Map();
        for (const book of this.books) {
            for (const author of bookAuthors(book))
                counts.set(author, (counts.get(author) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([author]) => author);
    }

    //книги по номеру; пропуски в нумерации показываются отдельными строками
    get rows() {
        const rows = [];
        const numbered = this.books.filter(book => Number(book.serno) > 0);
        const max = numbered.reduce((acc, book) => Math.max(acc, Number(book.serno)), 0);
        const byNo = new Map();
        for (const book of numbered) {
            const no = Number(book.serno);
            if (!byNo.has(no))
                byNo.set(no, []);
            byNo.get(no).push(book);
        }
        if (max <= 200) {
            for (let no = 1; no <= max; no++) {
                const items = byNo.get(no);
                if (items)
                    items.forEach((book, index) => rows.push({key: `${no}-${index}`, no, book}));
                else
                    rows.push({key: `${no}-missing`, no, book: null});
            }
        } else {
            numbered.forEach((book, index) => rows.push({key: `n-${index}`, no: Number(book.serno), book}));
        }
        this.books.filter(book => !(Number(book.serno) > 0))
            .forEach((book, index) => rows.push({key: `x-${index}`, no: 0, book}));
        return rows;
    }

    get readCount() {
        return this.books.filter(book => this.stateOf(book).read).length;
    }

    get allRead() {
        return this.books.length > 0 && this.readCount === this.books.length;
    }

    get nextBook() {
        return this.rows.map(row => row.book).find(book => book && !this.stateOf(book).read) || null;
    }

    get summary() {
        const missing = this.rows.filter(row => !row.book).length;
        const parts = [t('Книг: {n}', {n: this.books.length})];
        if (this.readCount)
            parts.push(t('{read} из {total} прочитано', {read: this.readCount, total: this.books.length}));
        if (missing)
            parts.push(t('нет в библиотеке: {n}', {n: missing}));
        return parts.join(' · ');
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    bookLink(book) {
        return `/book/${encodeURIComponent(bookUid(book))}`;
    }

    bookMeta(book) {
        return [bookAuthors(book).join(', '), book.lang, String(book.ext || '').toUpperCase()].filter(Boolean).join(' · ');
    }

    openBook(book) {
        this.$router.push(this.bookLink(book));
    }

    async load() {
        const name = this.name;
        this.loadedName = name;
        this.loading = true;
        this.error = '';
        this.books = [];
        this.states = {};
        try {
            const result = await this.api.getSeriesBookList(name);
            if (name !== this.name)
                return;
            const showDeleted = !!this.$store.state.settings.showDeleted;
            this.books = (result.books || []).filter(book => showDeleted || !book.del);
        } catch (e) {
            this.error = tMessage(e.message);
        } finally {
            this.loading = false;
        }
        await this.loadStates();
    }

    async loadStates() {
        if (!this.books.length || !this.signedIn)
            return;
        try {
            const result = await this.api.getBookStates(this.books.map(bookUid));
            this.states = (result && result.states) || {};
        } catch (e) {
            this.states = {};
        }
    }

    async toggleSeriesRead() {
        const read = !this.allRead;
        try {
            await this.api.markSeriesRead(this.name, read);
            await this.loadStates();
            this.$root.notify.success(read ? t('Серия отмечена прочитанной') : t('Отметки серии сняты'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }
}

export default vueComponent(SeriesPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.series-authors {
    margin-top: 4px;
    font-size: 16px;
}

.series-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.series-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--app-border);
}

.series-row:last-child {
    border-bottom: 0;
}

.series-row--missing {
    background: var(--app-surface-2);
}

.series-no {
    width: 32px;
    flex: none;
    color: var(--app-muted);
    font-weight: 600;
    text-align: right;
}

.series-cover {
    width: 40px;
    flex: none;
}

.series-main {
    flex: 1;
    min-width: 0;
}

.series-title {
    color: var(--app-text) !important;
    font-family: var(--app-font-serif);
    font-weight: 600;
    text-decoration: none;
}

.series-title:hover {
    color: var(--app-primary) !important;
}
</style>
