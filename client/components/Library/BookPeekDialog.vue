<template>
    <q-dialog :model-value="!!uid" :maximized="$q.screen.lt.sm" @update:model-value="close">
        <div class="book-dialog">
            <q-btn class="book-dialog-close" flat round dense icon="la la-times" :aria-label="$t('common.close')" @click="close" />
            <BookPage v-if="uid" :dialog-uid="uid" />
        </div>
    </q-dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import {defineAsyncComponent} from 'vue';
import vueComponent from '../vueComponent.js';

const componentOptions = {
    components: {
        //BookPage сам показывает это окно: подключаем при открытии, чтобы не было кругового импорта
        BookPage: defineAsyncComponent(() => import('./BookPage.vue')),
    },
    emits: ['update:uid'],
};

//Книга поверх окна другой книги (возможная замена недоступной): адрес не меняется, закрытие возвращает к прежнему окну
class BookPeekDialog {
    _options = componentOptions;
    _props = {
        uid: {type: String, default: ''},
    };

    close() {
        this.$emit('update:uid', '');
    }
}

export default vueComponent(BookPeekDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-dialog {
    position: relative;
    display: flex;
    width: min(1060px, 92vw);
    max-width: none !important;
    height: 86vh;
    overflow: hidden;
    border-radius: 12px;
    background: var(--app-bg);
}

.book-dialog > :deep(.page) {
    flex: 1 1 auto;
}

.book-dialog-close {
    position: absolute;
    top: 10px;
    right: 12px;
    z-index: 1;
}

.q-dialog__inner--maximized .book-dialog {
    width: 100vw;
    height: 100%;
    border-radius: 0;
}
</style>
