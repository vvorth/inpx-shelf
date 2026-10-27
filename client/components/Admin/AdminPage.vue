<template>
    <div class="page admin-page">
        <div class="page-body">
            <header class="page-head">
                <div>
                    <div class="page-eyebrow"><q-icon name="la la-shield-alt" size="16px" />{{ $t('settings.admin.title') }}</div>
                    <h1 class="page-title">{{ sectionLabel }}</h1>
                </div>
                <div v-if="canEditExternalDiscovery && section === 'overview'" class="admin-toolbar">
                    <q-btn outline color="primary" dense no-caps icon="la la-sync" :loading="adminLoading" @click="loadAdminPanel">
                        {{ $t('settings.admin.refresh') }}
                    </q-btn>
                    <q-btn outline color="primary" dense no-caps icon="la la-broom" :loading="adminCleanLoading" @click="cleanAdminCache('all')">
                        {{ $t('settings.clearBothCaches') }}
                    </q-btn>
                    <q-btn outline color="negative" dense no-caps icon="la la-database" :loading="adminReindexLoading" :disable="adminIndexBusy" @click="reindexAdmin">
                        {{ $t('settings.admin.reindex') }}
                    </q-btn>
                </div>
            </header>

            <div v-if="!canEditExternalDiscovery" class="card">
                <div>{{ $t('admin.onlyAnAdministratorCan') }}</div>
            </div>

            <div v-else class="section-layout">
                <nav class="section-nav" :aria-label="$t('admin.adminSections')">
                    <router-link
                        v-for="item in sections"
                        :key="item.id"
                        class="section-nav-item"
                        :class="{'is-active': item.id === section}"
                        :to="`/admin/${item.id}`"
                    >
                        <q-icon :name="item.icon" size="18px" />{{ item.label }}
                    </router-link>
                    <div class="section-nav-sep" />
                    <router-link class="section-nav-item" to="/">
                        <q-icon name="la la-arrow-left" size="18px" />{{ $t('admin.backToLibrary') }}
                    </router-link>
                </nav>

                <div class="section-content">
                <div v-if="adminIndexStatusVisible" class="admin-index-status" :class="{'admin-index-status--busy': adminIndexBusy}">
                    <q-spinner v-if="adminIndexBusy" color="primary" size="22px" />
                    <q-icon v-else name="la la-check-circle" size="22px" />
                    <div class="admin-index-status-copy">
                        <div class="admin-index-status-title">{{ adminIndexStatusTitle }}</div>
                        <div class="admin-index-status-text">{{ adminIndexStatusText }}</div>
                        <q-linear-progress v-if="adminIndexBusy" rounded size="6px" :value="adminIndexProgress" color="primary" />
                    </div>
                </div>

                <div v-if="userDataBlocked.length" class="admin-index-status admin-data-blocked" role="alert">
                    <q-icon name="la la-exclamation-triangle" size="22px" />
                    <div class="admin-index-status-copy">
                        <div class="admin-index-status-title">{{ $t('settings.admin.userDataBlockedTitle') }}</div>
                        <div v-for="item in userDataBlocked" :key="item.file" class="admin-data-blocked-file">
                            {{ $t('settings.admin.userDataBlockedFile', {file: item.file, copy: item.copy}) }}
                        </div>
                        <div class="admin-index-status-text">{{ $t('settings.admin.userDataBlockedHint') }}</div>
                        <div class="admin-data-blocked-actions">
                            <q-btn outline color="primary" dense no-caps icon="la la-archive" to="/admin/backups">
                                {{ $t('settings.admin.userDataRestore') }}
                            </q-btn>
                            <q-btn outline color="negative" dense no-caps icon="la la-broom" :loading="userDataResetLoading" @click="acceptUserDataReset">
                                {{ $t('settings.admin.userDataReset') }}
                            </q-btn>
                        </div>
                    </div>
                </div>

                    <AdminOverview v-if="section === 'overview'" :admin="adminContext" />

                    <AdminUsers v-else-if="section === 'users'" />

                    <AdminLibrary v-else-if="section === 'library'" :admin="adminContext" />

                    <AdminStorage v-else-if="section === 'storage'" :admin="adminContext" />

                    <AdminBackups v-else-if="section === 'backups'" @restored="onBackupRestored" />

                    <AdminLog v-else-if="section === 'log'" :admin="adminContext" />

                    <!-- v-show на обёртке, не на компоненте: у компонента с комментарием в корне v-show молча не работает; несохранённые правки переживают переключение разделов -->
                    <div v-show="section === 'integrations'">
                        <AdminIntegrations />
                    </div>
                </div>
            </div>
        </div>

        <DiscoverySourceDialog v-if="canEditExternalDiscovery" v-model="discoverySourceDialogVisible" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import DiscoverySourceDialog from './DiscoverySourceDialog.vue';
