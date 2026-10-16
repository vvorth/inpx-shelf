<template>
    <section :id="table" class="card">
        <div class="card-head">
            <div>
                <h2 class="card-title">
                    {{ $t(text.title) }}
                </h2>
                <div class="card-hint">
                    {{ $t(text.hint) }}
                </div>
            </div>
            <div class="names-actions">
                <q-btn color="primary" unelevated no-caps icon="la la-download" :loading="busy" :disable="running" @click="update">
                    {{ status.ready ? $t('reader.refresh') : $t('adminAuthorNames.downloadAndMatch') }}
                </q-btn>
                <q-btn outline color="primary" no-caps icon="la la-file-export" :loading="exporting" :disable="!status.ready" @click="exportNames">
                    {{ $t('adminAuthorNames.export') }}
                </q-btn>
                <q-btn outline color="primary" no-caps icon="la la-file-import" :loading="importing" :disable="running" @click="openImport">
                    {{ $t('adminAuthorNames.import') }}
                </q-btn>
                <input ref="importInput" type="file" accept="application/zip,.zip" style="display: none" @change="onImportSelected" />
            </div>
        </div>

        <div v-if="running" class="names-progress">
            <q-linear-progress rounded size="6px" :value="progress" color="primary" />
            <div class="card-hint">
                {{ job.running ? $t(text.downloading) : $t('adminAuthorNames.rebuildingTheSearchIndex') }}
            </div>
        </div>
        <div v-else-if="job.error" class="names-error">
            {{ $t('adminAuthorNames.downloadFailed', {error: $tm(job.error)}) }}
        </div>
        <div v-else-if="status.ready" class="card-hint num">
            {{ $t(text.count, {count: status.count.toLocaleString(), date: formatDate(status.updatedAt), matched: Number(status.matched || 0).toLocaleString()}) }}
        </div>
        <div v-else class="card-hint">
            {{ $t('adminAuthorNames.tableEmpty') }}
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, formatDateTime} from '../../share/i18n';

//Одна карточка для каждой таблицы Wikidata: английские имена авторов и названия произведений на других языках
const texts = {
    'author-names': {title: 'adminAuthorNames.englishAuthorNames', hint: 'adminAuthorNames.searchWillFindFor',
        downloading: 'adminAuthorNames.downloadingNamesFromWikidata', count: 'adminAuthorNames.namesInTheTable',
        importConfirm: 'adminAuthorNames.importConfirm', imported: 'adminAuthorNames.imported'},
    'work-titles': {title: 'adminWorkTitles.title', hint: 'adminWorkTitles.hint',
        downloading: 'adminWorkTitles.downloading', count: 'adminWorkTitles.count',
        importConfirm: 'adminWorkTitles.importConfirm', imported: 'adminWorkTitles.imported'},
};

class AdminAuthorNames {
    _props = {
        table: {type: String, default: 'author-names'},
    };

    status = {ready: false, count: 0, updatedAt: '', matched: 0, job: {}, indexBuilding: false};
    busy = false;
    exporting = false;
    importing = false;
    timer = null;

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.refresh();
    }

    beforeUnmount() {
        //запрос в полёте после закрытия не должен снова запускать таймер
        this.closed = true;
        clearTimeout(this.timer);
    }

    get text() {
        return texts[this.table] || texts['author-names'];
    }

    get job() {
        return this.status.job || {};
    }

    //скачивание или любая пересборка индекса (после скачивания, импорта имён, смены библиотек): число совпадений ещё старое
    get running() {
        return !!(this.job.running || this.status.indexBuilding);
    }

    get progress() {
        return (this.job.running ? Number(this.job.progress || 0) * 0.8 : 0.9);
    }

    formatDate(value) {
        return formatDateTime(value, {year: 'numeric', month: '2-digit', day: '2-digit'});
    }

    async refresh() {
        clearTimeout(this.timer);
        const wasRunning = this.running;
        try {
            this.status = await this.api.adminAuthorNamesStatus(this.table);
        } catch (e) {
            //разовый сбой связи (телефон уснул) не останавливает опрос идущего задания
            if (wasRunning && !this.closed)
                this.timer = setTimeout(() => this.refresh(), 2000);
            return;
        }
        if (this.closed)
            return;
        if (this.running) {
            this.timer = setTimeout(() => this.refresh(), 2000);
        } else if (wasRunning || this.job.message) {
            //готово: обновим сведения о поиске (баннер, подсказки)
            await this.api.updateConfig();
        }
    }

    //тот же архив, что полный бэкап, но только с author-names.json: на новом сервере не нужно ждать Wikidata
    async exportNames() {
        this.exporting = true;
        try {
            const result = await this.api.createAdminBackup(this.table);
            if (result && result.link)
                window.location.href = result.link;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.exporting = false;
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
        if (!await this.$root.stdDialog.confirm(t(this.text.importConfirm), t('adminAuthorNames.import'))) {
            input.value = '';
            return;
        }

        this.importing = true;
        try {
            await this.api.importAdminBackup(file, this.table);
            this.$root.notify.success(t(this.text.imported));
            if (!this.closed)
                this.timer = setTimeout(() => this.refresh(), 1000);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        } finally {
            this.importing = false;
            input.value = '';
        }
    }

    async update() {
        this.busy = true;
        try {
            this.status = await this.api.adminAuthorNamesUpdate(this.table);
            if (!this.closed)
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
.names-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

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
