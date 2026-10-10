<template>
    <q-btn class="lang-picker" outline no-caps dense :aria-label="$t('Мои языки')" @click="load">
        <q-icon name="la la-language" size="18px" />
        <span class="lang-picker-label">{{ label }}</span>
        <q-icon name="la la-angle-down" size="14px" />
        <q-menu anchor="bottom right" self="top right" :offset="[0, 6]">
            <div class="lang-menu">
                <div class="lang-menu-head">
                    <div class="lang-menu-title">
                        {{ $t('Мои языки') }}
                    </div>
                    <div class="lang-menu-hint">
                        {{ $t('Книги на других языках скрыты в поиске, у авторов, в сериях и на главной.') }}
                    </div>
                </div>
                <label class="lang-option">
                    <input type="checkbox" :checked="languages.all" :disabled="saving" @change="toggleAll" />
                    <span class="lang-option-name">{{ $t('Все языки') }}</span>
                </label>
                <div class="lang-sep" />
                <label v-for="item in options" :key="item.code" class="lang-option">
                    <input type="checkbox" :checked="!languages.all && languages.codes.has(item.code)" :disabled="saving" @change="toggle(item.code)" />
                    <span class="lang-option-name">{{ item.name }}</span>
                    <span v-if="item.count" class="lang-option-count num">{{ item.count.toLocaleString() }}</span>
                </label>
                <div v-if="!signedIn" class="lang-menu-hint lang-menu-foot">
                    {{ $t('Выбор сохранится в этом браузере. После входа языки хранятся в профиле.') }}
                </div>
            </div>
        </q-menu>
    </q-btn>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

import {t} from '../../share/i18n';
import {isSignedIn} from '../../share/session';
import {myLanguages, saveMyLanguages, languageName, allLanguages} from '../../share/languages';

let libraryLanguagesCache = null;

class LanguagePicker {
    available = [];
    saving = false;

    get config() {
        return this.$store.state.config;
    }

    get signedIn() {
        return isSignedIn(this.config);
    }

    get languages() {
        return myLanguages(this.config, this.$store.state.settings);
    }

    get label() {
        if (this.languages.all)
            return t('Все языки');
        const codes = this.languages.list.map(code => code.toUpperCase());
        return (codes.length > 3 ? `${codes.slice(0, 3).join(' · ')} +${codes.length - 3}` : codes.join(' · '));
    }

    get options() {
        const rows = new Map(this.available.map(item => [item.code, item]));
        //выбранные языки видны всегда, даже если их нет в списке библиотеки
        for (const code of this.languages.list) {
            if (!rows.has(code))
                rows.set(code, {code, count: 0});
        }
        return [...rows.values()].map(item => Object.assign({}, item, {name: languageName(item.code)}));
    }

    //языки библиотеки: с количеством книг из индекса, иначе просто список
    async load() {
        if (libraryLanguagesCache) {
            this.available = libraryLanguagesCache;
            return;
        }
        const api = this.$root.api;
        try {
            const status = this.config.catalogSearch || {};
            if (status.ready) {
                const result = await api.catalogSearch({q: '', limit: 1, filters: {}});
                libraryLanguagesCache = ((result.facets && result.facets.lang) || []).map(([code, count]) => ({code: code.toLowerCase(), count}));
            } else {
                const result = await api.getGenreTree();
                libraryLanguagesCache = (result.langList || []).map(code => ({code: String(code).toLowerCase(), count: 0}));
            }
            this.available = libraryLanguagesCache;
        } catch (e) {
            this.available = [];
        }
    }

    async save(codes) {
        this.saving = true;
        try {
            await saveMyLanguages(this, codes);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, t('Ошибка'));
        } finally {
            this.saving = false;
        }
    }

    toggleAll() {
        //снять «Все языки» - вернуться к языку интерфейса
        this.save(this.languages.all ? [] : [allLanguages]);
    }

    toggle(code) {
        const codes = new Set(this.languages.all ? [] : this.languages.list);
        if (codes.has(code))
            codes.delete(code);
        else
            codes.add(code);
        this.save(codes.size ? [...codes] : [allLanguages]);
    }
}

export default vueComponent(LanguagePicker);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.lang-picker {
    flex: none;
    height: 40px;
    padding: 0 10px;
    color: var(--app-text);
}

.lang-picker :deep(.q-btn__content) {
    gap: 6px;
}

.lang-picker-label {
    font-variant-numeric: tabular-nums;
}

.lang-menu {
    display: flex;
    flex-direction: column;
    width: 300px;
    max-height: min(70vh, 520px);
    overflow-y: auto;
    padding: 8px 0;
}

.lang-menu-head {
    padding: 4px 14px 8px;
}

.lang-menu-title {
    font-weight: 600;
}

.lang-menu-hint {
    color: var(--app-muted);
    font-size: 12px;
    line-height: 1.4;
}

.lang-menu-foot {
    padding: 8px 14px 2px;
}

.lang-option {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    cursor: pointer;
}

.lang-option:hover {
    background: var(--app-surface-3);
}

.lang-option input {
    accent-color: var(--app-primary);
}

.lang-option-name {
    flex: 1;
}

.lang-option-count {
    color: var(--app-muted);
    font-size: 12px;
}

.lang-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--app-border);
}

</style>
