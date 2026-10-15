<template>
    <div v-if="!canDeliver" class="card-stack">
        <section class="card">
            <div class="card-hint">
                {{ $t('meDelivery.needsPassword') }}
            </div>
        </section>
    </div>
    <form v-else class="card-stack" @submit.prevent="save">
        <section class="card">
            <h2 class="card-title">
                {{ $t('meDelivery.sendToEmail') }}
            </h2>
            <div class="card-hint">
                {{ $t('meDelivery.booksCanBeSent') }}
            </div>
            <div class="form-grid">
                <q-input v-model="emailTo" outlined dense clearable type="email" :label="$t('profiles.emailTo')" />
            </div>
        </section>

        <section class="card">
            <h2 class="card-title">
                {{ $t('meDelivery.sendToTelegram') }}
            </h2>
            <div class="card-hint">
                {{ $t('meDelivery.sendTheLibraryBot') }}
            </div>
            <div class="form-grid">
                <q-input v-model="telegramChatId" outlined dense clearable :label="$t('profiles.personalTelegramChatId')" />
            </div>
        </section>

        <div class="card-actions">
            <q-btn type="submit" color="primary" unelevated no-caps :loading="saving">
                {{ $t('common.save') }}
            </q-btn>
        </div>
    </form>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {currentProfile} from '../../share/session';

class MeDelivery {
    emailTo = '';
    telegramChatId = '';
    saving = false;

    //профиль без пароля открыт любому: слать книги на свои адреса может только профиль с паролем (или SSO)
    get canDeliver() {
        const config = this.$store.state.config;
        return !!(currentProfile(config).hasPassword || config.profileBoundId);
    }

    created() {
        this.api = this.$root.api;
        const profile = currentProfile(this.$store.state.config);
        this.emailTo = profile.emailTo || '';
        this.telegramChatId = profile.telegramChatId || '';
    }

    async save() {
        this.saving = true;
        try {
            const profile = currentProfile(this.$store.state.config);
            await this.api.updateUserProfile(profile.id, {
                emailTo: String(this.emailTo || '').trim(),
                telegramChatId: String(this.telegramChatId || '').trim(),
            });
            await this.api.updateConfig();
            this.$root.notify.success(t('settings.mail.saved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.saving = false;
        }
    }
}

export default vueComponent(MeDelivery);
//-----------------------------------------------------------------------------
</script>
