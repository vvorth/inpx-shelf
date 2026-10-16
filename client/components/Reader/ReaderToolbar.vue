<template>
    <div
        class="reader-toolbar"
        :class="{
            'reader-toolbar--home': !reader.bookUid,
            'reader-toolbar--hidden': reader.readerChromeHidden,
            'reader-toolbar--overlay': reader.readerToolbarOverlay,
        }"
    >
        <div class="reader-toolbar-main">
            <q-btn
                flat
                no-caps
                :icon="reader.readerNoteReturnPoint ? 'la la-undo-alt' : 'la la-arrow-left'"
                class="reader-back-btn"
                :class="{'reader-back-btn--note-return': reader.readerNoteReturnPoint}"
                :aria-label="reader.readerNoteReturnPoint ? reader.uiText.noteReturn : reader.uiText.back"
                :data-testid="reader.readerNoteReturnPoint ? 'reader-note-return' : null"
                :label="reader.isCompactLayout ? '' : (reader.readerNoteReturnPoint ? reader.uiText.noteReturn : reader.uiText.back)"
                @click="reader.goBack"
            />

            <div v-if="reader.bookUid" class="reader-book-meta">
                <div
                    class="reader-book-title"
                    :class="{'is-expanded': reader.isCompactLayout && reader.readerMetaExpanded}"
                    @click="reader.toggleReaderMeta"
                >
                    {{ reader.readerHeaderTitle }}
                </div>
                <div
                    v-if="reader.readerHeaderSubtitle"
                    class="reader-book-author"
                    :class="{'is-expanded': reader.isCompactLayout && reader.readerMetaExpanded}"
                    @click="reader.toggleReaderMeta"
                >
                    {{ reader.readerHeaderSubtitle }}
                </div>
                <div
                    v-if="reader.bookUid && !reader.isCompactLayout"
                    class="reader-book-progress"
                    :class="{'is-clickable': reader.hasReaderPlaces}"
                    @click="reader.hasReaderPlaces && reader.openPlacesDialog(reader.defaultPlacesTab)"
                >
                    {{ reader.readerProgressLabel }}<span v-if="reader.readerPageMeta"> | {{ reader.readerPageMeta }}</span><span v-if="reader.readerSectionMeta"> &middot; {{ reader.readerSectionMeta }}</span>
                </div>
            </div>

            <button
                v-if="reader.bookUid && !reader.isStandaloneMode"
                type="button"
                class="reader-profile-chip"
                :class="reader.readerProfileChipClass"
                @click="reader.handleReaderProfileChipClick"
            >
                <q-icon :name="reader.readerProfileChipIcon" />
                <span>{{ reader.readerProfileChipLabel }}</span>
            </button>

            <div v-if="reader.bookUid" class="reader-toolbar-quick-actions">
                <q-btn
                    v-if="reader.hasPrevSection"
                    flat
                    dense
                    round
                    icon="la la-angle-left"
                    class="reader-icon-btn"
                    @click="reader.jumpToAdjacentSection(-1)"
                />
                <q-btn
                    v-if="reader.hasContentsMenu"
                    flat
                    dense
                    round
                    icon="la la-list"
                    class="reader-icon-btn"
                    @click="reader.toggleContentsDialog"
                />
                <q-btn
                    v-if="reader.isPagedMode"
                    flat
                    dense
                    round
                    icon="la la-search"
                    class="reader-icon-btn"
                    :class="{'is-active': reader.searchDialogOpen}"
                    @click="reader.toggleSearchDialog"
                />
                <q-btn
                    flat
                    dense
                    round
                    icon="la la-bookmark"
                    class="reader-icon-btn"
                    @click="reader.addCurrentBookmark"
                />
                <q-btn
                    flat
                    dense
                    round
                    :icon="reader.isBookMarkedRead ? 'la la-undo' : 'la la-check-circle'"
                    class="reader-icon-btn"
                    @click="reader.toggleCurrentBookRead"
                />
                <q-btn
                    flat
                    dense
                    round
                    :icon="reader.fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                    class="reader-icon-btn"
                    @click="reader.toggleFullscreen"
                />
                <q-btn
                    flat
                    dense
                    round
                    icon="la la-question-circle"
                    class="reader-icon-btn"
                    @click="reader.toggleHelpDialog"
                />
                <q-btn
                    flat
                    dense
                    round
                    icon="la la-sliders-h"
                    class="reader-icon-btn"
                    :class="{'is-active': reader.controlsOpen}"
                    @click="reader.toggleControls"
                />
                <q-btn
                    v-if="reader.hasNextSection"
                    flat
                    dense
                    round
                    icon="la la-angle-right"
                    class="reader-icon-btn"
                    @click="reader.jumpToAdjacentSection(1)"
                />
            </div>
        </div>

        <slot></slot>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//Верхняя панель читалки: назад, название и прогресс, профиль, быстрые действия. Панель не убирается из разметки,
