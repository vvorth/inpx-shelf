<template>
    <section id="author-names" class="card">
        <div class="card-head">
            <div>
                <h2 class="card-title">
                    {{ $t('adminAuthorNames.englishAuthorNames') }}
                </h2>
                <div class="card-hint">
                    {{ $t('adminAuthorNames.searchWillFindFor') }}
                </div>
            </div>
            <q-btn color="primary" unelevated no-caps icon="la la-download" :loading="busy" @click="update">
                {{ status.ready ? $t('reader.refresh') : $t('adminAuthorNames.downloadAndMatch') }}
            </q-btn>
        </div>

        <div v-if="running" class="names-progress">
            <q-linear-progress rounded size="6px" :value="progress" color="primary" />
            <div class="card-hint">
                {{ job.running ? $t('adminAuthorNames.downloadingNamesFromWikidata') : $t('adminAuthorNames.rebuildingTheSearchIndex') }}
            </div>
        </div>
        <div v-else-if="job.error" class="names-error">
            {{ $t('adminAuthorNames.downloadFailed', {error: $tm(job.error)}) }}
        </div>
        <div v-else-if="status.ready" class="card-hint num">
            {{ $t('adminAuthorNames.namesInTheTable', {count: status.count.toLocaleString(), date: formatDate(status.updatedAt), matched: status.matched.toLocaleString()}) }}
        </div>
        <div v-else class="card-hint">
            {{ $t('adminAuthorNames.tableEmpty') }}
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';

class AdminAuthorNames {
    status = {ready: false, count: 0, updatedAt: '', matched: 0, job: {}, indexBuilding: false};
    busy = false;
    timer = null;

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.refresh();
    }

    beforeUnmount() {
        clearTimeout(this.timer);
    }

    get job() {
        return this.status.job || {};
    }

    get running() {
        return !!(this.job.running || (this.status.indexBuilding && this.job.message));
    }

    get progress() {
        return (this.job.running ? Number(this.job.progress || 0) * 0.8 : 0.9);
    }

    formatDate(value) {
        const date = new Date(value);
        return (Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString());
    }

    async refresh() {
        clearTimeout(this.timer);
        try {
            this.status = await this.api.adminAuthorNamesStatus();
        } catch (e) {
            return;
        }
        if (this.running) {
            this.timer = setTimeout(() => this.refresh(), 2000);
        } else if (this.job.message) {
            //готово: обновим сведения о поиске (баннер, подсказки)
            await this.api.updateConfig();
        }
    }

    async update() {
        this.busy = true;
        try {
            this.status = await this.api.adminAuthorNamesUpdate();
            this.timer = setTimeout(() => this.refresh(), 1000);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.busy = false;
        }
    }
}

export default vueComponent(AdminAuthorNames);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.names-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 420px;
}

.names-error {
    color: var(--app-danger);
}
</style>
