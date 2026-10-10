<template>
    <div class="app-shell" :class="{'app-shell--bare': bare}">
        <nav v-if="!bare" class="shell-rail" :aria-label="$t('Разделы')">
            <router-link class="shell-brand" to="/">
                <img class="shell-brand-logo" src="../Search/assets/logo.png" alt="" />
                <span class="shell-brand-name">{{ collectionName || config.name || 'inpx-web' }}</span>
            </router-link>

            <div class="shell-nav">
                <router-link class="shell-nav-item" :class="{'is-active': activeItem === 'home'}" to="/">
                    <q-icon name="la la-home" size="20px" />
                    <span>{{ $t('Главная') }}</span>
                </router-link>
                <router-link class="shell-nav-item" :class="{'is-active': activeItem === 'catalog'}" :to="catalogPath">
                    <q-icon name="la la-book" size="20px" />
                    <span>{{ $t('Каталог') }}</span>
                </router-link>
                <router-link
                    v-for="item in discoveryItems"
                    :key="item.route"
                    class="shell-nav-item"
                    :class="{'is-active': activeItem === item.route}"
                    :to="`/${item.route}`"
                >
                    <q-icon :name="item.icon" size="20px" />
                    <span>{{ item.label }}</span>
                </router-link>
                <router-link class="shell-nav-item" :class="{'is-active': activeItem === 'lists'}" to="/lists">
                    <q-icon name="la la-bookmark" size="20px" />
                    <span>{{ $t('Списки') }}</span>
                </router-link>
            </div>

            <div class="shell-nav shell-nav--bottom">
                <router-link v-if="signedIn" class="shell-nav-item" :class="{'is-active': activeItem === 'me'}" to="/me">
                    <q-icon name="la la-user-cog" size="20px" />
                    <span>{{ $t('Профиль и устройства') }}</span>
                </router-link>
                <router-link v-if="admin" class="shell-nav-item" :class="{'is-active': activeItem === 'admin'}" to="/admin">
                    <q-icon name="la la-shield-alt" size="20px" />
                    <span>{{ $t('Администрирование') }}</span>
                </router-link>

                <div v-if="showReleaseNotice" class="shell-release">
                    <div class="shell-release-title">
                        {{ $t('Доступна версия {version}', {version: config.latestVersion}) }}
                    </div>
                    <div class="shell-release-actions">
                        <a v-if="config.latestReleaseLink" :href="config.latestReleaseLink" target="_blank" rel="noopener">{{ $t('Подробнее') }}</a>
                        <button type="button" class="shell-link-btn" @click="dismissRelease">
                            {{ $t('Скрыть') }}
                        </button>
                    </div>
                </div>

                <button type="button" class="shell-user" :aria-label="$t('Меню профиля')">
                    <span class="shell-avatar" :class="{'shell-avatar--guest': !signedIn}">{{ signedIn ? avatarText : '' }}<q-icon v-if="!signedIn" name="la la-user" size="18px" /></span>
                    <span class="shell-user-copy">
                        <span class="shell-user-name">{{ userName }}</span>
                        <span class="shell-user-hint">{{ userHint }}</span>
                    </span>
                    <q-icon name="la la-angle-up" size="16px" class="shell-user-caret" />
                    <q-menu anchor="top left" self="bottom left" :offset="[0, 6]" class="shell-menu">
                        <ShellUserMenu
                            :signed-in="signedIn"
                            :admin="admin"
                            :sso="sso"
                            :access-locked="!config.freeAccess"
                            :dark-theme="darkTheme"
                            @sign-in="signIn"
                            @sign-out="signOut"
                            @leave-library="leaveLibrary"
                            @toggle-theme="toggleTheme"
                        />
                    </q-menu>
                </button>
                <div class="shell-version">
                    {{ config.name }} v{{ config.webAppVersion || config.version }}
                </div>
            </div>
        </nav>

        <div class="shell-column">
            <div v-if="!bare && showNamesBanner" class="shell-banner" role="status">
                <q-icon name="la la-lightbulb" size="18px" />
                <span class="shell-banner-text">{{ $t('Поиск может находить авторов и по английским именам: «Isaac Asimov» найдёт Азимова. Для этого нужно скачать таблицу имён.') }}</span>
                <router-link to="/admin/library" @click="dismissNamesBanner">
                    {{ $t('Настроить') }}
                </router-link>
                <button type="button" class="shell-banner-close" :aria-label="$t('Скрыть на неделю')" :title="$t('Скрыть на неделю')" @click="dismissNamesBanner">
                    <q-icon name="la la-times" size="16px" />
                </button>
            </div>
            <header v-if="!bare" class="shell-top">
                <Omnibox />
                <LanguagePicker />
            </header>
            <main class="shell-main">
                <slot></slot>
            </main>
        </div>

        <nav v-if="!bare" class="shell-tabbar" :aria-label="$t('Разделы')">
            <router-link class="shell-tab" :class="{'is-active': activeItem === 'home' || discoveryActive}" to="/">
                <q-icon name="la la-home" size="22px" />
                <span>{{ $t('Главная') }}</span>
            </router-link>
            <router-link class="shell-tab" :class="{'is-active': activeItem === 'catalog'}" :to="catalogPath">
                <q-icon name="la la-book" size="22px" />
                <span>{{ $t('Каталог') }}</span>
            </router-link>
            <router-link class="shell-tab" :class="{'is-active': activeItem === 'lists'}" to="/lists">
                <q-icon name="la la-bookmark" size="22px" />
                <span>{{ $t('Списки') }}</span>
            </router-link>
            <router-link v-if="signedIn" class="shell-tab" :class="{'is-active': activeItem === 'me' || activeItem === 'admin'}" to="/me">
                <q-icon name="la la-user-circle" size="22px" />
                <span>{{ $t('Профиль') }}</span>
            </router-link>
            <button v-else type="button" class="shell-tab" @click="signIn">
                <q-icon name="la la-sign-in-alt" size="22px" />
                <span>{{ $t('Войти') }}</span>
            </button>
        </nav>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import ShellUserMenu from './ShellUserMenu.vue';
