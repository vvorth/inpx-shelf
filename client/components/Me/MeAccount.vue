<template>
    <div class="card-stack">
        <form class="card" @submit.prevent="saveProfile">
            <h2 class="card-title">
                {{ $t('common.profile') }}
            </h2>
            <div class="form-grid">
                <q-input v-model="name" outlined dense :label="$t('profiles.name')" />
                <q-input v-model="login" outlined dense :disable="sso" :label="$t('common.login')" :hint="sso ? $t('meAccount.yourLoginComesFrom') : ''" />
            </div>
            <div class="card-actions">
                <q-btn type="submit" color="primary" unelevated no-caps :loading="profileSaving">
                    {{ $t('common.save') }}
                </q-btn>
            </div>
        </form>

        <form v-if="!sso" class="card" @submit.prevent="changePassword">
            <h2 class="card-title">
                {{ $t('common.password') }}
            </h2>
            <div class="form-grid">
                <q-input v-model="newPassword" outlined dense type="password" autocomplete="new-password" :label="$t('profiles.newPassword')" />
                <q-input
                    v-model="repeatPassword"
                    outlined
                    dense
                    type="password"
                    autocomplete="new-password"
                    :label="$t('meAccount.repeatPassword')"
                    :error="!!repeatPassword && repeatPassword !== newPassword"
                    :error-message="$t('meAccount.passwordsDontMatch')"
                />
            </div>
            <div class="card-hint">
                {{ $t('meAccount.changingThePasswordSigns') }}
            </div>
            <div class="card-actions">
                <q-btn type="submit" color="primary" unelevated no-caps :loading="passwordSaving" :disable="!canChangePassword">
                    {{ $t('meAccount.changePassword') }}
                </q-btn>
            </div>
        </form>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {currentProfile} from '../../share/session';

const componentOptions = {
    watch: {
        '$store.state.config'() {
            this.syncFromConfig();
        },
    },
};

class MeAccount {
    _options = componentOptions;

    name = '';
    login = '';
    newPassword = '';
    repeatPassword = '';
    profileSaving = false;
    passwordSaving = false;

    created() {
        this.api = this.$root.api;
        this.syncFromConfig();
    }

    get config() {
        return this.$store.state.config;
    }

    get profile() {
        return currentProfile(this.config);
    }

    get sso() {
        return !!this.config.profileBoundId;
    }

    get canChangePassword() {
        return !!(this.newPassword && this.newPassword === this.repeatPassword);
    }

    syncFromConfig() {
        this.name = this.profile.name || '';
        this.login = this.profile.login || '';
    }

    async saveProfile() {
        const patch = {name: this.name};
        const loginChanged = !this.sso && String(this.login || '').trim() !== String(this.profile.login || '');
        if (loginChanged) {
            patch.login = String(this.login || '').trim();
            //смена логина закрывает сессии профиля: нужен пароль, чтобы сразу войти снова
            if (this.profile.hasPassword) {
                const prompt = await this.$root.stdDialog.password(t('meAccount.enterYourPasswordTo'), t('meAccount.changeLogin'), {
                    inputValidator: (value) => (value ? true : t('common.passwordRequired')),
                });
                if (!prompt || prompt === false)
                    return;
                patch.password = String(prompt.value || '');
            }
        }

        this.profileSaving = true;
        try {
            await this.api.updateUserProfile(this.profile.id, patch);
            if (patch.password) {
                const result = await this.api.loginUserProfile(patch.login, patch.password);
                await this.api.completeProfileLogin(result);
            } else {
                await this.api.updateConfig();
            }
            this.$root.notify.success(t('profiles.profileSaved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.profileSaving = false;
        }
    }

    async changePassword() {
        if (!this.canChangePassword)
            return;

        this.passwordSaving = true;
        const login = this.profile.login || this.login;
        const password = this.newPassword;
        try {
            await this.api.updateUserProfile(this.profile.id, {password});
            //смена пароля закрывает все сессии профиля - сразу входим заново с новым паролем
            const result = await this.api.loginUserProfile(login, password);
            await this.api.completeProfileLogin(result);
            this.newPassword = '';
            this.repeatPassword = '';
            this.$root.notify.success(t('meAccount.passwordChanged'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.passwordSaving = false;
        }
    }
}

export default vueComponent(MeAccount);
//-----------------------------------------------------------------------------
</script>
