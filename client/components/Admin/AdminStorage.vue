<template>
    <div class="admin-subsection">
        <div class="admin-subsection-head">
            <div>
                <div class="admin-mail-title">{{ $t('settings.cacheRotation') }}</div>
                <div class="admin-mail-subtitle">{{ $t('settings.limitsSetMegabytesScheduled') }}</div>
            </div>
            <q-btn outline color="primary" dense no-caps icon="la la-save" :loading="admin.adminCacheSaveLoading" @click="admin.saveAdminCacheSettings">
                {{ $t('common.save') }}
            </q-btn>
        </div>
        <div class="admin-cache-settings-grid">
            <q-input v-model.number="admin.adminCacheSettings.bookCacheSizeMb" outlined dense type="number" min="1" :label="$t('settings.bookCacheMb')" />
            <q-input v-model.number="admin.adminCacheSettings.coverCacheSizeMb" outlined dense type="number" min="1" :label="$t('settings.coverCacheMb')" />
            <q-checkbox class="admin-cache-enabled-toggle" v-model="admin.adminCacheSettings.cacheCleanEnabled" size="32px" :label="$t('settings.scheduledRotation')" />
            <q-select v-model="admin.adminCacheSettings.cacheCleanFrequency" :options="adminCacheFrequencyOptions" outlined dense emit-value map-options :label="$t('settings.frequency')" :disable="!admin.adminCacheSettings.cacheCleanEnabled" />
            <q-select v-if="admin.adminCacheSettings.cacheCleanFrequency === 'weekly'" v-model="admin.adminCacheSettings.cacheCleanWeekDay" :options="admin.adminCacheWeekDayOptions" outlined dense emit-value map-options :label="$t('settings.dayWeek')" :disable="!admin.adminCacheSettings.cacheCleanEnabled" />
            <q-select v-if="admin.adminCacheSettings.cacheCleanFrequency === 'monthly'" v-model="admin.adminCacheSettings.cacheCleanMonthDay" :options="adminCacheMonthDayOptions" outlined dense emit-value map-options :label="$t('settings.dayMonth')" :disable="!admin.adminCacheSettings.cacheCleanEnabled" />
            <q-input class="admin-cache-time-input" v-model="admin.adminCacheSettings.cacheCleanTime" outlined dense type="time" :label="$t('settings.startTime')" :hint="$t('settings.serverTime')" persistent-hint :disable="!admin.adminCacheSettings.cacheCleanEnabled || admin.adminCacheSettings.cacheCleanFrequency === 'advanced'" />
            <q-input v-model.number="admin.adminCacheSettings.cacheCleanTargetPercent" outlined dense type="number" min="10" max="100" :label="$t('settings.cleanupTargetPercent')" />
        </div>
        <div class="admin-cache-actions">
            <q-btn outline color="primary" dense no-caps icon="la la-book" :loading="admin.adminCleanBookCacheLoading" @click="admin.cleanAdminCache('book')">
                {{ $t('settings.clearBookCache') }}
            </q-btn>
            <q-btn outline color="primary" dense no-caps icon="la la-image" :loading="admin.adminCleanCoverCacheLoading" @click="admin.cleanAdminCache('cover')">
                {{ $t('settings.clearCoverCache') }}
            </q-btn>
        </div>
    </div>

    <div class="admin-subsection">
        <div class="admin-subsection-head">
            <div>
                <div class="admin-mail-title">{{ $t('settings.admin.coverDiagnostics') }}</div>
                <div class="admin-mail-subtitle">{{ $t('settings.admin.coverDiagnosticsHint') }}</div>
            </div>
            <q-btn flat dense no-caps color="negative" icon="la la-broom" :loading="admin.adminBrokenCoversLoading" @click="admin.cleanBrokenCovers">
                {{ $t('settings.admin.cleanBrokenCovers') }}
            </q-btn>
        </div>
        <div class="admin-dashboard-grid admin-dashboard-grid--compact">
            <div class="admin-stat">
                <div class="admin-stat-label">{{ $t('settings.admin.coverCache') }}</div>
                <div class="admin-stat-value">{{ admin.formatBytes(adminCoverStats.size) }}</div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-label">{{ $t('settings.admin.files') }}</div>
                <div class="admin-stat-value">{{ adminCoverStats.files || 0 }}</div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-label">{{ $t('settings.admin.limit') }}</div>
                <div class="admin-stat-value">{{ admin.formatBytes(adminCoverStats.limit) }}</div>
                <div class="admin-stat-hint">{{ admin.adminCacheTargetText(adminCoverStats.targetSize) }}</div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-label">{{ $t('settings.admin.coverErrors') }}</div>
                <div class="admin-stat-value">{{ adminCoverErrors.length }}</div>
            </div>
        </div>
        <div class="admin-cover-actions">
            <q-input v-model="admin.adminCoverBookUid" outlined dense clearable :label="$t('settings.admin.coverBookUid')" />
            <q-btn color="primary" dense no-caps icon="la la-sync" :loading="admin.adminCoverRebuildLoading" @click="admin.rebuildAdminCover">
                {{ $t('settings.admin.rebuildCover') }}
            </q-btn>
        </div>
        <div v-if="adminCoverErrors.length" class="admin-event-list admin-event-list--compact">
            <div v-for="event in adminCoverErrors" :key="event.id" class="admin-event-row" :class="`admin-event-row--${event.level}`">
                <div class="admin-event-meta">
                    {{ admin.formatDateTime(event.time) }} · {{ event.level }} · {{ event.category }}
                </div>
                <div class="admin-event-message">{{ $tm(event.message) }}</div>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import {t} from '../../share/i18n';

//Раздел страницы администрирования: данные, действия и таймеры опроса остаются в AdminPage, сюда приходит её экземпляр
class AdminStorage {
    _props = {
        admin: {type: Object, required: true},
    };

    get adminCacheFrequencyOptions() {
        return [
            {label: t('settings.frequencyDaily'), value: 'daily'},
            {label: t('settings.frequencyWeekly'), value: 'weekly'},
            {label: t('settings.frequencyMonthly'), value: 'monthly'},
        ];
    }

    get adminCacheMonthDayOptions() {
        return Array.from({length: 31}, (_, index) => ({
            label: t('settings.monthDay', {n: index + 1}),
            value: index + 1,
        }));
    }

    get adminCoverStats() {
        return (this.admin.adminDashboard && this.admin.adminDashboard.covers) || {};
    }

    get adminCoverErrors() {
        return Array.isArray(this.adminCoverStats.latestErrors) ? this.adminCoverStats.latestErrors : [];
    }
}

export default vueComponent(AdminStorage);
//-----------------------------------------------------------------------------
</script>

<style scoped src="./adminSections.css"></style>

<style scoped>
.admin-mail-subtitle {
    margin-top: 3px;
    font-size: 12px;
    color: var(--app-muted);
}

.admin-cache-settings-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 10px;
    row-gap: 18px;
    margin-top: 14px;
}

.admin-cache-enabled-toggle {
    grid-column: 1 / -1;
    align-self: center;
    min-height: 40px;
    margin-top: 2px;
    padding-top: 14px;
    border-top: 1px solid var(--app-border);
}

.admin-cache-time-input {
    min-width: 150px;
}

.admin-cache-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 14px;
}

.admin-cover-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin-top: 12px;
}

@media (max-width: 720px) {
    .admin-cache-settings-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .admin-cover-actions {
        grid-template-columns: 1fr;
    }
}
</style>
