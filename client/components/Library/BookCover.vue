<template>
    <div class="book-cover" :class="{'book-cover--small': small}" :style="placeholder ? {background: clothColor} : null">
        <img v-if="!placeholder" :src="src" alt="" loading="lazy" @error="failed = true" @load="onLoad" />
        <template v-else>
            <div class="book-cover-title">
                {{ book.title || $t('Без названия') }}
            </div>
            <div class="book-cover-author">
                {{ shortAuthor }}
            </div>
        </template>
        <div v-if="progress > 0 && progress < 1" class="book-cover-progress">
            <i :style="{width: `${Math.round(progress * 100)}%`}" />
        </div>
        <div v-else-if="progress >= 1" class="book-cover-read" :title="$t('Прочитано')">
            <q-icon name="la la-check" size="14px" />
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {coverUrl, bookAuthors} from '../../share/bookActions';

//Цвета переплётной ткани для обложек-заглушек: белый текст читается на каждом
const clothColors = ['#2f5d7c', '#24566b', '#6b3a3a', '#4b3f73', '#5b5a2e', '#7a4a1c', '#3c4a3a', '#1f5c50', '#5a3550', '#38465c'];

const componentOptions = {
    watch: {
        'book._uid'() {
            this.failed = false;
        },
    },
};

class BookCover {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        progress: {type: Number, default: 0},
        small: Boolean,
    };

    failed = false;

    get src() {
        return coverUrl(this.$store.state.config, this.book);
    }

    get placeholder() {
        return this.failed || !this.src;
    }

    get shortAuthor() {
        const first = bookAuthors(this.book)[0] || '';
        const parts = first.split(/\s+/).filter(Boolean);
        return parts.length > 1 ? `${parts[1][0]}. ${parts[0]}` : first;
    }

    get clothColor() {
        const seed = String(this.book.genre || this.book.title || '');
        let sum = 0;
        for (const char of seed)
            sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
        return clothColors[sum % clothColors.length];
    }

    onLoad(event) {
        //сервер отдаёт пустую картинку 1x1, если обложки нет
        const img = event.target;
        if (img && img.naturalWidth <= 2 && img.naturalHeight <= 2)
            this.failed = true;
    }
}

export default vueComponent(BookCover);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-cover {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    aspect-ratio: 2 / 3;
    width: 100%;
    max-width: 100%;
    padding: 12% 10%;
    overflow: hidden;
    border-radius: 3px 5px 5px 3px;
    background: var(--app-surface-3);
    color: #fff;
    box-shadow: inset 4px 0 0 rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.18);
}

.book-cover img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.book-cover-title {
    font-family: var(--app-font-serif);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.15;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
}

.book-cover-author {
    font-size: 11px;
    opacity: 0.85;
}

.book-cover--small {
    padding: 8% 8%;
}

.book-cover--small .book-cover-title {
    font-size: 11px;
    -webkit-line-clamp: 4;
}

.book-cover--small .book-cover-author {
    display: none;
}

.book-cover-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgba(0, 0, 0, 0.35);
}

.book-cover-progress i {
    display: block;
    height: 100%;
    background: #fff;
}

.book-cover-read {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--app-primary);
    color: var(--app-on-primary);
}
</style>
