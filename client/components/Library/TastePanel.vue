<template>
    <section class="card taste">
        <div class="card-head">
            <div>
                <h2 class="card-title">
                    {{ $t('Что вам нравится читать?') }}
                </h2>
                <div class="card-hint">
                    {{ $t('Жанры и авторы уточняют рекомендации. Языки книг задаются кнопкой «Мои языки» рядом с поиском.') }}
                </div>
            </div>
        </div>

        <div class="taste-grid">
            <q-select
                v-model="genres"
                outlined
                dense
                multiple
                use-chips
                use-input
                clearable
                emit-value
                map-options
                options-dense
                input-debounce="0"
                max-values="20"
                :options="genreOptions"
                :label="$t('Любимые жанры')"
                @filter="filterGenres"
            />
            <q-select
                v-model="authors"
                outlined
                dense
                multiple
                use-chips
                use-input
                clearable
                options-dense
                new-value-mode="add-unique"
                input-debounce="250"
                max-values="40"
                :options="authorOptions"
                :loading="authorsLoading"
                :label="$t('Любимые авторы')"
                :hint="$t('Начните вводить фамилию или имя')"
                @filter="filterAuthors"
            />
            <q-select
                v-model="explorationRatio"
                outlined
                dense
                emit-value
                map-options
                :options="explorationOptions"
                :label="$t('Сколько нового пробовать')"
            />
        </div>

        <div class="card-actions">
            <q-btn color="primary" unelevated no-caps icon="la la-check" @click="save">
                {{ $t('Сохранить вкусы') }}
            </q-btn>
            <q-btn flat no-caps @click="needsSetup ? $emit('dismiss') : $emit('close')">
                {{ needsSetup ? $t('Не сейчас') : $t('Закрыть') }}
            </q-btn>
        </div>
    </section>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {loadGenres, allGenres} from '../../share/genres';

const componentOptions = {
    emits: ['save', 'dismiss', 'close'],
};

//Вкусы для персональных рекомендаций: жанры, авторы, доля нового
class TastePanel {
    _options = componentOptions;
    _props = {
        taste: {type: Object, default: () => ({})},
        needsSetup: Boolean,
    };

    genres = [];
    authors = [];
    explorationRatio = 0.15;
    genreOptions = [];
    authorOptions = [];
    authorsLoading = false;
    authorSeq = 0;

    created() {
        this.api = this.$root.api;
        const taste = this.taste || {};
        this.genres = Array.isArray(taste.genres) ? taste.genres.slice() : [];
        this.authors = Array.isArray(taste.authors) ? taste.authors.slice() : [];
        this.explorationRatio = Number(taste.explorationRatio) || 0.15;
        this.authorOptions = this.authors.slice();
        loadGenres(this.api).then(() => {
            this.genreOptions = allGenres();
        }).catch(() => {});
    }

    get explorationOptions() {
        return [
            {label: t('Осторожно · 10%'), value: 0.1},
            {label: t('Сбалансированно · 15%'), value: 0.15},
            {label: t('Больше нового · 25%'), value: 0.25},
        ];
    }

    filterGenres(value, update) {
        const words = String(value || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
        update(() => {
            this.genreOptions = allGenres().filter((item) => {
                const text = `${item.label} ${item.value}`.toLowerCase().replace(/ё/g, 'е');
                return words.every(word => text.includes(word));
            });
        });
    }

    //авторы ищутся по индексу каталога, как подсказки строки поиска
    async filterAuthors(value, update) {
        const query = String(value || '').trim();
        const seq = ++this.authorSeq;
        if (query.length < 2 || !((this.$store.state.config.catalogSearch || {}).ready)) {
            update(() => {
                this.authorOptions = this.authors.slice();
            });
            return;
        }
        this.authorsLoading = true;
        try {
            const result = await this.api.catalogSuggest(query);
            if (seq !== this.authorSeq)
                return;
            update(() => {
                this.authorOptions = [...new Set([...this.authors, ...(result.authors || []).map(item => item.name)])];
            });
        } catch (e) {
            update(() => {
                this.authorOptions = this.authors.slice();
            });
        } finally {
            if (seq === this.authorSeq)
                this.authorsLoading = false;
        }
    }

    save() {
        //языки не передаём: они хранятся в «Моих языках» и при сохранении вкусов не меняются
        this.$emit('save', {
            genres: this.genres.slice(0, 20),
            authors: this.authors.slice(0, 40),
            explorationRatio: this.explorationRatio,
            completedAt: new Date().toISOString(),
        });
    }
}

export default vueComponent(TastePanel);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.taste-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
}
</style>
