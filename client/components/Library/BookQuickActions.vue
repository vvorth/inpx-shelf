<template>
    <div class="quick-actions">
        <q-btn flat dense round icon="la la-book-open" :aria-label="$t('Читать')" @click="act('readBook')">
            <q-tooltip>{{ $t('Читать') }}</q-tooltip>
        </q-btn>
        <q-btn flat dense round icon="la la-download" :aria-label="$t('Скачать')" @click="act('download')">
            <q-tooltip>{{ $t('Скачать {ext}', {ext: String(book.ext || '').toUpperCase()}) }}</q-tooltip>
        </q-btn>
        <q-btn v-if="signedIn" flat dense round icon="la la-bookmark" :aria-label="$t('В список')" @click="$emit('lists')">
            <q-tooltip>{{ $t('В список') }}</q-tooltip>
        </q-btn>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {runBookAction} from '../../share/bookActions';

const componentOptions = {
    emits: ['lists'],
};

class BookQuickActions {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        signedIn: Boolean,
    };

    act(action) {
        runBookAction(this, this.book, action);
    }
}

export default vueComponent(BookQuickActions);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.quick-actions {
    display: flex;
    gap: 2px;
}
</style>
