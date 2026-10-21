<template>
    <div class="page lists-page">
        <div class="page-body">
            <header class="page-head">
                <h1 class="page-title">
                    {{ $t('common.readingLists') }}
                </h1>
                <div v-if="canUseLists" class="page-actions">
                    <q-btn flat dense no-caps icon="la la-database" to="/me/data">
                        {{ $t('readingLists.backup') }}
                        <q-tooltip>{{ $t('readingLists.backupHint') }}</q-tooltip>
                    </q-btn>
                </div>
            </header>

            <div v-if="!canUseLists" class="page-empty">
                <div>{{ $t('lists.signInToKeep') }}</div>
                <q-btn color="primary" unelevated no-caps @click="signIn">
                    {{ $t('profiles.loginAction') }}
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
                        <span class="lists-side-name">{{ $t('lists.readingNow') }}</span>
                        <span class="lists-side-count">{{ readingNowCount }}</span>
                    </button>
                    <button
                        type="button"
                        class="lists-side-item"
                        :class="{'is-active': isHidden}"
                        @click="select(hiddenId)"
                    >
                        <q-icon name="la la-eye-slash" size="18px" />
                        <span class="lists-side-name">{{ $t('lists.hiddenBooks') }}</span>
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
                        <q-input v-model="newListName" dense outlined :label="$t('readingLists.newList')" class="col" />
                        <q-btn type="submit" flat dense round icon="la la-plus" color="primary" :disable="!String(newListName || '').trim()" :aria-label="$t('common.create')" />
                    </form>
                </aside>

                <section class="lists-main">
                    <!-- «Читаю сейчас» и списки - один вид: у «Читаю сейчас» нет переименования, удаления, OPDS и Kobo -->
                    <template v-if="current">
                        <div class="lists-main-head">
                            <div>
                                <h2 class="lists-main-title">
                                    {{ current.name }}
                                </h2>
                                <div class="lists-main-sub">
                                    {{ subtitle }}
                                </div>
                            </div>
                            <div v-if="isHidden && books.length" class="page-actions">
                                <q-btn flat dense no-caps icon="la la-trash" color="negative" @click="forget(books)">
                                    {{ $t('reader.forgetAllHidden') }}
                                </q-btn>
                            </div>
                            <div v-if="selectedList" class="page-actions">
                                <q-btn flat dense no-caps icon="la la-pen" @click="renameList(selectedList)">
                                    {{ $t('profiles.rename') }}
                                </q-btn>
                                <q-btn flat dense no-caps icon="la la-trash" color="negative" @click="deleteList(selectedList)">
                                    {{ $t('profiles.delete') }}
                                </q-btn>
                            </div>
                        </div>

                        <div v-if="selectedList" class="lists-toggles">
                            <q-toggle
                                :model-value="selectedList.visibility === 'opds'"
                                :label="$t('lists.showInOpds')"
                                @update:model-value="setOpds(selectedList, $event)"
                            />
                            <q-toggle
                                v-for="device in koboDevices"
                                :key="device.id"
                                :model-value="(device.listIds || []).includes(selectedList.id)"
                                :label="$t('lists.syncTo', {name: device.name})"
                                @update:model-value="setKoboSync(device, selectedList, $event)"
                            />
                        </div>

                        <div v-if="booksLoading && !books.length" class="page-empty page-empty--inline">
                            {{ $t('readingLists.loadingBooks') }}
                        </div>
                        <div v-else-if="!books.length" class="page-empty page-empty--inline">
                            {{ isHidden ? $t('lists.noHiddenBooks') : (isReadingNow ? $t('lists.noBooksInProgress') : $t('lists.thisListIsEmpty')) }}
                        </div>
                        <template v-else>
                            <div class="lists-tools">
                                <q-input v-model="filterText" class="lists-filter" dense outlined clearable :placeholder="$t('lists.filter')">
                                    <template #prepend>
                                        <q-icon name="la la-search" size="18px" />
                                    </template>
                                </q-input>
                                <q-toggle v-if="selectedList" v-model="unreadOnly" :label="$t('discovery.unreadOnly')" />
                                <q-toggle v-if="attentionCount || attentionOnly" v-model="attentionOnly" :label="$t('lists.needsAttention', {n: attentionCount})" />
                                <q-space />
                                <q-btn-toggle
                                    :model-value="view"
                                    :options="viewOptions"
                                    dense
                                    no-caps
                                    unelevated
                                    toggle-color="primary"
                                    @update:model-value="setSetting('listsView', $event)"
                                />
                            </div>

                            <div v-if="!visibleBooks.length" class="page-empty page-empty--inline">
                                {{ $t('lists.nothingMatches') }}
                            </div>
                            <BookCollection v-else-if="view !== 'table'" :books="visibleBooks.map(book => book.record)" :states="bookStates" :view="view" />
                            <div v-else class="table-wrap">
                                <table class="data-table">
                                    <thead>
                                        <tr>
                                            <th v-if="!isHidden" class="col-check">
                                                {{ $t('common.read') }}
                                            </th>
                                            <th v-for="column in columns" :key="column.key" :class="column.class">
                                                <button type="button" class="sort-head" :class="{'is-sorted': sort.key === column.key}" @click="sortBy(column.key)">
                                                    {{ column.label }}
                                                    <q-icon v-if="sort.key === column.key" :name="sort.desc ? 'la la-arrow-down' : 'la la-arrow-up'" size="14px" />
                                                </button>
                                            </th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="book in visibleBooks" :key="book.bookUid" :class="{'is-unavailable': book.unavailable}">
                                            <td v-if="!isHidden" class="col-check">
                                                <q-checkbox :model-value="book.read" dense :aria-label="$t('common.read')" @update:model-value="toggleRead(book, $event)" />
                                            </td>
                                            <td>
                                                <router-link class="book-title" :to="bookLink(book)">
                                                    {{ book.title || $t('common.untitled') }}
                                                </router-link>
                                                <span v-if="book.newerEdition" class="pill pill--warn">{{ $t('bookCard.newerEdition') }}</span>
                                                <div class="book-meta show-narrow">
                                                    {{ bookMeta(book) }}
                                                </div>
                                            </td>
                                            <td class="hide-narrow col-authors">
                                                <div class="clip" :title="book.authors.join(', ')">
                                                    <template v-for="(name, index) in book.authors" :key="name">
                                                        <router-link :to="authorLink(name)">
                                                            {{ name }}
                                                        </router-link><span v-if="index < book.authors.length - 1">, </span>
                                                    </template>
                                                </div>
                                            </td>
                                            <td class="hide-narrow">
                                                <router-link v-if="book.series" :to="seriesLink(book.series)">
                                                    {{ book.series }}
                                                </router-link><span v-if="book.series && book.serno" class="num"> #{{ book.serno }}</span>
                                            </td>
                                            <td class="hide-narrow book-meta num col-file">
                                                {{ fileMeta(book) }}
                                            </td>
                                            <td class="col-progress hide-narrow">
                                                <template v-if="book.percent > 0">
                                                    <div class="progress">
                                                        <i :style="{width: `${percent(book.percent)}%`}" />
                                                    </div>
                                                    <span class="num">{{ percent(book.percent) }}%</span>
                                                </template>
                                            </td>
                                            <td class="col-actions">
                                                <q-btn v-if="!book.unavailable" flat dense round color="primary" icon="la la-book-open" :aria-label="$t('common.readBook')" @click="openReader(book.bookUid)">
                                                    <q-tooltip>{{ $t('common.readBook') }}</q-tooltip>
                                                </q-btn>
                                                <template v-if="isHidden">
                                                    <q-btn flat dense round icon="la la-undo" :aria-label="$t('reader.restoreToReading')" @click="restoreReading(book)">
                                                        <q-tooltip>{{ $t('reader.restoreToReading') }}</q-tooltip>
                                                    </q-btn>
                                                    <q-btn flat dense round icon="la la-trash" color="negative" :aria-label="$t('reader.forgetBook')" @click="forget([book])">
                                                        <q-tooltip>{{ $t('reader.forgetBook') }}</q-tooltip>
                                                    </q-btn>
                                                </template>
                                                <template v-else>
                                                    <q-btn v-if="isReadingNow" flat dense round icon="la la-eye-slash" :aria-label="$t('reader.removeFromReading')" @click="hideReading(book)">
                                                        <q-tooltip>{{ $t('reader.removeFromReading') }}</q-tooltip>
                                                    </q-btn>
                                                    <q-btn flat dense round :icon="listIcon(book)" :aria-label="$t('book.list')" @click="openLists(book)">
                                                        <q-tooltip>{{ $t('book.list') }}</q-tooltip>
                                                    </q-btn>
                                                </template>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <AddToListDialog v-if="listsBook" v-model="listsDialogVisible" :book="listsBook" @changed="load" />
                            </div>
                        </template>
                    </template>
                </section>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import BookCollection from '../Library/BookCollection.vue';
