<template>
    <div class="page">
        <div class="page-body">
            <header class="page-head">
                <div>
                    <h1 class="page-title">
                        {{ pageTitle }}
                    </h1>
                    <div class="card-hint">
                        {{ pageSubtitle }}
                        <template v-if="hiddenByLanguage">
                            · {{ $t('ещё {n} на других языках', {n: hiddenByLanguage}) }}
                            <button type="button" class="link-btn" @click="allLanguages = true">
                                {{ $t('показать') }}
                            </button>
                        </template>
                    </div>
                </div>
                <div class="page-actions">
                    <q-toggle
                        v-if="kind === 'for-you'"
                        :model-value="settings.showDiscoveryUnreadOnly === true"
                        :label="$t('Только непрочитанное')"
                        @update:model-value="setSetting('showDiscoveryUnreadOnly', $event)"
                    />
                    <q-btn v-if="kind === 'for-you' && signedIn" flat no-caps icon="la la-sliders-h" @click="tasteOpen = !tasteOpen">
                        {{ $t('Настроить вкусы') }}
                    </q-btn>
                    <q-btn flat no-caps icon="la la-sync" :loading="loading" @click="load(true)">
                        {{ $t('Обновить') }}
                    </q-btn>
                    <q-btn-toggle
                        :model-value="view"
                        :options="viewOptions"
                        dense
                        no-caps
                        unelevated
                        toggle-color="primary"
                        @update:model-value="setSetting('bookView', $event)"
                    />
                </div>
            </header>

            <TastePanel
                v-if="showTaste"
                :key="tasteKey"
                :taste="taste"
                :needs-setup="tasteNeedsSetup"
                @save="saveTaste"
                @dismiss="dismissTaste"
                @close="tasteOpen = false"
            />

            <div v-if="kind === 'bestsellers' && genreOptions.length > 1" class="external-tools">
                <q-select
                    :model-value="settings.discoveryExternalGenreUrl || ''"
                    dense
                    outlined
                    emit-value
                    map-options
                    options-dense
                    class="external-genre"
                    :options="genreOptions"
                    :label="$t('Жанр внешней витрины')"
                    :disable="loading"
                    @update:model-value="setExternalGenre"
                />
            </div>

            <div v-if="loading && !shelves.length" class="page-empty page-empty--inline">
                <q-linear-progress indeterminate size="3px" color="primary" />
                {{ $t('Собираю витрину...') }}
            </div>
            <div v-else-if="error" class="page-empty page-empty--inline">
                {{ error }}
            </div>
            <div v-else-if="!shelves.length" class="page-empty">
                {{ $t('Пока пусто.') }}
            </div>

            <section v-for="shelf in shelves" :key="shelf.id" class="shelf">
                <div class="shelf-head">
                    <div class="shelf-copy">
                        <h2 class="card-title">
                            {{ $tm(shelf.title) }}
                        </h2>
                        <div v-if="shelf.subtitle" class="card-hint">
                            {{ $tm(shelf.subtitle) }}
                        </div>
                        <div class="shelf-meta">
                            <span v-if="shelf.updatedAt">{{ $t('Обновлено {time}', {time: formatTime(shelf.updatedAt)}) }}</span>
                            <span v-if="shelf.discoveryStale" class="shelf-warn">{{ $t('Показан кеш') }}</span>
                            <span v-if="shelf.discoveryRefreshError" class="shelf-warn">{{ shelf.discoveryRefreshError }}</span>
                        </div>
                    </div>
                    <div class="shelf-actions">
                        <q-btn v-if="shelf.sourceUrl" flat dense no-caps icon="la la-external-link-alt" type="a" :href="shelf.sourceUrl" target="_blank" rel="noopener">
                            {{ $t('Источник') }}
                        </q-btn>
                        <q-btn v-if="hideSetting(shelf)" flat dense no-caps icon="la la-eye-slash" @click="hideShelf(shelf)">
                            {{ $t('Скрыть полку') }}
                        </q-btn>
                    </div>
                </div>

                <BookCollection
                    v-if="shelf.items.length"
                    :books="shelf.items"
                    :states="states"
                    :view="view"
                    discovery
                    @interaction="recordInteraction"
                    @feedback="sendFeedback"
                    @restore="restoreBook"
                />
                <div v-else class="card-hint">
                    {{ shelf.emptyMessage ? $tm(shelf.emptyMessage) : $t('Пока пусто.') }}
                </div>

                <q-btn v-if="canLoadMore(shelf)" class="shelf-more" outline color="primary" no-caps icon="la la-plus" :loading="loading" @click="loadMore(shelf)">
                    {{ shelf.id === 'similar-books' ? $t('Ещё рекомендации') : $t('Загрузить ещё') }}
                </q-btn>
            </section>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCollection from './BookCollection.vue';
