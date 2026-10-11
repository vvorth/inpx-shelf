<template>
    <div class="page">
        <div class="page-body">
            <header class="page-head">
                <div>
                    <h1 class="page-title">
                        {{ pageTitle }}
                    </h1>
                    <div class="card-hint num">
                        {{ pageSubtitle }}
                        <template v-if="hiddenByLanguage">
                            · {{ $t('author.moreInOtherLanguages', {n: hiddenByLanguage}) }}
                            <button type="button" class="link-btn" @click="allLanguages = true">
                                {{ $t('author.show') }}
                            </button>
                        </template>
                    </div>
                </div>
                <div class="page-actions">
                    <q-btn v-if="kind === 'home'" color="primary" unelevated no-caps icon="la la-search" @click="$router.push('/search')">
                        {{ $t('discovery.openCatalog') }}
                    </q-btn>
                    <q-toggle
                        v-if="kind === 'home' && signedIn"
                        :model-value="settings.showDiscoveryUnreadOnly === true"
                        :label="$t('discovery.unreadOnly')"
                        @update:model-value="setSetting('showDiscoveryUnreadOnly', $event)"
                    />
                    <q-btn v-if="kind === 'home' && signedIn" flat no-caps icon="la la-sliders-h" @click="tasteOpen = !tasteOpen">
                        {{ $t('discovery.setUpTastes') }}
                    </q-btn>
                    <q-btn v-if="requestable" flat no-caps icon="la la-sync" :loading="loading" @click="load(true)">
                        {{ $t('reader.refresh') }}
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
                    :label="$t('discovery.externalShowcaseGenre')"
                    :disable="loading"
                    @update:model-value="setExternalGenre"
                />
            </div>

            <section v-if="kind === 'home' && !signedIn" class="card">
                <h2 class="card-title">
                    {{ $t('discovery.signInToPick') }}
                </h2>
                <div class="card-hint">
                    {{ $t('discovery.afterYouSignIn') }}
                </div>
                <div class="card-actions">
                    <q-btn color="primary" unelevated no-caps @click="$router.push({path: '/login', query: {redirect: '/'}})">
                        {{ $t('profiles.loginAction') }}
                    </q-btn>
                </div>
            </section>

            <div v-else-if="!requestable" />
            <div v-else-if="loading && !shelves.length" class="page-empty page-empty--inline">
                <q-linear-progress indeterminate size="3px" color="primary" />
                {{ $t('discovery.buildingShowcase') }}
            </div>
            <div v-else-if="error" class="page-empty page-empty--inline">
                {{ error }}
            </div>
            <div v-else-if="!shelves.length" class="page-empty">
                {{ $t('discovery.nothingHereYet') }}
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
                            <span v-if="shelf.updatedAt">{{ $t('discovery.updated', {time: formatTime(shelf.updatedAt)}) }}</span>
                            <span v-if="shelf.discoveryStale" class="shelf-warn">{{ $t('discovery.showingCachedData') }}</span>
                            <span v-if="shelf.discoveryRefreshError" class="shelf-warn">{{ shelf.discoveryRefreshError }}</span>
                        </div>
                    </div>
                    <div class="shelf-actions">
                        <q-btn v-if="shelf.sourceUrl" flat dense no-caps icon="la la-external-link-alt" type="a" :href="shelf.sourceUrl" target="_blank" rel="noopener">
                            {{ $t('common.source') }}
                        </q-btn>
                        <q-btn v-if="hideSetting(shelf)" flat dense no-caps icon="la la-eye-slash" @click="hideShelf(shelf)">
                            {{ $t('discovery.hideShelf') }}
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
                    {{ shelf.emptyMessage ? $tm(shelf.emptyMessage) : $t('discovery.nothingHereYet') }}
                </div>

                <q-btn v-if="canLoadMore(shelf)" class="shelf-more" outline color="primary" no-caps icon="la la-plus" :loading="loading" @click="loadMore(shelf)">
                    {{ shelf.id === 'similar-books' ? $t('discovery.moreRecommendations') : $t('discovery.loadMore') }}
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

import {t, tm, formatDateTime} from '../../share/i18n';
import {isSignedIn, currentProfile} from '../../share/session';
import {bookUid} from '../../share/bookActions';
import {bookView, bookViewOptions} from '../../share/bookView';
import {myLanguages, languageMatches} from '../../share/languages';
import {externalDiscovery, discoveryRouteLabel} from '../../share/discoveryRoutes';
import {isExternalOnly, feedbackMessage} from '../../share/discovery';

const kinds = ['home', 'bestsellers'];
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

