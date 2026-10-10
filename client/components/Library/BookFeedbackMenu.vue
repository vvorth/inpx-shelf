<template>
    <q-btn v-if="restore" flat dense no-caps icon="la la-undo" @click="$emit('restore')">
        {{ $t('Вернуть') }}
    </q-btn>
    <q-btn v-else flat dense round icon="la la-ellipsis-h" :aria-label="$t('Отзыв о рекомендации')">
        <q-tooltip>{{ $t('Отзыв о рекомендации') }}</q-tooltip>
        <q-menu anchor="bottom right" self="top right">
            <div class="feedback-menu">
                <button v-for="item in options" :key="item.kind" v-close-popup type="button" class="feedback-item" @click="$emit('feedback', item.kind)">
                    <q-icon :name="item.icon" size="16px" />{{ item.label }}
                </button>
            </div>
        </q-menu>
    </q-btn>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {feedbackOptions} from '../../share/discovery';

const componentOptions = {
    emits: ['feedback', 'restore'],
};

//Отзыв на рекомендацию («Неинтересно», «Больше похожих»...) или возврат скрытой книги
class BookFeedbackMenu {
    _options = componentOptions;
    _props = {
        restore: Boolean,
    };

    get options() {
        return feedbackOptions();
    }
}

export default vueComponent(BookFeedbackMenu);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.feedback-menu {
    display: flex;
    flex-direction: column;
    min-width: 230px;
    padding: 6px 0;
}

.feedback-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border: 0;
    background: none;
    color: var(--app-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.feedback-item:hover {
    background: var(--app-surface-3);
}
</style>
