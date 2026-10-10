<template>
    <div class="page lists-page">
        <div class="page-body">
            <header class="page-head">
                <h1 class="page-title">
                    {{ $t('Списки чтения') }}
                </h1>
                <div v-if="canUseLists" class="page-actions">
                    <q-btn flat dense no-caps icon="la la-file-export" @click="exportLists">
                        {{ $t('Экспорт') }}
                    </q-btn>
                    <q-btn flat dense no-caps icon="la la-file-import" @click="openImport">
                        {{ $t('Импорт') }}
                    </q-btn>
                    <input ref="importInput" type="file" accept="application/json,.json" style="display: none" @change="onImportSelected">
                </div>
            </header>

            <div v-if="!canUseLists" class="page-empty">
                <div>{{ $t('Войдите в профиль, чтобы вести списки чтения и сохранять прогресс.') }}</div>
                <q-btn color="primary" unelevated no-caps @click="signIn">
                    {{ $t('Войти') }}
                </q-btn>
            </div>

            <div v-else class="lists-layout">
                <aside class="lists-side">
                    <button
                        type="button"
                        class="lists-side-item"
                        :class="{'is-active': selectedId === readingNowId}"
                        @click="select(readingNowId)"
                    >
                        <q-icon name="la la-book-reader" size="18px" />
                        <span class="lists-side-name">{{ $t('Читаю сейчас') }}</span>
                        <span class="lists-side-count">{{ readingNow.length }}</span>
                    </button>
                    <button
                        v-for="item in lists"
                        :key="item.id"
                        type="button"
                        class="lists-side-item"
                        :class="{'is-active': selectedId === item.id}"
                        @click="select(item.id)"
                    >
                        <q-icon :name="item.visibility === 'opds' ? 'la la-rss' : 'la la-bookmark'" size="18px" />
                        <span class="lists-side-name">{{ item.name }}</span>
                        <span class="lists-side-count">{{ item.readCount || 0 }}/{{ item.bookCount || 0 }}</span>
                    </button>

                    <form class="lists-create" @submit.prevent="createList">
                        <q-input v-model="newListName" dense outlined :label="$t('Новый список')" class="col" />
                        <q-btn type="submit" flat dense round icon="la la-plus" color="primary" :disable="!String(newListName || '').trim()" :aria-label="$t('Создать')" />
                    </form>
                </aside>

                <section class="lists-main">
                    <template v-if="selectedId === readingNowId">
                        <div class="lists-main-head">
                            <div>
                                <h2 class="lists-main-title">
                                    {{ $t('Читаю сейчас') }}
                                </h2>
                                <div class="lists-main-sub">
                                    {{ $t('Книги с сохранённым прогрессом. Убранная книга вернётся, если открыть её снова.') }}
                                </div>
                            </div>
                        </div>
                        <div v-if="!readingNow.length" class="page-empty page-empty--inline">
                            {{ $t('Пока нет книг в процессе чтения.') }}
                        </div>
                        <div v-else class="table-wrap">
                            <table class="data-table">
                                <tbody>
                                    <tr v-for="book in readingNow" :key="book.bookUid">
                                        <td>
                                            <div class="book-title">
                                                {{ book.title }}
                                            </div>
                                            <div class="book-meta">
                                                {{ bookMeta(book) }}
                                            </div>
                                        </td>
                                        <td class="col-progress">
                                            <div class="progress">
                                                <i :style="{width: `${percent(book.percent)}%`}" />
                                            </div>
                                            <span class="num">{{ percent(book.percent) }}%</span>
                                        </td>
                                        <td class="col-actions">
                                            <q-btn flat dense no-caps color="primary" icon="la la-book-open" @click="openReader(book.bookUid)">
                                                {{ $t('Читать') }}
                                            </q-btn>
                                            <q-btn flat dense round icon="la la-times" :aria-label="$t('Убрать')" @click="hideReading(book)" />
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </template>

                    <template v-else-if="selectedList">
                        <div class="lists-main-head">
                            <div>
                                <h2 class="lists-main-title">
                                    {{ selectedList.name }}
                                </h2>
                                <div class="lists-main-sub">
                                    {{ $t('{read} / {total} книг прочитано', {read: selectedList.readCount || 0, total: selectedList.bookCount || 0}) }}
                                </div>
                            </div>
                            <div class="page-actions">
                                <q-btn flat dense no-caps icon="la la-pen" @click="renameList(selectedList)">
                                    {{ $t('Переименовать') }}
                                </q-btn>
                                <q-btn flat dense no-caps icon="la la-trash" color="negative" @click="deleteList(selectedList)">
                                    {{ $t('Удалить') }}
                                </q-btn>
                            </div>
                        </div>

                        <div class="lists-toggles">
                            <q-toggle
                                :model-value="selectedList.visibility === 'opds'"
                                :label="$t('Показывать в OPDS')"
                                @update:model-value="setOpds(selectedList, $event)"
                            />
                            <q-toggle
                                v-for="device in koboDevices"
                                :key="device.id"
                                :model-value="(device.listIds || []).includes(selectedList.id)"
                                :label="$t('Синхронизировать с {name}', {name: device.name})"
                                @update:model-value="setKoboSync(device, selectedList, $event)"
                            />
                        </div>

                        <div v-if="booksLoading" class="page-empty page-empty--inline">
                            {{ $t('Загружаю книги...') }}
                        </div>
                        <div v-else-if="!books.length" class="page-empty page-empty--inline">
                            {{ $t('Список пуст. Добавляйте книги из каталога кнопкой «В список».') }}
                        </div>
                        <div v-else class="table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th class="col-check">
                                            {{ $t('Прочитано') }}
                                        </th>
                                        <th>{{ $t('Книга') }}</th>
                                        <th class="hide-narrow">
                                            {{ $t('Файл') }}
                                        </th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="book in books" :key="book.bookUid">
                                        <td class="col-check">
                                            <q-checkbox :model-value="book.read" dense :aria-label="$t('Прочитано')" @update:model-value="toggleRead(book, $event)" />
                                        </td>
                                        <td>
                                            <div class="book-title">
                                                {{ book.title || $t('Без названия') }}
                                            </div>
                                            <div class="book-meta">
                                                {{ bookMeta(book) }}
                                            </div>
                                        </td>
                                        <td class="hide-narrow book-meta num">
                                            {{ fileMeta(book) }}
                                        </td>
                                        <td class="col-actions">
                                            <q-btn flat dense no-caps color="primary" icon="la la-book-open" @click="openReader(book.bookUid)">
                                                {{ $t('Читать') }}
                                            </q-btn>
                                            <q-btn flat dense round icon="la la-times" :aria-label="$t('Убрать из списка')" @click="removeBook(book)" />
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </template>
                </section>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {isSignedIn, currentProfile} from '../../share/session';
