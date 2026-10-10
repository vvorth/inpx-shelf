<template>
    <div v-if="external" class="quick-actions">
        <q-btn flat dense no-caps icon="la la-external-link-alt" type="a" :href="book.discoveryUrl" target="_blank" rel="noopener">
            {{ $t('Открыть источник') }}
        </q-btn>
    </div>
    <div v-else class="quick-actions">
        <q-btn flat dense round icon="la la-book-open" :aria-label="$t('Читать')" @click="act('readBook')">
            <q-tooltip>{{ $t('Читать') }}</q-tooltip>
        </q-btn>
        <q-btn flat dense round icon="la la-download" :aria-label="$t('Скачать')" @click="act('download')">
            <q-tooltip>{{ $t('Скачать {ext}', {ext: String(book.ext || '').toUpperCase()}) }}</q-tooltip>
        </q-btn>
        <q-btn v-if="formats.length" flat dense round icon="la la-file-export" :aria-label="$t('Скачать в другом формате')">
            <q-tooltip>{{ $t('Скачать в другом формате') }}</q-tooltip>
            <q-menu anchor="bottom right" self="top right">
                <div class="format-menu">
                    <div class="format-menu-title">
                        {{ $t('Конвертировать и скачать') }}
                    </div>
                    <button v-for="format in formats" :key="format" v-close-popup type="button" class="format-item" @click="act('download', format)">
                        {{ format.toUpperCase() }}
                    </button>
                </div>
            </q-menu>
        </q-btn>
        <q-btn v-if="signedIn" flat dense round icon="la la-bookmark" :aria-label="$t('В список')" @click="$emit('lists')">
            <q-tooltip>{{ $t('В список') }}</q-tooltip>
        </q-btn>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {runBookAction, conversionFormats} from '../../share/bookActions';
import {isExternalOnly} from '../../share/discovery';

const componentOptions = {
    emits: ['lists', 'used'],
};

class BookQuickActions {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        signedIn: Boolean,
    };

    get formats() {
        return conversionFormats(this.$store.state.config, this.book);
    }

    get external() {
        return isExternalOnly(this.book);
    }

    act(action, format = '') {
        this.$emit('used', action === 'readBook' ? 'start' : 'download');
        runBookAction(this, this.book, action, format);
    }
}

export default vueComponent(BookQuickActions);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.format-menu {
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 6px 0;
}

.format-menu-title {
    padding: 4px 14px 6px;
    color: var(--app-muted);
    font-size: 12px;
}

.format-item {
    padding: 7px 14px;
    border: 0;
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.format-item:hover {
    background: var(--app-surface-3);
}

.quick-actions {
    display: flex;
    gap: 2px;
}
</style>
