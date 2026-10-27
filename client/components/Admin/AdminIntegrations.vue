<template>
    <!-- card-stack: те же отступы между карточками, что в .section-content -->
    <div class="card-stack">
        <section class="card">
            <h2 class="card-title">{{ $t('settings.mail.title') }}</h2>
            <div class="card-hint">{{ $t('admin.theTelegramBotAnd') }}</div>
            <div v-if="integrationEnvVars" class="card-hint">{{ $t('settings.fromEnv', {vars: integrationEnvVars}) }}</div>
            <div class="admin-mail-section">
                <div class="admin-mail-section-head">
                    <q-checkbox v-model="integrations.telegramShareEnabled" size="34px" :disable="locked('telegramShareEnabled')" :label="$t('settings.mail.telegramEnabled')" />
                    <q-btn flat dense no-caps color="primary" icon="la la-plug" :loading="telegramTestLoading" @click="testTelegram">
                        {{ $t('settings.mail.test') }}
                    </q-btn>
                </div>
                <div class="admin-mail-grid">
                    <q-input v-model="integrations.telegramBotToken" outlined dense clearable :disable="locked('telegramBotToken')" :type="telegramTokenVisible ? 'text' : 'password'" label="Telegram bot token">
                        <template #append>
                            <q-icon :name="telegramTokenVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="telegramTokenVisible = !telegramTokenVisible" />
                        </template>
                    </q-input>
                    <q-input class="admin-mail-wide" v-model="integrations.telegramCaptionTemplate" outlined dense clearable :disable="locked('telegramCaptionTemplate')" :label="$t('settings.mail.telegramCaption')" />
                </div>
            </div>

            <div class="admin-mail-section">
                <div class="admin-mail-section-head">
                    <q-checkbox v-model="integrations.emailShareEnabled" size="34px" :disable="locked('emailShareEnabled')" :label="$t('settings.mail.smtpEnabled')" />
                    <q-btn flat dense no-caps color="primary" icon="la la-plug" :loading="smtpTestLoading" @click="testSmtp">
                        {{ $t('settings.mail.test') }}
                    </q-btn>
                </div>
                <div class="admin-mail-grid">
                    <q-input v-model="integrations.smtpHost" outlined dense clearable :disable="locked('smtpHost')" label="SMTP host" />
                    <q-input v-model.number="integrations.smtpPort" outlined dense type="number" :disable="locked('smtpPort')" label="SMTP port" />
                    <q-input v-model="integrations.smtpUser" outlined dense clearable :disable="locked('smtpUser')" label="SMTP user" />
                    <q-input v-model="integrations.smtpPass" outlined dense clearable :disable="locked('smtpPass')" :type="smtpPassVisible ? 'text' : 'password'" label="SMTP password">
                        <template #append>
                            <q-icon :name="smtpPassVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="smtpPassVisible = !smtpPassVisible" />
                        </template>
                    </q-input>
                    <q-input v-model="integrations.emailFrom" outlined dense clearable :disable="locked('emailFrom')" label="Email from" />
                    <q-input v-model="integrations.emailTo" outlined dense clearable :disable="locked('emailTo')" :label="$t('settings.mail.emailTo')" />
                    <q-checkbox v-model="integrations.smtpSecure" size="34px" :disable="locked('smtpSecure')" label="SMTP secure / SSL" />
                </div>
            </div>

            <div class="admin-mail-actions">
                <q-btn color="primary" dense no-caps icon="la la-save" :loading="integrationSaveLoading" @click="saveIntegrations">
                    {{ $t('settings.mail.save') }}
                </q-btn>
            </div>
        </section>

        <section class="card">
            <h2 class="card-title">{{ $t('settings.opds.title') }}</h2>
            <div class="card-hint">{{ $t('settings.opds.subtitle') }}</div>
            <div class="admin-mail-grid">
                <q-checkbox v-model="opdsSettings.enabled" size="34px" :label="$t('settings.opds.enabled')" />
                <q-input v-model="opdsSettings.root" outlined dense clearable :label="$t('settings.opds.root')" />
                <q-select v-model="opdsSettings.lang" :options="opdsLangOptions" outlined dense emit-value map-options :disable="opdsLangFromEnv" :label="$t('settings.opds.lang')" />
                <q-input v-model="opdsSettings.user" outlined dense clearable :label="$t('settings.opds.user')" />
                <q-input v-model="opdsSettings.password" outlined dense clearable :type="opdsPasswordVisible ? 'text' : 'password'" :label="$t('settings.opds.password')">
                    <template #append>
                        <q-icon :name="opdsPasswordVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="opdsPasswordVisible = !opdsPasswordVisible" />
                    </template>
                </q-input>
                <q-checkbox v-model="opdsSettings.guestAccess" size="34px" :disable="opdsSettings.guestAccessFromEnv" :label="$t('settings.opds.guestAccess')" />
            </div>
            <div class="card-hint">
                {{ $t('settings.opds.guestAccessHint') }}
                <template v-if="opdsSettings.guestAccessFromEnv">
                    {{ $t('settings.opds.guestAccessFromEnv') }}
                </template>
                <template v-if="opdsLangFromEnv">
                    {{ $t('settings.fromEnv', {vars: opdsLangFromEnv}) }}
                </template>
            </div>
            <div class="admin-mail-actions">
                <q-btn color="primary" dense no-caps icon="la la-save" :loading="opdsSaveLoading" @click="saveOpdsSettings">
                    {{ $t('settings.opds.save') }}
                </q-btn>
            </div>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import {t} from '../../share/i18n';
