<template>
    <div class="card-stack">
        <section class="card">
            <div class="card-head">
                <h2 class="card-title">
                    {{ $t('OPDS-каталог') }}
                </h2>
                <q-toggle
                    :model-value="opdsEnabled"
                    :disable="profile.isAdmin || opdsSaving"
                    :label="$t('Включён')"
                    left-label
                    @update:model-value="saveOpds({opdsEnabled: $event})"
                />
            </div>
            <div v-if="profile.isAdmin" class="card-hint">
                {{ $t('Профиль администратора не публикуется в OPDS.') }}
            </div>
            <template v-else>
                <div class="card-hint">
                    {{ $t('Добавьте этот адрес в KOReader, Moon+ Reader, FBReader или другую OPDS-читалку.') }}
                </div>
                <div class="copy-row">
                    <code class="copy-value">{{ opdsUrl }}</code>
                    <q-btn flat dense no-caps color="primary" icon="la la-copy" @click="copy(opdsUrl)">
                        {{ $t('Скопировать') }}
                    </q-btn>
                </div>
                <q-toggle
                    :model-value="opdsAuthEnabled"
                    :disable="!opdsEnabled || !profile.login || !profile.hasPassword || opdsSaving"
                    :label="$t('Требовать мой логин и пароль')"
                    @update:model-value="saveOpds({opdsAuthEnabled: $event})"
                />
                <div class="card-hint">
                    {{ $t('Списки, которые видны в OPDS, отмечаются на странице') }}
                    <router-link to="/lists">
                        {{ $t('Списки') }}
                    </router-link>.
                </div>
            </template>
        </section>

        <section v-if="config.koboEnabled" class="card">
            <div class="card-head">
                <h2 class="card-title">
                    Kobo
                </h2>
            </div>
            <div class="card-hint">
                {{ $t('Kobo синхронизирует книги из выбранных списков чтения: книга в списке — книга на устройстве. FB2 конвертируется в KEPUB. Каждый список появляется на Kobo как коллекция, а книга, дочитанная на Kobo, отмечается прочитанной.') }}
            </div>

            <div v-if="koboEndpoint" class="notice">
                <b>{{ $t('Адрес для Kobo') }}</b>
                <div class="card-hint">
                    {{ $t('Подключите Kobo к компьютеру, откройте .kobo/Kobo/Kobo eReader.conf и замените строку api_endpoint в разделе [OneStoreServices]. Адрес показывается только сейчас; если потеряете его, создайте новую ссылку.') }}
                </div>
                <div class="copy-row">
                    <code class="copy-value">api_endpoint={{ koboEndpoint }}</code>
                    <q-btn flat dense no-caps color="primary" icon="la la-copy" @click="copy(`api_endpoint=${koboEndpoint}`)">
                        {{ $t('Скопировать') }}
                    </q-btn>
                    <q-btn flat dense no-caps @click="koboEndpoint = ''">
                        {{ $t('Скрыть') }}
                    </q-btn>
                </div>
            </div>

            <div v-if="koboLoading" class="card-hint">
                …
            </div>
            <div v-else-if="!koboDevices.length" class="card-hint">
                {{ $t('Устройств пока нет.') }}
            </div>

            <div v-for="device in koboDevices" :key="device.id" class="device">
                <div class="device-head">
                    <q-input v-model="device.draft.name" outlined dense class="device-name" :label="$t('Название устройства')" />
                    <div class="card-hint">
                        {{ $t('Книг на устройстве') }}: {{ device.bookCount }} ·
                        {{ $t('Последняя синхронизация') }}: {{ device.lastSyncAt ? formatDateTime(device.lastSyncAt) : $t('ещё не было') }}
                        <template v-if="device.refreshPending">
                            · {{ $t('ожидают обновления') }}: {{ device.refreshPending }}
                        </template>
                    </div>
                </div>
                <div class="device-sub">
                    {{ $t('Синхронизируемые списки') }}
                </div>
                <div v-if="!readingLists.length" class="card-hint">
                    {{ $t('Для этого профиля пока нет списков чтения.') }}
                </div>
                <div class="device-lists">
                    <q-checkbox v-for="list in readingLists" :key="list.id" v-model="device.draft.listIds" :val="list.id" dense :label="list.name" />
                </div>
                <q-checkbox v-model="device.draft.keepRemovedBooks" dense :label="$t('Оставлять книги на устройстве после удаления из списка')" />
                <div class="card-hint">
                    {{ $t('Если выключено, книга, убранная из всех выбранных списков, удаляется с Kobo при следующей синхронизации.') }}
                </div>
                <q-checkbox v-model="device.draft.resendDeletedBooks" dense :label="$t('Возвращать книги, удалённые на устройстве')" />
                <div class="card-hint">
                    {{ $t('Если включено, книга из выбранных списков, удалённая на Kobo, загружается снова при следующей синхронизации. Чтобы убрать книгу с устройства, уберите её из списка.') }}
                </div>
                <q-checkbox v-model="device.draft.storeProxy" dense :label="$t('Подключать магазин Kobo')" />
                <div class="card-hint">
                    {{ $t('Для купленных в магазине Kobo книг: вход, покупки и их прогресс передаются на серверы Kobo. Если выключено, устройство общается только с inpx-web.') }}
                </div>
                <div class="card-actions">
                    <q-btn color="primary" unelevated dense no-caps icon="la la-save" @click="saveKoboDevice(device)">
                        {{ $t('Сохранить') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="primary" icon="la la-sync" @click="resetKoboDevice(device)">
                        {{ $t('Синхронизировать заново') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="primary" icon="la la-redo-alt" @click="refreshKoboDevice(device)">
                        {{ $t('Обновить книги на устройстве') }}
                    </q-btn>
                    <q-btn flat dense no-caps icon="la la-key" @click="regenerateKoboDevice(device)">
                        {{ $t('Новая ссылка') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="negative" icon="la la-trash" @click="deleteKoboDevice(device)">
                        {{ $t('Удалить') }}
                    </q-btn>
                </div>
            </div>

            <form class="device-add" @submit.prevent="createKoboDevice">
                <q-input v-model="newKoboDeviceName" outlined dense class="device-name" :label="$t('Название устройства')" />
                <q-btn type="submit" color="primary" unelevated dense no-caps icon="la la-plus" :disable="!String(newKoboDeviceName || '').trim()">
                    {{ $t('Добавить устройство') }}
                </q-btn>
            </form>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {copyTextToClipboard} from '../../share/utils';
import {currentProfile} from '../../share/session';

class MeDevices {
    opdsSaving = false;
    koboDevices = [];
    koboLoading = false;
    koboEndpoint = '';
    newKoboDeviceName = 'Kobo';
    readingLists = [];

    created() {
        this.api = this.$root.api;
        this.load();
    }

    get config() {
        return this.$store.state.config;
    }

    get profile() {
        return currentProfile(this.config);
    }

    get opdsEnabled() {
        return this.profile.opdsEnabled !== false;
    }

    get opdsAuthEnabled() {
        return this.profile.opdsAuthEnabled === true;
    }

    get opdsUrl() {
        const root = this.config.opdsRoot || '/opds';
        const userId = this.profile.login || this.profile.id || '';
        return `${window.location.origin}${root}?user=${encodeURIComponent(userId)}`;
    }

    async load() {
        if (!this.config.koboEnabled)
            return;

        try {
            const result = await this.api.getReadingLists('');
            this.readingLists = (result && Array.isArray(result.lists) ? result.lists : []);
        } catch (e) {
            this.readingLists = [];
        }
        await this.loadKoboDevices();
    }

    async copy(text) {
        if (await copyTextToClipboard(text))
            this.$root.notify.success(t('Скопировано'));
    }

    async saveOpds(patch) {
        this.opdsSaving = true;
        try {
            await this.api.updateUserProfile(this.profile.id, patch);
            await this.api.updateConfig();
            this.$root.notify.success(t('Настройки OPDS сохранены'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.opdsSaving = false;
        }
    }

    formatDateTime(value) {
        const date = new Date(value);
        return (Number.isNaN(date.getTime()) ? '' : date.toLocaleString());
    }

    setKoboDevices(devices = []) {
        this.koboDevices = devices.map(device => Object.assign({}, device, {
            draft: {
                name: device.name,
                listIds: (device.listIds || []).slice(),
                keepRemovedBooks: device.keepRemovedBooks === true,
                resendDeletedBooks: device.resendDeletedBooks === true,
                storeProxy: device.storeProxy === true,
            },
        }));
    }

    async loadKoboDevices() {
        this.koboLoading = true;
        try {
            const result = await this.api.getKoboDevices();
            this.setKoboDevices(result && Array.isArray(result.devices) ? result.devices : []);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.koboLoading = false;
        }
    }

    async createKoboDevice() {
        try {
            const result = await this.api.createKoboDevice({name: this.newKoboDeviceName, listIds: [], keepRemovedBooks: false, resendDeletedBooks: false, storeProxy: false});
            this.koboEndpoint = result.endpoint;
            this.newKoboDeviceName = 'Kobo';
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async saveKoboDevice(device) {
        try {
            await this.api.updateKoboDevice(device.id, device.draft);
            await this.loadKoboDevices();
            this.$root.notify.success(t('Устройство сохранено'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async confirmDevice(message) {
        return await this.$root.stdDialog.confirm(message, 'Kobo');
    }

    async resetKoboDevice(device) {
        if (!await this.confirmDevice(t('Отправить на «{name}» все книги из списков заново при следующей синхронизации?', {name: device.name})))
            return;
        try {
            await this.api.resetKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async refreshKoboDevice(device) {
        if (!await this.confirmDevice(t('Отправить на «{name}» заново все книги, которые уже на нём, с текущими авторами, сериями и файлами? Книги не удаляются с устройства, поэтому прогресс чтения и заметки сохраняются.', {name: device.name})))
            return;
        try {
            await this.api.refreshKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async regenerateKoboDevice(device) {
        if (!await this.confirmDevice(t('Создать новую ссылку для «{name}»? Старая перестанет работать, и её нужно будет заменить в Kobo eReader.conf.', {name: device.name})))
            return;
        try {
            const result = await this.api.regenerateKoboDeviceToken(device.id);
            this.koboEndpoint = result.endpoint;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }

    async deleteKoboDevice(device) {
        if (!await this.confirmDevice(t('Удалить устройство «{name}»? Kobo перестанет синхронизироваться, книги на нём останутся.', {name: device.name})))
            return;
        try {
            await this.api.deleteKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        }
    }
}

export default vueComponent(MeDevices);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.device {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
}

.device-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
}

.device-name {
    min-width: 200px;
    max-width: 320px;
    flex: 1;
}

.device-sub {
    margin-top: 6px;
    font-weight: 600;
}

.device-lists {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
}

.device-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}
</style>
