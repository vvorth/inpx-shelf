<template>
    <div class="card-stack">
        <section class="card">
            <div class="card-head">
                <div>
                    <h2 class="card-title">
                        {{ $t('Пользователи') }}
                    </h2>
                    <div class="card-hint">
                        {{ config.profileLoginRequired
                            ? $t('Гостевой доступ выключен: каталог открыт только после входа.')
                            : $t('Гостевой доступ включён: каталог можно смотреть без входа.') }}
                        {{ $t('Меняется переменной INPX_ALLOW_ANONYMOUS_ACCESS.') }}
                    </div>
                </div>
                <q-btn color="primary" unelevated no-caps icon="la la-user-plus" @click="toggleCreate">
                    {{ $t('Новый пользователь') }}
                </q-btn>
            </div>

            <form v-if="createVisible" class="user-form" @submit.prevent="createUser">
                <div class="form-grid">
                    <q-input v-model="draft.name" outlined dense :label="$t('Имя')" />
                    <q-input v-model="draft.login" outlined dense :label="$t('Логин')" />
                    <q-input v-model="draft.password" outlined dense :label="$t('Временный пароль')">
                        <template #append>
                            <q-icon name="la la-dice" class="cursor-pointer" @click="draft.password = generatePassword()">
                                <q-tooltip>{{ $t('Сгенерировать') }}</q-tooltip>
                            </q-icon>
                        </template>
                    </q-input>
                    <q-input v-model="draft.emailTo" outlined dense :label="$t('Email для отправки')" />
                    <q-input v-model="draft.telegramChatId" outlined dense :label="$t('Личный Telegram chat id')" />
                </div>
                <q-toggle v-model="draft.opdsEnabled" :label="$t('Показывать профиль в OPDS')" />
                <q-toggle v-model="draft.opdsAuthEnabled" :disable="!draft.login || !draft.password" :label="$t('Требовать пароль для OPDS')" />
                <div class="card-hint">
                    {{ $t('Сообщите пользователю логин и пароль. Пароль он сможет сменить в своём профиле.') }}
                </div>
                <div class="card-actions">
                    <q-btn type="submit" color="primary" unelevated no-caps :disable="!draft.name">
                        {{ $t('Создать') }}
                    </q-btn>
                    <q-btn flat no-caps @click="createVisible = false">
                        {{ $t('Отмена') }}
                    </q-btn>
                </div>
            </form>
        </section>

        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>{{ $t('Имя') }}</th>
                        <th>{{ $t('Роль') }}</th>
                        <th class="hide-narrow">
                            OPDS
                        </th>
                        <th class="hide-narrow">
                            {{ $t('Читает') }}
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
                                    <span v-if="user.id === currentUserId" class="pill pill--accent">{{ $t('Это вы') }}</span>
                                </div>
                                <div class="card-hint">
                                    {{ user.login || $t('без логина') }}{{ user.requiresLogin ? '' : ` · ${$t('без пароля')}` }}
                                </div>
                            </td>
                            <td>{{ roleLabel(user) }}</td>
                            <td class="hide-narrow">
                                {{ user.anonymousProfile || user.isAdmin ? '—' : (user.opdsEnabled === false ? $t('выкл.') : (user.opdsAuthEnabled ? $t('с паролем') : $t('вкл.'))) }}
                            </td>
                            <td class="hide-narrow num">
                                {{ user.currentReadingCount || 0 }}
                            </td>
                            <td class="col-actions">
                                <template v-if="!user.anonymousProfile && user.id !== currentUserId">
                                    <q-btn flat dense no-caps icon="la la-pen" @click="toggleEdit(user)">
                                        {{ $t('Изменить') }}
                                    </q-btn>
                                    <q-btn v-if="!user.isAdmin" flat dense no-caps icon="la la-key" @click="resetPassword(user)">
                                        {{ $t('Сбросить пароль') }}
                                    </q-btn>
                                    <q-btn v-if="!user.isAdmin" flat dense round color="negative" icon="la la-trash" :aria-label="$t('Удалить')" @click="deleteUser(user)" />
                                </template>
                                <router-link v-else-if="user.id === currentUserId" to="/me/account">
                                    {{ $t('Мой профиль') }}
                                </router-link>
                            </td>
                        </tr>
                        <tr v-if="editId === user.id" class="user-edit-row">
                            <td colspan="5">
                                <form class="user-form" @submit.prevent="saveEdit(user)">
                                    <div class="form-grid">
                                        <q-input v-model="edit.name" outlined dense :label="$t('Имя')" />
                                        <q-input v-model="edit.login" outlined dense :label="$t('Логин')" />
                                    </div>
                                    <template v-if="!user.isAdmin">
                                        <q-toggle v-model="edit.opdsEnabled" :label="$t('Показывать профиль в OPDS')" />
                                        <q-toggle v-model="edit.opdsAuthEnabled" :disable="!edit.login || !user.requiresLogin" :label="$t('Требовать пароль для OPDS')" />
                                    </template>
                                    <div class="card-actions">
                                        <q-btn type="submit" color="primary" unelevated dense no-caps>
                                            {{ $t('Сохранить') }}
                                        </q-btn>
                                        <q-btn flat dense no-caps @click="editId = ''">
                                            {{ $t('Отмена') }}
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

