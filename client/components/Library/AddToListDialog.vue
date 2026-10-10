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
            </header>

            <q-linear-progress v-if="stateLoading" indeterminate size="2px" color="primary" class="atl-loading" />
            <div v-if="stateLoading" class="atl-hint">
                {{ series ? $t('Обновляю списки...') : $t('Проверяю, в каких списках уже есть книга. Отмечать можно сразу.') }}
            </div>
            <div class="atl-body">
                <div v-if="!rows.length && !listsKnown" class="atl-empty">
                    {{ $t('Загрузка списков...') }}
                </div>
                <div v-else-if="!rows.length" class="atl-empty">
                    {{ $t('Списков пока нет. Создайте первый ниже.') }}
                </div>

                <div v-for="row in rows" :key="row.key" class="atl-row" :class="{'is-on': row.checked, 'is-changed': isChanged(row)}">
                    <label class="atl-row-main">
                        <input
                            type="checkbox"
                            class="atl-check"
                            :checked="row.checked"
                            @change="row.checked = $event.target.checked; row.touched = true"
                        />
                        <span class="atl-row-copy">
                            <span class="atl-row-name">{{ row.name }}</span>
                            <span class="atl-row-meta num">{{ rowMeta(row) }}</span>
                        </span>
                    </label>

                    <span v-if="row.visibility === 'opds'" class="atl-badge">OPDS</span>

                    <q-toggle
                        v-if="!series && row.checked"
                        v-model="row.read"
                        dense
                        size="sm"
                        :label="$t('Прочитано')"
                        class="atl-read"
                    />

                    <q-btn v-if="!series && book && book.series && !row.isNew" flat dense round size="sm" icon="la la-ellipsis-h" :aria-label="$t('Ещё')">
                        <q-menu anchor="bottom right" self="top right">
                            <div class="atl-menu">
                                <label class="atl-menu-item">
                                    <input v-model="row.addSeries" type="checkbox" class="atl-check" />
                                    {{ $t('Добавить всю серию «{name}»', {name: book.series}) }}
                                </label>
                            </div>
                        </q-menu>
                    </q-btn>
                </div>
            </div>

            <form class="atl-create" @submit.prevent="stageNewList">
                <q-input
                    v-model="newListName"
                    dense
                    outlined
                    class="atl-create-input"
                    :placeholder="$t('Новый список')"
                />
                <q-btn type="submit" outline color="primary" dense no-caps icon="la la-plus" :disable="!String(newListName || '').trim()">
                    {{ $t('Создать') }}
                </q-btn>
            </form>

            <footer class="atl-foot">
                <router-link to="/lists" @click="visible = false">
                    {{ $t('Все списки') }}
                </router-link>
                <span class="atl-foot-spacer" />
                <q-btn flat dense no-caps @click="visible = false">
                    {{ $t('Отмена') }}
                </q-btn>
                <q-btn color="primary" unelevated dense no-caps class="atl-save" :disable="!hasChanges" @click="save">
                    {{ $t('Сохранить') }}
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
import {readingListsCache, refreshReadingLists} from '../../share/readingLists';

const componentOptions = {
    components: {
        BookCover,
    },
    emits: ['update:modelValue', 'changed'],
};

