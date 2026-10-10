<template>
    <div class="card-stack">
        <section class="card">
            <h2 class="card-title">
                {{ $t('Интерфейс') }}
            </h2>
            <div class="form-grid">
                <q-select
                    :model-value="settings.uiLang || ''"
                    :options="uiLangSelectOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Язык интерфейса')"
                    @update:model-value="set('uiLang', $event || '')"
                />
                <q-select
                    :model-value="settings.limit"
                    :options="limitOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Результатов на странице')"
                    @update:model-value="set('limit', $event)"
                />
                <q-select
                    :model-value="settings.bookCardView === 'list' ? 'list' : 'cards'"
                    :options="bookCardViewOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Вид карточек')"
                    @update:model-value="set('bookCardView', $event)"
                />
            </div>
            <q-toggle :model-value="!!settings.darkTheme" :label="$t('Тёмная тема')" @update:model-value="set('darkTheme', $event)" />
            <q-toggle v-if="config.latestVersion" :model-value="settings.showNewReleaseAvailable !== false" :label="$t('Уведомлять о выходе новой версии')" @update:model-value="set('showNewReleaseAvailable', $event)" />
        </section>

        <section class="card">
            <h2 class="card-title">
                {{ $t('Каталог') }}
            </h2>
            <div class="toggle-grid">
                <q-toggle :model-value="settings.showCounts" :label="$t('Показывать количество')" @update:model-value="set('showCounts', $event)" />
                <q-toggle :model-value="settings.showRates" :label="$t('Показывать оценки')" @update:model-value="set('showRates', $event)" />
                <q-toggle :model-value="settings.showInfo" :label="$t('Показывать кнопку «Инфо»')" @update:model-value="set('showInfo', $event)" />
                <q-toggle :model-value="settings.showGenres" :label="$t('Показывать жанры')" @update:model-value="set('showGenres', $event)" />
                <q-toggle :model-value="settings.showDates" :label="$t('Показывать даты поступления')" @update:model-value="set('showDates', $event)" />
                <q-toggle :model-value="settings.showDeleted" :label="$t('Показывать удалённые')" @update:model-value="set('showDeleted', $event)" />
                <q-toggle :model-value="settings.downloadAsZip" :label="$t('Скачивать книги в виде zip-архива')" @update:model-value="set('downloadAsZip', $event)" />
                <q-toggle :model-value="settings.abCacheEnabled" :label="$t('Кешировать запросы')" @update:model-value="set('abCacheEnabled', $event)" />
            </div>
        </section>

        <section v-if="discoveryEnabled" class="card">
            <h2 class="card-title">
                {{ $t('Витрины') }}
            </h2>
            <div class="toggle-grid">
                <q-toggle :model-value="settings.showDiscoveryNewest !== false" :label="$t('Показывать вкладку «Новинки»')" @update:model-value="set('showDiscoveryNewest', $event)" />
                <q-toggle :model-value="settings.showDiscoveryPopular !== false" :label="$t('Показывать вкладку «Популярное»')" @update:model-value="set('showDiscoveryPopular', $event)" />
                <q-toggle v-if="externalAvailable" :model-value="settings.showDiscoveryExternal !== false" :label="$t('Показывать вкладку внешнего источника')" @update:model-value="set('showDiscoveryExternal', $event)" />
                <q-toggle :model-value="settings.showDiscoveryContinueReading !== false" :label="$t('Показывать полку «Продолжить чтение»')" @update:model-value="set('showDiscoveryContinueReading', $event)" />
                <q-toggle :model-value="settings.showDiscoveryFromLists !== false" :label="$t('Показывать полку «Из ваших списков»')" @update:model-value="set('showDiscoveryFromLists', $event)" />
                <q-toggle :model-value="settings.showDiscoveryUnfinishedSeries !== false" :label="$t('Показывать полку «Незаконченные серии»')" @update:model-value="set('showDiscoveryUnfinishedSeries', $event)" />
                <q-toggle :model-value="settings.showDiscoverySimilar !== false" :label="$t('Показывать полку «Похоже на то, что вы читали»')" @update:model-value="set('showDiscoverySimilar', $event)" />
                <q-toggle :model-value="settings.showDiscoveryUnreadOnly === true" :label="$t('Во вкладке «Для вас» показывать только непрочитанное')" @update:model-value="set('showDiscoveryUnreadOnly', $event)" />
                <q-toggle :model-value="settings.compactDiscoveryCards === true" :label="$t('Использовать компактные карточки в витринах')" @update:model-value="set('compactDiscoveryCards', $event)" />
            </div>
            <div class="form-grid">
                <q-select
                    :model-value="parseInt(settings.discoveryNewestLimit, 10) || 8"
                    :options="discoveryLimitOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Лимит «Новинки»')"
                    @update:model-value="set('discoveryNewestLimit', $event)"
                />
                <q-select
                    :model-value="parseInt(settings.discoveryPopularLimit, 10) || 8"
                    :options="discoveryLimitOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Лимит «Популярное»')"
                    @update:model-value="set('discoveryPopularLimit', $event)"
                />
            </div>
        </section>
        <div class="card-hint">
            {{ $t('Эти настройки хранятся в этом браузере.') }}
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t, uiLangOptions} from '../../share/i18n';
import {externalDiscovery} from '../../share/discoveryRoutes';

const toOptions = values => values.map(value => ({label: String(value), value}));

class MePreferences {
    limitOptions = toOptions([10, 20, 50, 100, 200, 500, 1000]);
    discoveryLimitOptions = toOptions([4, 6, 8, 10, 12, 16, 20, 24]);

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get discoveryEnabled() {
        return (this.config.discovery || {}).enabled !== false;
    }

    get externalAvailable() {
        return externalDiscovery(this.config, this.settings).source !== 'none';
    }

    get uiLangSelectOptions() {
        return uiLangOptions.map(option => (option.value ? option : {...option, label: t(option.label)}));
    }

    get bookCardViewOptions() {
        return [
            {label: t('Карточки'), value: 'cards'},
            {label: t('Список'), value: 'list'},
        ];
    }

    set(key, value) {
        this.$store.commit('setSettings', {[key]: value});
    }
}

export default vueComponent(MePreferences);
//-----------------------------------------------------------------------------
</script>
