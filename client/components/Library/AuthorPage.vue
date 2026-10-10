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
                    <div v-if="!loading" class="card-hint num">
                        {{ summary }}
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

            <section v-for="group in groups" :key="group.key" class="entity-group">
                <div class="card-head">
                    <h2 class="card-title">
                        <router-link v-if="group.series" :to="seriesLink(group.series)">
                            {{ group.series }}
                        </router-link>
                        <span v-else>{{ $t('Вне серий') }}</span>
                    </h2>
                    <span class="card-hint num">{{ groupSummary(group) }}</span>
                </div>
                <div class="book-grid">
                    <BookCard
                        v-for="book in group.books"
                        :key="book._uid"
                        :book="book"
                        :progress="stateOf(book).percent || 0"
                        :prefix="book.serno ? `#${book.serno}` : ''"
                        :meta="bookMeta(book)"
                    />
                </div>
            </section>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCard from './BookCard.vue';

import {t, tMessage} from '../../share/i18n';
import {isSignedIn, initials} from '../../share/session';
import {bookUid, bookAuthors} from '../../share/bookActions';

const componentOptions = {
    components: {
        BookCard,
    },
    watch: {
        '$route.params.name'() {
            if (this.$route.path.startsWith('/author/'))
                this.load();
        },
    },
};

class AuthorPage {
    _options = componentOptions;

    books = [];
    states = {};
    loading = false;
    error = '';
    loadedName = '';

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

    get summary() {
        const langs = [...new Set(this.books.map(book => book.lang).filter(Boolean))];
        return [t('Книг: {n}', {n: this.books.length}), langs.join(', ')].filter(Boolean).join(' · ');
    }

    //серии по алфавиту, книги без серии в конце; внутри серии - по номеру
    get groups() {
        const map = new Map();
        for (const book of this.books) {
            const key = book.series || '';
            if (!map.has(key))
                map.set(key, {key: key || '__none__', series: key, books: []});
            map.get(key).books.push(book);
        }
        const groups = [...map.values()];
        for (const group of groups)
            group.books.sort((a, b) => (Number(a.serno) || 0) - (Number(b.serno) || 0) || String(a.title).localeCompare(String(b.title), 'ru'));
        groups.sort((a, b) => (!a.series) - (!b.series) || a.series.localeCompare(b.series, 'ru'));
        return groups;
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    groupSummary(group) {
        const read = group.books.filter(book => this.stateOf(book).read).length;
        return read ? t('{read} из {total} прочитано', {read, total: group.books.length}) : t('Книг: {n}', {n: group.books.length});
    }

    bookMeta(book) {
        const coauthors = bookAuthors(book).filter(author => author.toLowerCase() !== this.name.toLowerCase());
        return coauthors.length ? t('Соавторы: {names}', {names: coauthors.join(', ')}) : String(book.lang || '');
    }

    seriesLink(series) {
        return `/series/${encodeURIComponent(series)}`;
    }

    async load() {
        const name = this.name;
        this.loadedName = name;
        this.loading = true;
        this.error = '';
        this.books = [];
        this.states = {};
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

.entity-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.book-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 18px;
}

@media (max-width: 899px) {
    .entity-avatar {
        width: 52px;
        height: 52px;
        font-size: 20px;
    }

    .book-grid {
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 12px;
    }
}
</style>
