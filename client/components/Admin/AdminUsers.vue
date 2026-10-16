<template>
    <div class="card-stack">
        <section class="card">
            <div class="card-head">
                <div>
                    <h2 class="card-title">
                        {{ $t('admin.users') }}
                    </h2>
                    <div class="card-hint">
                        {{ config.profileLoginRequired
                            ? $t('adminUsers.guestAccessIsOff')
                            : $t('adminUsers.guestAccessIsOn') }}
                        {{ $t('adminUsers.setItWithThe') }}
                    </div>
                </div>
                <q-btn color="primary" unelevated no-caps icon="la la-user-plus" @click="toggleCreate">
                    {{ $t('adminUsers.newUser') }}
                </q-btn>
            </div>

            <form v-if="createVisible" class="user-form" @submit.prevent="createUser">
                <div class="form-grid">
                    <q-input v-model="draft.name" outlined dense :label="$t('profiles.name')" />
                    <q-input v-model="draft.login" outlined dense :label="$t('common.login')" />
                    <q-input v-model="draft.password" outlined dense :label="$t('adminUsers.temporaryPassword')">
                        <template #append>
                            <q-icon name="la la-dice" class="cursor-pointer" @click="draft.password = generatePassword()">
                                <q-tooltip>{{ $t('adminUsers.generate') }}</q-tooltip>
                            </q-icon>
                        </template>
                    </q-input>
                    <q-input v-model="draft.emailTo" outlined dense :label="$t('profiles.emailTo')" />
                    <q-input v-model="draft.telegramChatId" outlined dense :label="$t('profiles.personalTelegramChatId')" />
                </div>
                <q-toggle v-model="draft.opdsEnabled" :label="$t('profiles.showProfileInOpds')" />
                <q-toggle v-model="draft.opdsAuthEnabled" :disable="!draft.login || !draft.password" :label="$t('profiles.requireOpdsAuth')" />
                <q-toggle v-model="draft.isAdmin" :disable="!draft.login || !draft.password" :label="$t('profiles.defaultAdminName')">
                    <q-tooltip>{{ $t('adminUsers.adminHint') }}</q-tooltip>
                </q-toggle>
                <div class="card-hint">
                    {{ $t('adminUsers.giveTheUserTheir') }}
                </div>
                <div class="card-actions">
                    <q-btn type="submit" color="primary" unelevated no-caps :disable="!draft.name">
                        {{ $t('common.create') }}
                    </q-btn>
                    <q-btn flat no-caps @click="createVisible = false">
                        {{ $t('common.cancel') }}
                    </q-btn>
                </div>
            </form>
        </section>

        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>{{ $t('profiles.name') }}</th>
                        <th>{{ $t('adminUsers.role') }}</th>
                        <th class="hide-narrow">
                            OPDS
                        </th>
                        <th class="hide-narrow">
                            {{ $t('adminUsers.reading') }}
                        </th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    <template v-for="user in users" :key="user.id">
                        <tr>
                            <td>
                                <div class="user-name">
                                    {{ $tm(user.name) }}
                                    <span v-if="user.id === currentUserId" class="pill pill--accent">{{ $t('adminUsers.you') }}</span>
                                </div>
                                <div class="card-hint">
                                    {{ user.login || $t('adminUsers.noLogin') }}{{ user.requiresLogin ? '' : ` · ${$t('reader.profileOpenShort')}` }}
                                </div>
                            </td>
                            <td>{{ roleLabel(user) }}</td>
                            <td class="hide-narrow">
                                {{ user.anonymousProfile || user.isAdmin ? '—' : (user.opdsEnabled === false ? $t('adminUsers.off') : (user.opdsAuthEnabled ? $t('adminUsers.withPassword') : $t('adminUsers.on'))) }}
                            </td>
                            <td class="hide-narrow num">
                                {{ user.currentReadingCount || 0 }}
                            </td>
                            <td class="col-actions">
                                <template v-if="!user.anonymousProfile && user.id !== currentUserId">
                                    <q-btn flat dense no-caps icon="la la-pen" @click="toggleEdit(user)">
                                        {{ $t('adminUsers.edit') }}
                                    </q-btn>
                                    <q-btn v-if="!user.isAdmin" flat dense no-caps icon="la la-key" @click="resetPassword(user)">
                                        {{ $t('adminUsers.resetPassword') }}
                                    </q-btn>
                                    <q-btn v-if="!user.isAdmin" flat dense round color="negative" icon="la la-trash" :aria-label="$t('profiles.delete')" @click="deleteUser(user)" />
                                </template>
                                <router-link v-else-if="user.id === currentUserId" to="/me/account">
                                    {{ $t('adminUsers.myProfile') }}
                                </router-link>
                            </td>
                        </tr>
                        <tr v-if="editId === user.id" class="user-edit-row">
                            <td colspan="5">
                                <form class="user-form" @submit.prevent="saveEdit(user)">
                                    <div class="form-grid">
                                        <q-input v-model="edit.name" outlined dense :label="$t('profiles.name')" />
                                        <q-input v-model="edit.login" outlined dense :label="$t('common.login')" />
                                    </div>
                                    <template v-if="!user.isAdmin">
                                        <q-toggle v-model="edit.opdsEnabled" :label="$t('profiles.showProfileInOpds')" />
                                        <q-toggle v-model="edit.opdsAuthEnabled" :disable="!edit.login || !user.requiresLogin" :label="$t('profiles.requireOpdsAuth')" />
                                    </template>
                                    <q-toggle v-model="edit.isAdmin" :disable="user.mainAdmin || !edit.login || !user.requiresLogin" :label="$t('profiles.defaultAdminName')">
                                        <q-tooltip>{{ $t('adminUsers.adminHint') }}</q-tooltip>
                                    </q-toggle>
                                    <div class="card-actions">
                                        <q-btn type="submit" color="primary" unelevated dense no-caps>
                                            {{ $t('common.save') }}
                                        </q-btn>
                                        <q-btn flat dense no-caps @click="editId = ''">
                                            {{ $t('common.cancel') }}
                                        </q-btn>
                                    </div>
                                </form>
                            </td>
                        </tr>
                    </template>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, tm} from '../../share/i18n';
