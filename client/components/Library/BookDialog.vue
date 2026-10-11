<template>
    <q-dialog :model-value="!!uid" :maximized="$q.screen.lt.sm" no-route-dismiss @update:model-value="close">
        <div class="book-dialog">
            <q-btn class="book-dialog-close" flat round dense icon="la la-times" :aria-label="$t('common.close')" @click="close" />
            <BookPage v-if="uid" :dialog-uid="uid" />
        </div>
    </q-dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookPage from './BookPage.vue';
import {bookDialogUid, closeBookDialog} from '../../router';

const componentOptions = {
    components: {
        BookPage,
    },
};

//Страница книги поверх текущей страницы: открывается по ?book=<uid>, «Назад» её закрывает
class BookDialog {
    _options = componentOptions;

    get uid() {
        return bookDialogUid(this.$route);
    }

    close() {
        if (this.uid)
            closeBookDialog();
    }
}

export default vueComponent(BookDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-dialog {
    position: relative;
    display: flex;
    width: min(1100px, 94vw);
    max-width: none !important;
    height: 90vh;
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
