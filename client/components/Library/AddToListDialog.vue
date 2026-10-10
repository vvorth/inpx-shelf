<template>
    <q-dialog v-model="visible" :position="narrow ? 'bottom' : 'standard'" @show="onShow">
        <div class="atl" :class="{'atl--sheet': narrow}" role="dialog" :aria-label="title">
            <header class="atl-head">
                <div v-if="book" class="atl-cover">
                    <BookCover :book="book" small />
                </div>
                <div class="atl-head-copy">
                    <div class="atl-eyebrow">
                        {{ title }}
                    </div>
                    <div class="atl-book">
                        {{ series || (book && book.title) || $t('Без названия') }}
                    </div>
                    <div v-if="subtitle" class="atl-author">
                        {{ subtitle }}
                    </div>
                </div>
                <button type="button" class="atl-close" :aria-label="$t('Закрыть')" @click="visible = false">
                    <q-icon name="la la-times" size="18px" />
                </button>
            </header>

            <div class="atl-body">
                <div v-if="loading && !lists.length" class="atl-empty">
                    {{ $t('Загрузка списков...') }}
                </div>
                <div v-else-if="!lists.length" class="atl-empty">
                    {{ $t('Списков пока нет. Создайте первый ниже.') }}
                </div>

                <div v-for="item in lists" :key="item.id" class="atl-row" :class="{'is-on': !series && item.containsBook}">
                    <label v-if="!series" class="atl-row-main">
                        <input
                            type="checkbox"
                            class="atl-check"
                            :checked="item.containsBook"
                            :disabled="item.busy"
                            @change="toggleBook(item, $event.target.checked)"
                        />
                        <span class="atl-row-copy">
                            <span class="atl-row-name">{{ item.name }}</span>
                            <span class="atl-row-meta num">{{ listMeta(item) }}</span>
                        </span>
                    </label>
                    <div v-else class="atl-row-main">
                        <span class="atl-row-copy">
                            <span class="atl-row-name">{{ item.name }}</span>
                            <span class="atl-row-meta num">{{ listMeta(item) }}</span>
                        </span>
                    </div>

                    <span v-if="item.visibility === 'opds'" class="atl-badge">OPDS</span>

                    <q-toggle
                        v-if="!series && item.containsBook"
                        :model-value="!!item.readBook"
                        :disable="item.busy"
                        dense
                        size="sm"
                        :label="$t('Прочитано')"
                        class="atl-read"
                        @update:model-value="toggleRead(item, $event)"
                    />

                    <q-btn
                        v-if="series"
                        unelevated
                        dense
                        no-caps
                        :color="item.seriesAdded ? undefined : 'primary'"
                        :flat="!!item.seriesAdded"
                        :loading="item.busy"
                        :icon="item.seriesAdded ? 'la la-check' : 'la la-plus'"
                        @click="addSeries(item)"
                    >
                        {{ item.seriesAdded > 0 ? $t('Добавлено: {n}', {n: item.seriesAdded}) : (item.seriesAdded < 0 ? $t('Уже в списке') : $t('Добавить серию')) }}
                    </q-btn>
                    <q-btn v-else-if="book && book.series" flat dense round size="sm" icon="la la-ellipsis-h" :aria-label="$t('Ещё')">
                        <q-menu anchor="bottom right" self="top right">
                            <div class="atl-menu">
                                <button v-close-popup type="button" class="atl-menu-item" @click="addSeries(item)">
                                    <q-icon name="la la-layer-group" size="16px" />
                                    {{ $t('Добавить всю серию «{name}»', {name: book.series}) }}
                                </button>
                            </div>
                        </q-menu>
                    </q-btn>
                </div>
            </div>

            <form class="atl-create" @submit.prevent="createList">
                <q-input
                    v-model="newListName"
                    dense
                    outlined
                    class="atl-create-input"
                    :placeholder="$t('Новый список')"
                    :disable="creating"
                />
                <q-btn type="submit" color="primary" unelevated dense no-caps icon="la la-plus" :loading="creating" :disable="!String(newListName || '').trim()">
                    {{ series ? $t('Создать и добавить серию') : $t('Создать') }}
                </q-btn>
            </form>

            <footer class="atl-foot">
                <router-link to="/lists" @click="visible = false">
                    {{ $t('Все списки') }}
                </router-link>
                <q-btn color="primary" flat dense no-caps @click="visible = false">
                    {{ $t('Готово') }}
                </q-btn>
            </footer>
        </div>
    </q-dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from './BookCover.vue';

import {t, tMessage} from '../../share/i18n';
import {bookUid, bookAuthors} from '../../share/bookActions';

const componentOptions = {
    components: {
        BookCover,
    },
    emits: ['update:modelValue', 'changed'],
};

