<template>
    <div class="reader-home">
        <div class="reader-home-panel">
            <div class="reader-home-head">
                <div>
                    <h1 class="page-title">{{ reader.uiText.readerHomeTitle }}</h1>
                    <div class="reader-home-subtitle">{{ reader.readerHomeSubtitle }}</div>
                </div>
                <div class="reader-home-actions">
                    <div class="reader-theme-switch reader-home-theme">
                        <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'dark'}" @click="reader.setTheme('dark')">{{ reader.uiText.themeDark }}</q-btn>
                        <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'sepia'}" @click="reader.setTheme('sepia')">{{ reader.uiText.themeSepia }}</q-btn>
                        <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'light'}" @click="reader.setTheme('light')">{{ reader.uiText.themeLight }}</q-btn>
                        <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'eink'}" @click="reader.setTheme('eink')">{{ reader.uiText.themeEink }}</q-btn>
                    </div>
                    <q-btn
                        v-if="reader.readerHomeCanLogin"
                        flat
                        no-caps
                        icon="la la-sign-in-alt"
                        class="reader-home-action-btn reader-home-action-btn--primary"
                        @click="reader.promptReaderProfileLogin"
                    >
                        {{ reader.uiText.profileLoginAction }}
                    </q-btn>
                </div>
            </div>

            <div v-if="reader.readerHomeLoading" class="reader-home-state">
                <q-icon class="la la-spinner icon-rotate" size="22px" />
                <span>{{ reader.uiText.loadingBook }}</span>
            </div>

            <div v-if="!reader.readerHomeLoading && !reader.readerHomeCanLogin" class="reader-home-tools">
                <div class="reader-home-tabs">
                    <div class="tabs reader-home-tab-list">
                        <button
                            v-for="item in reader.readerHomeFilterOptions"
                            :key="item.value"
                            type="button"
                            class="tab"
                            :class="{'is-active': reader.readerHomeFilter === item.value}"
                            :disabled="reader.readerHomeResetting"
                            @click="reader.setReaderHomeFilter(item.value)"
                        >
                            {{ item.label }} <span class="tab-count">{{ reader.readerHomeCounters[item.value] || 0 }}</span>
                        </button>
                    </div>
                    <div class="reader-home-tab-actions">
                        <q-btn
                            v-if="reader.readerHomeFilter === 'hidden' && reader.readerHomeBooks.length"
                            flat
                            dense
                            no-caps
                            icon="la la-trash"
                            class="reader-home-reset-btn"
                            :disable="reader.readerHomeResetting"
                            @click="reader.forgetReaderHomeBooks(reader.readerHomeBooks)"
                        >
                            {{ reader.uiText.forgetAllHidden }}
                        </q-btn>
                        <q-btn
                            flat
                            dense
                            no-caps
                            icon="la la-undo-alt"
                            class="reader-home-reset-btn"
                            :disable="reader.readerHomeResetting || !(reader.readerHomeCounters.all > 0)"
                            :loading="reader.readerHomeResetting"
                            @click="reader.resetReaderHomeProgress"
                        >
                            {{ reader.uiText.resetReaderProgress }}
                        </q-btn>
                        <q-btn
                            flat
                            dense
                            round
                            icon="la la-sync"
                            class="reader-home-refresh-btn reader-icon-btn"
                            :aria-label="reader.uiText.refresh"
                            :disable="reader.readerHomeResetting"
                            @click="reader.loadReaderHome"
                        >
                            <q-tooltip :delay="600">{{ reader.uiText.refresh }}</q-tooltip>
                        </q-btn>
                    </div>
                </div>

                <div class="reader-home-search-row">
                    <q-input
                        v-model="reader.readerHomeSearch"
                        :dark="reader.preferences.theme === 'dark'"
                        dense
                        outlined
                        clearable
                        :disable="reader.readerHomeResetting"
                        debounce="250"
                        class="reader-home-search"
                        :placeholder="reader.uiText.readerHomeSearchPlaceholder"
                        @update:model-value="reader.loadReaderHome"
                    >
                        <template v-slot:prepend>
                            <q-icon name="la la-search" />
                        </template>
                    </q-input>
                    <q-select
                        v-model="reader.readerHomeSort"
                        :options="reader.readerHomeSortOptions"
                        behavior="menu"
                        :dark="reader.preferences.theme === 'dark'"
                        popup-content-class="reader-font-menu"
                        :popup-content-style="reader.readerDialogStyle"
                        dense
                        outlined
                        emit-value
                        map-options
                        options-dense
                        :disable="reader.readerHomeResetting"
                        class="reader-home-sort"
                        dropdown-icon="la la-angle-down"
                        @update:model-value="reader.loadReaderHome"
                    />
                </div>
            </div>

            <div v-if="!reader.readerHomeLoading && !reader.readerHomeCanLogin && reader.readerHomeBooks.length" class="reader-home-list">
                <div
                    v-for="book in reader.readerHomeBooks"
                    :key="book.bookUid"
                    class="reader-home-book"
                >
                    <BookCover class="reader-home-cover" :book="reader.readerHomeCoverBook(book)" :progress="book.percent" :read="!!book.read" small />
                    <div class="reader-home-book-main">
                        <div class="reader-home-book-title">{{ book.title || reader.uiText.untitledBook }}</div>
                        <div v-if="book.author" class="reader-home-book-meta">{{ book.author }}</div>
                        <div v-if="book.series" class="reader-home-book-meta">
                            {{ reader.uiText.series }}: {{ book.series }}<span v-if="book.serno"> #{{ book.serno }}</span>
                        </div>
                        <div v-if="book.unavailable" class="reader-home-book-meta">
                            {{ reader.uiText.readerHomeUnavailableText }}
                        </div>
                        <div v-if="book.read" class="reader-home-progress">
                            <span class="read-mark"><q-icon name="la la-check-circle" size="16px" />{{ reader.uiText.readerHomeFilterRead }}</span>
                        </div>
                        <div v-else class="reader-home-progress">
                            <div class="reader-home-progress-bar">
                                <div class="reader-home-progress-fill" :style="{width: `${reader.formatReaderHomePercent(book.percent)}%`}"></div>
                            </div>
                            <span>{{ reader.formatReaderHomePercent(book.percent) }}%</span>
                        </div>
                    </div>
                    <div class="reader-home-book-actions">
                        <q-btn
                            v-if="!book.hidden && !book.unavailable"
                            flat
                            no-caps
                            icon="la la-book-open"
                            class="reader-home-action-btn reader-home-action-btn--primary"
                            @click="reader.openReaderHomeBook(book)"
                        >
                            {{ book.state === 'read' ? reader.uiText.openBook : reader.uiText.continueReading }}
                        </q-btn>
                        <q-btn
                            v-if="book.hidden"
                            flat
                            no-caps
                            icon="la la-undo"
                            class="reader-home-action-btn reader-home-action-btn--primary"
                            @click="reader.restoreReaderHomeBook(book)"
                        >
                            {{ reader.uiText.restoreToReading }}
                        </q-btn>
                        <q-btn
                            v-if="book.hidden"
                            flat
                            no-caps
                            icon="la la-trash"
                            class="reader-home-action-btn reader-home-action-btn--muted"
                            @click="reader.forgetReaderHomeBooks([book])"
                        >
                            {{ reader.uiText.forgetBook }}
                        </q-btn>
                        <q-btn
                            v-if="!book.hidden"
                            flat
                            no-caps
                            icon="la la-times"
                            class="reader-home-action-btn reader-home-action-btn--muted"
                            @click="reader.removeReaderHomeBook(book)"
                        >
                            {{ reader.uiText.removeFromReading }}
                        </q-btn>
                    </div>
                </div>
            </div>

            <div v-else-if="!reader.readerHomeLoading && reader.readerHomeCanLogin" class="reader-home-state reader-home-state--locked">
                <q-icon name="la la-user-lock" size="28px" />
                <div>
                    <div class="reader-home-empty-title">{{ reader.uiText.profileLoginRequired }}</div>
                    <div class="reader-home-empty-text">{{ reader.uiText.profileLoginReaderHint }}</div>
                </div>
                <q-btn
                    flat
                    no-caps
                    icon="la la-sign-in-alt"
                    class="reader-home-action-btn reader-home-action-btn--primary"
                    @click="reader.promptReaderProfileLogin"
                >
                    {{ reader.uiText.profileLoginAction }}
                </q-btn>
            </div>

            <div v-else-if="!reader.readerHomeLoading" class="reader-home-state reader-home-state--empty">
                <q-icon name="la la-book-reader" size="28px" />
                <div>
                    <div class="reader-home-empty-title">{{ reader.uiText.readerHomeEmptyTitle }}</div>
                    <div class="reader-home-empty-text">{{ reader.readerHomeEmptyText }}</div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import BookCover from '../Library/BookCover.vue';