import Omnibox from './Omnibox.vue';
import LanguagePicker from './LanguagePicker.vue';

import {t, tMessage} from '../../share/i18n';
import {currentProfile, isSignedIn, isAdmin, initials} from '../../share/session';
import {enabledDiscoveryRoutes, discoveryRouteLabel} from '../../share/discoveryRoutes';
import {newReleaseAvailable} from '../../share/release';
import {myLanguages, langDefaultFor} from '../../share/languages';

const discoveryIcons = {
    'for-you': 'la la-magic',
    'newest': 'la la-calendar-plus',
    'popular': 'la la-fire',
    'bestsellers': 'la la-globe',
};
const namesBannerKey = 'inpx-web-author-names-banner';
const weekMs = 7 * 24 * 3600 * 1000;
const catalogRoutes = new Set(['/search', '/author', '/series', '/title', '/books', '/extended']);

const componentOptions = {
    components: {
        ShellUserMenu,
        Omnibox,
        LanguagePicker,
    },
    watch: {
        //поле «Язык» старого поиска по полям следует за «Моими языками»
        langDefault: {
            handler(value) {
                if (this.$store.state.settings.langDefault !== value)
                    this.$store.commit('setSettings', {langDefault: value});
            },
            immediate: true,
        },
        //серверные uiDefaults при первом входе могут перезаписать поле - возвращаем
        '$store.state.settings.langDefault'(value) {
            if (value !== this.langDefault)
                this.$store.commit('setSettings', {langDefault: this.langDefault});
        },
        '$route'(to) {
            if (catalogRoutes.has(to.path))
                this.lastCatalogPath = to.fullPath;
        },
    },
};

class AppShell {
    _options = componentOptions;
    _props = {
        bare: Boolean,
    };

    lastCatalogPath = '/search';
    namesBannerDismissedAt = 0;

    created() {
        try {
            this.namesBannerDismissedAt = Number(localStorage.getItem(namesBannerKey) || 0) || 0;
        } catch (e) {
            this.namesBannerDismissedAt = 0;
        }
        if (catalogRoutes.has(this.$route.path))
            this.lastCatalogPath = this.$route.fullPath;
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get profile() {
        return currentProfile(this.config);
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get admin() {
        return isAdmin(this.config);
    }

    get sso() {
        return !!this.config.profileBoundId;
    }

    get userName() {
        return this.signedIn ? (tMessage(this.profile.name) || this.profile.login || t('Профиль')) : t('Гость');
    }

    get userHint() {
        if (!this.signedIn)
            return t('Войти');
        const parts = [this.profile.login || ''];
        if (this.admin)
            parts.push(t('Администратор'));
        if (this.sso)
            parts.push(t('Вход через SSO'));
        return parts.filter(Boolean).join(' · ');
    }

    get avatarText() {
        return initials(this.userName);
    }

    get langDefault() {
        return langDefaultFor(myLanguages(this.config, this.settings));
    }

    get darkTheme() {
        return !!this.settings.darkTheme;
    }

    get collectionName() {
        const info = (this.config.dbConfig && this.config.dbConfig.inpxInfo) || {};
        return String(info.collection || '').split('\n')[0].trim();
    }

    get catalogPath() {
        return this.lastCatalogPath || '/search';
    }

    get discoveryItems() {
        return enabledDiscoveryRoutes(this.config, this.settings).map(route => ({
            route,
            label: discoveryRouteLabel(route, this.config, this.settings),
            icon: discoveryIcons[route],
        }));
    }

    get discoveryActive() {
        return Object.keys(discoveryIcons).includes(this.activeItem);
    }

    get activeItem() {
        const path = this.$route.path;
        if (path === '/')
            return 'home';
        const section = this.$route.meta && this.$route.meta.section;
        if (section && section !== 'library')
            return section;
        const route = path.replace(/^\//, '');
        return discoveryIcons[route] ? route : 'catalog';
    }

    get showReleaseNotice() {
        return this.settings.showNewReleaseAvailable !== false && newReleaseAvailable(this.config);
    }

    //подсказка администратору: таблица английских имён авторов не скачана; не чаще раза в неделю
    get showNamesBanner() {
        const search = this.config.catalogSearch || {};
        const names = search.authorNames;
        return !!(this.admin && search.enabled && names && !names.ready && Date.now() - this.namesBannerDismissedAt > weekMs);
    }

    dismissNamesBanner() {
        this.namesBannerDismissedAt = Date.now();
        try {
            localStorage.setItem(namesBannerKey, String(this.namesBannerDismissedAt));
        } catch (e) {
            //без localStorage подсказка вернётся после перезагрузки
        }
    }

    dismissRelease() {
        this.$store.commit('setSettings', {showNewReleaseAvailable: false});
    }

    toggleTheme() {
        this.$store.commit('setSettings', {darkTheme: !this.darkTheme});
    }

    signIn() {
        this.$router.push({path: '/login', query: {redirect: this.$route.fullPath}});
    }

    async signOut() {
        await this.$root.api.signOutProfile();
        if (this.$route.meta && ['me', 'admin'].includes(this.$route.meta.section))
            this.$router.push(this.catalogPath);
    }

    async leaveLibrary() {
        await this.$root.api.logout();
    }
}

export default vueComponent(AppShell);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.app-shell {
    display: grid;
    grid-template-columns: var(--shell-rail-width) minmax(0, 1fr);
    width: 100%;
    height: 100%;
}

.app-shell--bare {
    grid-template-columns: minmax(0, 1fr);
}

.shell-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
}

.shell-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px 6px 28px;
    background: var(--app-accent-soft);
    color: var(--app-text);
    font-size: 13px;
}

.shell-banner-text {
    flex: 1;
    min-width: 0;
}

.shell-banner-close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--app-muted);
    cursor: pointer;
}