import AddToListDialog from '../Library/AddToListDialog.vue';
import {t} from '../../share/i18n';
import {isSignedIn, currentProfile} from '../../share/session';
import {setReadingLists} from '../../share/readingLists';
import {bookAuthors, bookUid, forgetBooks, loadBookStates, markBookRead} from '../../share/bookActions';
import {bookViews, bookViewOptions} from '../../share/bookView';
import {fasBookmark} from '@quasar/extras/fontawesome-v5';

const readingNowId = '__reading__';
const hiddenId = '__hidden__';
const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const normalize = value => String(value || '').toLowerCase().replace(/ё/g, 'е');//i18n-ignore: поиск без учёта ё

//ключи сортировки колонок; без сортировки книги идут в порядке добавления в список
const sortKeys = {
    title: book => [book.title],
    author: book => [book.author, book.series, Number(book.serno) || 0, book.title],
    //книги без серии - в конце
    series: book => [book.series ? 0 : 1, book.series, Number(book.serno) || 0, book.title],
    file: book => [book.ext, book.size],
    progress: book => [book.percent],
};

const componentOptions = {
    components: {
        BookCollection,
        AddToListDialog,
    },
    watch: {
        //в закрытом окне книги могли отметить прочитанное или убрать книгу из списка
        '$route.query.book'(uid, old) {
            if (old && !uid && this.isActive)
                this.load();
        },
        '$store.state.config'() {
            if (this.isActive)
                this.load();
        },
    },
};

