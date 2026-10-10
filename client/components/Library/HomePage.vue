<template>
    <div class="page">
        <div class="page-body">
            <header class="page-head">
                <div>
                    <h1 class="page-title">
                        {{ greeting }}
                    </h1>
                    <div class="card-hint num">
                        {{ statsLine }}
                    </div>
                </div>
                <div class="page-actions">
                    <q-btn color="primary" unelevated no-caps icon="la la-search" @click="$router.push(catalogPath)">
                        {{ $t('Открыть каталог') }}
                    </q-btn>
                </div>
            </header>

            <section v-if="continueReading.length" class="home-shelf">
                <div class="card-head">
                    <h2 class="card-title">
                        {{ $t('Продолжить чтение') }}
                    </h2>
                    <router-link to="/lists">
                        {{ $t('Все') }}
                    </router-link>
                </div>
                <div class="book-grid">
                    <BookCard
                        v-for="item in continueReading"
                        :key="item._uid"
                        :book="item"
                        :progress="item.percent"
                        :meta="$t('Прочитано {n}%', {n: Math.round(item.percent * 100)})"
                    />
                </div>
            </section>

            <div v-if="shelvesLoading && !shelves.length" class="page-empty page-empty--inline">
                {{ $t('Собираю витрину...') }}
            </div>

            <section v-for="shelf in shelves" :key="shelf.id" class="home-shelf">
                <div class="card-head">
                    <div>
                        <h2 class="card-title">
                            {{ $tm(shelf.title) }}
                        </h2>
                        <div v-if="shelf.subtitle" class="card-hint">
                            {{ $tm(shelf.subtitle) }}
                        </div>
                    </div>
                    <router-link v-if="shelfLink(shelf)" :to="shelfLink(shelf)">
                        {{ $t('Все') }}
                    </router-link>
                </div>
                <div class="book-grid">
                    <BookCard v-for="item in shelf.items" :key="item._uid" :book="item" :progress="stateOf(item).percent || 0" />
                </div>
            </section>

            <section v-if="!signedIn" class="card">
                <h2 class="card-title">
                    {{ $t('Войдите, чтобы читать с того же места') }}
                </h2>
                <div class="card-hint">
                    {{ $t('После входа здесь появятся книги, которые вы читаете, ваши списки и подборки по вашим вкусам.') }}
                </div>
                <div class="card-actions">
                    <q-btn color="primary" unelevated no-caps @click="$router.push({path: '/login', query: {redirect: '/'}})">
                        {{ $t('Войти') }}
                    </q-btn>
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
import {isSignedIn, currentProfile} from '../../share/session';
import {externalDiscovery, isDiscoveryRouteEnabled} from '../../share/discoveryRoutes';
import {bookUid} from '../../share/bookActions';

const shelfItemLimit = 12;

const componentOptions = {
    components: {
        BookCard,
    },
    watch: {
        '$store.state.config.currentUserId'() {
            if (this.isActive)
                this.loadShelves();
        },
    },
};

class HomePage {
    _options = componentOptions;

    isActive = false;
    shelves = [];
    shelvesLoading = false;
    states = {};
    loadedAt = 0;

    created() {
        this.api = this.$root.api;
    }

    activated() {
        this.isActive = true;
        this.$root.setAppTitle(this.collectionName || t('Главная'));
        //витрины кешируются на сервере; обновляем не чаще раза в минуту
        if (Date.now() - this.loadedAt > 60 * 1000)
            this.loadShelves();
    }

    deactivated() {
        this.isActive = false;
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

    get collectionName() {
        const info = (this.config.dbConfig && this.config.dbConfig.inpxInfo) || {};
        return String(info.collection || '').split('\n')[0].trim();
    }

    get catalogPath() {
        return '/search';
    }

    get greeting() {
        if (!this.signedIn)
            return this.collectionName || t('Библиотека');
        const name = tMessage(currentProfile(this.config).name) || '';
        const hour = new Date().getHours();
        if (hour < 5 || hour >= 22)
            return t('Доброй ночи, {name}', {name});
        if (hour < 12)
            return t('Доброе утро, {name}', {name});
        if (hour < 18)
            return t('Добрый день, {name}', {name});
        return t('Добрый вечер, {name}', {name});
    }

    get statsLine() {
        const stats = (this.config.dbConfig && this.config.dbConfig.stats) || {};
        const parts = [];
        if (stats.bookCount)
            parts.push(t('Книг: {n}', {n: Number(stats.bookCount).toLocaleString()}));
        if (stats.authorCount)
            parts.push(t('Авторов: {n}', {n: Number(stats.authorCount).toLocaleString()}));
        if (stats.seriesCount)
            parts.push(t('Серий: {n}', {n: Number(stats.seriesCount).toLocaleString()}));
        if (this.signedIn && this.collectionName)
            parts.unshift(this.collectionName);
        return parts.join(' · ');
    }

    get continueReading() {
        const rows = currentProfile(this.config).currentReading;
        return (Array.isArray(rows) ? rows : []).slice(0, shelfItemLimit).map(item => ({
            _uid: item.bookUid,
            title: item.title,
            author: item.author,
            series: item.series,
            percent: Number(item.percent || 0) || 0,
        }));
    }

    stateOf(book) {
        return this.states[bookUid(book)] || {};
    }

    shelfLink(shelf) {
        const id = String(shelf.id || '');
        const route = id.startsWith('newest') ? 'newest'
            : id.startsWith('popular') ? 'popular'
                : id.startsWith('external') ? 'bestsellers'
                    : (shelf.source === 'personal' ? 'for-you' : '');
        return (route && isDiscoveryRouteEnabled(route, this.config, this.settings) ? `/${route}` : '');
    }

    async loadShelves() {
        if ((this.config.discovery || {}).enabled === false) {
            this.shelves = [];
            return;
        }

        this.shelvesLoading = true;
        try {
            const external = externalDiscovery(this.config, this.settings);
            const response = await this.api.getDiscoveryShelves({
                newestLimit: shelfItemLimit,
                popularLimit: shelfItemLimit,
                personalLimit: shelfItemLimit,
                personalSimilarEnabled: this.settings.showDiscoverySimilar !== false,
                externalSource: external.source,
                externalName: external.name,
                externalUrl: external.url,
            });
            //"Продолжить чтение" строится из профиля, внешняя витрина и служебные полки - на своих страницах
            this.shelves = ((response && response.shelves) || [])
                .filter(shelf => shelf && Array.isArray(shelf.items) && shelf.items.length)
                .filter(shelf => !['continue-reading', 'hidden-books', 'external-error'].includes(shelf.id))
                .filter(shelf => !String(shelf.id || '').startsWith('external'))
                .map(shelf => Object.assign({}, shelf, {items: shelf.items.filter(item => bookUid(item)).slice(0, shelfItemLimit)}));
            this.loadedAt = Date.now();
        } catch (e) {
            this.shelves = [];
        } finally {
            this.shelvesLoading = false;
        }

        if (this.signedIn) {
            const uids = [...new Set(this.shelves.flatMap(shelf => shelf.items.map(bookUid)))];
            if (uids.length) {
                try {
                    const result = await this.api.getBookStates(uids);
                    this.states = (result && result.states) || {};
                } catch (e) {
                    this.states = {};
                }
            }
        }
    }
}

export default vueComponent(HomePage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.home-shelf {
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
    .book-grid {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        padding-bottom: 6px;
        scroll-snap-type: x mandatory;
    }

    .book-grid > * {
        flex: 0 0 104px;
        scroll-snap-align: start;
    }
}
</style>