import {refreshReadingLists} from '../../share/readingLists';

const readingNowId = '__reading__';

const componentOptions = {
    watch: {
        '$store.state.config'() {
            if (this.isActive)
                this.load();
        },
    },
};

class ListsPage {
    _options = componentOptions;

    readingNowId = readingNowId;
    isActive = false;
    lists = [];
    selectedId = readingNowId;
    books = [];
    booksLoading = false;
    newListName = '';
    koboDevices = [];

    created() {
        this.api = this.$root.api;
    }

    activated() {
        this.isActive = true;
        this.$root.setAppTitle(t('Списки чтения'));
        this.load();
    }

    deactivated() {
        this.isActive = false;
    }

    get config() {
        return this.$store.state.config;
    }

    get canUseLists() {
        return isSignedIn(this.config);
    }

    get readingNow() {
        const rows = currentProfile(this.config).currentReading;
        return Array.isArray(rows) ? rows : [];
    }

    get selectedList() {
        return this.lists.find(item => item.id === this.selectedId) || null;
    }

    signIn() {
        this.$router.push({path: '/login', query: {redirect: '/lists'}});
    }

    async load() {
        if (!this.canUseLists) {
            this.lists = [];
            this.koboDevices = [];
            return;
        }

        try {
            const response = await this.api.getReadingLists('');
            this.lists = response.lists || [];
            refreshReadingLists(this.api, String(this.config.currentUserId || ''));
            if (this.selectedId !== readingNowId && !this.selectedList)
                this.selectedId = readingNowId;
            if (this.selectedList)
                await this.loadBooks();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }

        if (this.config.koboEnabled) {
            try {
                const result = await this.api.getKoboDevices();
                this.koboDevices = (result && Array.isArray(result.devices) ? result.devices : []);
            } catch (e) {
                this.koboDevices = [];
            }
        }
    }

