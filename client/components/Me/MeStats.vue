<template>
    <div class="card-stack">
        <div v-if="!stats" class="page-empty page-empty--inline">
            {{ $t('meStats.loading') }}
        </div>
        <div v-else-if="!stats.finished && !stats.inProgress" class="page-empty">
            {{ $t('meStats.empty') }}
        </div>
        <template v-else>
            <section class="card">
                <div class="stats-totals">
                    <div v-for="item in totals" :key="item.label" class="stats-total">
                        <div class="stats-total-value num">{{ item.value }}</div>
                        <div class="card-hint">{{ item.label }}</div>
                    </div>
                </div>
                <div class="card-hint">
                    {{ $t('meStats.dateHint') }}
                    <template v-if="undated">{{ $t('meStats.undated', {count: undated}) }}</template>
                </div>
            </section>

            <section v-for="chart in charts" :key="chart.title" class="card">
                <h2 class="card-title">{{ chart.title }}</h2>
                <div class="stats-bars">
                    <template v-for="row in chart.rows" :key="row.key">
                        <router-link v-if="row.to" :to="row.to" class="stats-label">{{ row.label }}</router-link>
                        <span v-else class="stats-label">{{ row.label }}</span>
                        <div class="progress stats-bar"><i :style="{width: `${row.count / chart.max * 100}%`}" /></div>
                        <span class="num stats-count">{{ row.count }}</span>
                    </template>
                </div>
            </section>
        </template>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, getLang} from '../../share/i18n';
import {loadGenres, genreName} from '../../share/genres';
import {authorRoute} from '../../share/bookActions';

class MeStats {
    stats = null;
    genresReady = false;

    async created() {
        try {
            this.stats = await this.$root.api.getReadingStats();
            await loadGenres(this.$root.api);
            this.genresReady = true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }

    //даты окончания - по часовому поясу браузера
    get dates() {
        return (this.stats ? this.stats.finishedAt.map(value => new Date(value)) : []);
    }

    get year() {
        return new Date().getFullYear();
    }

    get undated() {
        return this.stats.finished - this.dates.length;
    }

    get totals() {
        return [
            {label: t('meStats.finished'), value: this.stats.finished},
            {label: t('meStats.thisYear'), value: this.dates.filter(date => date.getFullYear() === this.year).length},
            {label: t('meStats.inProgress'), value: this.stats.inProgress},
        ];
    }

    get charts() {
        const countBy = (keys, keyOf) => keys.map(key => ({key, count: this.dates.filter(date => keyOf(date) === key).length}));
        const months = countBy([...Array(new Date().getMonth() + 1).keys()], date => (date.getFullYear() === this.year ? date.getMonth() : -1))
            .map(row => Object.assign(row, {label: new Date(this.year, row.key).toLocaleString(getLang(), {month: 'long'})}));
        const firstYear = Math.min(this.year, ...this.dates.map(date => date.getFullYear()));
        const years = countBy([...Array(this.year - firstYear + 1).keys()].map(index => firstYear + index), date => date.getFullYear())
            .map(row => Object.assign(row, {label: String(row.key)}));
        const authors = this.stats.authors.map(row => ({key: row.name, label: row.name, count: row.count, to: authorRoute(row.name)}));
        const genres = this.stats.genres.map(row => ({key: row.name, label: (this.genresReady ? genreName(row.name) : row.name),
            count: row.count, to: {path: '/search', query: {genre: row.name}}}));

        return [
            {title: t('meStats.byMonth', {year: this.year}), rows: months},
            {title: t('meStats.byYear'), rows: years},
            {title: t('meStats.topAuthors'), rows: authors},
            {title: t('meStats.topGenres'), rows: genres},
        ].filter(chart => chart.rows.length)
            .map(chart => Object.assign(chart, {max: Math.max(1, ...chart.rows.map(row => row.count))}));
    }
}

export default vueComponent(MeStats);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.stats-totals {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 40px;
}

.stats-total-value {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
}

.stats-bars {
    display: grid;
    grid-template-columns: fit-content(40%) minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 12px;
}

.stats-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.stats-bar {
    height: 10px;
    border-radius: 5px;
}

.stats-count {
    min-width: 2ch;
    text-align: right;
}
</style>
