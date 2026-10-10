<template>
    <div class="login-page">
        <form class="login-card" @submit.prevent="submit">
            <div class="login-brand">
                <img src="../Search/assets/logo.png" alt="" />
                <div>
                    <div class="login-title">
                        {{ collectionName || config.name || 'inpx-web' }}
                    </div>
                    <div class="login-subtitle">
                        {{ $t('Вход в профиль') }}
                    </div>
                </div>
            </div>

            <q-input
                ref="loginInput"
                v-model="login"
                outlined
                :label="$t('Логин')"
                autocomplete="username"
                :disable="busy"
            />
            <q-input
                v-model="password"
                outlined
                :type="passwordVisible ? 'text' : 'password'"
                :label="$t('Пароль')"
                autocomplete="current-password"
                :disable="busy"
            >
                <template #append>
                    <q-icon
                        :name="passwordVisible ? 'la la-eye-slash' : 'la la-eye'"
                        class="cursor-pointer"
                        @click="passwordVisible = !passwordVisible"
                    />
                </template>
            </q-input>

            <div v-if="error" class="login-error" role="alert">
                {{ error }}
            </div>

            <q-btn type="submit" color="primary" unelevated no-caps :loading="busy" :disable="!canSubmit" class="login-submit">
                {{ $t('Войти') }}
            </q-btn>

            <template v-if="openProfiles.length">
                <div class="login-divider">
                    <span>{{ $t('Профили без пароля') }}</span>
                </div>
                <div class="login-open-profiles">
                    <button
                        v-for="profile in openProfiles"
                        :key="profile.id"
                        type="button"
                        class="login-open-profile"
                        :disabled="busy"
                        @click="selectOpenProfile(profile)"
                    >
                        <span class="login-avatar">{{ avatar(profile) }}</span>
                        {{ $tm(profile.name) }}
                    </button>
                </div>
            </template>

            <q-btn v-if="guestAllowed" flat no-caps color="primary" :disable="busy" class="login-guest" @click="continueAsGuest">
                {{ $t('Продолжить без входа') }}
            </q-btn>
            <div v-else class="login-hint">
                {{ $t('Библиотека открыта только для зарегистрированных читателей. Учётную запись создаёт администратор.') }}
            </div>
        </form>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, tMessage} from '../../share/i18n';
import {initials} from '../../share/session';

class LoginPage {
    login = '';
    password = '';
    passwordVisible = false;
    busy = false;
    error = '';
    succeeded = false;

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.reset();
    }

    activated() {
        this.reset();
    }

    deactivated() {
        this.leave();
    }

    beforeUnmount() {
        this.leave();
    }

    reset() {
        this.login = String(this.$route.query.login || '');
        this.password = '';
        this.passwordVisible = false;
        this.error = '';
        this.busy = false;
        this.succeeded = false;
        this.$root.setAppTitle(t('Вход в профиль'));
        this.$nextTick(() => {
            if (this.$refs.loginInput)
                this.$refs.loginInput.focus();
        });
    }

    leave() {
        if (!this.succeeded)
            this.api.cancelLoginPage();
    }

    get config() {
        return this.$store.state.config;
    }

    get collectionName() {
        const info = (this.config.dbConfig && this.config.dbConfig.inpxInfo) || {};
        return String(info.collection || '').split('\n')[0].trim();
    }

    get guestAllowed() {
        return !this.config.profileLoginRequired;
    }

    get openProfiles() {
        if (this.config.profileBoundId)
            return [];
        return (this.config.userProfiles || []).filter(profile => profile && !profile.requiresLogin && !profile.anonymousProfile);
    }

    get canSubmit() {
        return !!(String(this.login || '').trim() && this.password);
    }

    get redirectPath() {
        const redirect = String(this.$route.query.redirect || '');
        return (redirect.startsWith('/') && !redirect.startsWith('/login') ? redirect : '/');
    }

    avatar(profile) {
        return initials(tMessage(profile.name));
    }

    finish() {
        this.succeeded = true;
        this.$router.replace(this.redirectPath);
    }

    async submit() {
        if (!this.canSubmit || this.busy)
            return;

        this.busy = true;
        this.error = '';
        try {
            const result = await this.api.loginUserProfile(String(this.login).trim(), this.password);
            await this.api.completeProfileLogin(result);
            this.finish();
        } catch (e) {
            this.error = tMessage(e.message);
            this.password = '';
        } finally {
            this.busy = false;
        }
    }

    async selectOpenProfile(profile) {
        this.busy = true;
        try {
            await this.api.selectOpenProfile(profile.id);
            this.finish();
        } catch (e) {
            this.error = tMessage(e.message);
        } finally {
            this.busy = false;
        }
    }

    async continueAsGuest() {
        const guest = (this.config.userProfiles || []).find(profile => profile && profile.anonymousProfile);
        this.busy = true;
        try {
            await this.api.selectOpenProfile(guest ? guest.id : '');
            this.finish();
        } catch (e) {
            this.error = tMessage(e.message);
        } finally {
            this.busy = false;
        }
    }
}

export default vueComponent(LoginPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 24px 16px;
    overflow-y: auto;
    background: var(--app-bg);
}

.login-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
    max-width: 380px;
    padding: 28px;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: var(--app-surface);
    box-shadow: var(--app-shadow);
}

.login-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
}

.login-brand img {
    width: 40px;
    height: 40px;
}

.login-title {
    font-family: var(--app-font-serif);
    font-size: 19px;
    font-weight: 600;
    line-height: 1.2;
}

.login-subtitle {
    color: var(--app-muted);
}

.login-error {
    padding: 8px 12px;
    border-radius: var(--app-radius);
    background: rgba(163, 58, 42, 0.1);
    color: var(--app-danger);
}

.login-submit {
    min-height: 42px;
}

.login-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
    color: var(--app-muted);
    font-size: 12px;
}

.login-divider::before,
.login-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--app-border);
}

.login-open-profiles {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.login-open-profile {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.login-open-profile:hover {
    border-color: var(--app-primary);
}

.login-avatar {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--app-accent-soft);
    color: var(--app-primary);
    font-size: 12px;
    font-weight: 600;
}

.login-guest {
    align-self: center;
}

.login-hint {
    color: var(--app-muted);
    font-size: 13px;
    text-align: center;
}
</style>
