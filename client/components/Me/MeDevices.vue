<template>
    <div class="card-stack">
        <section class="card">
            <div class="card-head">
                <h2 class="card-title">
                    {{ $t('meDevices.opdsCatalog') }}
                </h2>
                <q-toggle
                    :model-value="opdsEnabled"
                    :disable="profile.isAdmin || opdsSaving"
                    :label="$t('meDevices.on')"
                    left-label
                    @update:model-value="saveOpds({opdsEnabled: $event})"
                />
            </div>
            <div v-if="profile.isAdmin" class="card-hint">
                {{ $t('meDevices.theAdministratorProfileIs') }}
            </div>
            <template v-else>
                <div class="card-hint">
                    {{ $t('meDevices.addThisAddressTo') }}
                </div>
                <div class="copy-row">
                    <code class="copy-value">{{ opdsUrl }}</code>
                    <q-btn flat dense no-caps color="primary" icon="la la-copy" @click="copy(opdsUrl)">
                        {{ $t('meDevices.copy') }}
                    </q-btn>
                </div>
                <q-toggle
                    :model-value="opdsAuthEnabled"
                    :disable="!opdsEnabled || !profile.login || !profile.hasPassword || opdsSaving"
                    :label="$t('meDevices.requireMyLoginAnd')"
                    @update:model-value="saveOpds({opdsAuthEnabled: $event})"
                />
                <div class="card-hint">
                    {{ $t('meDevices.chooseWhichListsAppear') }}
                    <router-link to="/lists">
                        {{ $t('profiles.lists') }}
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
                {{ $t('meDevices.koboSyncsTheBooks') }}
            </div>

            <div v-if="koboEndpoint" class="notice">
                <b>{{ $t('meDevices.koboAddress') }}</b>
                <div class="card-hint">
                    {{ $t('meDevices.connectTheKoboTo') }}
                </div>
                <div class="copy-row">
                    <code class="copy-value">api_endpoint={{ koboEndpoint }}</code>
                    <q-btn flat dense no-caps color="primary" icon="la la-copy" @click="copy(`api_endpoint=${koboEndpoint}`)">
                        {{ $t('meDevices.copy') }}
                    </q-btn>
                    <q-btn flat dense no-caps @click="koboEndpoint = ''">
                        {{ $t('common.hide') }}
                    </q-btn>
                </div>
            </div>

            <div v-if="koboLoading" class="card-hint">
                …
            </div>
            <div v-else-if="!koboDevices.length" class="card-hint">
                {{ $t('meDevices.noDevicesYet') }}
            </div>

            <div v-for="device in koboDevices" :key="device.id" class="device">
                <div class="device-head">
                    <q-input v-model="device.draft.name" outlined dense class="device-name" :label="$t('meDevices.deviceName')" />
                    <div class="card-hint">
                        {{ $t('meDevices.booksOnDevice') }}: {{ device.bookCount }} ·
                        {{ $t('meDevices.lastSync') }}: {{ device.lastSyncAt ? formatDateTime(device.lastSyncAt) : $t('meDevices.never') }}
                        <template v-if="device.refreshPending">
                            · {{ $t('meDevices.waitingForRefresh') }}: {{ device.refreshPending }}
                        </template>
                    </div>
                </div>
                <div class="device-sub">
                    {{ $t('meDevices.syncedLists') }}
                </div>
                <div>
                    {{ syncedListNames(device) || $t('meDevices.noListsSyncedYet') }}
                </div>
                <div class="card-hint">
                    {{ $t('meDevices.turnOnSyncFor') }}
                    <router-link to="/lists">
                        {{ $t('profiles.lists') }}
                    </router-link>.
                </div>
                <q-checkbox v-model="device.draft.keepRemovedBooks" dense :label="$t('meDevices.keepBooksOnThe')" />
                <div class="card-hint">
                    {{ $t('meDevices.whenOffABook') }}
                </div>
                <q-checkbox v-model="device.draft.resendDeletedBooks" dense :label="$t('meDevices.sendBackBooksDeleted')" />
                <div class="card-hint">
                    {{ $t('meDevices.whenOnABook') }}
                </div>
                <q-checkbox v-model="device.draft.storeProxy" dense :label="$t('meDevices.connectTheKoboStore')" />
                <div class="card-hint">
                    {{ $t('meDevices.forBooksBoughtIn') }}
                </div>
                <div class="card-actions">
                    <q-btn color="primary" unelevated dense no-caps icon="la la-save" @click="saveKoboDevice(device)">
                        {{ $t('common.save') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="primary" icon="la la-sync" @click="resetKoboDevice(device)">
                        {{ $t('meDevices.syncAgain') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="primary" icon="la la-redo-alt" @click="refreshKoboDevice(device)">
                        {{ $t('meDevices.refreshBooksOnDevice') }}
                    </q-btn>
                    <q-btn flat dense no-caps icon="la la-key" @click="regenerateKoboDevice(device)">
                        {{ $t('meDevices.newLink') }}
                    </q-btn>
                    <q-btn flat dense no-caps color="negative" icon="la la-trash" @click="deleteKoboDevice(device)">
                        {{ $t('profiles.delete') }}
                    </q-btn>
                </div>
            </div>

            <form class="device-add" @submit.prevent="createKoboDevice">
                <q-input v-model="newKoboDeviceName" outlined dense class="device-name" :label="$t('meDevices.deviceName')" />
                <q-btn type="submit" color="primary" unelevated dense no-caps icon="la la-plus" :disable="!String(newKoboDeviceName || '').trim()">
                    {{ $t('meDevices.addDevice') }}
                </q-btn>
            </form>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, formatDateTime} from '../../share/i18n';
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
            this.$root.notify.success(t('meDevices.copied'));
    }

    async saveOpds(patch) {
        this.opdsSaving = true;
        try {
            await this.api.updateUserProfile(this.profile.id, patch);
            await this.api.updateConfig();
            this.$root.notify.success(t('settings.opds.saved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.opdsSaving = false;
        }
    }

    formatDateTime(value) {
        return formatDateTime(value, {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
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

    syncedListNames(device) {
        const ids = device.listIds || [];
        return this.readingLists.filter(list => ids.includes(list.id)).map(list => list.name).join(', ');
    }

    async loadKoboDevices() {
        this.koboLoading = true;
        try {
            const result = await this.api.getKoboDevices();
            this.setKoboDevices(result && Array.isArray(result.devices) ? result.devices : []);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
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
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async saveKoboDevice(device) {
        try {
            await this.api.updateKoboDevice(device.id, device.draft);
            await this.loadKoboDevices();
            this.$root.notify.success(t('meDevices.deviceSaved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async confirmDevice(message) {
        return await this.$root.stdDialog.confirm(message, 'Kobo');
    }

    async resetKoboDevice(device) {
        if (!await this.confirmDevice(t('meDevices.sendAllBooksFrom', {name: device.name})))
            return;
        try {
            await this.api.resetKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async refreshKoboDevice(device) {
        if (!await this.confirmDevice(t('meDevices.sendEveryBookAlready', {name: device.name})))
            return;
        try {
            await this.api.refreshKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async regenerateKoboDevice(device) {
        if (!await this.confirmDevice(t('meDevices.createANewLink', {name: device.name})))
            return;
        try {
            const result = await this.api.regenerateKoboDeviceToken(device.id);
            this.koboEndpoint = result.endpoint;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    async deleteKoboDevice(device) {
        if (!await this.confirmDevice(t('meDevices.deleteDeviceTheKobo', {name: device.name})))
            return;
        try {
            await this.api.deleteKoboDevice(device.id);
            await this.loadKoboDevices();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
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

.device-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}
</style>