import {t, tMessage} from '../../share/i18n';
import {currentProfile} from '../../share/session';

const passwordWords = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'heron', 'iris', 'juniper', 'koala', 'lumen', 'maple', 'nova', 'otter', 'plum', 'quartz', 'raven', 'sage', 'tulip'];

function emptyDraft() {
    return {name: '', login: '', password: '', emailTo: '', telegramChatId: '', opdsEnabled: true, opdsAuthEnabled: false};
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
            return t('Гость');
        return user.isAdmin ? t('Администратор') : t('Читатель');
    }

    generatePassword() {
        const values = new Uint32Array(3);
        window.crypto.getRandomValues(values);
        const word = index => passwordWords[values[index] % passwordWords.length];
        return `${word(0)}-${word(1)}-${values[2] % 90 + 10}`;
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
                await this.$root.stdDialog.alert(t('Пользователь создан. Логин: {login}, пароль: {password}', {login, password}), t('Новый пользователь'));
            else
                this.$root.notify.success(t('Пользователь создан'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    toggleEdit(user) {
        if (this.editId === user.id) {
            this.editId = '';
            return;
        }
        this.editId = user.id;
        this.edit = {
            name: tMessage(user.name) || '',
            login: user.login || '',
            opdsEnabled: user.opdsEnabled !== false,
            opdsAuthEnabled: user.opdsAuthEnabled === true,
        };
    }

    async saveEdit(user) {
        //email и chat id читатель задаёт сам: get-config не отдаёт их для чужих профилей
        const patch = {name: this.edit.name, login: this.edit.login};
        if (!user.isAdmin) {
            patch.opdsEnabled = this.edit.opdsEnabled;
            patch.opdsAuthEnabled = this.edit.opdsAuthEnabled;
        }

        try {
            await this.api.updateUserProfile(user.id, patch);
            this.editId = '';
            await this.api.updateConfig();
            this.$root.notify.success(t('Профиль сохранён'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async resetPassword(user) {
        const prompt = await this.$root.stdDialog.password(
            t('Введите новый пароль для профиля «{name}»:', {name: tMessage(user.name)}),
            t('Сброс пароля'),
            {inputValidator: (value) => (String(value || '') ? true : t('Пароль не должен быть пустым'))},
        );
        if (!prompt || prompt === false)
            return;

        try {
            await this.api.updateUserProfile(user.id, {password: String(prompt.value || '')});
            await this.api.updateConfig();
            this.$root.notify.success(t('Пароль профиля «{name}» обновлён', {name: tMessage(user.name)}));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async deleteUser(user) {
        const confirmed = await this.$root.stdDialog.confirm(
            t('Удалить профиль «{name}» вместе со всеми его списками?', {name: tMessage(user.name)}),
            t('Удаление профиля'),
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteUserProfile(user.id);
            await this.api.updateConfig();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
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