import {isAdmin} from '../../share/session';

//Поля, заданные окружением, не отправляются: сервер всё равно их не сохранит
function withoutKeys(obj, keys) {
    return Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
}

const componentOptions = {
    watch: {
        settings() {
            this.loadSettings();
        },
    },
};

class AdminIntegrations {
    _options = componentOptions;
    integrationSaveLoading = false;
    smtpTestLoading = false;
    telegramTestLoading = false;
    opdsSaveLoading = false;
    smtpPassVisible = false;
    telegramTokenVisible = false;
    opdsPasswordVisible = false;
    integrations = this.makeDefaultIntegrations();
    opdsSettings = this.makeDefaultOpdsSettings();

    created() {
        this.api = this.$root.api;
        this.loadSettings();
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get canEditExternalDiscovery() {
        return isAdmin(this.config);
    }

    //fromEnv приходит с сервера: {ключ: переменная окружения}
    get integrationEnvVars() {
        return Array.from(new Set(Object.values(this.integrations.fromEnv))).join(', ');
    }

    get opdsLangFromEnv() {
        return this.opdsSettings.fromEnv.lang;
    }

    locked(key) {
        return key in this.integrations.fromEnv;
    }

    loadSettings() {
        this.loadIntegrations();
        this.loadOpdsSettings();
    }

    get opdsLangOptions() {
        return [
            {label: t('settings.automaticReaderAppLanguage'), value: ''},
            {label: t('langNames.ru'), value: 'ru'},
            {label: t('langNames.en'), value: 'en'},
        ];
    }

    makeDefaultIntegrations() {
        return {
            telegramShareEnabled: false,
            telegramBotToken: '',
            telegramChatId: '',
            telegramCaptionTemplate: '${AUTHOR} - ${TITLE}',
            emailShareEnabled: false,
            smtpHost: '',
            smtpPort: 587,
            smtpSecure: false,
            smtpUser: '',
            smtpPass: '',
            emailFrom: '',
            emailTo: '',
            fromEnv: {},
        };
    }

    makeDefaultOpdsSettings() {
        return {
            enabled: true,
            root: '/opds',
            user: '',
            password: '',
            lang: '',
            guestAccess: false,
            guestAccessFromEnv: false,
            fromEnv: {},
        };
    }

    loadIntegrations() {
        const source = this.config.adminIntegrations || {};
        this.integrations = Object.assign(this.makeDefaultIntegrations(), source, {
            smtpPort: parseInt(source.smtpPort, 10) || 587,
            telegramBotToken: source.telegramBotToken || (source.telegramBotTokenSet ? '__KEEP__' : ''),
            smtpPass: source.smtpPass || (source.smtpPassSet ? '__KEEP__' : ''),
        });
    }

    loadOpdsSettings() {
        const source = this.config.adminOpds || {};
        this.opdsSettings = Object.assign(this.makeDefaultOpdsSettings(), source, {
            password: source.password || (source.passwordSet ? '__KEEP__' : ''),
        });
    }

    async saveIntegrations(options = {}) {
        if (!this.canEditExternalDiscovery)
            return false;

        this.integrationSaveLoading = true;
        try {
            const result = await this.api.updateAdminIntegrations(withoutKeys(this.integrations, ['fromEnv', ...Object.keys(this.integrations.fromEnv)]));
            if (result && result.integrations)
                this.integrations = Object.assign(this.makeDefaultIntegrations(), result.integrations);
            await this.api.updateConfig();
            if (!options.quiet)
                this.$root.notify.success(t('settings.mail.saved'));
            return true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
            return false;
        } finally {
            this.integrationSaveLoading = false;
        }
    }

    async testSmtp() {
        const saved = await this.saveIntegrations({quiet: true});
        if (!saved)
            return;

        this.smtpTestLoading = true;
        try {
            const result = await this.api.testAdminIntegration('smtp');
            this.$root.notify.success((result && result.message) || 'SMTP ok');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.smtpTestLoading = false;
        }
    }

    async testTelegram() {
        const saved = await this.saveIntegrations({quiet: true});
        if (!saved)
            return;

        this.telegramTestLoading = true;
        try {
            const result = await this.api.testAdminIntegration('telegram');
            this.$root.notify.success((result && result.message) || 'Telegram ok');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.telegramTestLoading = false;
        }
    }

    async saveOpdsSettings() {
        if (!this.canEditExternalDiscovery)
            return false;

        this.opdsSaveLoading = true;
        try {
            const result = await this.api.updateAdminOpds(withoutKeys(this.opdsSettings, this.opdsLangFromEnv ? ['fromEnv', 'lang'] : ['fromEnv']));
            if (result && result.opds)
                this.opdsSettings = Object.assign(this.makeDefaultOpdsSettings(), result.opds);
            await this.api.updateConfig();
            this.$root.notify.success(t('settings.opds.saved'));
            return true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
            return false;
        } finally {
            this.opdsSaveLoading = false;
        }
    }
}

export default vueComponent(AdminIntegrations);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.admin-mail-section {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--app-border);
}

.admin-mail-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}

.admin-mail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 8px;
}

.password-visibility-toggle {
    cursor: pointer;
}

.admin-mail-wide,
.admin-mail-actions {
    grid-column: span 2;
}

.admin-mail-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
}

@media (max-width: 720px) {
    .admin-mail-grid {
        grid-template-columns: 1fr;
    }

    .admin-mail-wide,
    .admin-mail-actions {
        grid-column: span 1;
    }

    .admin-mail-actions {
        justify-content: flex-start;
    }
}
</style>
