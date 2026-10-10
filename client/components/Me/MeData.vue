<template>
    <div class="card-stack">
        <section class="card">
            <h2 class="card-title">
                {{ $t('Бэкап профиля') }}
            </h2>
            <div class="card-hint">
                {{ $t('Сохраняет личные списки, прогресс чтения, закладки, скрытые книги и настройки читалки. Пароль профиля не экспортируется.') }}
            </div>
            <div class="card-actions">
                <q-btn outline color="primary" no-caps icon="la la-file-export" :loading="busy" @click="exportBackup">
                    {{ $t('Скачать JSON') }}
                </q-btn>
                <q-btn outline color="primary" no-caps icon="la la-file-import" :loading="busy" @click="openImport">
                    {{ $t('Восстановить JSON') }}
                </q-btn>
                <input ref="importInput" type="file" accept="application/json,.json" style="display: none" @change="onImportSelected" />
            </div>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {currentProfile} from '../../share/session';

class MeData {
    busy = false;

    created() {
        this.api = this.$root.api;
    }

    downloadJson(data, fileName) {
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'});
        const href = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => window.URL.revokeObjectURL(href), 1000);
    }

    async exportBackup() {
        this.busy = true;
        try {
            const data = await this.api.exportReadingLists();
            const profile = currentProfile(this.$store.state.config);
            const stamp = new Date().toISOString().substring(0, 10);
            const login = String(profile.login || profile.id || 'profile')
                .replace(/[^a-z0-9._-]+/gi, '-')
                .replace(/^-+|-+$/g, '') || 'profile';
            this.downloadJson(data, `inpx-web-profile-${login}-${stamp}.json`);
            this.$root.notify.success(t('Бэкап профиля скачан'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.busy = false;
        }
    }

    openImport() {
        const input = this.$refs.importInput;
        if (!input)
            return;
        input.value = '';
        input.click();
    }

    async onImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            t('Восстановить JSON-бэкап в текущий профиль? Списки, прогресс, закладки и личные настройки будут добавлены или обновлены.'),
            t('Бэкап профиля'),
        );
        if (!confirmed) {
            input.value = '';
            return;
        }

        this.busy = true;
        try {
            await this.api.importReadingLists(JSON.parse(await file.text()));
            await this.api.updateConfig();
            this.$root.notify.success(t('Бэкап профиля восстановлен'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.busy = false;
            input.value = '';
        }
    }
}

export default vueComponent(MeData);
//-----------------------------------------------------------------------------
</script>
