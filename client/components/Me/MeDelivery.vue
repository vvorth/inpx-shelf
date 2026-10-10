<template>
    <form class="card-stack" @submit.prevent="save">
        <section class="card">
            <h2 class="card-title">
                {{ $t('Отправка на email') }}
            </h2>
            <div class="card-hint">
                {{ $t('Книги можно отправлять на этот адрес из карточки книги, например на адрес Send to Kindle.') }}
            </div>
            <div class="form-grid">
                <q-input v-model="emailTo" outlined dense clearable type="email" :label="$t('Email для отправки')" />
            </div>
        </section>

        <section class="card">
            <h2 class="card-title">
                {{ $t('Отправка в Telegram') }}
            </h2>
            <div class="card-hint">
                {{ $t('Напишите боту библиотеки любое сообщение и вставьте сюда ваш chat id.') }}
            </div>
            <div class="form-grid">
                <q-input v-model="telegramChatId" outlined dense clearable :label="$t('Личный Telegram chat id')" />
            </div>
        </section>

        <div class="card-actions">
            <q-btn type="submit" color="primary" unelevated no-caps :loading="saving">
                {{ $t('Сохранить') }}
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
            this.$root.notify.success(t('Настройки отправки сохранены'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.saving = false;
        }
    }
}

export default vueComponent(MeDelivery);
//-----------------------------------------------------------------------------
</script>
