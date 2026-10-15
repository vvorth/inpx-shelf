<template>
    <div class="admin-subsection">
        <div class="admin-subsection-head">
            <div class="admin-mail-title">{{ $t('settings.admin.sources') }}</div>
            <q-btn flat dense no-caps color="primary" icon="la la-plus" @click="admin.addAdminSource">
                {{ $t('settings.admin.addSource') }}
            </q-btn>
        </div>
        <div class="admin-source-list">
            <div v-for="(source, index) in admin.adminSources" :key="index" class="admin-source-row">
                <q-checkbox v-model="source.enabled" size="32px" />
                <q-input v-model="source.name" outlined dense :label="$t('settings.admin.sourceName')" />
                <q-input v-model="source.inpx" outlined dense :label="$t('settings.admin.sourceInpx')" />
                <q-input v-model="source.libDir" outlined dense :label="$t('settings.admin.sourceLibDir')" />
                <q-btn flat dense round color="primary" icon="la la-search" :loading="source.diagnosticsLoading" @click="admin.diagnoseAdminSource(index)">
                    <q-tooltip>{{ $t('settings.admin.checkSource') }}</q-tooltip>
                </q-btn>
                <q-btn flat dense round color="negative" icon="la la-trash" @click="admin.removeAdminSource(index)" />
                <div class="admin-source-diagnostics">
                    <span :class="source.inpxExists ? 'text-positive' : 'text-negative'">INPX</span>
                    <span :class="source.libDirExists ? 'text-positive' : 'text-negative'">{{ $t('settings.admin.folder') }}</span>
                    <span>{{ $t('settings.admin.archives') }}: {{ source.archiveCount || 0 }}{{ source.archiveCountTruncated ? '+' : '' }}</span>
                    <span>covers: {{ source.hasCovers ? 'ok' : '-' }}</span>
                    <span>etc: {{ source.hasEtc ? 'ok' : '-' }}</span>
                    <span>images: {{ source.hasImages ? 'ok' : '-' }}</span>
                    <span>bin: {{ source.hasBin ? 'ok' : '-' }}</span>
                    <span v-if="source.foundInpx && source.foundInpx.length">{{ $t('settings.admin.foundInpx') }}: {{ source.foundInpx.length }}</span>
                </div>
            </div>
        </div>
        <div v-if="admin.adminSourcesNeedReindex || admin.adminSourcesReindexNeeded" class="admin-source-warning">
            <q-icon name="la la-exclamation-triangle" size="18px" />
            <span>{{ $t('settings.admin.sourcesNeedReindex') }}</span>
        </div>
        <div class="admin-mail-actions">
            <q-btn color="primary" dense no-caps icon="la la-save" :loading="admin.adminSourcesLoading" @click="admin.saveAdminSources">
                {{ $t('settings.admin.saveSources') }}
            </q-btn>
        </div>
    </div>

    <AdminAuthorNames v-if="admin.catalogSearchEnabled" />
    <AdminAuthorNames v-if="admin.catalogSearchEnabled" table="work-titles" />

    <section v-if="admin.discoveryEnabled" class="card">
        <h2 class="card-title">{{ $t('admin.externalShowcase') }}</h2>
        <div class="card-hint">{{ admin.externalDiscoverySummary }}</div>
        <div class="card-actions">
            <q-btn outline color="primary" dense no-caps icon="la la-sliders-h" @click="admin.discoverySourceDialogVisible = true">
                {{ $t('settings.manage') }}
            </q-btn>
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import AdminAuthorNames from './AdminAuthorNames.vue';

//Раздел страницы администрирования: данные, действия и таймеры опроса остаются в AdminPage, сюда приходит её экземпляр
class AdminLibrary {
    _options = {components: {AdminAuthorNames}};
    _props = {
        admin: {type: Object, required: true},
    };
}

export default vueComponent(AdminLibrary);
//-----------------------------------------------------------------------------
</script>

<style scoped src="./adminSections.css"></style>

<style scoped>
.admin-mail-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
}

.admin-source-list {
    display: grid;
    gap: 10px;
    margin-top: 10px;
}

.admin-source-row {
    display: grid;
    grid-template-columns: auto minmax(120px, 0.8fr) minmax(180px, 1.2fr) minmax(180px, 1.2fr) auto auto;
    gap: 8px;
    align-items: center;
}

.admin-source-diagnostics {
    grid-column: 2 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-source-diagnostics span {
    padding: 2px 6px;
    border-radius: 999px;
    background: rgba(23, 32, 38, 0.05);
}

.admin-source-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    color: var(--app-accent);
    font-size: 13px;
    font-weight: 700;
}

@media (max-width: 720px) {
    .admin-source-row {
        grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .admin-source-row :deep(.q-field) {
        grid-column: 2 / 3;
    }

    .admin-source-diagnostics {
        grid-column: 1 / 4;
    }

    .admin-mail-actions {
        justify-content: flex-start;
    }
}
</style>