    async select(id) {
        this.selectedId = id;
        this.books = [];
        if (this.selectedList)
            await this.loadBooks();
    }

    async loadBooks() {
        const list = this.selectedList;
        if (!list)
            return;

        this.booksLoading = true;
        try {
            const response = await this.api.getReadingList(list.id);
            if (list.id !== this.selectedId)
                return;
            this.books = (response && Array.isArray(response.books) ? response.books : []).map(book => ({
                bookUid: String(book.bookUid || book._uid || '').trim(),
                title: String(book.title || '').trim(),
                author: String(book.author || '').trim(),
                series: String(book.series || '').trim(),
                serno: book.serno || '',
                ext: book.ext || '',
                size: Number(book.size || 0),
                read: !!(book._readingListRead || book.read),
            }));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.booksLoading = false;
        }
    }

    bookMeta(book) {
        const author = String(book.author || '').split(',').filter(Boolean).join(', ');
        const series = book.series ? `${book.series}${book.serno ? ` #${book.serno}` : ''}` : '';
        return [author, series].filter(Boolean).join(' · ');
    }

    fileMeta(book) {
        const size = book.size > 0 ? `${Math.max(1, Math.round(book.size / 1024))} KB` : '';
        return [book.ext, size].filter(Boolean).join(' · ');
    }

    percent(value) {
        return Math.max(0, Math.min(100, Math.round((Number(value || 0) || 0) * 100)));
    }

    openReader(bookUid) {
        if (bookUid)
            this.$router.push({path: '/reader', query: {bookUid}});
    }