import AdminUsers from './AdminUsers.vue';
import AdminOverview from './AdminOverview.vue';
import AdminLibrary from './AdminLibrary.vue';
import AdminStorage from './AdminStorage.vue';
import AdminLog from './AdminLog.vue';
import AdminIntegrations from './AdminIntegrations.vue';
import AdminBackups from './AdminBackups.vue';
import {t, formatDateTime} from '../../share/i18n';
import {isAdmin} from '../../share/session';

const componentOptions = {
    components: {
        DiscoverySourceDialog,
        AdminUsers,
        AdminOverview,
        AdminLibrary,
        AdminStorage,
        AdminLog,
        AdminIntegrations,
        AdminBackups,
    },
    watch: {
        settings() {
            this.loadSettings();
        },
        section() {
            this.updateTitle();
        },
    },
};

class AdminPage {
    _options = componentOptions;
    isActive = false;
    discoveryExternalSource = '';
    discoveryExternalName = '';
    discoverySourceDialogVisible = false;
    adminLoading = false;
    adminCleanLoading = false;
    adminCleanBookCacheLoading = false;
    adminCleanCoverCacheLoading = false;
    adminCacheSaveLoading = false;
    adminReindexLoading = false;
    userDataResetLoading = false;
    adminSourcesLoading = false;
    adminBrokenCoversLoading = false;
    adminCoverRebuildLoading = false;
    adminCoverBookUid = '';
    adminTestEventLoading = false;
    adminEventsLoading = false;
    adminEventsRequestId = 0;
    adminSourcesReindexNeeded = false;
    adminReindexInProgress = false;
    adminIndexPollTimer = null;
    adminMetricsPollTimer = null;
    adminMetricsPollInFlight = false;
    adminDashboard = {};
    adminCacheSettings = this.makeDefaultAdminCacheSettings();
    adminSources = [];
    adminEvents = [];
    adminEventLevel = 'all';
    adminEventCategory = 'all';
    adminEventLogEnabled = true;
    adminEventLogSize = 300;

    get adminCacheWeekDayOptions() {
        return [
            {label: t('settings.monday'), value: 1},
            {label: t('settings.tuesday'), value: 2},
            {label: t('settings.wednesday'), value: 3},
            {label: t('settings.thursday'), value: 4},
            {label: t('settings.friday'), value: 5},
            {label: t('settings.saturday'), value: 6},
            {label: t('settings.sunday'), value: 0},
        ];
    }

    created() {
        this.commit = this.$store.commit;
        this.api = this.$root.api;
        this.loadSettings();
    }

    activated() {
        this.isActive = true;
        this.updateTitle();
        if (this.canEditExternalDiscovery)
            this.loadAdminPanel();// no await
    }

    deactivated() {
        this.isActive = false;
        this.stopAdminMetricsPolling();
    }

    unmounted() {
        this.isActive = false;
        this.stopAdminMetricsPolling();
        this.stopAdminIndexPolling();
    }

    get catalogSearchEnabled() {
        return !!(this.config.catalogSearch || {}).enabled;
    }

    get sections() {
        return [
            {id: 'overview', label: t('admin.overview'), icon: 'la la-tachometer-alt'},
            {id: 'users', label: t('admin.users'), icon: 'la la-users'},
            {id: 'library', label: t('settings.library'), icon: 'la la-book'},
            {id: 'integrations', label: t('admin.integrations'), icon: 'la la-plug'},
            {id: 'storage', label: t('settings.storage'), icon: 'la la-hdd'},
            {id: 'backups', label: t('admin.backups'), icon: 'la la-archive'},
            {id: 'log', label: t('admin.eventLog'), icon: 'la la-stream'},
        ];
    }