class ListsPage {
    _options = componentOptions;

    readingNowId = readingNowId;
    hiddenId = hiddenId;
    isActive = false;
    lists = [];
    selectedId = readingNowId;
    books = [];
    //состояния книг открытого раздела: прогресс, «прочитано», есть ли в списках
    states = {};
    booksLoading = false;
    newListName = '';
    koboDevices = [];
    filterText = '';
    unreadOnly = false;
    attentionOnly = false;
    listsBook = null;
    listsDialogVisible = false;

    created() {
        this.api = this.$root.api;
    }

    activated() {
        this.isActive = true;
        this.$root.setAppTitle(t('common.readingLists'));
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

    get readingNowCount() {
        if (this.isReadingNow && !this.booksLoading)
            return this.books.length;
        return Number(currentProfile(this.config).currentReadingCount || 0) || 0;
    }

    get isReadingNow() {
        return this.selectedId === readingNowId;
    }

    get isHidden() {
        return this.selectedId === hiddenId;
    }

    get subtitle() {
        if (this.isHidden)
            return t('lists.hiddenBooksSub');
        if (this.isReadingNow)
            return t('lists.booksWithSavedProgress');
        return t('lists.booksRead', {read: this.selectedList.readCount || 0, total: this.selectedList.bookCount || 0});
    }

    get selectedList() {
        return this.lists.find(item => item.id === this.selectedId) || null;
    }

    //открытый раздел: «Читаю сейчас» показывается так же, как список
    get current() {
        if (this.isReadingNow)
            return {id: readingNowId, name: t('lists.readingNow')};
        if (this.isHidden)
            return {id: hiddenId, name: t('lists.hiddenBooks')};
        return this.selectedList;
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
            setReadingLists(String(this.config.currentUserId || ''), response);
            if (this.selectedId !== readingNowId && !this.isHidden && !this.selectedList)
                this.selectedId = readingNowId;
            await this.loadBooks();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
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
        this.states = {};
        this.filterText = '';
        this.attentionOnly = false;
        await this.loadBooks();
    }

    async loadBooks() {
        const current = this.current;
        if (!current)
            return;

        this.booksLoading = true;
        try {
            const response = (this.selectedList ? await this.api.getReadingList(current.id) : await this.api.getReadingNow(this.isHidden));
            if (current.id !== this.selectedId)
                return;
            const records = (response && Array.isArray(response.books) ? response.books : []);
            //прогресс, «прочитано» и есть ли книга в списках - как в каталоге: значок закладки у книг в списках закрашен
            const states = await loadBookStates(this.api, records);
            if (current.id !== this.selectedId)
                return;
            this.states = states || {};
            this.books = records.map((book, order) => ({
                bookUid: String(book.bookUid || book._uid || '').trim(),
                title: String(book.title || '').trim(),
                author: String(book.author || '').trim(),
                authors: bookAuthors(book),
                aliases: (book._authorAliases || []).join(' '),
                series: String(book.series || '').trim(),
                serno: book.serno || '',
                ext: book.ext || '',
                size: Number(book.size || 0),
                //прочитана ли книга профилем; в «Читаю сейчас» книги не дочитаны
                read: !!(book._readingListRead || book.read),
                percent: Number(book._readerPercent !== undefined ? book._readerPercent : (this.states[bookUid(book)] || {}).percent) || 0,
                //выключенная библиотека или книги больше нет: строка бледная, открывается только окно книги
                unavailable: book.unavailable || '',
                //помечена удалённой, а позже добавлена та же книга: замену выбирают на странице книги
                newerEdition: !!book.newerEdition,
                order,
                record: book,
            }));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.booksLoading = false;
        }
    }

    get settings() {
        return this.$store.state.settings;
    }

    get view() {
        return (bookViews.includes(this.settings.listsView) ? this.settings.listsView : 'table');
    }

    get viewOptions() {
        return [
            {icon: 'la la-table', value: 'table', attrs: {'aria-label': t('lists.asTable'), title: t('lists.asTable')}},
            ...bookViewOptions(),
        ];
    }


    //состояния книг для карточек: прогресс и списки читателя; в открытом списке книга в нём
    get bookStates() {
        return Object.fromEntries(this.books.map((book) => {
            const state = Object.assign({}, this.states[book.bookUid] || {}, {percent: book.percent});
            if (this.selectedList)
                Object.assign(state, {read: book.read, percent: (book.read ? 1 : book.percent), inList: true});
            return [book.bookUid, state];
        }));
    }

    get columns() {
        return [
            {key: 'title', label: t('common.title')},
            {key: 'author', label: t('search.author'), class: 'hide-narrow'},
            {key: 'series', label: t('common.series'), class: 'hide-narrow'},
            {key: 'file', label: t('opds.file'), class: 'hide-narrow'},
            {key: 'progress', label: t('lists.progress'), class: 'hide-narrow col-progress'},
        ];
    }

    //сортировка хранится строкой: 'author' - по возрастанию, '-author' - по убыванию
    get sort() {
        const value = String(this.settings.listsSort || '');
        const key = value.replace(/^-/, '');
        return (sortKeys[key] ? {key, desc: value.startsWith('-')} : {key: '', desc: false});
    }

    //недоступная книга или есть новая редакция удалённой: читателю стоит выбрать замену
    needsAttention(book) {
        return !!(book.unavailable || book.newerEdition);
    }

    get attentionCount() {
        return this.books.filter(book => this.needsAttention(book)).length;
    }

    get visibleBooks() {
        const words = normalize(this.filterText).split(/\s+/).filter(Boolean);
        const books = this.books.filter((book) => {
            if (this.unreadOnly && book.read)
                return false;
            if (this.attentionOnly && !this.needsAttention(book))
                return false;
            const text = normalize(`${book.title} ${book.author} ${book.aliases} ${book.series}`);
            return words.every(word => text.includes(word));
        });

        const {key, desc} = this.sort;
        if (!key)
            return books;
        const keyOf = sortKeys[key];
        return books.sort((a, b) => {
            const left = keyOf(a);
            const right = keyOf(b);
            for (let i = 0; i < left.length; i++) {
                const cmp = (typeof left[i] === 'number' ? left[i] - right[i] : collator.compare(left[i] || '', right[i] || ''));
                if (cmp)
                    return (desc ? -cmp : cmp);
            }
            return a.order - b.order;
        });
    }

    setSetting(name, value) {
        this.$store.commit('setSettings', {[name]: value});
    }

    //повторный щелчок меняет направление, третий - возвращает порядок добавления
    sortBy(key) {
        const {key: current, desc} = this.sort;
        this.setSetting('listsSort', (current !== key ? key : (desc ? '' : `-${key}`)));
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
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async renameList(item) {
        const response = await this.$root.stdDialog.prompt(t('common.enterNewListName'), t('common.renameList'), {
            inputValue: item.name,
            inputValidator: (value) => (String(value || '').trim() ? true : t('common.nameRequired')),
        });
        if (!response || response === false)
            return;

        try {
            await this.api.updateReadingList(item.id, {name: response.value});
            await this.load();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async deleteList(item) {
        const confirmed = await this.$root.stdDialog.confirm(t('common.deleteListConfirm', {name: item.name}), t('common.deleteListTitle'));
        if (!confirmed)
            return;

        try {
            await this.api.deleteReadingList(item.id);
            this.selectedId = readingNowId;
            await this.load();
            this.$root.notify.success(t('profiles.deleteListSuccess'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async setOpds(item, enabled) {
        const visibility = (enabled ? 'opds' : 'private');
        try {
            await this.api.updateReadingList(item.id, {visibility});
            item.visibility = visibility;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
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
                ? t('lists.willGetThisList', {name: device.name})
                : t('lists.thisListNoLonger', {name: device.name}));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async toggleRead(book, read) {
        //«прочитано» - отметка профиля, не списка: в «Читаю сейчас» дочитанная книга оттуда уходит
        if (this.isReadingNow) {
            if (await markBookRead(this, book.bookUid, read)) {
                await this.api.updateConfig();
                await this.loadBooks();
            }
            return;
        }
        const list = this.selectedList;
        try {
            await this.api.setBookRead(book.bookUid, read);
            if (!!book.read !== !!read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) + (read ? 1 : -1));
            book.read = !!read;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    listIcon(book) {
        return ((this.bookStates[book.bookUid] || {}).inList ? fasBookmark : 'la la-bookmark');
    }

    async hideReading(book) {
        if (!await this.$root.stdDialog.confirm(t('reader.removeReadingConfirm', {title: book.title || ''}), t('lists.readingNow')))
            return;
        await this.setHidden(book, true, t('reader.removeReadingSuccess'));
    }

    async restoreReading(book) {
        await this.setHidden(book, false, t('reader.restoreReadingSuccess'));
    }

    async setHidden(book, hidden, message) {
        try {
            await this.api.updateReaderProgress(book.bookUid, {hidden, percent: Number(book.percent || 0) || 0});
            await this.api.updateConfig();
            this.books = this.books.filter(item => item.bookUid !== book.bookUid);
            this.$root.notify.success(message);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async forget(books) {
        if (await forgetBooks(this, books))
            await this.load();
    }

    openLists(book) {
        this.listsBook = book.record;
        this.listsDialogVisible = true;
    }
}

export default vueComponent(ListsPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.data-table tr.is-unavailable td:not(.col-actions):not(.col-check) {
    opacity: 0.5;
}

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
    width: 64px;
}

.lists-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
}

.lists-filter {
    flex: 0 1 320px;
}

.sort-head {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
}

.col-file {
    white-space: nowrap;
}

/* max-width: 0 lets the column take its width share and clip instead of growing */
.col-authors {
    width: 25%;
    max-width: 0;
}

.col-authors .clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.sort-head.is-sorted {
    color: var(--app-text);
}

.show-narrow {
    display: none;
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
    display: block;
    color: var(--app-text) !important;
    font-family: var(--app-font-serif);
    font-weight: 600;
    text-decoration: none;
}

.book-title:hover {
    color: var(--app-primary) !important;
    text-decoration: underline;
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

    .show-narrow {
        display: block;
    }
}
</style>