.shell-banner-close:hover {
    background: var(--app-surface);
}

.shell-top {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 28px;
    border-bottom: 1px solid var(--app-border);
    background: var(--app-surface);
    position: relative;
    z-index: 20;
}

.shell-main {
    flex: 1 1 auto;
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.shell-main > :deep(*) {
    flex: 1 1 auto;
    min-width: 0;
}

.shell-rail {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 14px 10px 10px;
    background: var(--app-surface);
    border-right: 1px solid var(--app-border);
    overflow-y: auto;
}

.shell-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    color: var(--app-text);
    text-decoration: none;
}

.shell-brand-logo {
    width: 28px;
    height: 28px;
    flex: none;
}

.shell-brand-name {
    font-family: var(--app-font-serif);
    font-weight: 600;
    font-size: 15px;
    line-height: 1.2;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.shell-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.shell-nav--bottom {
    margin-top: auto;
}

.shell-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--app-radius);
    color: var(--app-text);
    text-decoration: none;
    font-weight: 500;
}

.shell-nav-item:hover {
    background: var(--app-surface-3);
}

.shell-nav-item.is-active {
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-weight: 600;
}

.shell-release {
    margin: 6px 0;
    padding: 10px;
    border-radius: var(--app-radius);
    background: var(--app-accent-soft);
    font-size: 13px;
}

.shell-release-title {
    font-weight: 600;
}

.shell-release-actions {
    display: flex;
    gap: 12px;
    margin-top: 4px;
}

.shell-link-btn {
    border: 0;
    padding: 0;
    background: none;
    color: var(--app-link);
    cursor: pointer;
    font: inherit;
}

.shell-user {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin-top: 6px;
    padding: 8px;
    border: 0;
    border-top: 1px solid var(--app-border);
    border-radius: 0;
    background: none;
    color: var(--app-text);
    cursor: pointer;
    text-align: left;
    font: inherit;
}

.shell-user:hover {
    background: var(--app-surface-3);
}

.shell-avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: none;
    border-radius: 50%;
    background: var(--app-primary);
    color: var(--app-on-primary);
    font-weight: 600;
    font-size: 13px;
}

.shell-avatar--guest {
    background: var(--app-surface-3);
    color: var(--app-muted);
}

.shell-user-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
}

.shell-user-name,
.shell-user-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.shell-user-name {
    font-weight: 600;
}

.shell-user-hint {
    font-size: 12px;
    color: var(--app-muted);
}

.shell-user-caret {
    color: var(--app-muted);
}

.shell-version {
    padding: 4px 8px 0;
    font-size: 11px;
    color: var(--app-muted);
}

.shell-tabbar {
    display: none;
}

@media (max-width: 899px) {
    .app-shell {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) auto;
    }

    .shell-rail {
        display: none;
    }

    .shell-top {
        padding: 8px 12px;
        padding-top: calc(8px + env(safe-area-inset-top, 0px));
    }

    .shell-tabbar {
        display: grid;
        grid-auto-columns: 1fr;
        grid-auto-flow: column;
        background: var(--app-surface);
        border-top: 1px solid var(--app-border);
        padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .shell-tab {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 7px 0 6px;
        border: 0;
        background: none;
        color: var(--app-muted);
        text-decoration: none;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }

    .shell-tab.is-active {
        color: var(--app-primary);
        font-weight: 600;
    }
}
</style>
