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
                    :model-value="bookViewValue"
                    :options="bookViewSelectOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('Вид списков книг')"
                    @update:model-value="set('bookView', $event)"
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
                <q-toggle :model-value="settings.showDeleted" :label="$t('Показывать удалённые')" @update:model-value="set('showDeleted', $event)" />
                <q-toggle :model-value="settings.downloadAsZip" :label="$t('Скачивать книги в виде zip-архива')" @update:model-value="set('downloadAsZip', $event)" />
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
import {bookView} from '../../share/bookView';

const toOptions = values => values.map(value => ({label: String(value), value}));

class MePreferences {
    limitOptions = toOptions([10, 20, 50, 100, 200, 500, 1000]);

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

    get bookViewValue() {
        return bookView(this.settings);
    }

    get bookViewSelectOptions() {
        return [
            {label: t('Обложками'), value: 'covers'},
            {label: t('Карточками'), value: 'cards'},
            {label: t('Списком'), value: 'list'},
        ];
    }

    set(key, value) {
        this.$store.commit('setSettings', {[key]: value});
    }
}

export default vueComponent(MePreferences);
//-----------------------------------------------------------------------------
</script>
