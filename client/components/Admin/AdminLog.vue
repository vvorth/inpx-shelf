<template>
    <div class="admin-subsection">
        <div class="admin-subsection-head">
            <div class="admin-mail-title">{{ $t('settings.admin.events') }}</div>
            <div class="admin-event-filters">
                <q-checkbox v-model="admin.adminEventLogEnabled" size="32px" :label="$t('settings.admin.eventLogEnabled')" @update:model-value="admin.saveAdminEventLog" />
                <q-select v-model="admin.adminEventLogSize" :options="adminEventLogSizeOptions" outlined dense emit-value map-options @update:model-value="admin.saveAdminEventLog" />
                <q-select v-model="admin.adminEventLevel" :options="adminEventLevelOptions" outlined dense emit-value map-options @update:model-value="admin.refreshAdminEvents" />
                <q-select v-model="admin.adminEventCategory" :options="adminEventCategoryOptions" outlined dense emit-value map-options @update:model-value="admin.refreshAdminEvents" />
                <q-btn flat dense no-caps color="primary" icon="la la-bug" :loading="admin.adminTestEventLoading" @click="admin.addAdminTestEvent">
                    {{ $t('settings.admin.testEvent') }}
                </q-btn>
            </div>
        </div>
        <div v-if="admin.adminEventsLoading" class="admin-empty">{{ $t('settings.admin.eventsLoading') }}</div>
        <div v-else-if="!admin.adminEventLogEnabled" class="admin-empty">{{ $t('settings.admin.eventsDisabled') }}</div>
        <div v-else-if="!admin.adminEvents.length" class="admin-empty">{{ $t('settings.admin.noEvents') }}</div>
        <div v-else class="admin-event-list">
            <div v-for="event in admin.adminEvents" :key="event.id" class="admin-event-row" :class="`admin-event-row--${event.level}`">
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
class AdminLog {
    _props = {
        admin: {type: Object, required: true},
    };
    adminEventLogSizeOptions = [
        {label: '100', value: 100},
        {label: '300', value: 300},
        {label: '500', value: 500},
        {label: '1000', value: 1000},
    ];

    get adminEventLevelOptions() {
        return [
            {label: t('settings.allLevels'), value: 'all'},
            {label: 'Info', value: 'info'},
            {label: 'Warn', value: 'warn'},
            {label: 'Error', value: 'error'},
        ];
    }

    get adminEventCategoryOptions() {
        return [
            {label: t('settings.allEvents'), value: 'all'},
            {label: t('common.settings'), value: 'settings'},
            {label: t('settings.sources'), value: 'sources'},
            {label: t('settings.cache'), value: 'cache'},
            {label: t('settings.covers'), value: 'cover'},
            {label: t('settings.index'), value: 'index'},
            {label: t('settings.delivery'), value: 'delivery'},
            {label: t('settings.system'), value: 'system'},
        ];
    }
}

export default vueComponent(AdminLog);
//-----------------------------------------------------------------------------
</script>

<style scoped src="./adminSections.css"></style>

<style scoped>
.admin-event-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

.admin-event-filters :deep(.q-field) {
    min-width: 132px;
}

.admin-empty {
    margin-top: 10px;
    color: var(--app-muted);
    font-size: 13px;
}
</style>
