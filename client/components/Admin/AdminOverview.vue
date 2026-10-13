<template>
    <div class="admin-dashboard-sections">
        <section class="admin-dashboard-section">
            <div class="admin-dashboard-section-title">{{ $t('settings.library') }}</div>
            <div class="admin-dashboard-grid">
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.books') }}</div>
                    <div class="admin-stat-value">{{ adminStat('bookCountAll') }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.authors') }}</div>
                    <div class="admin-stat-value">{{ adminStat('authorCountAll') }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.series') }}</div>
                    <div class="admin-stat-value">{{ adminStat('seriesCount') }}</div>
                </div>
            </div>
        </section>

        <section class="admin-dashboard-section">
            <div class="admin-dashboard-section-title">{{ $t('settings.process') }}</div>
            <div class="admin-dashboard-grid">
                <div class="admin-stat">
                    <div class="admin-stat-label">Uptime</div>
                    <div class="admin-stat-value">{{ adminUptime }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.memory') }}</div>
                    <div class="admin-stat-value">{{ admin.formatBytes(admin.adminDashboard.memory && admin.adminDashboard.memory.rss) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.cpu') }}</div>
                    <div class="admin-stat-value">{{ adminCpuText }}</div>
                    <div class="admin-stat-hint">{{ adminCpuHint }}</div>
                </div>
            </div>
        </section>

        <section class="admin-dashboard-section admin-dashboard-section--wide">
            <div class="admin-dashboard-section-title">{{ $t('settings.admin.requests') }}</div>
            <div class="admin-dashboard-grid admin-dashboard-grid--runtime">
                <div class="admin-stat">
                    <div class="admin-stat-label">WebSocket action</div>
                    <div class="admin-stat-value">{{ adminRuntime.totalActions || 0 }}</div>
                    <div class="admin-stat-hint">{{ adminRuntimeHint }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">Event loop</div>
                    <div class="admin-stat-value">{{ runtimeLagText }}</div>
                    <div class="admin-stat-hint">{{ runtimeLagHint }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.lastSlowAction') }}</div>
                    <div class="admin-stat-value admin-stat-value--small">{{ runtimeLastSlowActionText }}</div>
                    <div class="admin-stat-hint">{{ runtimeLastSlowActionHint }}</div>
                </div>
            </div>
            <div v-if="runtimeSlowestActions.length" class="admin-runtime-list">
                <div v-for="item in runtimeSlowestActions" :key="item.action" class="admin-runtime-row">
                    <span class="admin-runtime-action">{{ item.action }}</span>
                    <span class="admin-runtime-value">{{ actionDurationText(item) }}</span>
                </div>
            </div>
        </section>

        <section class="admin-dashboard-section admin-dashboard-section--wide">
            <div class="admin-dashboard-section-title">{{ $t('settings.recommendationQuality') }}</div>
            <div class="admin-dashboard-grid admin-dashboard-grid--runtime">
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.metricImpressions') }}</div>
                    <div class="admin-stat-value">{{ discoveryMetric('impression') }}</div>
                    <div class="admin-stat-hint">{{ $t('settings.metricProfiles', {n: adminDiscovery.profiles || 0}) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.metricOpenCtr') }}</div>
                    <div class="admin-stat-value">{{ discoveryRateText('ctr') }}</div>
                    <div class="admin-stat-hint">{{ $t('settings.metricOpens', {n: discoveryMetric('open')}) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.metricStartedReading') }}</div>
                    <div class="admin-stat-value">{{ discoveryRateText('start') }}</div>
                    <div class="admin-stat-hint">{{ $t('settings.metricStarts', {n: discoveryMetric('start')}) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.metricSaved') }}</div>
                    <div class="admin-stat-value">{{ discoveryRateText('save') }}</div>
                    <div class="admin-stat-hint">{{ $t('settings.metricSaves', {n: discoveryMetric('save')}) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.metricSetUpTastes') }}</div>
                    <div class="admin-stat-value">{{ adminDiscovery.configuredProfiles || 0 }}</div>
                    <div class="admin-stat-hint">{{ $t('settings.metricTastesHint') }}</div>
                </div>
            </div>
        </section>

        <section class="admin-dashboard-section">
            <div class="admin-dashboard-section-title">{{ $t('settings.storage') }}</div>
            <div class="admin-dashboard-grid admin-dashboard-grid--storage">
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.dbSize') }}</div>
                    <div class="admin-stat-value">{{ admin.formatBytes(admin.adminDashboard.sizes && admin.adminDashboard.sizes.db && admin.adminDashboard.sizes.db.size) }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.bookCache') }}</div>
                    <div class="admin-stat-value">{{ admin.formatBytes(admin.adminDashboard.sizes && admin.adminDashboard.sizes.bookCache && admin.adminDashboard.sizes.bookCache.size) }}</div>
                    <div class="admin-stat-hint">{{ adminCacheLimitText('book') }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.admin.coverCache') }}</div>
                    <div class="admin-stat-value">{{ admin.formatBytes(admin.adminDashboard.sizes && admin.adminDashboard.sizes.coverCache && admin.adminDashboard.sizes.coverCache.size) }}</div>
                    <div class="admin-stat-hint">{{ adminCacheLimitText('cover') }}</div>
                </div>
                <div class="admin-stat">
                    <div class="admin-stat-label">{{ $t('settings.cacheRotation') }}</div>
                    <div class="admin-stat-value">{{ adminCacheRotationValue() }}</div>
                    <div class="admin-stat-hint">{{ adminCacheRotationHint() }}</div>
                </div>
            </div>
        </section>
    </div>

    <div class="admin-subsection">
        <div class="admin-subsection-head">
            <div class="admin-mail-title">{{ $t('settings.admin.tasks') }}</div>
        </div>
        <div class="admin-task-list">
            <div v-for="task in adminTasks" :key="task.id" class="admin-task-row" :class="{'admin-task-row--active': task.active}">
                <div class="admin-task-main">
                    <div class="admin-task-title">{{ $tm(task.title) }}</div>
                    <div class="admin-task-message">{{ task.message ? $tm(task.message) : (task.state || $t('settings.admin.noTaskMessage')) }}</div>
                    <q-linear-progress v-if="task.active" rounded size="6px" :value="taskProgress(task)" color="primary" />
                    <div v-if="task.lastError" class="admin-task-error">{{ task.lastError }}</div>
                </div>
                <q-btn flat dense no-caps :disable="true" icon="la la-ban">
                    {{ task.cancellable ? $t('settings.admin.cancel') : $t('settings.admin.noCancel') }}
                </q-btn>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import {t} from '../../share/i18n';

//Раздел страницы администрирования: данные, действия и таймеры опроса остаются в AdminPage, сюда приходит её экземпляр
class AdminOverview {
    _props = {
        admin: {type: Object, required: true},
    };

    formatDuration(seconds = 0) {
        let total = Math.max(0, Math.round(Number(seconds || 0)));
        const days = Math.floor(total / 86400);
        total -= days * 86400;
        const hours = Math.floor(total / 3600);
        total -= hours * 3600;
        const minutes = Math.floor(total / 60);

        return [
            days ? t('settings.durationDays', {n: days}) : '',
            hours ? t('settings.durationHours', {n: hours}) : '',
            t('settings.durationMinutes', {n: minutes}),
        ].filter(Boolean).join(' ');
    }

    formatMilliseconds(value = 0) {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0)
            return '0 ms';
        if (ms < 1000)
            return `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;

        return `${(ms / 1000).toFixed(1)} s`;
    }

    adminStat(name) {
        const stats = (this.admin.adminDashboard && this.admin.adminDashboard.stats) || {};
        const value = stats[name];
        return (value === undefined || value === null ? '0' : String(value));
    }

    adminCacheLimitText(kind = '') {
        const limits = (this.admin.adminDashboard && this.admin.adminDashboard.limits) || {};
        const limit = kind === 'book' ? limits.bookCacheSize : limits.coverCacheSize;
        const target = kind === 'book' ? limits.bookCacheTargetSize : limits.coverCacheTargetSize;
        const parts = [];

        if (limit !== null && limit !== undefined)
            parts.push(t('settings.limitValue', {value: this.admin.formatBytes(limit)}));
        if (target !== null && target !== undefined)
            parts.push(this.admin.adminCacheTargetText(target));

        return parts.filter(Boolean).join(' · ');
    }

    adminCacheRotationValue() {
        const limits = (this.admin.adminDashboard && this.admin.adminDashboard.limits) || {};
        const schedule = String(limits.cacheCleanSchedule || '').trim();
        const parsed = this.admin.parseAdminCacheSchedule(schedule);
        if (!parsed.enabled)
            return t('settings.rotationDisabled');
        if (parsed.advancedSchedule)
            return t('settings.scheduleCron');
        if (parsed.frequency === 'weekly')
            return t('settings.frequencyWeekly');
        if (parsed.frequency === 'monthly')
            return t('settings.frequencyMonthly');

        return t('settings.frequencyDaily');
    }

    adminCacheRotationHint() {
        const limits = (this.admin.adminDashboard && this.admin.adminDashboard.limits) || {};
        const schedule = String(limits.cacheCleanSchedule || '').trim();
        const parsed = this.admin.parseAdminCacheSchedule(schedule);
        const nextRun = this.admin.formatServerDateTime(limits.cacheCleanNextRunAt, limits.cacheCleanServerTimeZone);
        const parts = [];

        if (parsed.enabled && !parsed.advancedSchedule) {
            if (parsed.frequency === 'weekly')
                parts.push(`${this.admin.adminCacheWeekDayLabel(parsed.weekDay)}, ${parsed.time}`);
            else if (parsed.frequency === 'monthly')
                parts.push(t('settings.monthDayAt', {day: parsed.monthDay, time: parsed.time}));
            else
                parts.push(parsed.time);
        } else if (parsed.advancedSchedule) {
            parts.push(schedule);
        }
        if (nextRun)
            parts.push(t('settings.nextRun', {value: nextRun}));
        if (limits.cacheCleanServerTimeZone)
            parts.push(limits.cacheCleanServerTimeZone);

        return parts.join(' · ');
    }

    get adminUptime() {
        return this.formatDuration(this.admin.adminDashboard && this.admin.adminDashboard.uptime);
    }

    get adminCpuText() {
        const cpu = (this.admin.adminDashboard && this.admin.adminDashboard.cpu) || {};
        const percent = Number.isFinite(Number(cpu.currentPercent)) ? Number(cpu.currentPercent) : Number(cpu.averagePercent);
        if (!Number.isFinite(percent))
            return '0%';

        return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
    }

    get adminCpuHint() {
        const cpu = (this.admin.adminDashboard && this.admin.adminDashboard.cpu) || {};
        const average = Number(cpu.averagePercent);
        const averageText = Number.isFinite(average) ? `${t('settings.cpuAverage', {value: average.toFixed(average >= 10 ? 0 : 1)})} · ` : '';
        const totalSeconds = Number(cpu.totalSeconds);
        const totalText = Number.isFinite(totalSeconds) ? t('settings.cpuTime', {value: this.formatDuration(totalSeconds)}) : '';
        return `${averageText}${totalText}`.trim();
    }

    get adminRuntime() {
        return (this.admin.adminDashboard && this.admin.adminDashboard.runtime) || {};
    }

    get adminDiscovery() {
        return (this.admin.adminDashboard && this.admin.adminDashboard.discovery) || {};
    }

    discoveryMetric(key = '') {
        return Number((this.adminDiscovery.totals || {})[key]) || 0;
    }

    discoveryRateText(key = '') {
        const rate = Number((this.adminDiscovery.rates || {})[key]) || 0;
        return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
    }

    get adminRuntimeHint() {
        const inFlight = Number(this.adminRuntime.inFlightActions || 0);
        const actionCount = Number(this.adminRuntime.actionCount || 0);
        return t('settings.requestsRunning', {inFlight, count: actionCount});
    }

    get runtimeLagText() {
        return this.formatMilliseconds(this.adminRuntime.lastEventLoopLagMs);
    }

    get runtimeLagHint() {
        return `p95: ${this.formatMilliseconds(this.adminRuntime.eventLoopLagP95Ms)}`;
    }

    get runtimeLastSlowActionText() {
        const slow = this.adminRuntime.lastSlowAction || {};
        return slow.action || t('settings.noSlowAction');
    }

    get runtimeLastSlowActionHint() {
        const slow = this.adminRuntime.lastSlowAction || {};
        if (!slow.action)
            return t('settings.slowActionThreshold');

        const time = slow.at ? this.admin.formatDateTime(slow.at) : '';
        return `${this.formatMilliseconds(slow.durationMs)}${time ? ` · ${time}` : ''}`;
    }

    get runtimeSlowestActions() {
        return Array.isArray(this.adminRuntime.slowestActions) ? this.adminRuntime.slowestActions : [];
    }

    actionDurationText(item = {}) {
        return `p95 ${this.formatMilliseconds(item.p95Ms)} · max ${this.formatMilliseconds(item.maxMs)} · ${item.count || 0}`;
    }

    get adminTasks() {
        return Array.isArray(this.admin.adminDashboard.tasks) ? this.admin.adminDashboard.tasks : [];
    }

    taskProgress(task = {}) {
        const progress = parseFloat(task.progress);
        if (!Number.isFinite(progress) || progress <= 0)
            return 0;

        return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
    }
}

export default vueComponent(AdminOverview);
//-----------------------------------------------------------------------------
</script>

<style scoped src="./adminSections.css"></style>

<style scoped>
.admin-dashboard-sections {
    display: grid;
    gap: 14px;
    margin-top: 12px;
}

.admin-dashboard-section {
    display: grid;
    gap: 8px;
}

.admin-dashboard-section-title {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0;
}

.admin-runtime-list {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: var(--app-surface);
}

.admin-runtime-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-runtime-action {
    min-width: 0;
    overflow: hidden;
    color: var(--app-text);
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.admin-runtime-value {
    white-space: nowrap;
}

.admin-task-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
}

.admin-task-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    background: rgba(23, 32, 38, 0.04);
}

.admin-task-row--active {
    border-color: color-mix(in srgb, var(--app-primary) 45%, var(--app-border));
}

.admin-task-title {
    font-size: 13px;
    font-weight: 800;
}

.admin-task-message,
.admin-task-error {
    margin-top: 3px;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-task-error {
    color: #dc2626;
    font-weight: 700;
}

.admin-task-main :deep(.q-linear-progress) {
    margin-top: 8px;
}

@media (max-width: 720px) {
    .admin-task-row {
        grid-template-columns: 1fr;
    }
}
</style>