//Главная с персональными подборками и внешняя витрина
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
        this.$root.setAppTitle(this.kind === 'home' ? (this.collectionName || t('discovery.home')) : this.pageTitle);
        if (this.requestKey !== this.loadedKey)
            this.load();
    }

    get isOwnRoute() {
        return kinds.includes(this.kind);
    }

    get kind() {
        return String(this.$route.path || '').replace(/^\//, '') || 'home';
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
        return (this.kind === 'home' ? this.greeting : discoveryRouteLabel(this.kind, this.config, this.settings));
    }

    get pageSubtitle() {
        if (this.kind === 'home')
            return this.statsLine;
        return t('discovery.picksFromAnExternal');
    }

    get collectionName() {
        const info = (this.config.dbConfig && this.config.dbConfig.inpxInfo) || {};
        return String(info.collection || '').split('\n')[0].trim();
    }

    get greeting() {
        if (!this.signedIn)
            return this.collectionName || t('settings.library');
        const name = tm(currentProfile(this.config).name) || '';
        const hour = new Date().getHours();
        if (hour < 5 || hour >= 22)
            return t('discovery.goodNight', {name});
        if (hour < 12)
            return t('discovery.goodMorning', {name});
        if (hour < 18)
            return t('discovery.goodAfternoon', {name});
        return t('discovery.goodEvening', {name});
    }

    get statsLine() {
        const stats = (this.config.dbConfig && this.config.dbConfig.stats) || {};
        const parts = [];
        if (stats.bookCount)
            parts.push(t('addToListDialog.books', {n: Number(stats.bookCount).toLocaleString()}));
        if (stats.authorCount)
            parts.push(t('discovery.authors', {n: Number(stats.authorCount).toLocaleString()}));
        if (stats.seriesCount)
            parts.push(t('discovery.series', {n: Number(stats.seriesCount).toLocaleString()}));
        if (this.signedIn && this.collectionName)
            parts.unshift(this.collectionName);
        return parts.join(' · ');
    }

    //персональные подборки есть только у вошедшего пользователя
    get requestable() {
        if ((this.config.discovery || {}).enabled === false)
            return false;
        return (this.kind !== 'home' || this.signedIn);
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
        if (!this.requestable) {
            this.rawShelves = [];
            return;
        }
        this.loading = true;
        this.error = '';
        try {
            const external = this.external;
            const response = await this.api.getDiscoveryShelves({
                section: (this.kind === 'home' ? 'personal' : 'external'),
                forceRefresh: force === true,
                personalLimit: 12,
                personalSimilarLimit: this.similarLimit,
                personalSimilarEnabled: this.settings.showDiscoverySimilar !== false,
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
                this.error = t('search.showcaseError', {message: tm(e.message) || t('search.noResponseServer')});
        } finally {
            if (seq === this.requestSeq)
                this.loading = false;
        }
    }

    //полки текущей страницы, с отметками для отзывов и фильтром «Моих языков»
    get preparedShelves() {
        const shelves = this.rawShelves.filter(Boolean);
        if (this.kind === 'home') {
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
        return this.kind === 'home' && this.signedIn && (this.tasteOpen || this.tasteNeedsSetup);
    }

    get tasteKey() {
        return JSON.stringify(this.taste);
    }

    get genreOptions() {
        const shelf = this.rawShelves.find(item => item && item.source === 'external') || {};
        const result = [{label: t('search.allGenres'), value: ''}];
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
        return (this.kind === 'home' && shelfSettings[shelf.id]) || '';
    }

    canLoadMore(shelf) {
        if (!shelf.items.length || shelf.discoveryHasMore !== true)
            return false;
        return (shelf.id === 'similar-books' || shelf.source === 'external');
    }

    formatTime(value) {
        return formatDateTime(value);
    }

    setSetting(name, value) {
        this.$store.commit('setSettings', {[name]: value});
    }

    hideShelf(shelf) {
        this.setSetting(this.hideSetting(shelf), false);
        this.$root.notify.success(t('search.shelfHiddenCanRestore'));
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
                this.$root.notify.info(t('search.noNewRecommendationsYet'));
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
        if (this.kind !== 'home' || !this.signedIn)
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
            this.$root.stdDialog.alert(tm(e.message), t('common.error'));
        }
    }

    async restoreBook(book) {
        try {
            await this.api.updateDiscoveryPreferences({hiddenBooksRemove: [bookUid(book)], feedbackRemove: [bookUid(book)]});
            this.$root.notify.success(t('search.bookReturnedPersonalShowcases'));
            await this.load(true);
        } catch (e) {
            this.$root.stdDialog.alert(tm(e.message), t('common.error'));
        }
    }

    async saveTaste(taste) {
        try {
            await this.api.updateDiscoveryPreferences({taste});
            this.tasteOpen = false;
            this.tasteDismissed = true;
            this.similarExhausted = false;
            this.$root.notify.success(t('search.tastesSavedPersonalPicks'));
            await this.load(true);
        } catch (e) {
            this.$root.stdDialog.alert(tm(e.message), t('common.error'));
        }
    }

    async dismissTaste() {
        this.tasteDismissed = true;
        try {
            await this.api.updateDiscoveryPreferences({tastePromptDismissedAt: new Date().toISOString()});
            this.$root.notify.info(t('discovery.youCanSetYour'));
        } catch (e) {
            this.$root.stdDialog.alert(tm(e.message), t('common.error'));
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
