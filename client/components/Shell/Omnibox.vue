<template>
    <form class="omnibox" role="search" @submit.prevent="submit">
        <q-icon name="la la-search" size="18px" class="omnibox-icon" />
        <input
            ref="input"
            v-model="query"
            class="omnibox-input"
            type="search"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('Авторы, книги, серии')"
            :aria-label="$t('Поиск по библиотеке')"
            aria-autocomplete="list"
            :aria-expanded="open ? 'true' : 'false'"
            @input="onInput"
            @focus="onFocus"
            @blur="onBlur"
            @keydown="onKeydown"
        />
        <span v-if="!query" class="omnibox-key">/</span>

        <div v-if="open" class="omnibox-panel" role="listbox" @mousedown.prevent>
            <div v-if="suggestion.corrected" class="omnibox-note">
                {{ suggestion.layout ? $t('Другая раскладка:') : $t('Возможно, вы искали:') }}
                <b>{{ suggestion.corrected }}</b>
            </div>
            <template v-for="group in groups" :key="group.id">
                <div class="omnibox-group">
                    {{ group.label }}
                </div>
                <button
                    v-for="item in group.items"
                    :key="item.key"
                    type="button"
                    class="omnibox-item"
                    :class="{'is-active': item.index === activeIndex}"
                    role="option"
                    @click="choose(item)"
                    @mousemove="activeIndex = item.index"
                >
                    <q-icon :name="item.icon" size="16px" class="omnibox-item-icon" />
                    <span class="omnibox-item-main">{{ item.label }}</span>
                    <span v-if="item.meta" class="omnibox-item-meta">{{ item.meta }}</span>
                </button>
            </template>
            <button
                type="button"
                class="omnibox-item omnibox-item--all"
                :class="{'is-active': activeIndex === allIndex}"
                @click="submit"
                @mousemove="activeIndex = allIndex"
            >
                <q-icon name="la la-search" size="16px" class="omnibox-item-icon" />
                <span class="omnibox-item-main">{{ $t('Искать «{q}» везде', {q: query.trim()}) }}</span>
                <span class="omnibox-item-meta">Enter</span>
            </button>
        </div>
    </form>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {bookAuthors} from '../../share/bookActions';

const componentOptions = {
    watch: {
        '$route.query.q': {
            handler(value) {
                if (this.$route.path === '/search')
                    this.query = String(value || '');
            },
        },
    },
};

class Omnibox {
    _options = componentOptions;

    query = '';
    focused = false;
    suggestion = {authors: [], series: [], books: [], corrected: '', layout: false};
    activeIndex = -1;
    requestSeq = 0;
    timer = null;

