<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center" style="font-size: 110%">
                <q-icon class="q-mr-sm text-primary" name="la la-satellite-dish" size="28px" />
                {{ $t('common.externalSource') }}
            </div>
        </template>

        <div class="q-mx-md column" style="min-width: 320px; max-width: 720px; font-size: 110%;">
            <div class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">{{ $t('discoverySource.sourceType') }}</div>
                <q-select
                    v-model="discoveryExternalSource"
                    :options="externalSourceOptions"
                    class="bg-white col"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">{{ $t('common.title') }}</div>
                <q-input
                    v-model="discoveryExternalName"
                    class="bg-white col"
                    outlined
                    dense
                    clearable
                    :placeholder="$t('discoverySource.exampleAwardWinners')"
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">{{ $t('discoverySource.refreshInterval') }}</div>
                <q-select
                    v-model="discoveryExternalTtlMinutes"
                    :options="discoveryTtlOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="q-mt-md text-grey-7" style="font-size: 85%;">
                {{ $t('discoverySource.ifDeleteSourceTab') }}
            </div>
        </div>

        <template #footer>
            <q-btn
                v-if="externalDiscoveryEnabled"
                class="q-px-md q-ml-sm"
                color="negative"
                flat
                dense
                no-caps
                @click="removeSource"
            >
                {{ $t('discoverySource.deleteSource') }}
            </q-btn>
            <q-space />
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="okClick">
                OK
            </q-btn>
        </template>
    </Dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import Dialog from '../share/Dialog.vue';
import {t} from '../../share/i18n';

const componentOptions = {
    components: {
        Dialog,
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },
        settings() {
            this.loadSettings();
        },
        discoveryExternalSource(newValue) {
            const normalizedValue = (String(newValue || '').trim().toLowerCase() === 'none' ? 'none' : 'wikidata-awards');
            if (normalizedValue === 'none') {
                this.discoveryExternalName = '';
                this.discoveryExternalTtlMinutes = 1440;
                this.commit('setSettings', {
                    discoveryExternalSource: 'none',
                    discoveryExternalName: '',
                    discoveryExternalTtlMinutes: 1440,
                    showDiscoveryExternal: false,
                });
                return;
            }

            this.commit('setSettings', {discoveryExternalSource: normalizedValue});
        },
        discoveryExternalName(newValue) {
            this.commit('setSettings', {discoveryExternalName: newValue});
        },
        discoveryExternalTtlMinutes(newValue) {
            const normalizedValue = Math.max(1440, parseInt(newValue, 10) || 1440);
            if (normalizedValue !== this.discoveryExternalTtlMinutes) {
                this.discoveryExternalTtlMinutes = normalizedValue;
                return;
            }
            this.commit('setSettings', {discoveryExternalTtlMinutes: normalizedValue});
        },
    },
};

class DiscoverySourceDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };

    dialogVisible = false;
    discoveryExternalSource = 'none';
    discoveryExternalName = '';
    discoveryExternalTtlMinutes = 1440;

    get discoveryTtlOptions() {
        return [
            {label: t('discoverySource.n24Hours'), value: 1440},
            {label: t('discoverySource.n3Days'), value: 4320},
            {label: t('discoverySource.n7Days'), value: 10080},
        ];
    }

    created() {
        this.commit = this.$store.commit;
        this.api = this.$root.api;
        this.loadSettings();
    }

    get settings() {
        return this.$store.state.settings;
    }

    get config() {
        return this.$store.state.config;
    }

    get discoveryConfig() {
        return this.config.discovery || {};
    }

    get externalSourceOptions() {
        return [
            {label: t('common.no'), value: 'none'},
            {label: t('discoverySource.wikidataAwards'), value: 'wikidata-awards'},
        ];
    }

    get externalDiscoveryEnabled() {
        return !!(this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    loadSettings() {
        const settings = this.settings;
        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'wikidata-awards');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
        this.discoveryExternalTtlMinutes = Math.max(
            1440,
            parseInt(settings.discoveryExternalTtlMinutes, 10) || parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440,
        );
    }

    removeSource() {
        this.discoveryExternalSource = 'none';
    }

    async okClick() {
        try {
            await this.api.updateSharedDiscoveryConfig({
                externalSource: this.discoveryExternalSource,
                externalName: this.discoveryExternalName,
                externalTtlMinutes: this.discoveryExternalTtlMinutes,
            });
            await this.api.updateConfig();
            this.loadSettings();
            this.dialogVisible = false;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('common.error'));
        }
    }
}

export default vueComponent(DiscoverySourceDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.dialog-label {
    min-width: 128px;
}

</style>