//Добавление книги (или всей серии) в списки чтения
class AddToListDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
        book: {type: Object, default: null},
        //название серии: режим «добавить серию в список»
        series: {type: String, default: ''},
    };

    lists = [];
    loading = false;
    creating = false;
    newListName = '';
    narrow = false;

    created() {
        this.api = this.$root.api;
        this.media = window.matchMedia('(max-width: 899px)');
        this.narrow = this.media.matches;
        this.onMedia = (event) => {
            this.narrow = event.matches;
        };
        this.media.addEventListener('change', this.onMedia);
    }

    beforeUnmount() {
        this.media.removeEventListener('change', this.onMedia);
    }

    get visible() {
        return this.modelValue;
    }

    set visible(value) {
        this.$emit('update:modelValue', value);
    }

    get title() {
        return (this.series ? t('Серия в список') : t('Добавить в список'));
    }

    get subtitle() {
        if (!this.book)
            return '';
        if (this.series)
            return bookAuthors(this.book).join(', ');
        return [bookAuthors(this.book).join(', '), this.book.series ? `${this.book.series}${this.book.serno ? ` #${this.book.serno}` : ''}` : ''].filter(Boolean).join(' · ');
    }

    listMeta(item) {
        const total = Number(item.bookCount || 0);
        const read = Number(item.readCount || 0);
        return (read ? t('{read} из {total} прочитано', {read, total}) : t('Книг: {n}', {n: total}));
    }

    onShow() {
        this.newListName = '';
        this.load();
    }

    async load() {
        if (!this.book)
            return;
        this.loading = true;
        try {
            const response = await this.api.getReadingLists(this.series ? '' : bookUid(this.book));
            this.lists = (response.lists || []).map(item => Object.assign({}, item, {busy: false, seriesAdded: 0}));
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        } finally {
            this.loading = false;
        }
    }

    async toggleBook(item, enabled) {
        item.busy = true;
        try {
            await this.api.updateReadingListBook(item.id, bookUid(this.book), enabled);
            if (!enabled && item.readBook) {
                item.readBook = false;
                item.readCount = Math.max(0, (item.readCount || 0) - 1);
            }
            item.containsBook = !!enabled;
            item.bookCount = Math.max(0, (item.bookCount || 0) + (enabled ? 1 : -1));
            this.$emit('changed');
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
            await this.load();
        } finally {
            item.busy = false;
        }
    }

    async toggleRead(item, read) {
        item.busy = true;
        try {
            await this.api.setReadingListBookRead(item.id, bookUid(this.book), read);
            if (!!item.readBook !== !!read)
                item.readCount = Math.max(0, (item.readCount || 0) + (read ? 1 : -1));
            item.readBook = !!read;
            this.$emit('changed');
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        } finally {
            item.busy = false;
        }
    }

    async addSeries(item) {
        const series = this.series || (this.book && this.book.series);
        if (!series)
            return;
        item.busy = true;
        try {
            const result = await this.api.addSeriesToReadingList(item.id, series);
            const added = Number(result && result.addedBooks) || 0;
            item.seriesAdded = added || item.seriesAdded || -1;
            item.bookCount = (item.bookCount || 0) + added;
            if (!this.series && !item.containsBook && added)
                item.containsBook = true;
            this.$root.notify.success(added
                ? t('В список «{list}» добавлено книг серии: {n}', {list: item.name, n: added})
                : t('Все книги серии уже в списке «{list}»', {list: item.name}));
            this.$emit('changed');
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        } finally {
            item.busy = false;
        }
    }

    async createList() {
        const name = String(this.newListName || '').trim();
        if (!name)
            return;
        this.creating = true;
        try {
            const response = await this.api.createReadingListWithVisibility(name, 'private');
            const created = response.list;
            if (this.series)
                await this.api.addSeriesToReadingList(created.id, this.series);
            else
                await this.api.updateReadingListBook(created.id, bookUid(this.book), true);
            this.newListName = '';
            await this.load();
            this.$emit('changed');
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        } finally {
            this.creating = false;
        }
    }
}

export default vueComponent(AddToListDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.atl {
    display: flex;
    flex-direction: column;
    width: min(460px, 94vw);
    max-height: min(80vh, 680px);
    overflow: hidden;
    border-radius: 10px;
    background: var(--app-surface);
    color: var(--app-text);
    box-shadow: var(--app-shadow);
}

.atl--sheet {
    width: 100vw;
    max-height: 85vh;
    border-radius: 14px 14px 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
}

.atl-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 16px 16px 14px 18px;
    border-bottom: 1px solid var(--app-border);
}

.atl-cover {
    width: 44px;
    flex: none;
}

.atl-head-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.atl-eyebrow {
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.atl-book {
    font-family: var(--app-font-serif);
    font-size: 17px;
    font-weight: 600;
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.atl-author {
    color: var(--app-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.atl-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: none;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--app-muted);
    cursor: pointer;
}

.atl-close:hover {
    background: var(--app-surface-3);
}

.atl-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
}

.atl-empty {
    padding: 18px 12px;
    color: var(--app-muted);
    text-align: center;
}

.atl-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 6px 8px 6px 10px;
    border-radius: var(--app-radius);
}

.atl-row:hover {
    background: var(--app-surface-3);
}

.atl-row.is-on {
    background: var(--app-accent-soft);
}

.atl-row-main {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    cursor: pointer;
}

.atl-check {
    width: 18px;
    height: 18px;
    flex: none;
    margin: 0;
    accent-color: var(--app-primary);
    cursor: pointer;
}

.atl-row-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.atl-row-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.atl-row-meta {
    color: var(--app-muted);
    font-size: 12px;
}

.atl-badge {
    flex: none;
    padding: 1px 7px;
    border-radius: 99px;
    background: var(--app-surface-3);
    color: var(--app-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
}

.atl-read {
    flex: none;
    font-size: 13px;
}

.atl-menu {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
}

.atl-menu-item {
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

.atl-menu-item:hover {
    background: var(--app-surface-3);
}

.atl-create {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--app-border);
}

.atl-create-input {
    flex: 1;
}

.atl-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 10px 10px 18px;
    font-size: 13px;
}
</style>