    async hideReading(book) {
        const confirmed = await this.$root.stdDialog.confirm(
            t('Скрыть книгу «{title}»? Её можно будет вернуть из главного экрана читалки.', {title: book.title || ''}),
            t('Текущее чтение'),
        );
        if (!confirmed)
            return;

        try {
            await this.api.updateReaderProgress(book.bookUid, {
                hidden: true,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
            });
            await this.api.updateConfig();
            this.$root.notify.success(t('Книга перемещена в «Скрыто»'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async createList() {
        const name = String(this.newListName || '').trim();
        if (!name)
            return;

        try {
            const response = await this.api.createReadingListWithVisibility(name, 'private');
            this.newListName = '';
            await this.load();
            if (response && response.list)
                await this.select(response.list.id);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async renameList(item) {
        const response = await this.$root.stdDialog.prompt(t('Введите новое название списка:'), t('Переименовать список'), {
            inputValue: item.name,
            inputValidator: (value) => (String(value || '').trim() ? true : t('Название не должно быть пустым')),
        });
        if (!response || response === false)
            return;

        try {
            await this.api.renameReadingList(item.id, response.value);
            await this.load();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async deleteList(item) {
        const confirmed = await this.$root.stdDialog.confirm(t('Удалить список «{name}»?', {name: item.name}), t('Удаление списка'));
        if (!confirmed)
            return;

        try {
            await this.api.deleteReadingList(item.id);
            this.selectedId = readingNowId;
            await this.load();
            this.$root.notify.success(t('Список удалён'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async setOpds(item, enabled) {
        const visibility = (enabled ? 'opds' : 'private');
        try {
            await this.api.setReadingListVisibility(item.id, visibility);
            item.visibility = visibility;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async setKoboSync(device, list, enabled) {
        const listIds = new Set(device.listIds || []);
        if (enabled)
            listIds.add(list.id);
        else
            listIds.delete(list.id);

        try {
            await this.api.updateKoboDevice(device.id, {
                name: device.name,
                listIds: [...listIds],
                keepRemovedBooks: device.keepRemovedBooks === true,
                resendDeletedBooks: device.resendDeletedBooks === true,
                storeProxy: device.storeProxy === true,
            });
            device.listIds = [...listIds];
            this.$root.notify.success(enabled
                ? t('«{name}» получит книги списка при следующей синхронизации', {name: device.name})
                : t('Список больше не синхронизируется с «{name}»', {name: device.name}));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async toggleRead(book, read) {
        const list = this.selectedList;
        try {
            await this.api.setReadingListBookRead(list.id, book.bookUid, read);
            if (!!book.read !== !!read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) + (read ? 1 : -1));
            book.read = !!read;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async removeBook(book) {
        const list = this.selectedList;
        const confirmed = await this.$root.stdDialog.confirm(
            t('Убрать книгу «{title}» из списка «{list}»?', {title: book.title || t('Без названия'), list: list.name || ''}),
            t('Удаление книги из списка'),
        );
        if (!confirmed)
            return;

        try {
            await this.api.updateReadingListBook(list.id, book.bookUid, false);
            if (book.read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) - 1);
            list.bookCount = Math.max(0, (Number(list.bookCount || 0) || 0) - 1);
            this.books = this.books.filter(item => item.bookUid !== book.bookUid);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    downloadJson(data, fileName) {
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'});
        const href = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => window.URL.revokeObjectURL(href), 1000);
    }

    async exportLists() {
        try {
            const data = await this.api.exportReadingLists();
            this.downloadJson(data, `reading-lists-${new Date().toISOString().substring(0, 10)}.json`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    openImport() {
        const input = this.$refs.importInput;
        if (!input)
            return;
        input.value = '';
        input.click();
    }

    async onImportSelected(event) {
        const file = event.target.files && event.target.files[0];
        if (!file)
            return;

        try {
            const result = await this.api.importReadingLists(JSON.parse(await file.text()));
            await this.load();
            this.$root.notify.success(t('Импортировано списков: {lists}, книг: {books}', {lists: result.importedLists, books: result.importedBooks}));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }
}

export default vueComponent(ListsPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.lists-layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
}

.lists-side {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.lists-side-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--app-radius);
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.lists-side-item:hover {
    background: var(--app-surface-3);
}

.lists-side-item.is-active {
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-weight: 600;
}

.lists-side-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.lists-side-count {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
}

.lists-create {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 10px;
}

.lists-main {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
}

.lists-main-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}

.lists-main-title {
    margin: 0;
    font-family: var(--app-font-serif);
    font-size: 22px;
    font-weight: 600;
    line-height: 1.25;
}

.lists-main-sub {
    color: var(--app-muted);
}

.lists-toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 24px;
    padding: 8px 12px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.col-check {
    width: 90px;
}

.col-progress {
    width: 160px;
    white-space: nowrap;
}

.col-progress .progress {
    display: inline-block;
    width: 90px;
    margin-right: 8px;
    vertical-align: middle;
}

.col-actions {
    text-align: right;
    white-space: nowrap;
}

.book-title {
    font-family: var(--app-font-serif);
    font-weight: 600;
}

.book-meta {
    color: var(--app-muted);
    font-size: 13px;
}

@media (max-width: 899px) {
    .lists-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
    }

    .lists-side {
        flex-direction: row;
        flex-wrap: nowrap;
        overflow-x: auto;
        gap: 4px;
    }

    .lists-side-item {
        flex: none;
        max-width: 240px;
    }

    .lists-create {
        flex: none;
        margin-top: 0;
        min-width: 200px;
    }

    .hide-narrow {
        display: none;
    }
}
</style>
