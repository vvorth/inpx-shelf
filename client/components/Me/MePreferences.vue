<template>
    <div class="card-stack">
        <section class="card">
            <h2 class="card-title">
                {{ $t('me.interface') }}
            </h2>
            <div class="form-grid">
                <q-select
                    :model-value="settings.uiLang || ''"
                    :options="uiLangSelectOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('settings.interfaceLanguage')"
                    @update:model-value="set('uiLang', $event || '')"
                />
                <q-select
                    :model-value="settings.limit"
                    :options="limitOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('settings.resultsPerPage')"
                    @update:model-value="set('limit', $event)"
                />
                <q-select
                    :model-value="bookViewValue"
                    :options="bookViewSelectOptions"
                    outlined
                    dense
                    emit-value
                    map-options
                    :label="$t('mePreferences.bookListView')"
                    @update:model-value="set('bookView', $event)"
                />
            </div>
            <q-toggle :model-value="!!settings.darkTheme" :label="$t('mePreferences.darkTheme')" @update:model-value="set('darkTheme', $event)" />
            <q-toggle v-if="config.latestVersion" :model-value="settings.showNewReleaseAvailable !== false" :label="$t('settings.notifyAboutNewVersions')" @update:model-value="set('showNewReleaseAvailable', $event)" />
        </section>

        <section class="card">
            <h2 class="card-title">
                {{ $t('mePreferences.catalog') }}
            </h2>
            <div class="toggle-grid">
                <q-toggle :model-value="settings.showDeleted" :label="$t('settings.showDeleted')" @update:model-value="set('showDeleted', $event)" />
                <q-toggle :model-value="settings.downloadAsZip" :label="$t('settings.downloadBooksZipArchives')" @update:model-value="set('downloadAsZip', $event)" />
            </div>
        </section>

        <section v-if="discoveryEnabled" class="card">
            <h2 class="card-title">
                {{ $t('settings.showcases') }}
            </h2>
            <div class="toggle-grid">
                <q-toggle v-if="externalAvailable" :model-value="settings.showDiscoveryExternal !== false" :label="$t('settings.showExternalSourceTab')" @update:model-value="set('showDiscoveryExternal', $event)" />
                <q-toggle :model-value="settings.showDiscoveryContinueReading !== false" :label="$t('settings.showContinueReadingShelf')" @update:model-value="set('showDiscoveryContinueReading', $event)" />
                <q-toggle :model-value="settings.showDiscoveryFromLists !== false" :label="$t('settings.showListsShelf')" @update:model-value="set('showDiscoveryFromLists', $event)" />
                <q-toggle :model-value="settings.showDiscoveryUnfinishedSeries !== false" :label="$t('settings.showUnfinishedSeriesShelf')" @update:model-value="set('showDiscoveryUnfinishedSeries', $event)" />
                <q-toggle :model-value="settings.showDiscoverySimilar !== false" :label="$t('settings.showSimilarWhatRead')" @update:model-value="set('showDiscoverySimilar', $event)" />
                <q-toggle :model-value="settings.showDiscoveryUnreadOnly === true" :label="$t('mePreferences.showOnlyUnreadBooks')" @update:model-value="set('showDiscoveryUnreadOnly', $event)" />
            </div>
        </section>
        <div class="card-hint">
            {{ $t('mePreferences.theseSettingsAreStored') }}
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
        return uiLangOptions();
    }

    get bookViewValue() {
        return bookView(this.settings);
    }

    get bookViewSelectOptions() {
        return [
            {label: t('mePreferences.asCovers'), value: 'covers'},
            {label: t('mePreferences.asCards'), value: 'cards'},
            {label: t('mePreferences.asAList'), value: 'list'},
        ];
    }

    set(key, value) {
        this.$store.commit('setSettings', {[key]: value});
    }
}

export default vueComponent(MePreferences);
//-----------------------------------------------------------------------------
</script>