import {currentProfile} from '../../share/session';

//32 знака без похожих (l/1, o/0): 16 знаков - 80 бит, подбор через вход не успеет и с тысяч адресов
const passwordAlphabet = 'abcdefghijkmnpqrstuvwxyz23456789';

function emptyDraft() {
    return {name: '', login: '', password: '', emailTo: '', telegramChatId: '', opdsEnabled: true, opdsAuthEnabled: false, isAdmin: false};
}

class AdminUsers {
    createVisible = false;
    draft = emptyDraft();
    editId = '';
    edit = {};

    created() {
        this.api = this.$root.api;
    }

    get config() {
        return this.$store.state.config;
    }

    get currentUserId() {
        return currentProfile(this.config).id || '';
    }

    get users() {
        return Array.isArray(this.config.userProfiles) ? this.config.userProfiles : [];
    }

    roleLabel(user) {
        if (user.anonymousProfile)
            return t('adminUsers.guest');
        return user.isAdmin ? t('profiles.defaultAdminName') : t('adminUsers.reader');
    }

    generatePassword() {
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => passwordAlphabet[byte % passwordAlphabet.length]).join('').match(/.{4}/g).join('-');
    }

    toggleCreate() {
        this.createVisible = !this.createVisible;
        if (this.createVisible)
            this.draft = Object.assign(emptyDraft(), {password: this.generatePassword()});
    }

    async createUser() {
        try {
            await this.api.createUserProfile(this.draft);
            const login = this.draft.login;
            const password = this.draft.password;
            this.createVisible = false;
            this.draft = emptyDraft();
            await this.api.updateConfig();
            if (login && password)
                await this.$root.stdDialog.alert(t('adminUsers.userCreatedLoginPassword', {login, password}), t('adminUsers.newUser'));
            else
                this.$root.notify.success(t('adminUsers.userCreated'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    toggleEdit(user) {
        if (this.editId === user.id) {
            this.editId = '';
            return;
        }
        this.editId = user.id;
        this.edit = {
            name: tm(user.name) || '',
            login: user.login || '',
            opdsEnabled: user.opdsEnabled !== false,
            opdsAuthEnabled: user.opdsAuthEnabled === true,
            isAdmin: user.isAdmin === true,
        };
    }

    async saveEdit(user) {
        //email и chat id читатель задаёт сам: get-config не отдаёт их для чужих профилей
        const patch = {name: this.edit.name, login: this.edit.login, isAdmin: this.edit.isAdmin};
        if (!user.isAdmin) {
            patch.opdsEnabled = this.edit.opdsEnabled;
            patch.opdsAuthEnabled = this.edit.opdsAuthEnabled;
        }

        try {
            await this.api.updateUserProfile(user.id, patch);
            this.editId = '';
            await this.api.updateConfig();
            this.$root.notify.success(t('profiles.profileSaved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async resetPassword(user) {
        const prompt = await this.$root.stdDialog.password(
            t('profiles.resetPasswordPrompt', {name: tm(user.name)}),
            t('profiles.resetPasswordTitle'),
            {inputValidator: (value) => (String(value || '') ? true : t('common.passwordRequired'))},
        );
        if (!prompt || prompt === false)
            return;

        try {
            await this.api.updateUserProfile(user.id, {password: String(prompt.value || '')});
            await this.api.updateConfig();
            this.$root.notify.success(t('profiles.resetPasswordSuccess', {name: tm(user.name)}));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async deleteUser(user) {
        const confirmed = await this.$root.stdDialog.confirm(
            t('profiles.deleteProfileConfirm', {name: tm(user.name)}),
            t('profiles.deleteProfileTitle'),
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteUserProfile(user.id);
            await this.api.updateConfig();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }
}

export default vueComponent(AdminUsers);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.user-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.user-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
}

.user-edit-row td {
    background: var(--app-surface-2);
}
</style>