const componentOptions = {
    components: {BookCover},
};

//Часть шаблона Reader.vue: состояние и обработчики остаются в Reader, сюда приходит его экземпляр
class ReaderHome {
    _options = componentOptions;
    _props = {
        reader: {type: Object, required: true},
    };
}

export default vueComponent(ReaderHome);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.reader-icon-btn {
    border-radius: var(--reader-radius);
    color: var(--reader-muted);
}

.reader-icon-btn:hover {
    color: var(--reader-text);
}

.reader-icon-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-theme-switch,
.reader-stepper {
    display: inline-flex;
    align-items: center;
    align-content: stretch;
    flex-wrap: wrap;
    gap: 1px;
    padding: 1px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    overflow: hidden;
}

.reader-controls-tabs .tab,
.reader-dialog-tabs .tab {
    cursor: pointer;
}

.reader-theme-switch :deep(.q-btn),
.reader-stepper :deep(.q-btn) {
    min-height: 30px;
    min-width: 30px;
    padding: 3px 7px;
    font-size: 12px;
}

.reader-theme-switch :deep(.q-btn) {
    flex: 1 1 0;
    min-width: 0;
    border-radius: var(--reader-radius);
}

.reader-theme-switch :deep(.q-btn.is-active) {
    background: var(--reader-accent);
    color: var(--reader-on-accent);
}