import TastePanel from './TastePanel.vue';

import {t, tMessage, getLocale} from '../../share/i18n';
import {isSignedIn} from '../../share/session';
import {bookUid} from '../../share/bookActions';
import {bookView, bookViewOptions} from '../../share/bookView';
import {myLanguages, languageMatches} from '../../share/languages';
import {externalDiscovery, discoveryRouteLabel} from '../../share/discoveryRoutes';
import {isExternalOnly, feedbackMessage} from '../../share/discovery';

const kinds = ['for-you', 'newest', 'popular', 'bestsellers'];
const shelfSettings = {
    'continue-reading': 'showDiscoveryContinueReading',
    'from-your-lists': 'showDiscoveryFromLists',
    'unfinished-series': 'showDiscoveryUnfinishedSeries',
    'similar-books': 'showDiscoverySimilar',
};

const componentOptions = {
    components: {
        BookCollection,
        TastePanel,
    },
    watch: {
        '$route.path'() {
            if (this.isOwnRoute)
                this.onEnter();
        },
        requestKey() {
            if (this.isOwnRoute)
                this.load();
        },
    },
};

//Витрины: «Для вас», «Новинки», «Популярное» и внешний источник
class DiscoveryPage {
    _options = componentOptions;

    rawShelves = [];
    states = {};
    loading = false;
    error = '';
    loadedKey = '';
    requestSeq = 0;
    similarLimit = 16;
    similarExhausted = false;
    tasteOpen = false;
    tasteDismissed = false;
    allLanguages = false;
    impressionsKey = '';

    created() {
        this.api = this.$root.api;
    }

    activated() {
        this.onEnter();
    }

    onEnter() {
        this.$root.setAppTitle(this.pageTitle);
        if (this.requestKey !== this.loadedKey)
            this.load();
    }

    get isOwnRoute() {
        return kinds.includes(this.kind);
    }

