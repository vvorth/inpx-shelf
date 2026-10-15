<template>
    <section class="card">
        <h2 class="card-title">{{ $t('settings.backup.title') }}</h2>
        <div class="admin-backup-note">
            <div>{{ $t('settings.backup.fullBackupInfo') }}</div>
            <div>{{ $t('settings.backup.settingsBackupInfo') }}</div>
            <div>{{ $t('settings.backup.restoreNote') }}</div>
        </div>
        <div class="admin-backup-actions">
            <q-btn color="primary" dense no-caps icon="la la-download" :loading="backupLoading" @click="createBackup">
                {{ $t('settings.backup.backup') }}
            </q-btn>
            <q-btn outline color="primary" dense no-caps icon="la la-file-import" :loading="backupImportLoading" @click="openBackupImport">
                {{ $t('settings.backup.backupImport') }}
            </q-btn>
            <q-btn outline color="primary" dense no-caps icon="la la-file-export" :loading="settingsExportLoading" @click="exportSettings">
                {{ $t('settings.backup.settings') }}
            </q-btn>
            <q-btn outline color="primary" dense no-caps icon="la la-file-import" :loading="settingsImportLoading" @click="openSettingsImport">
                {{ $t('settings.backup.settingsImport') }}
            </q-btn>
            <input
                ref="settingsImportInput"
                type="file"
                accept="application/json,.json"
                style="display: none"
                @change="onSettingsImportSelected"
            />
            <input
                ref="backupImportInput"
                type="file"
                accept="application/zip,.zip"
                style="display: none"
                @change="onBackupImportSelected"
            />
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import {t} from '../../share/i18n';
import {downloadJson} from '../../share/utils';

const componentOptions = {
    emits: ['restored'],
};

class AdminBackups {
    _options = componentOptions;
    backupLoading = false;
    backupImportLoading = false;
    settingsExportLoading = false;
    settingsImportLoading = false;

    created() {
        this.api = this.$root.api;
    }

    async exportSettings() {
        this.settingsExportLoading = true;
        try {
            const result = await this.api.exportAdminSettings();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadJson(result, `inpx-shelf-settings-${stamp}.json`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.settingsExportLoading = false;
        }
    }

    openSettingsImport() {
        const input = this.$refs.settingsImportInput;
        if (!input)
            return;

        input.value = '';
        input.click();
    }

    openBackupImport() {
        const input = this.$refs.backupImportInput;
        if (!input)
            return;

        input.value = '';
        input.click();
    }

    async onSettingsImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;
        if (!await this.$root.stdDialog.confirm(t('settings.backup.settingsImportConfirm'), t('settings.backup.settingsImport'))) {
            input.value = '';
            return;
        }

        this.settingsImportLoading = true;
        try {
            await this.api.importAdminSettings(file);
            await this.api.updateConfig();
            this.$emit('restored');
            this.$root.notify.success(t('settings.settingsRestored'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.settingsImportLoading = false;
            if (input)
                input.value = '';
        }
    }

    async onBackupImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            t('settings.backup.restoreConfirm'),
            t('settings.backup.backupImport'),
        );
        if (!confirmed) {
            input.value = '';
            return;
        }

        this.backupImportLoading = true;
        try {
            await this.api.importAdminBackup(file);
            await this.api.updateConfig();
            this.$emit('restored');
            this.$root.notify.success(t('settings.backup.restored'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.backupImportLoading = false;
            if (input)
                input.value = '';
        }
    }

    async createBackup() {
        this.backupLoading = true;
        try {
            const result = await this.api.createAdminBackup();
            if (result && result.link) {
                window.location.href = result.link;
                this.$root.notify.success(t('settings.backup.ready'));
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.backupLoading = false;
        }
    }
}

export default vueComponent(AdminBackups);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.admin-backup-note {
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    color: var(--app-muted);
    font-size: 12px;
    line-height: 1.4;
}

.admin-backup-note > div + div {
    margin-top: 6px;
}

.admin-backup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
}
</style>