:global(.reader-font-menu) {
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
    overflow: hidden;
}

:global(.reader-font-menu .q-item) {
    min-height: 34px;
    color: var(--reader-text);
    font-size: 13px;
    font-weight: 700;
}

:global(.reader-font-menu .q-item.q-item--active),
:global(.reader-font-menu .q-item--active .q-item__label) {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-home {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 28px;
}

.reader-home-panel {
    width: min(980px, 100%);
    margin: 0 auto;
}

.reader-home-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
}

.reader-home-subtitle {
    margin-top: 4px;
    color: var(--reader-muted);
    font-size: 14px;
}

.reader-home-actions,
.reader-home-book-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.reader-home-theme {
    flex: 0 0 auto;
    justify-content: center;
    margin-left: auto;
}

.reader-home-theme :deep(.q-btn) {
    min-height: 28px;
    padding: 4px 9px;
    font-size: 13px;
    line-height: 1.15;
}

.reader-home-tools {
    display: grid;
    gap: 12px;
    margin-bottom: 14px;
}

.reader-home-tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
}

.reader-home-tab-list {
    flex: 1 1 auto;
    flex-wrap: wrap;
    min-width: 0;
}

.reader-home-tab-list .tab {
    cursor: pointer;
}

.reader-home-tab-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding-bottom: 4px;
}

.reader-home-reset-btn {
    color: var(--reader-muted);
    white-space: nowrap;
}

.reader-home-reset-btn:hover {
    color: #c45143;
}

.reader-home-search-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
    gap: 10px;
    align-items: center;
}

.reader-page .reader-home-search :deep(.q-field__control),
.reader-page .reader-home-sort :deep(.q-field__control) {
    min-height: 42px;
    border-radius: 8px;
    background: var(--reader-surface);
    color: var(--reader-text);
}

.reader-home-search :deep(.q-field__native),
.reader-home-search :deep(.q-field__input),
.reader-home-search :deep(.q-field__prepend),
.reader-home-search :deep(.q-field__append),
.reader-home-search :deep(.q-icon),
.reader-home-sort :deep(.q-field__native),
.reader-home-sort :deep(.q-field__input),
.reader-home-sort :deep(.q-field__append),
.reader-home-sort :deep(.q-select__dropdown-icon),
.reader-home-sort :deep(.q-icon) {
    color: var(--reader-muted);
}

.reader-home-search :deep(.q-field__native),
.reader-home-search :deep(.q-field__input),
.reader-home-sort :deep(.q-field__native),
.reader-home-sort :deep(.q-field__input) {
    color: var(--reader-text);
}

.reader-home-search :deep(.q-field__control:hover .q-icon),
.reader-home-search :deep(.q-field--focused .q-icon),
.reader-home-sort :deep(.q-field__control:hover .q-icon),
.reader-home-sort :deep(.q-field--focused .q-icon) {
    color: var(--reader-accent);
}

