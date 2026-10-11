<template>
    <div class="page">
        <div class="page-body">
            <header class="page-head">
                <h1 class="page-title">
                    {{ $t('me.profileAndDevices') }}
                </h1>
            </header>

            <div class="section-layout">
                <nav class="section-nav" :aria-label="$t('me.profileSections')">
                    <router-link
                        v-for="item in sections"
                        :key="item.id"
                        class="section-nav-item"
                        :class="{'is-active': item.id === section}"
                        :to="`/me/${item.id}`"
                    >
                        <q-icon :name="item.icon" size="18px" />{{ item.label }}
                    </router-link>
                    <div class="section-nav-sep" />
                    <router-link v-if="admin" class="section-nav-item" to="/admin">
                        <q-icon name="la la-shield-alt" size="18px" />{{ $t('settings.admin.title') }}
                    </router-link>
                    <button v-if="signedIn && !sso" type="button" class="section-nav-item" @click="signOut">
                        <q-icon name="la la-sign-out-alt" size="18px" />{{ $t('profiles.logout') }}
                    </button>
                    <button v-if="!signedIn" type="button" class="section-nav-item" @click="signIn">
                        <q-icon name="la la-sign-in-alt" size="18px" />{{ $t('profiles.loginAction') }}
                    </button>
                </nav>

                <div class="section-content">
                    <div v-if="needsSignIn" class="card">
                        <div>{{ $t('me.signInToOpen') }}</div>
                        <div>
                            <q-btn color="primary" unelevated no-caps @click="signIn">
                                {{ $t('profiles.loginAction') }}
                            </q-btn>
                        </div>
                    </div>
                    <MeAccount v-else-if="section === 'account'" />
                    <MeDevices v-else-if="section === 'devices'" />
                    <MeDelivery v-else-if="section === 'delivery'" />
                    <MePreferences v-else-if="section === 'preferences'" />
                    <MeData v-else-if="section === 'data'" />
                </div>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import MeAccount from './MeAccount.vue';
import MeDevices from './MeDevices.vue';
import MeDelivery from './MeDelivery.vue';
import MePreferences from './MePreferences.vue';
import MeData from './MeData.vue';

import {t} from '../../share/i18n';
import {isSignedIn, isAdmin} from '../../share/session';

const personalSections = ['account', 'devices', 'delivery', 'data'];

const componentOptions = {
    components: {
        MeAccount,
        MeDevices,
        MeDelivery,
        MePreferences,
        MeData,
    },
    watch: {
        section() {
            this.updateTitle();
        },
    },
};

class MePage {
    _options = componentOptions;

    activated() {
        this.updateTitle();
    }

    get config() {
        return this.$store.state.config;
    }

    get section() {
        const value = String(this.$route.params.section || 'account');
        return this.sections.some(item => item.id === value) ? value : 'account';
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

    get needsSignIn() {
        return !this.signedIn && personalSections.includes(this.section);
    }

    get sections() {
        return [
            {id: 'account', label: t('me.account'), icon: 'la la-user'},
            {id: 'devices', label: t('me.devices'), icon: 'la la-tablet'},
            {id: 'delivery', label: t('settings.mail.title'), icon: 'la la-paper-plane'},
            {id: 'preferences', label: t('me.interface'), icon: 'la la-sliders-h'},
            {id: 'data', label: t('me.myData'), icon: 'la la-database'},
        ];
    }

    updateTitle() {
        if (!this.$route.path.startsWith('/me'))
            return;
        const item = this.sections.find(row => row.id === this.section);
        this.$root.setAppTitle(item ? item.label : t('common.profile'));
    }

    signIn() {
        this.$router.push({path: '/login', query: {redirect: this.$route.fullPath}});
    }

    async signOut() {
        await this.$root.api.signOutProfile();
        this.$router.push('/');
    }
}

export default vueComponent(MePage);
//-----------------------------------------------------------------------------
</script>