    get section() {
        const value = String(this.$route.params.section || 'overview');
        return this.sections.some(item => item.id === value) ? value : 'overview';
    }

    get sectionLabel() {
        const item = this.sections.find(row => row.id === this.section);
        return item ? item.label : t('settings.admin.title');
    }

    //разделы обзор/библиотека/хранилище/журнал вынесены в дочерние компоненты: данные и таймеры опроса
    //остаются здесь (один владелец на всю страницу), разделам передаётся сама страница
    get adminContext() {
        return this;
    }

    updateTitle() {
        if (this.$route.path.startsWith('/admin'))
            this.$root.setAppTitle(`${t('settings.admin.title')}: ${this.sectionLabel}`);
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get discoveryConfig() {
        return this.config.discovery || {};
    }

    get discoveryEnabled() {
        return (this.discoveryConfig.enabled !== false);
    }

    get canEditExternalDiscovery() {
        return isAdmin(this.config);
    }

    get externalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    get effectiveExternalDiscoverySource() {
        const value = String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalSource || this.discoveryConfig.externalSource || '')
                : (this.discoveryConfig.externalSource || ''),
        ).trim().toLowerCase();
        return (value && value !== 'none' ? 'wikidata-awards' : 'none');
    }

    get effectiveExternalDiscoveryName() {
        return String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalName || this.discoveryConfig.externalName || '')
                : (this.discoveryConfig.externalName || ''),
        ).trim();
    }

    get effectiveExternalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.effectiveExternalDiscoverySource !== 'none');
    }

    get externalDiscoverySummary() {
        if (!this.effectiveExternalDiscoveryAvailable)
            return t('settings.notConfigured');

        const name = this.effectiveExternalDiscoveryName || t('common.externalSource');
        return t('settings.awardsShowcase', {name});
    }

    loadSettings() {
        const settings = this.settings;
        const configExternalSource = (String(this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'wikidata-awards');
        const hasStoredExternalSettings = !!(
            String(settings.discoveryExternalSource || '').trim()
            || String(settings.discoveryExternalName || '').trim()
        );

        if (!hasStoredExternalSettings && configExternalSource !== 'none') {
            this.commit('setSettings', {
                discoveryExternalSource: configExternalSource,
                discoveryExternalName: String(this.discoveryConfig.externalName || '').trim(),
                discoveryExternalTtlMinutes: Math.max(1440, parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440),
            });
        }

        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'wikidata-awards');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
    }

    makeDefaultAdminCacheSettings() {
        return {
            bookCacheSizeMb: 2048,
            coverCacheSizeMb: 512,
            cacheCleanEnabled: true,
            cacheCleanFrequency: 'daily',
            cacheCleanTime: '00:00',
            cacheCleanWeekDay: 1,
            cacheCleanMonthDay: 1,
            cacheCleanAdvancedSchedule: '',
            cacheCleanTargetPercent: 80,
            fromEnv: {},
        };
    }

    syncAdminCacheSettings() {
        const limits = (this.adminDashboard && this.adminDashboard.limits) || {};
        const toMb = (value, fallback) => {
            const size = Number(value || 0);
            return Math.max(1, Math.round((size > 0 ? size : fallback) / (1024 * 1024)));
        };
        const ratio = Number(limits.cacheCleanTargetRatio || 0.8);
        const schedule = this.parseDailyCacheSchedule(limits.cacheCleanSchedule || '0 0 * * *');

        this.adminCacheSettings = {
            bookCacheSizeMb: toMb(limits.bookCacheSize, 2048 * 1024 * 1024),
            coverCacheSizeMb: toMb(limits.coverCacheSize, 512 * 1024 * 1024),
            cacheCleanEnabled: schedule.enabled,
            cacheCleanFrequency: schedule.frequency,
            cacheCleanTime: schedule.time,
            cacheCleanWeekDay: schedule.weekDay,
            cacheCleanMonthDay: schedule.monthDay,
            cacheCleanAdvancedSchedule: schedule.advancedSchedule,
            cacheCleanTargetPercent: Math.max(10, Math.min(100, Math.round(ratio * 100))),
            fromEnv: limits.fromEnv || {},
        };
    }

    parseAdminCacheSchedule(schedule = '') {
        const text = String(schedule || '').trim();
        if (!text)
            return this.makeParsedAdminCacheSchedule({enabled: false});

        const fields = text.split(/\s+/);
        if (fields.length !== 5)
            return this.makeParsedAdminCacheSchedule({advancedSchedule: text});

        const [minuteText, hourText, dayOfMonth, month, dayOfWeek] = fields;
        const minute = this.clampAdminCacheNumber(minuteText, 0, 59, 0);
        const hour = this.clampAdminCacheNumber(hourText, 0, 23, 0);
        const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        if (month === '*' && dayOfMonth === '*' && dayOfWeek === '*')
            return this.makeParsedAdminCacheSchedule({frequency: 'daily', time});

        if (month === '*' && dayOfMonth === '*' && /^\d{1,2}$/.test(dayOfWeek)) {
            const weekDay = this.clampAdminCacheNumber(dayOfWeek, 0, 7, 1);
            return this.makeParsedAdminCacheSchedule({frequency: 'weekly', time, weekDay: weekDay === 7 ? 0 : weekDay});
        }

        if (month === '*' && dayOfWeek === '*' && /^\d{1,2}$/.test(dayOfMonth)) {
            const monthDay = this.clampAdminCacheNumber(dayOfMonth, 1, 31, 1);
            return this.makeParsedAdminCacheSchedule({frequency: 'monthly', time, monthDay});
        }

        return this.makeParsedAdminCacheSchedule({advancedSchedule: text});
    }

    makeParsedAdminCacheSchedule(values = {}) {
        return {
            enabled: values.enabled !== false,
            frequency: values.frequency || (values.advancedSchedule ? 'advanced' : 'daily'),
            time: values.time || '00:00',
            weekDay: values.weekDay === 0 ? 0 : (values.weekDay || 1),
            monthDay: values.monthDay || 1,
            advancedSchedule: values.advancedSchedule || '',
        };
    }

    clampAdminCacheNumber(value, min, max, fallback) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed))
            return fallback;

        return Math.max(min, Math.min(max, parsed));
    }

    parseDailyCacheSchedule(schedule = '') {
        return this.parseAdminCacheSchedule(schedule);
    }

    dailyCacheScheduleFromSettings(settings = this.adminCacheSettings) {
        if (!settings.cacheCleanEnabled)
            return '';
        if (settings.cacheCleanAdvancedSchedule && !['daily', 'weekly', 'monthly'].includes(settings.cacheCleanFrequency))
            return settings.cacheCleanAdvancedSchedule;

        const match = String(settings.cacheCleanTime || '00:00').trim().match(/^(\d{1,2}):(\d{2})$/);
        const hour = match ? this.clampAdminCacheNumber(match[1], 0, 23, 0) : 0;
        const minute = match ? this.clampAdminCacheNumber(match[2], 0, 59, 0) : 0;
        const frequency = String(settings.cacheCleanFrequency || 'daily');

        if (frequency === 'weekly') {
            const weekDay = this.clampAdminCacheNumber(settings.cacheCleanWeekDay, 0, 7, 1);
            return `${minute} ${hour} * * ${weekDay === 7 ? 0 : weekDay}`;
        }

        if (frequency === 'monthly') {
            const monthDay = this.clampAdminCacheNumber(settings.cacheCleanMonthDay, 1, 31, 1);
            return `${minute} ${hour} ${monthDay} * *`;
        }

        return `${minute} ${hour} * * *`;
    }

    adminCacheWeekDayLabel(value = 1) {
        const normalized = value === 7 ? 0 : value;
        const option = this.adminCacheWeekDayOptions.find(item => item.value === normalized);
        return option ? option.label.toLowerCase() : '';
    }

    formatBytes(value) {
        let size = Number(value || 0);
        if (!(size > 0))
            return '0 MB';

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }

        return `${size.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
    }

    formatDateTime(value = '') {
        return formatDateTime(value, {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
    }

    adminCacheTargetText(value) {
        if (value === null || value === undefined)
            return '';

        return t('settings.cleanupTarget', {value: this.formatBytes(value)});
    }

    adminCacheScheduleText(schedule = '', nextRunAt = '', timeZone = '') {
        if (!schedule)
            return t('settings.rotationStatusDisabled');

        const parts = [t('settings.rotationStatus', {value: this.adminCacheScheduleLabel(schedule)})];
        const nextRun = this.formatServerDateTime(nextRunAt, timeZone);
        if (nextRun)
            parts.push(t('settings.nextShort', {value: nextRun}));
        if (timeZone)
            parts.push(timeZone);

        return parts.join(' · ');
    }

    adminCacheScheduleLabel(schedule = '') {
        const parsed = this.parseAdminCacheSchedule(schedule);
        if (!parsed.enabled)
            return t('settings.rotationDisabledLower');
        if (parsed.advancedSchedule)
            return schedule;
        if (parsed.frequency === 'weekly')
            return t('settings.scheduleWeeklyAt', {day: this.adminCacheWeekDayLabel(parsed.weekDay), time: parsed.time});
        if (parsed.frequency === 'monthly')
            return t('settings.scheduleMonthlyAt', {day: parsed.monthDay, time: parsed.time});

        return t('settings.scheduleDailyAt', {time: parsed.time});
    }

    formatServerDateTime(value = '', timeZone = '') {
        if (!value)
            return '';

        try {
            return formatDateTime(value, {
                timeZone: timeZone || undefined,
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch (e) {
            return this.formatDateTime(value);
        }
    }

    get adminIndex() {
        return (this.adminDashboard && this.adminDashboard.index) || {};
    }

    get adminIndexBusy() {
        const state = String(this.adminIndex.state || '');
        return state === 'db_creating' || state === 'db_loading' || (this.adminReindexInProgress && this.adminIndex.ready !== true);
    }

    //файлы данных, которые не читаются: запись в них отклоняется, пока администратор не решит, что делать
    get userDataBlocked() {
        return (this.adminDashboard && this.adminDashboard.userDataBlocked) || [];
    }

    get adminIndexStatusVisible() {
        return this.adminIndexBusy || this.adminSourcesReindexNeeded || this.adminIndex.ready === false;
    }

    get adminIndexStatusTitle() {
        if (this.adminIndexBusy)
            return t('settings.admin.indexBusy');
        if (this.adminSourcesReindexNeeded)
            return t('settings.admin.indexNeedsReindex');
        if (this.adminIndex.ready === false)
            return t('settings.admin.indexNotReady');

        return t('settings.admin.indexReady');
    }

    get adminIndexStatusText() {
        return this.adminIndex.jobMessage
            || this.adminIndex.serverMessage
            || (this.adminSourcesReindexNeeded ? t('settings.admin.sourcesNeedReindex') : t('settings.admin.indexWaiting'));
    }

    get adminIndexProgress() {
        const progress = parseFloat(this.adminIndex.progress);
        if (!Number.isFinite(progress) || progress <= 0)
            return 0;

        return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
    }

    get adminSourcesChanged() {
        const original = ((this.adminDashboard && this.adminDashboard.sources) || [])
            .map(source => this.normalizeAdminSourceForCompare(source));
        const current = (this.adminSources || [])
            .map(source => this.normalizeAdminSourceForCompare(source));
        return JSON.stringify(original) !== JSON.stringify(current);
    }

    //включение, название и папка библиотеки применяются без переиндексации; нужна она при смене набора библиотек или INPX
    get adminSourcesNeedReindex() {
        const shape = list => JSON.stringify(list.map(source => {
            const {id, inpx, remote} = this.normalizeAdminSourceForCompare(source);
            return [id, inpx, remote && remote.url, remote && remote.source];
        }));
        return shape((this.adminDashboard && this.adminDashboard.sources) || []) !== shape(this.adminSources || []);
    }

    normalizeAdminSourceForCompare(source = {}) {
        return {
            id: String(source.id || '').trim(),
            name: String(source.name || '').trim(),
            inpx: String(source.inpx || '').trim(),
            libDir: String(source.libDir || '').trim(),
            enabled: source.enabled !== false,
            //введённый токен - тоже изменение
            remote: (source.remote ? {url: String(source.remote.url || '').trim(), source: String(source.remote.source || '').trim(),
                token: String(source.remote.token || '')} : null),
        };
    }

    syncAdminSources() {
        const sources = (this.adminDashboard && this.adminDashboard.sources) || [];
        this.adminSources = sources.map(source => ({
            id: source.id || '',
            name: source.name || '',
            inpx: source.inpx || '',
            libDir: source.libDir || '',
            enabled: source.enabled !== false,
            inpxExists: source.inpxExists === true,
            libDirExists: source.libDirExists === true,
            foundInpx: source.foundInpx || [],
            archiveCount: source.archiveCount || 0,
            archiveCountTruncated: source.archiveCountTruncated === true,
            hasCovers: source.hasCovers === true,
            hasEtc: source.hasEtc === true,
            hasImages: source.hasImages === true,
            remote: (source.remote ? Object.assign({}, source.remote, {token: ''}) : null),
            diagnosticsLoading: false,
        }));
    }

    async loadAdminPanel() {
        this.adminLoading = true;
        try {
            await this.refreshAdminDashboard(true);
            this.refreshAdminEvents();
            this.startAdminMetricsPolling();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminLoading = false;
        }
    }

    async refreshAdminDashboard(syncSources = false) {
        this.adminDashboard = await this.api.getAdminDashboard();
        this.syncAdminCacheSettings();
        if (syncSources)
            this.syncAdminSources();
    }

    async refreshAdminMetrics() {
        const metrics = await this.api.getAdminDashboardMetrics();
        this.adminDashboard = Object.assign({}, this.adminDashboard, metrics);
    }

    startAdminMetricsPolling(delay = 5000) {
        this.stopAdminMetricsPolling();
        if (!this.isActive)
            return;

        this.adminMetricsPollTimer = setTimeout(async() => {
            this.adminMetricsPollTimer = null;
            if (!this.isActive)
                return;

            if (this.adminMetricsPollInFlight || this.adminIndexBusy || this.adminReindexInProgress) {
                this.startAdminMetricsPolling();
                return;
            }

            this.adminMetricsPollInFlight = true;
            try {
                await this.refreshAdminMetrics();
                await this.refreshAdminEvents({quiet: true});
            } catch (e) {
                // Keep the settings panel quiet; the next tick or manual refresh can recover.
            } finally {
                this.adminMetricsPollInFlight = false;
            }

            if (this.isActive)
                this.startAdminMetricsPolling();
        }, delay);
    }

    stopAdminMetricsPolling() {
        if (!this.adminMetricsPollTimer)
            return;

        clearTimeout(this.adminMetricsPollTimer);
        this.adminMetricsPollTimer = null;
    }

    scheduleAdminIndexPolling(delay = 2500) {
        this.stopAdminIndexPolling();
        this.adminIndexPollTimer = setTimeout(async() => {
            this.adminIndexPollTimer = null;
            if (!this.isActive && !this.adminReindexInProgress)
                return;

            try {
                await this.refreshAdminDashboard(false);
                if (this.adminIndexBusy) {
                    this.scheduleAdminIndexPolling();
                } else {
                    this.adminReindexInProgress = false;
                    this.refreshAdminEvents();
                }
            } catch (e) {
                this.adminReindexInProgress = false;
                this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
            }
        }, delay);
    }

    stopAdminIndexPolling() {
        if (!this.adminIndexPollTimer)
            return;

        clearTimeout(this.adminIndexPollTimer);
        this.adminIndexPollTimer = null;
    }

    async refreshAdminEvents(options = {}) {
        const quiet = options.quiet === true;
        const requestId = ++this.adminEventsRequestId;
        if (!quiet)
            this.adminEventsLoading = true;
        try {
            const result = await this.api.getAdminEvents({
                level: this.adminEventLevel,
                category: this.adminEventCategory,
                limit: 50,
            });
            if (requestId !== this.adminEventsRequestId)
                return;

            this.adminEventLogEnabled = result.enabled !== false;
            this.adminEventLogSize = parseInt(result.maxSize, 10) || 300;
            this.adminEvents = result.events || [];
        } catch (e) {
            if (!quiet && requestId === this.adminEventsRequestId)
                this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            if (!quiet)
                this.adminEventsLoading = false;
        }
    }

    async saveAdminEventLog() {
        try {
            const result = await this.api.updateAdminEventLog({
                enabled: this.adminEventLogEnabled,
                maxSize: this.adminEventLogSize,
            });
            this.adminEventLogEnabled = result.enabled !== false;
            this.adminEventLogSize = parseInt(result.maxSize, 10) || this.adminEventLogSize;
            await this.refreshAdminEvents();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        }
    }

    async addAdminTestEvent() {
        this.adminTestEventLoading = true;
        try {
            await this.api.addAdminTestEvent('warn');
            await this.refreshAdminEvents();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminTestEventLoading = false;
        }
    }

    //remote - библиотека другого сервера inpx-shelf (API /remote/)
    addAdminSource(remote = false) {
        this.adminSources.push({
            id: '',
            name: '',
            inpx: '',
            libDir: '',
            enabled: true,
            inpxExists: false,
            libDirExists: false,
            foundInpx: [],
            archiveCount: 0,
            archiveCountTruncated: false,
            hasCovers: false,
            hasEtc: false,
            hasImages: false,
            remote: (remote ? {url: '', source: '', token: '', tokenSet: false} : null),
            diagnosticsLoading: false,
        });
    }

    removeAdminSource(index) {
        this.adminSources.splice(index, 1);
    }

    setAdminSource(index, patch = {}) {
        const source = this.adminSources[index];
        if (!source)
            return;

        this.adminSources.splice(index, 1, Object.assign({}, source, patch));
    }

    async diagnoseAdminSource(index) {
        const source = this.adminSources[index];
        if (!source)
            return;

        this.setAdminSource(index, {diagnosticsLoading: true});
        try {
            const diagnostics = await this.api.adminDiagnoseLibrarySource(source);
            this.setAdminSource(index, Object.assign({}, diagnostics, {diagnosticsLoading: false}));
        } catch (e) {
            this.setAdminSource(index, {diagnosticsLoading: false});
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        }
    }

    async saveAdminSources() {
        this.adminSourcesLoading = true;
        try {
            const result = await this.api.updateAdminLibrarySources(this.adminSources);
            await this.api.updateConfig();
            await this.loadAdminPanel();
            this.adminSourcesReindexNeeded = this.adminSourcesReindexNeeded || !!(result && result.reindexNeeded);
            this.$root.notify.success(t('settings.admin.savedSources'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminSourcesLoading = false;
        }
    }

    cacheCleanSummary(result = {}) {
        const rows = Array.isArray(result.cleaned) ? result.cleaned : [];
        if (!rows.length)
            return t('settings.cacheAlreadyClean');

        return rows.map(row => {
            const title = row.title || row.id || t('settings.cache');
            const removed = Number(row.removed || 0);
            return t('settings.cacheCleanResult', {title, removed, size: this.formatBytes(row.after || row.size || 0)});
        }).join(' · ');
    }

    async saveAdminCacheSettings() {
        this.adminCacheSaveLoading = true;
        try {
            //поля, заданные окружением, не отправляются: сервер всё равно их не сохранит
            const locked = this.adminCacheSettings.fromEnv;
            const patch = {cacheCleanSchedule: this.dailyCacheScheduleFromSettings()};
            if (!locked.bookCacheSize)
                patch.bookCacheSizeMb = this.adminCacheSettings.bookCacheSizeMb;
            if (!locked.coverCacheSize)
                patch.coverCacheSizeMb = this.adminCacheSettings.coverCacheSizeMb;
            if (!locked.cacheCleanTargetRatio)
                patch.cacheCleanTargetPercent = this.adminCacheSettings.cacheCleanTargetPercent;
            await this.api.updateAdminCache(patch);
            await this.api.updateConfig();
            await this.refreshAdminDashboard(false);
            this.$root.notify.success(t('settings.cacheRotationSettingsSaved'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminCacheSaveLoading = false;
        }
    }

    async cleanAdminCache(kind = 'all') {
        const normalizedKind = String(kind || 'all');
        //очистка необратима: готовые файлы книг и обложки будут заново собираться при первом обращении
        const [message, caption] = {
            book: ['settings.clearBookCacheConfirm', 'settings.clearBookCache'],
            cover: ['settings.clearCoverCacheConfirm', 'settings.clearCoverCache'],
        }[normalizedKind] || ['settings.clearBothCachesConfirm', 'settings.clearBothCaches'];
        if (!await this.$root.stdDialog.confirm(t(message), t(caption), {okLabel: t(caption)}))
            return;

        if (normalizedKind === 'book')
            this.adminCleanBookCacheLoading = true;
        else if (normalizedKind === 'cover')
            this.adminCleanCoverCacheLoading = true;
        else
            this.adminCleanLoading = true;

        try {
            const result = await this.api.adminCleanCache(normalizedKind);
            await this.loadAdminPanel();
            this.$root.notify.success(this.cacheCleanSummary(result));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            if (normalizedKind === 'book')
                this.adminCleanBookCacheLoading = false;
            else if (normalizedKind === 'cover')
                this.adminCleanCoverCacheLoading = false;
            else
                this.adminCleanLoading = false;
        }
    }

    async cleanBrokenCovers() {
        this.adminBrokenCoversLoading = true;
        try {
            const result = await this.api.adminCleanBrokenCovers();
            await this.loadAdminPanel();
            this.$root.notify.success(`${t('settings.admin.brokenCoversCleaned')}: ${result.removed || 0}`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminBrokenCoversLoading = false;
        }
    }

    async rebuildAdminCover() {
        const bookUid = String(this.adminCoverBookUid || '').trim();
        if (!bookUid) {
            this.$root.stdDialog.alert(t('settings.admin.coverBookUid'), t('settings.mail.errorTitle'));
            return;
        }

        this.adminCoverRebuildLoading = true;
        try {
            const result = await this.api.adminRebuildCover(bookUid);
            await this.refreshAdminDashboard(false);
            this.$root.notify.success(t('settings.admin.coverRebuildStarted'));
            if (result.coverUrl)
                window.setTimeout(() => { (new Image()).src = `${result.coverUrl}?t=${Date.now()}`; }, 50);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminCoverRebuildLoading = false;
        }
    }

    onBackupRestored() {
        this.loadSettings();
        //восстановленный файл снимает предупреждение о нечитаемых данных
        this.refreshAdminDashboard(false).catch(() => {});
    }

    async acceptUserDataReset() {
        const files = this.userDataBlocked.map(item => item.file).join(', ');
        const caption = t('settings.admin.userDataReset');
        if (!await this.$root.stdDialog.confirm(t('settings.admin.userDataResetConfirm', {files}), caption, {okLabel: caption}))
            return;

        this.userDataResetLoading = true;
        try {
            await this.api.adminAcceptUserDataReset();
            await this.refreshAdminDashboard(false);
            this.$root.notify.success(t('settings.admin.userDataResetDone'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.userDataResetLoading = false;
        }
    }

    async reindexAdmin() {
        //на время перестройки библиотека недоступна всем читателям
        if (!await this.$root.stdDialog.confirm(t('settings.admin.reindexConfirm'), t('settings.admin.reindex'), {okLabel: t('settings.admin.reindex')}))
            return;

        this.adminReindexLoading = true;
        try {
            await this.api.adminReindex();
            this.adminSourcesReindexNeeded = false;
            this.adminReindexInProgress = true;
            await this.refreshAdminDashboard(false);
            this.scheduleAdminIndexPolling(1500);
            this.$root.notify.success(t('settings.admin.reindexStarted'));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('settings.mail.errorTitle'));
        } finally {
            this.adminReindexLoading = false;
        }
    }

}

export default vueComponent(AdminPage);
//-----------------------------------------------------------------------------
</script>

<style scoped>

.admin-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.admin-index-status {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    color: var(--app-text);
    background: color-mix(in srgb, var(--app-primary) 5%, var(--app-surface));
}

.admin-index-status--busy {
    border-color: color-mix(in srgb, var(--app-primary) 45%, var(--app-border));
}

.admin-index-status-copy {
    min-width: 0;
    flex: 1;
}

.admin-index-status-title {
    font-weight: 800;
}

.admin-index-status-text {
    margin-top: 2px;
    color: var(--app-muted);
    font-size: 13px;
}

.admin-index-status :deep(.q-linear-progress) {
    margin-top: 8px;
}

.admin-data-blocked {
    border-color: var(--app-danger);
    background: color-mix(in srgb, var(--app-danger) 8%, var(--app-surface));
}

.admin-data-blocked > .q-icon {
    color: var(--app-danger);
}

.admin-data-blocked-file {
    margin-top: 4px;
    overflow-wrap: anywhere;
}

.admin-data-blocked-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
}
</style>