    created() {
        this.api = this.$root.api;
        if (this.$route.path === '/search')
            this.query = String(this.$route.query.q || '');

        //«/» в любом месте приложения ставит курсор в поиск
        this.keyHook = (event) => {
            if (event.type !== 'keydown' || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey)
                return;
            const target = event.target;
            const tag = (target && target.tagName) || '';
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (target && target.isContentEditable))
                return;
            event.preventDefault();
            this.focus();
        };
        this.$root.addKeyHook(this.keyHook);
    }

    beforeUnmount() {
        this.$root.removeKeyHook(this.keyHook);
        clearTimeout(this.timer);
    }

    get indexReady() {
        const status = this.$store.state.config.catalogSearch || {};
        return !!status.ready;
    }

    get groups() {
        let index = 0;
        const make = (id, label, items) => ({id, label, items: items.map(item => Object.assign(item, {index: index++}))});
        const s = this.suggestion;
        const groups = [];
        if (s.authors.length) {
            groups.push(make('authors', t('Авторы'), s.authors.map(item => ({
                key: `a-${item.name}`, icon: 'la la-user', label: item.name, meta: t('Книг: {n}', {n: item.books}),
                to: `/author/${encodeURIComponent(item.name)}`,
            }))));
        }
        if (s.series.length) {
            groups.push(make('series', t('Серии'), s.series.map(item => ({
                key: `s-${item.name}`, icon: 'la la-layer-group', label: item.name, meta: t('Книг: {n}', {n: item.books}),
                to: `/series/${encodeURIComponent(item.name)}`,
            }))));
        }
        if (s.books.length) {
            groups.push(make('books', t('Книги'), s.books.map(item => ({
                key: `b-${item._uid}`, icon: 'la la-book', label: item.title,
                meta: [bookAuthors(item)[0], String(item.ext || '').toUpperCase()].filter(Boolean).join(' · '),
                to: `/book/${encodeURIComponent(item._uid)}`,
            }))));
        }
        return groups;
    }

    get items() {
        return this.groups.flatMap(group => group.items);
    }

    get allIndex() {
        return this.items.length;
    }

    get open() {
        return this.focused && !!this.query.trim();
    }

    focus() {
        if (this.$refs.input) {
            this.$refs.input.focus();
            this.$refs.input.select();
        }
    }

    onFocus() {
        this.focused = true;
        if (this.query.trim())
            this.loadSuggestions();
    }

    onBlur() {
        this.focused = false;
    }

    onInput() {
        this.activeIndex = -1;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.loadSuggestions(), 150);
    }

    async loadSuggestions() {
        const q = this.query.trim();
        const seq = ++this.requestSeq;
        if (!q || !this.indexReady) {
            this.suggestion = {authors: [], series: [], books: [], corrected: '', layout: false};
            return;
        }
        try {
            const result = await this.api.catalogSuggest(q);
            if (seq === this.requestSeq)
                this.suggestion = result;
        } catch (e) {
            //подсказки не обязательны: Enter всё равно откроет поиск
        }
    }

    onKeydown(event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const count = this.items.length + 1;
            const step = (event.key === 'ArrowDown' ? 1 : -1);
            this.activeIndex = ((this.activeIndex + step) % count + count) % count;
        } else if (event.key === 'Enter') {
            const item = this.items[this.activeIndex];
            if (item) {
                event.preventDefault();
                this.choose(item);
            }
        } else if (event.key === 'Escape') {
            this.$refs.input.blur();
        }
    }

    choose(item) {
        this.$refs.input.blur();
        this.$router.push(item.to);
    }

    submit() {
        const q = this.query.trim();
        this.$refs.input.blur();
        this.$router.push({path: '/search', query: (q ? {q} : {})});
    }
}

export default vueComponent(Omnibox);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.omnibox {
    position: relative;
    flex: 1;
    max-width: 680px;
}

.omnibox-icon {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--app-muted);
    pointer-events: none;
}

.omnibox-input {
    width: 100%;
    height: 40px;
    padding: 0 36px 0 36px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-bg);
    color: var(--app-text);
    font: inherit;
    outline: none;
}

.omnibox-input:focus {
    border-color: var(--app-primary);
    background: var(--app-surface);
}

.omnibox-input::-webkit-search-cancel-button {
    cursor: pointer;
}

.omnibox-key {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    padding: 0 6px;
    border: 1px solid var(--app-border);
    border-radius: 4px;
    color: var(--app-muted);
    font-size: 11px;
    pointer-events: none;
}

.omnibox-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 3000;
    max-height: min(70vh, 520px);
    overflow-y: auto;
    padding: 6px 0;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
    box-shadow: var(--app-shadow);
}

.omnibox-note {
    padding: 6px 14px;
    color: var(--app-accent);
}

.omnibox-group {
    padding: 8px 14px 2px;
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.omnibox-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 14px;
    border: 0;
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.omnibox-item.is-active {
    background: var(--app-surface-3);
}

.omnibox-item-icon {
    flex: none;
    color: var(--app-muted);
}

.omnibox-item-main {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.omnibox-item-meta {
    flex: none;
    color: var(--app-muted);
    font-size: 12px;
}

.omnibox-item--all {
    margin-top: 4px;
    border-top: 1px solid var(--app-border);
}
</style>