    get kind() {
        return String(this.$route.path || '').replace(/^\//, '');
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get view() {
        return bookView(this.settings);
    }

    get viewOptions() {
        return bookViewOptions();
    }

    get pageTitle() {
        return discoveryRouteLabel(this.kind, this.config, this.settings);
    }

    get pageSubtitle() {
        return {
            'for-you': t('Подборки по вашей библиотеке и профилю чтения'),
            'newest': t('Последние поступления в библиотеку'),
            'popular': t('Что читают и добавляют в списки чаще всего'),
            'bestsellers': t('Подборка с внешнего сайта: книги, которых нет в библиотеке, открываются на сайте источника'),
        }[this.kind] || '';
    }

    get external() {
        return externalDiscovery(this.config, this.settings);
    }

    //набор параметров, от которого зависит ответ сервера
    get requestKey() {
        return JSON.stringify([
            this.kind, this.config.currentUserId || '', !!this.config.profileAuthorized, this.similarLimit,
            this.external, this.settings.discoveryExternalGenreUrl || '', this.settings.discoveryExternalLimit || 12,
            this.settings.showDiscoverySimilar !== false, (this.config.dbConfig || {}).inpxHash || '',
        ]);
    }

    async load(force = false) {
        if (!this.isOwnRoute)
            return;
        const seq = ++this.requestSeq;
        this.loadedKey = this.requestKey;
        this.loading = true;
        this.error = '';
        try {
            const external = this.external;
            const response = await this.api.getDiscoveryShelves({
                forceRefresh: force === true,
                personalLimit: 12,
                personalSimilarLimit: this.similarLimit,
                personalSimilarEnabled: this.settings.showDiscoverySimilar !== false,
                newestLimit: 24,
                popularLimit: 24,
                externalLimit: Math.max(12, Math.min(120, parseInt(this.settings.discoveryExternalLimit, 10) || 24)),
                externalSource: external.source,
                externalName: external.name,
                externalUrl: external.url,
                externalTtlMinutes: Math.max(1440, parseInt(this.settings.discoveryExternalTtlMinutes || (this.config.discovery || {}).externalTtlMinutes, 10) || 1440),
                externalBrowseUrl: this.settings.discoveryExternalGenreUrl || '',
                externalBrowseName: this.settings.discoveryExternalGenreName || '',
            });
            if (seq !== this.requestSeq)
                return;
            this.rawShelves = (response && Array.isArray(response.shelves) ? response.shelves : []);
            this.recordImpressions();
            this.loadStates();
        } catch (e) {
            if (seq === this.requestSeq)
                this.error = t('Ошибка витрины: {message}', {message: tMessage(e.message) || t('нет ответа от сервера')});
        } finally {
            if (seq === this.requestSeq)
                this.loading = false;
        }
    }

    //полки текущей страницы, с отметками для отзывов и фильтром «Моих языков»
    get preparedShelves() {
        const shelves = this.rawShelves.filter(Boolean);
        if (this.kind === 'for-you') {
            const allowed = new Set(['hidden-books']);
            for (const [id, setting] of Object.entries(shelfSettings)) {
                if (this.settings[setting] !== false)
                    allowed.add(id);
            }
            return shelves.filter(shelf => allowed.has(String(shelf.id || ''))).map((shelf) => {
                const hidden = shelf.id === 'hidden-books';
                return Object.assign({}, shelf, {
                    discoveryHasMore: (shelf.id === 'similar-books' && this.similarExhausted ? false : shelf.discoveryHasMore),
                    items: (shelf.items || [])
                        .filter(book => !(this.settings.showDiscoveryUnreadOnly === true && book.discoveryRead === true && !hidden))
                        .map(book => Object.assign({}, book, {
                            discoveryShelfId: String(shelf.id || ''),
                            discoveryDismissible: !hidden,
                            discoveryRestoreable: hidden,
                        })),
                });
            });
        }
        if (this.kind === 'newest')
            return shelves.filter(shelf => /^newest-\d+d$/.test(String(shelf.id || '')));
        if (this.kind === 'popular')
            return shelves.filter(shelf => shelf.id === 'popular');
        if (this.kind === 'bestsellers') {
            return shelves.filter(shelf => shelf.source === 'external').map(shelf => Object.assign({}, shelf, {
                items: (shelf.items || []).filter(book => String(book.discoveryItemKind || 'book').toLowerCase() !== 'genre'),
            }));
        }
        return [];
    }

    //книги не на «Моих языках» скрыты; внешние книги и «Продолжить чтение» показываются всегда
    get languageFilter() {
        const languages = myLanguages(this.config, this.settings);
        return (book, shelf) => this.allLanguages || languages.all || isExternalOnly(book)
            || shelf.id === 'continue-reading' || !book.lang || languageMatches(book, languages);
    }

    get shelves() {
        const keep = this.languageFilter;
        return this.preparedShelves
            .map(shelf => Object.assign({}, shelf, {items: (shelf.items || []).filter(book => keep(book, shelf))}))
            .filter(shelf => shelf.items.length || shelf.emptyMessage || shelf.id === 'similar-books');
    }

    get hiddenByLanguage() {
        const keep = this.languageFilter;
        let hidden = 0;
        for (const shelf of this.preparedShelves)
            hidden += (shelf.items || []).filter(book => !keep(book, shelf)).length;
        return hidden;
    }

    get similarShelf() {
        return this.rawShelves.find(shelf => shelf && shelf.id === 'similar-books') || {};
    }

    get taste() {
        return this.similarShelf.discoveryTaste || {};
    }

    get tasteNeedsSetup() {
        return this.similarShelf.discoveryNeedsTasteSetup === true && !this.tasteDismissed;
    }

    get showTaste() {
        return this.kind === 'for-you' && this.signedIn && (this.tasteOpen || this.tasteNeedsSetup);
    }

    get tasteKey() {
        return JSON.stringify(this.taste);
    }

    get genreOptions() {
        const shelf = this.rawShelves.find(item => item && item.source === 'external') || {};
        const result = [{label: t('Все жанры'), value: ''}];
        const seen = new Set(['']);
        for (const option of (shelf.genreOptions || [])) {
            const value = String(option && option.value || '').trim();
            if (value && !seen.has(value)) {
                seen.add(value);
                result.push({label: String(option.label || value), value});
            }
        }
        return result;
    }

    hideSetting(shelf) {
        return (this.kind === 'for-you' && shelfSettings[shelf.id]) || '';
    }

    canLoadMore(shelf) {
        if (!shelf.items.length || shelf.discoveryHasMore !== true)
            return false;
        return (shelf.id === 'similar-books' || shelf.source === 'external');
    }

    formatTime(value) {
        const date = new Date(Number(value) || value);
        return (Number.isNaN(date.getTime()) ? '' : date.toLocaleString(getLocale(), {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}));
    }

    setSetting(name, value) {
        this.$store.commit('setSettings', {[name]: value});
    }

    hideShelf(shelf) {
        this.setSetting(this.hideSetting(shelf), false);
        this.$root.notify.success(t('Полка скрыта. Её можно вернуть в настройках.'));
    }

    setExternalGenre(value) {
        const option = this.genreOptions.find(item => item.value === value);
        this.$store.commit('setSettings', {
            discoveryExternalGenreUrl: value || '',
            discoveryExternalGenreName: (value && option ? option.label : ''),
            discoveryExternalLimit: 24,
        });
    }

    async loadMore(shelf) {
        if (shelf.id === 'similar-books') {
            const before = shelf.items.length;
            this.similarLimit = Math.min(96, this.similarLimit + 8);
            await this.load(true);
            const after = (this.shelves.find(item => item.id === 'similar-books') || {items: []}).items.length;
            if (after <= before) {
                this.similarExhausted = true;
                this.$root.notify.info(t('Новых рекомендаций пока нет.'));
            }
        } else {
            const current = parseInt(this.settings.discoveryExternalLimit, 10) || 24;
            this.setSetting('discoveryExternalLimit', Math.min(120, current + 24));
        }
    }

    async loadStates() {
        if (!this.signedIn)
            return;
        const uids = [...new Set(this.rawShelves.flatMap(shelf => (shelf.items || []).map(bookUid)).filter(Boolean))];
        if (!uids.length)
            return;
        try {
            const result = await this.api.getBookStates(uids);
            this.states = (result && result.states) || {};
        } catch (e) {
            //отметки прочитанного не обязательны
        }
    }

    recordImpressions() {
        if (this.kind !== 'for-you' || !this.signedIn)
            return;
        const events = this.shelves
            .filter(shelf => shelf.id !== 'hidden-books')
            .flatMap(shelf => shelf.items.map(book => ({bookUid: bookUid(book), type: 'impression', shelfId: String(shelf.id || '')})))
            .filter(event => event.bookUid);
        const key = JSON.stringify(events.map(event => event.bookUid));
        if (events.length && key !== this.impressionsKey) {
            this.impressionsKey = key;
            this.api.recordDiscoveryEvents(events).catch(() => {});
        }
    }

    recordInteraction({book, type}) {
        const uid = bookUid(book || {});
        if (!uid || !type || !book.discoveryShelfId || !this.signedIn)
            return;
        this.api.recordDiscoveryEvents([{bookUid: uid, type, shelfId: book.discoveryShelfId}]).catch(() => {});
    }

    async sendFeedback({book, kind}) {
        try {
            await this.api.updateDiscoveryPreferences({
                feedbackSet: [{bookUid: bookUid(book), kind, shelfId: String(book.discoveryShelfId || 'similar-books')}],
            });
            this.similarExhausted = false;
            this.$root.notify.success(feedbackMessage(kind));
            await this.load(true);
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        }
    }

    async restoreBook(book) {
        try {
            await this.api.updateDiscoveryPreferences({hiddenBooksRemove: [bookUid(book)], feedbackRemove: [bookUid(book)]});
            this.$root.notify.success(t('Книга возвращена в персональные витрины.'));
            await this.load(true);
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        }
    }

    async saveTaste(taste) {
        try {
            await this.api.updateDiscoveryPreferences({taste});
            this.tasteOpen = false;
            this.tasteDismissed = true;
            this.similarExhausted = false;
            this.$root.notify.success(t('Вкусы сохранены. Персональная подборка обновлена.'));
            await this.load(true);
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        }
    }

    async dismissTaste() {
        this.tasteDismissed = true;
        try {
            await this.api.updateDiscoveryPreferences({tastePromptDismissedAt: new Date().toISOString()});
            this.$root.notify.info(t('Вкусы можно настроить позже на странице «Для вас».'));
        } catch (e) {
            this.$root.stdDialog.alert(tMessage(e.message), t('Ошибка'));
        }
    }
}

export default vueComponent(DiscoveryPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.link-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--app-link);
    font: inherit;
    cursor: pointer;
}

.external-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.external-genre {
    min-width: 260px;
}

.shelf {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--app-border);
}

.shelf-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 16px;
}

.shelf-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.shelf-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--app-muted);
    font-size: 12px;
}

.shelf-warn {
    color: var(--app-accent);
}

.shelf-actions {
    display: flex;
    gap: 4px;
}

.shelf-more {
    align-self: flex-start;
}
</style>