//Добавление книги (или всей серии) в списки чтения.
//Изменения копятся в окне и отправляются только по «Сохранить»; Отмена, Esc и щелчок мимо окна их отбрасывают.
//Списки показываются сразу из заранее загруженного кеша, состояние книги в них подгружается в фоне.
class AddToListDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
        book: {type: Object, default: null},
        //название серии: режим «добавить серию в список»
        series: {type: String, default: ''},
    };

    rows = [];
    listsKnown = false;
    stateLoading = false;
    newListName = '';
    narrow = false;
    openSeq = 0;

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

    get userKey() {
        return String(this.$store.state.config.currentUserId || '');
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

    get hasChanges() {
        return this.rows.some(row => this.isChanged(row));
    }

    isChanged(row) {
        if (row.isNew)
            return row.checked;
        if (this.series)
            return row.checked;
        return row.checked !== row.inList || (row.checked && row.read !== row.wasRead) || (row.checked && row.addSeries);
    }

    rowMeta(row) {
        if (row.isNew)
            return t('Новый список');
        if (row.bookCount === undefined)
            return '';
        const total = Number(row.bookCount || 0);
        const read = Number(row.readCount || 0);
        return (read ? t('{read} из {total} прочитано', {read, total}) : t('Книг: {n}', {n: total}));
    }

    makeRow(list) {
        return {
            key: list.id,
            id: list.id,
            name: list.name,
            visibility: list.visibility,
            bookCount: list.bookCount,
            readCount: list.readCount,
            //состояние на сервере (пока неизвестно - считаем, что книги в списке нет)
            inList: false,
            wasRead: false,
            //то, что выбрано в окне
            checked: false,
            read: false,
            addSeries: false,
            touched: false,
            isNew: false,
        };
    }

    onShow() {
        const seq = ++this.openSeq;
        const cache = readingListsCache();
        this.newListName = '';
        this.rows = (cache.userKey === this.userKey ? cache.lists : []).map(list => this.makeRow(list));
        this.listsKnown = (cache.userKey === this.userKey && cache.loaded);
        this.loadState(seq);
    }

    //Фоновая загрузка: счётчики и есть ли книга в каждом списке. Выбор пользователя не трогаем.
    async loadState(seq) {
        if (!this.book)
            return;
        this.stateLoading = true;
        try {
            const response = await this.api.getReadingLists(this.series ? '' : bookUid(this.book));
            if (seq !== this.openSeq)
                return;
            const byId = new Map(this.rows.map(row => [row.id, row]));
            const rows = [];
            for (const list of (response.lists || [])) {
                const row = byId.get(list.id) || this.makeRow(list);
                const pristine = !row.touched && row.checked === row.inList && row.read === row.wasRead;
                Object.assign(row, {name: list.name, visibility: list.visibility, bookCount: list.bookCount, readCount: list.readCount});
                if (!this.series) {
                    row.inList = !!list.containsBook;
                    row.wasRead = !!list.readBook;
                    if (pristine) {
                        row.checked = row.inList;
                        row.read = row.wasRead;
                    }
                }
                rows.push(row);
            }
            //новые списки, созданные в этом окне, остаются сверху
            this.rows = [...this.rows.filter(row => row.isNew), ...rows];
            this.listsKnown = true;
        } catch (e) {
            this.listsKnown = true;
        } finally {
            if (seq === this.openSeq)
                this.stateLoading = false;
        }
        refreshReadingLists(this.api, this.userKey);
    }

    stageNewList() {
        const name = String(this.newListName || '').trim();
        if (!name)
            return;
        if (this.rows.some(row => row.name.toLowerCase() === name.toLowerCase())) {
            this.$root.notify.info(t('Список «{name}» уже есть', {name}));
            return;
        }
        this.rows.unshift(Object.assign(this.makeRow({id: `new-${Date.now()}`, name, visibility: 'private'}), {isNew: true, checked: true}));
        this.newListName = '';
    }

    //Закрываем окно сразу, изменения отправляем в фоне
    save() {
        const book = this.book;
        const series = this.series || (book && book.series) || '';
        const ops = this.rows.filter(row => this.isChanged(row)).map(row => Object.assign({}, row));
        this.visible = false;
        this.apply(book, series, ops, !!this.series);
    }

    async apply(book, series, ops, seriesMode) {
        const uid = bookUid(book);
        const done = [];
        try {
            for (const row of ops) {
                let listId = row.id;
                if (row.isNew) {
                    const response = await this.api.createReadingListWithVisibility(row.name, 'private');
                    listId = response.list.id;
                }

                if (seriesMode) {
                    await this.api.addSeriesToReadingList(listId, series);
                    done.push(t('серия добавлена в «{list}»', {list: row.name}));
                    continue;
                }

                if (row.checked && !row.inList)
                    await this.api.updateReadingListBook(listId, uid, true);
                if (!row.checked && row.inList) {
                    await this.api.updateReadingListBook(listId, uid, false);
                    done.push(t('убрано из «{list}»', {list: row.name}));
                    continue;
                }
                if (row.checked && row.read !== row.wasRead)
                    await this.api.setReadingListBookRead(listId, uid, row.read);
                if (row.checked && row.addSeries && series)
                    await this.api.addSeriesToReadingList(listId, series);
                if (row.checked && (!row.inList || row.addSeries))
                    done.push(t('добавлено в «{list}»', {list: row.name}));
                else if (row.checked)
                    done.push(t('обновлено в «{list}»', {list: row.name}));
            }
            if (done.length)
                this.$root.notify.success(done.join(', '));
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        } finally {
            this.$emit('changed');
            refreshReadingLists(this.api, this.userKey);
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
    padding: 16px 18px 14px;
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

.atl-loading {
    flex: none;
}

.atl-hint {
    padding: 8px 18px 0;
    color: var(--app-muted);
    font-size: 12px;
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

.atl-row.is-changed .atl-row-name::after {
    content: " •";
    color: var(--app-primary);
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
    min-height: 16px;
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
    color: var(--app-text);
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
    gap: 8px;
    padding: 4px 16px 14px 18px;
    font-size: 13px;
}

.atl-foot-spacer {
    flex: 1;
}

.atl-save {
    min-width: 96px;
}
</style>