//а гаснет: область чтения не меняет размер, текст не прыгает. Панель настроек приходит слотом (её ref - у Reader).
//Состояние и обработчики остаются в Reader, сюда приходит его экземпляр
class ReaderToolbar {
    _props = {
        reader: {type: Object, required: true},
    };
}

export default vueComponent(ReaderToolbar);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.reader-toolbar {
    position: sticky;
    top: 0;
    z-index: 12;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface) 92%, transparent);
    backdrop-filter: blur(10px);
    overflow: visible;
    transition: opacity 0.18s ease, visibility 0.18s ease;
}

.reader-toolbar--hidden {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
}

.reader-toolbar--overlay {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
}

.reader-toolbar-main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    flex: 1 1 auto;
    gap: 12px;
    width: 100%;
    min-width: 0;
}

.reader-back-btn :deep(.q-btn__content) {
    flex-wrap: nowrap;
}

.reader-back-btn--note-return {
    border: 1px solid color-mix(in srgb, var(--reader-accent) 38%, var(--reader-border));
    border-radius: var(--reader-radius);
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
    font-weight: 800;
}

.reader-toolbar--home {
    align-items: stretch;
    justify-content: flex-start;
}

.reader-toolbar--home .reader-toolbar-main {
    display: flex;
    width: 100%;
    max-width: none;
    margin: 0;
}

.reader-book-meta {
    min-width: 0;
    width: 100%;
}

.reader-book-title {
    font-family: var(--app-font-serif, Georgia, serif);
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-book-author {
    margin-top: 2px;
    color: var(--reader-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-book-progress {
    margin-top: 6px;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.reader-book-progress.is-clickable {
    cursor: pointer;
    transition: color 0.18s ease;
}

.reader-book-progress.is-clickable:hover {
    color: var(--reader-accent);
}

.reader-toolbar-quick-actions {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 6px;
}

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

.reader-profile-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    width: fit-content;
    min-width: 96px;
    max-width: 220px;
    min-height: 34px;
    padding: 6px 10px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface);
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 800;
    line-height: 1.1;
    cursor: default;
}

.reader-profile-chip span {
    min-width: 0;
    max-width: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-profile-chip--authorized {
    border-color: color-mix(in srgb, var(--reader-text) 18%, var(--reader-border));
    color: var(--reader-muted);
    background: color-mix(in srgb, var(--reader-surface) 86%, var(--reader-surface-2) 14%);
}

.reader-profile-chip--open {
    border-color: color-mix(in srgb, #60a5fa 30%, var(--reader-border));
    color: color-mix(in srgb, #60a5fa 72%, var(--reader-text));
}

.reader-profile-chip--locked {
    border-color: color-mix(in srgb, var(--reader-accent) 42%, var(--reader-border));
    color: var(--reader-accent);
    cursor: pointer;
}

.reader-profile-chip--missing {
    color: var(--reader-muted);
}

@media (max-width: 1023.98px) {
    .reader-back-btn--note-return {
        min-width: 42px;
        min-height: 42px;
    }

    .reader-back-btn--note-return :deep(.block) {
        display: none;
    }
}

@media (max-width: 900px) {
    .reader-toolbar {
        flex-direction: column;
        align-items: stretch;
    }
}

@media (max-width: 640px) {
    .reader-toolbar {
        padding: 8px 8px 10px;
        gap: 8px;
        z-index: 40;
        backdrop-filter: none;
    }

    .reader-toolbar-main {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .reader-back-btn {
        min-width: 42px;
        min-height: 42px;
    }

    .reader-back-btn :deep(.block) {
        display: none;
    }

    .reader-book-meta {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .reader-book-title {
        font-size: 13px;
        line-height: 1.12;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        white-space: normal;
        overflow: hidden;
    }

    .reader-book-title.is-expanded {
        -webkit-line-clamp: initial;
        overflow: visible;
    }

    .reader-book-author {
        margin-top: 0;
        font-size: 12px;
        line-height: 1.2;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        white-space: normal;
        overflow: hidden;
    }

    .reader-book-author.is-expanded {
        -webkit-line-clamp: initial;
        overflow: visible;
    }

    .reader-book-progress {
        margin-top: 2px;
        font-size: 11px;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .reader-toolbar-quick-actions {
        display: none;
    }

    .reader-profile-chip {
        flex: 0 0 auto;
        max-width: 94px;
        min-height: 32px;
        padding: 5px 8px;
        gap: 5px;
        font-size: 11px;
        border-radius: var(--reader-radius);
    }

    .reader-profile-chip :deep(.q-icon) {
        font-size: 16px;
    }

    .reader-profile-chip span {
        max-width: 58px;
    }

    .reader-icon-btn {
        width: 34px;
        height: 34px;
    }
}
</style>