.reader-home-search :deep(.q-field--outlined .q-field__control::before),
.reader-home-sort :deep(.q-field--outlined .q-field__control::before) {
    border-color: var(--reader-border);
}

.reader-home-search :deep(.q-field--outlined.q-field--focused .q-field__control::after),
.reader-home-sort :deep(.q-field--outlined.q-field--focused .q-field__control::after) {
    border-color: var(--reader-accent);
}

.reader-home-search :deep(.q-field__native::placeholder),
.reader-home-search :deep(.q-field__input::placeholder) {
    color: var(--reader-muted);
    opacity: 0.86;
}

.reader-home-list {
    display: grid;
    gap: 10px;
}

.reader-home-book {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 14px;
    border: 1px solid var(--reader-border);
    border-radius: 8px;
    background: var(--reader-surface);
}

.reader-home-cover {
    width: 52px;
}

.reader-home-book-title {
    color: var(--reader-text);
    font-family: var(--app-font-serif, Georgia, serif);
    font-size: 16px;
    font-weight: 600;
    line-height: 1.25;
}

.reader-home-book-meta {
    margin-top: 4px;
    color: var(--reader-muted);
    font-size: 13px;
}

.reader-home-progress {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 800;
}

/* цвет отметки - из темы читалки */
.reader-home-progress .read-mark {
    color: var(--reader-accent);
}

.reader-home-progress-bar {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--reader-surface-2);
}

.reader-home-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--reader-accent);
}

.reader-home-action-btn {
    min-height: 36px;
    padding: 4px 12px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: transparent;
    color: var(--reader-text);
    font-weight: 600;
}

.reader-home-action-btn--primary {
    border-color: var(--reader-accent);
    background: var(--reader-accent);
    color: var(--reader-on-accent);
}

.reader-home-action-btn--muted {
    background: transparent;
    color: var(--reader-muted);
}

.reader-home-action-btn:not(.reader-home-action-btn--primary):hover,
.reader-home-action-btn:not(.reader-home-action-btn--primary):focus {
    color: var(--reader-accent);
}

.reader-home-state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px;
    border: 1px solid var(--reader-border);
    border-radius: 8px;
    background: var(--reader-surface);
    color: var(--reader-muted);
}

.reader-home-state--empty {
    align-items: flex-start;
}

.reader-home-state--locked {
    flex-wrap: wrap;
}

.reader-home-empty-title {
    color: var(--reader-text);
    font-weight: 800;
}

.reader-home-empty-text {
    margin-top: 4px;
    font-size: 13px;
}

.reader-mobile-btn.is-active {
    color: var(--reader-accent);
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

@media (max-width: 640px) {

    .reader-home {
        padding: 16px 10px 22px;
    }

    .reader-home-head {
        grid-template-columns: 1fr;
        display: grid;
    }

    .reader-home-book {
        grid-template-columns: auto minmax(0, 1fr);
        display: grid;
    }

    .reader-home-book-actions {
        grid-column: 1 / -1;
    }

    .reader-home-actions,
    .reader-home-book-actions {
        align-items: stretch;
    }

    .reader-home-tabs {
        flex-wrap: wrap;
        align-items: stretch;
    }

    .reader-home-tab-list,
    .reader-home-tab-actions {
        flex: 1 1 100%;
    }

    .reader-home-tab-actions {
        justify-content: flex-end;
    }

    .reader-home-search-row {
        grid-template-columns: 1fr;
    }

    .reader-home-actions .q-btn,
    .reader-home-book-actions .q-btn {
        flex: 1 1 150px;
    }

    .reader-home-theme :deep(.q-btn) {
        flex: 0 0 auto;
    }

    .reader-icon-btn {
        width: 34px;
        height: 34px;
    }

    .reader-mobile-spacing-target.is-active {
        border-color: color-mix(in srgb, var(--reader-accent) 42%, var(--reader-border));
        background: var(--reader-accent-soft);
        color: var(--reader-accent);
    }

    .reader-theme-switch,
    .reader-stepper,
    .reader-font-select {
        width: 100%;
        max-width: none;
        justify-content: center;
        border-radius: var(--reader-radius);
        min-height: 44px;
    }

    .reader-theme-switch :deep(.q-btn),
    .reader-stepper :deep(.q-btn) {
        min-height: 36px;
    }
}
</style>
