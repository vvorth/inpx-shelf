<template>
    <section class="card">
        <div class="card-head">
            <div>
                <h2 class="card-title">
                    {{ $t('adminRemote.title') }}
                </h2>
                <div class="card-hint">
                    {{ $t('adminRemote.hint', {path: path}) }}
                </div>
            </div>
        </div>

        <div v-if="newToken" class="remote-token">
            <div>{{ $t('adminRemote.tokenShownOnce', {name: newToken.name}) }}</div>
            <div class="copy-row">
                <code class="copy-value">{{ newToken.token }}</code>
                <q-btn flat dense no-caps color="primary" icon="la la-copy" @click="copy(newToken.token)">
                    {{ $t('meDevices.copy') }}
                </q-btn>
            </div>
        </div>

        <div v-for="item in rows" :key="item.id || 'new'" class="remote-row">
            <q-input v-model="item.draft.name" outlined dense :label="item.id ? $t('adminRemote.name') : $t('adminRemote.newName')" />
            <div class="remote-sources">
                <q-checkbox
                    v-for="source in sources" :key="source.id" v-model="item.draft.sources" :val="source.id" dense
                    :label="source.enabled ? source.name : $t('adminRemote.disabledSource', {name: source.name})"
                />
            </div>
            <div class="remote-actions">
                <q-btn v-if="item.id" flat dense no-caps color="primary" icon="la la-save" :disable="!changed(item) || busy" @click="save(item)">
                    {{ $t('common.save') }}
                </q-btn>
                <q-btn v-if="item.id" flat dense round color="negative" icon="la la-trash" :disable="busy" @click="remove(item)" />
                <q-btn v-else color="primary" unelevated dense no-caps icon="la la-key" :disable="!item.draft.name.trim() || busy" @click="create(item)">
                    {{ $t('adminRemote.create') }}
                </q-btn>
            </div>
            <div v-if="item.id" class="card-hint">
                {{ item.sources.length ? $t('adminRemote.opens', {n: item.sources.length}) : $t('adminRemote.opensNothing') }}
                · {{ item.createdAt.slice(0, 10) }}
            </div>
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {copyTextToClipboard} from '../../share/utils';

//Доступ других серверов inpx-shelf к библиотекам этого (API /remote/): токен на сервер, у токена - свои библиотеки
class AdminRemoteAccess {
    items = [];
    sources = [];
    path = '/remote';
    draft = {id: '', draft: {name: '', sources: []}};
    newToken = null;
    busy = false;

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.run(() => this.api.getRemoteAccess());
    }

    get rows() {
        return [...this.items, this.draft];
    }

    changed(item) {
        return item.draft.name.trim() !== item.name || [...item.draft.sources].sort().join() !== [...item.sources].sort().join();
    }

    apply(result) {
        this.sources = result.sources || [];
        this.path = result.path || this.path;
        this.items = (result.items || []).map(item => Object.assign({}, item, {draft: {name: item.name, sources: [...item.sources]}}));
    }

    async run(request) {
        this.busy = true;
        try {
            const result = await request();
            this.apply(result);
            return result;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
            return null;
        } finally {
            this.busy = false;
        }
    }

    async create(item) {
        const result = await this.run(() => this.api.createRemoteAccess(item.draft));
        if (result) {
            this.newToken = {name: result.created.name, token: result.token};
            this.draft = {id: '', draft: {name: '', sources: []}};
        }
    }

    async save(item) {
        await this.run(() => this.api.updateRemoteAccess({id: item.id, name: item.draft.name, sources: item.draft.sources}));
    }

    async remove(item) {
        if (!await this.$root.stdDialog.confirm(t('adminRemote.deleteConfirm', {name: item.name}), t('adminRemote.title')))
            return;
        await this.run(() => this.api.deleteRemoteAccess(item.id));
    }

    async copy(text) {
        if (await copyTextToClipboard(text))
            this.$root.notify.success(t('meDevices.copied'));
    }
}

export default vueComponent(AdminRemoteAccess);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.remote-token {
    margin-top: 10px;
    padding: 10px;
    border-radius: 8px;
    background: rgba(23, 32, 38, 0.05);
}

.remote-row {
    display: grid;
    grid-template-columns: minmax(160px, 0.8fr) minmax(200px, 1.6fr) auto;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
}

.remote-row .card-hint {
    grid-column: 1 / -1;
    margin-top: -4px;
}

.remote-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
}

.remote-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
}

@media (max-width: 720px) {
    .remote-row {
        grid-template-columns: minmax(0, 1fr);
    }

    .remote-actions {
        justify-content: flex-start;
    }
}
</style>
