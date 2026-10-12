<template>
    <component
        :is="reader.readerPanelTag"
        v-if="!reader.fullscreenActive || reader.contentsDialogOpen"
        v-bind="reader.readerPanelBinding('contentsDialogOpen')"
    >
        <div :class="reader.readerPanelClass" :style="reader.readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-heading">
                    <q-btn
                        v-if="reader.contentsPanelView === 'annotation'"
                        flat
                        dense
                        round
                        icon="la la-arrow-left"
                        :aria-label="reader.uiText.backToContents"
                        @click="reader.showContentsList"
                    />
                    <div class="reader-dialog-title">
                        {{ reader.contentsPanelView === 'annotation' ? reader.uiText.annotation : reader.uiText.contents }}
                    </div>
                </div>
                <q-btn flat dense round icon="la la-times" @click="reader.closeContentsDialog" />
            </div>

            <div class="reader-dialog-body" :class="{'reader-dialog-body--annotation': reader.contentsPanelView === 'annotation'}">
                <div
                    v-if="reader.contentsPanelView === 'annotation'"
                    class="reader-html reader-annotation-html"
                    :style="reader.readerAnnotationStyle"
                    @click="reader.handleReaderAnnotationClick"
                    v-html="reader.readerAnnotationHtml"
                ></div>
                <template v-else>
                    <button
                        v-if="reader.hasAnnotation"
                        type="button"
                        class="reader-dialog-link reader-dialog-link--feature"
                        @click="reader.showReaderAnnotation"
                    >
                        <q-icon name="la la-info-circle" />
                        <span>{{ reader.uiText.annotation }}</span>
                        <q-icon name="la la-angle-right" />
                    </button>
                    <button
                        v-if="reader.hasBookNotes"
                        type="button"
                        class="reader-dialog-link reader-dialog-link--feature"
                        data-testid="reader-notes-link"
                        @click="reader.showReaderNotes"
                    >
                        <q-icon name="la la-sticky-note" />
                        <span>{{ reader.uiText.bookNotes }}</span>
                        <q-icon name="la la-angle-right" />
                    </button>
                    <div v-if="(reader.hasAnnotation || reader.hasBookNotes) && reader.displayContents.length" class="reader-dialog-separator" role="separator"></div>
                    <button
                        v-for="item in reader.displayContents"
                        :key="item.id"
                        class="reader-dialog-link"
                        :class="{'is-active': item.id === reader.currentSectionId}"
                        @click="reader.jumpToContent(item.id)"
                    >
                        {{ item.title }}
                    </button>
                </template>
            </div>
        </div>
    </component>

    <component
        :is="reader.readerPanelTag"
        v-if="!reader.fullscreenActive || reader.bookmarksDialogOpen"
        v-bind="reader.readerPanelBinding('bookmarksDialogOpen')"
    >
        <div :class="reader.readerPanelClass" :style="reader.readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ reader.uiText.myPlaces }}</div>
                <q-btn flat dense round icon="la la-times" @click="bookmarksDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <div class="tabs reader-dialog-tabs">
                    <button
                        type="button"
                        class="tab"
                        :class="{'is-active': reader.currentPlacesTab === 'progress'}"
                        @click="currentPlacesTab = 'progress'"
                    >
                        {{ reader.uiText.continueReading }}
                    </button>
                    <button
                        type="button"
                        class="tab"
                        :class="{'is-active': reader.currentPlacesTab === 'bookmarks'}"
                        @click="currentPlacesTab = 'bookmarks'"
                    >
                        {{ reader.uiText.bookmarks }} <span v-if="reader.plainBookmarks.length" class="tab-count">{{ reader.plainBookmarks.length }}</span>
                    </button>
                    <button
                        type="button"
                        class="tab"
                        :class="{'is-active': reader.currentPlacesTab === 'notes'}"
                        @click="currentPlacesTab = 'notes'"
                    >
                        {{ reader.uiText.notes }} <span v-if="reader.noteBookmarks.length" class="tab-count">{{ reader.noteBookmarks.length }}</span>
                    </button>
                </div>

                <div v-if="reader.currentPlacesTab === 'progress'" class="reader-continue-card">
                    <div class="reader-continue-title">{{ reader.currentSectionTitle || reader.title }}</div>
                    <div class="reader-continue-meta">
                        {{ reader.displayProgressPercent }}%<span v-if="reader.showDisplayPagedPageCounter"> | {{ reader.displayCurrentPage }}/{{ reader.displayTotalPages }}</span>
                    </div>
                    <div v-if="reader.progress.updatedAt" class="reader-continue-updated">{{ reader.formatBookmarkDate(reader.progress.updatedAt) }}</div>
                    <div class="reader-continue-actions">
                        <q-btn flat dense no-caps icon="la la-book-open" class="reader-inline-action-btn" @click="reader.jumpToProgress">{{ reader.uiText.continueReading }}</q-btn>
                        <q-btn flat dense no-caps icon="la la-bookmark" class="reader-inline-action-btn" @click="reader.addCurrentBookmark">{{ reader.uiText.bookmark }}</q-btn>
                    </div>
                </div>

                <template v-else-if="reader.currentPlacesTab === 'bookmarks'">
                    <button
                        v-for="item in reader.plainBookmarks"
                        :key="item.id"
                        class="reader-dialog-link reader-dialog-link--bookmark"
                        @click="reader.jumpToBookmark(item)"
                    >
                        <span class="reader-dialog-link-text">
                            <span>{{ item.title }}</span>
                            <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                        </span>
                        <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                        <q-btn
                            flat
                            dense
                            round
                            icon="la la-trash"
                            class="reader-bookmark-delete"
                            @click.stop="reader.removeBookmark(item.id)"
                        />
                    </button>
                    <div v-if="!reader.plainBookmarks.length" class="reader-dialog-empty">{{ reader.uiText.noBookmarks }}</div>
                </template>

                <template v-else>
                    <button
                        v-for="item in reader.noteBookmarks"
                        :key="item.id"
                        class="reader-dialog-link reader-dialog-link--bookmark"
                        @click="reader.jumpToBookmark(item)"
                    >
                        <span class="reader-dialog-link-text">
                            <span>{{ item.title }}</span>
                            <small v-if="item.note" class="reader-dialog-link-note">{{ item.note }}</small>
                            <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                        </span>
                        <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                        <q-btn
                            flat
                            dense
                            round
                            icon="la la-trash"
                            class="reader-bookmark-delete"
                            @click.stop="reader.removeBookmark(item.id)"
                        />
                    </button>
                    <div v-if="!reader.noteBookmarks.length" class="reader-dialog-empty">{{ reader.uiText.noNotes }}</div>
                </template>
            </div>
        </div>
    </component>

    <component
        :is="reader.readerPanelTag"
        v-if="!reader.fullscreenActive || reader.helpDialogOpen"
        v-bind="reader.readerPanelBinding('helpDialogOpen')"
    >
        <div :class="reader.readerPanelClass" :style="reader.readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ reader.uiText.readerHelp }}</div>
                <q-btn flat dense round icon="la la-times" @click="helpDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <div class="reader-help-intro">{{ reader.readerHelpIntro }}</div>
                <div v-for="item in reader.readerHelpItems" :key="item" class="reader-help-item">{{ item }}</div>
            </div>
        </div>
    </component>

    <component
        :is="reader.readerPanelTag"
        v-if="reader.isPagedMode && (!reader.fullscreenActive || reader.searchDialogOpen)"
        v-bind="reader.readerPanelBinding('searchDialogOpen')"
    >
        <div :class="reader.readerPanelClass" :style="reader.readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ reader.uiText.searchTitle }}</div>
                <q-btn flat dense round icon="la la-times" @click="searchDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <q-input
                    v-model="reader.searchQuery"
                    dense
                    outlined
                    clearable
                    :aria-label="reader.uiText.searchTitle"
                    :placeholder="reader.uiText.searchPlaceholder"
                    @update:model-value="reader.handleSearchInput"
                    @keyup.enter="reader.jumpToNextSearchResult"
                />
                <div class="reader-search-toolbar">
                    <q-btn
                        flat
                        dense
                        no-caps
                        icon="la la-angle-left"
                        :label="reader.uiText.searchPrev"
                        class="reader-inline-action-btn"
                        :disable="!reader.hasSearchResults"
                        @click="reader.jumpToPrevSearchResult"
                    />
                    <q-btn
                        flat
                        dense
                        no-caps
                        icon-right="la la-angle-right"
                        :label="reader.uiText.searchNext"
                        class="reader-inline-action-btn"
                        :disable="!reader.hasSearchResults"
                        @click="reader.jumpToNextSearchResult"
                    />
                </div>
                <div class="reader-search-meta">
                    <span v-if="reader.hasSearchResults">{{ reader.searchResultsLabel }}</span>
                    <span v-else-if="reader.searchQuery.trim()">{{ reader.uiText.searchEmpty }}</span>
                    <span v-else>{{ reader.uiText.searchHint }}</span>
                </div>
            </div>
        </div>
    </component>

    <q-dialog v-model="reader.bookmarkComposerOpen">
        <div class="reader-dialog reader-dialog--composer std-dialog-card--reader" :class="reader.readerThemeClass" :style="reader.readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ reader.uiText.newPlace }}</div>
                <q-btn flat dense round icon="la la-times" @click="bookmarkComposerOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <div class="reader-compose-title">{{ reader.bookmarkDraft.title || reader.title }}</div>
                <div v-if="reader.bookmarkDraft.excerpt" class="reader-compose-excerpt">{{ reader.bookmarkDraft.excerpt }}</div>
                <q-input
                    class="reader-compose-input"
                    v-model="reader.bookmarkDraft.note"
                    outlined
                    autogrow
                    type="textarea"
                    :label="reader.uiText.noteLabel"
                />
                <div class="reader-compose-actions">
                    <q-btn flat dense no-caps icon="la la-bookmark" class="reader-inline-action-btn" @click="reader.saveBookmarkDraft('bookmark')">{{ reader.uiText.simpleBookmark }}</q-btn>
                    <q-btn flat dense no-caps icon="la la-sticky-note" class="reader-inline-action-btn" @click="reader.saveBookmarkDraft('note')">{{ reader.uiText.saveAsNote }}</q-btn>
                </div>
            </div>
        </div>
    </q-dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//Часть шаблона Reader.vue: состояние и обработчики остаются в Reader, сюда приходит его экземпляр
class ReaderDialogs {
    _props = {
        reader: {type: Object, required: true},
    };
}

export default vueComponent(ReaderDialogs);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.reader-icon-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-controls-tabs .tab,
.reader-dialog-tabs .tab {
    cursor: pointer;
}

.reader-home-tab-list .tab {
    cursor: pointer;
}

.reader-cover-box,
.reader-html :deep(.reader-cover-box) {
    display: flex;
    justify-content: center;
    margin-bottom: 24px;
}

.reader-cover,
.reader-html :deep(.reader-cover) {
    width: 180px;
    max-width: 42vw;
    border-radius: var(--reader-radius);
    box-shadow: 0 18px 38px rgba(0, 0, 0, 0.18);
}

.reader-body--paged .reader-html {
    display: block;
    height: auto;
    max-height: none;
    overflow: hidden;
}

.reader-page-sheet .reader-html,
.reader-page-column-sheet .reader-html {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
    max-height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    padding-bottom: 0;
}

.reader-page-sheet .reader-html :deep(.reader-page-content),
.reader-page-column-sheet .reader-html :deep(.reader-page-content) {
    display: flow-root;
    min-height: 0;
    padding-bottom: 0;
    box-sizing: border-box;
}

.reader-page-sheet .reader-html :deep(.reader-page-spacer),
.reader-page-column-sheet .reader-html :deep(.reader-page-spacer) {
    height: 0;
    pointer-events: none;
}

.reader-page-sheet.reader-reflow-anchor-highlight,
.reader-page-column-sheet.reader-reflow-anchor-highlight,
.reader-html :deep(.reader-reflow-anchor-highlight) {
    position: relative;
    border-radius: var(--reader-radius);
    animation: reader-reflow-anchor-pulse 4.2s ease-out both;
}

.reader-html :deep(.reader-reflow-anchor-highlight) {
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes,
.reader-body--paged .reader-progress-bar,
.reader-body--paged .reader-contents-inline,
.reader-body--paged .reader-series,
.reader-body--paged .reader-heading,
.reader-body--paged .reader-subheading,
.reader-body--paged .reader-image-block,
.reader-body--paged .reader-cover-box,
.reader-body--paged .reader-html :deep(.reader-section),
.reader-body--paged .reader-html :deep(.reader-notes),
.reader-body--paged .reader-html :deep(.reader-progress-bar),
.reader-body--paged .reader-html :deep(.reader-contents-inline),
.reader-body--paged .reader-html :deep(.reader-series),
.reader-body--paged .reader-html :deep(.reader-heading),
.reader-body--paged .reader-html :deep(.reader-subheading),
.reader-body--paged .reader-html :deep(.reader-image-block),
.reader-body--paged .reader-html :deep(.reader-cover-box) {
    break-inside: avoid;
}

.reader-series,
.reader-html :deep(.reader-series) {
    color: var(--reader-muted);
    font-size: 0.92em;
    font-weight: 650;
}

.reader-heading,
.reader-html :deep(.reader-heading) {
    margin: 10px 0 0;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.06;
}

.reader-subheading,
.reader-html :deep(.reader-subheading) {
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 0.98em;
}

.reader-opening-title,
.reader-html :deep(.reader-opening-title) {
    margin: 0 0 18px;
    font-size: 1.22em;
    font-weight: 700;
    line-height: 1.35;
}

.reader-html :deep(.reader-section-block) {
    margin-top: 18px;
}

.reader-body--paged .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: page;
    page-break-before: always;
}

.reader-body--paged-horizontal .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: column;
    page-break-before: auto;
}

.reader-html :deep(.reader-section-heading) {
    margin: 1.3em 0 0.55em;
    line-height: 1.18;
}

.reader-html :deep(.reader-subtitle) {
    margin: 1em 0 0.5em;
    line-height: 1.25;
}

.reader-html :deep(.reader-epigraph),
.reader-html :deep(.reader-cite) {
    margin: 1.1em 0;
    padding: 0.4em 0 0.4em 1.1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(.reader-epigraph-author) {
    margin-top: 0.55em;
    text-align: right;
    font-size: 0.92em;
}

.reader-html :deep(.reader-poem),
.reader-html :deep(.reader-stanza) {
    margin: 1em 0;
}

.reader-html :deep(.reader-image-block) {
    margin: 1.1em 0;
    text-align: center;
}

.reader-html :deep(.reader-empty-line) {
    height: 1em;
}

.reader-html {
    color: var(--reader-text);
}

.reader-html :deep(h1),
.reader-html :deep(h2),
.reader-html :deep(h3),
.reader-html :deep(h4) {
    line-height: 1.15;
    margin: 1.45em 0 0.5em;
}

.reader-html :deep(.reader-anchored-heading) {
    scroll-margin-top: 84px;
}

.reader-html :deep(.reader-inline-link) {
    color: var(--reader-accent);
    font-weight: 700;
    text-decoration: none;
}

.reader-html :deep(a.reader-inline-link) {
    cursor: pointer;
}

.reader-html :deep(a.reader-inline-link:hover) {
    text-decoration: underline;
}

.reader-html :deep(p),
.reader-paragraph {
    margin: 0.8em 0;
    text-align: justify;
}

.reader-body--paged .reader-html :deep(p),
.reader-body--paged .reader-paragraph {
    margin: 0.42em 0;
}

.reader-body--paged .reader-html :deep(.reader-section-heading) {
    margin: 0.9em 0 0.38em;
}

.reader-body--paged .reader-html :deep(.reader-subtitle) {
    margin: 0.75em 0 0.35em;
}

.reader-html :deep(blockquote) {
    margin: 1.2em 0;
    padding-left: 1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(img),
.reader-inline-image {
    display: block;
    max-width: min(100%, 680px);
    height: auto;
    margin: 18px auto;
    border-radius: var(--reader-radius);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

.reader-body--paged .reader-cover,
.reader-body--paged .reader-html :deep(.reader-cover) {
    width: 180px;
    max-width: min(100%, 320px);
    max-height: var(--reader-page-media-max-height);
    aspect-ratio: var(--reader-cover-aspect, auto);
    object-fit: contain;
}

.reader-body--paged .reader-html :deep(img),
.reader-body--paged .reader-inline-image {
    width: auto;
    max-width: 100%;
    max-height: var(--reader-page-media-max-height);
    object-fit: contain;
}

.reader-mobile-btn.is-active {
    color: var(--reader-accent);
}

.reader-dialog {
    width: min(92vw, 420px);
    max-height: 85vh;
    border-radius: var(--reader-radius-lg);
    background: var(--reader-surface) !important;
    color: var(--reader-text) !important;
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.std-dialog-card--reader :deep(.q-btn),
.std-dialog-card--reader :deep(.q-icon),
.std-dialog-card--reader :deep(.q-field__native),
.std-dialog-card--reader :deep(.q-field__input),
.std-dialog-card--reader :deep(.q-field__label),
.std-dialog-card--reader :deep(.q-field__marginal),
.std-dialog-card--reader :deep(.q-field__control) {
    color: var(--reader-text);
}

.std-dialog-card--reader :deep(.q-field__control) {
    background: var(--reader-surface-2);
}

.reader-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--reader-border);
}

.reader-dialog-heading {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
}

.reader-dialog-title {
    min-width: 0;
    font-size: 18px;
    font-weight: 750;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-dialog-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(85vh - 64px);
    overflow: auto;
    padding: 12px;
}

.reader-dialog-link {
    padding: 12px 14px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    text-align: left;
    cursor: pointer;
}

.reader-dialog-link--feature {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) 18px;
    align-items: center;
    gap: 10px;
    border-color: color-mix(in srgb, var(--reader-accent) 34%, var(--reader-border));
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
    font-weight: 800;
}

.reader-dialog-link--feature .q-icon:last-child {
    justify-self: end;
}

.reader-dialog-separator {
    height: 1px;
    margin: 4px 2px;
    background: var(--reader-border);
}

.reader-dialog-body--annotation {
    gap: 0;
}

.reader-annotation-html {
    min-width: 0;
    padding: 0 4px 10px;
    overflow-wrap: anywhere;
    user-select: text;
}

.reader-annotation-html :deep(p:first-child),
.reader-annotation-html :deep(blockquote:first-child) {
    margin-top: 0;
}

.reader-annotation-html :deep(p:last-child),
.reader-annotation-html :deep(blockquote:last-child) {
    margin-bottom: 0;
}

.reader-dialog-link--bookmark {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 56px 36px;
    align-items: start;
    gap: 10px;
}

.reader-dialog-link-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.reader-dialog-link-subtext {
    color: var(--reader-muted);
    font-size: 11px;
    line-height: 1.35;
}

.reader-dialog-link-meta {
    min-width: 56px;
    align-self: start;
    text-align: right;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
}

.reader-bookmark-delete {
    align-self: start;
    justify-self: end;
    color: var(--reader-muted);
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-dialog-tabs {
    flex-wrap: wrap;
}

.reader-continue-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
}

.reader-continue-title {
    font-size: 15px;
    font-weight: 750;
}

.reader-continue-meta,
.reader-continue-updated,
.reader-dialog-empty {
    color: var(--reader-muted);
    font-size: 12px;
}

.reader-help-intro {
    margin-bottom: 12px;
    color: var(--reader-muted);
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.reader-help-item {
    padding: 12px 14px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface-2) 86%, transparent);
    line-height: 1.45;
}

.reader-help-item + .reader-help-item {
    margin-top: 10px;
}

.reader-search-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}

.reader-search-toolbar :deep(.q-btn) {
    min-height: 34px;
    padding: 4px 10px;
    font-size: 13px;
    font-weight: 650;
    line-height: 1.2;
}

.reader-search-toolbar :deep(.q-icon) {
    font-size: 18px;
}

.reader-search-meta {
    margin-top: 6px;
    color: var(--reader-muted);
    font-size: 12px;
}

.reader-html :deep(.reader-search-hit) {
    padding: 0.04em 0.14em;
    border-radius: 0.28em;
    background: color-mix(in srgb, var(--reader-accent) 28%, transparent);
    color: inherit;
}

.reader-continue-actions,
.reader-compose-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reader-inline-action-btn {
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
}

.reader-compose-input :deep(.q-field__control),
.reader-compose-input :deep(.q-field__marginal),
.reader-compose-input :deep(.q-field__native),
.reader-compose-input :deep(.q-field__input) {
    color: var(--reader-text);
}

.reader-compose-input :deep(.q-field__control) {
    background: var(--reader-surface-2);
}

.reader-compose-input :deep(.q-field__label),
.reader-compose-input :deep(.q-field__bottom) {
    color: var(--reader-muted);
}

.reader-dialog-link-note {
    color: var(--reader-text);
    font-size: 12px;
    line-height: 1.45;
    font-weight: 600;
}

.reader-dialog--composer {
    width: min(92vw, 520px);
}

.reader-compose-title {
    font-size: 14px;
    font-weight: 750;
}

.reader-compose-excerpt {
    padding: 10px 12px;
    border-left: 3px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface-2) 86%, transparent);
    color: var(--reader-muted);
    line-height: 1.55;
}

.reader-theme-eink .reader-inline-image,
.reader-theme-eink .reader-page-sheet,
.reader-theme-eink .reader-mobile-bar,
.reader-theme-eink .reader-status-bar,
.reader-theme-eink .reader-dialog,
.reader-theme-eink .reader-overlay-panel {
    box-shadow: none;
}

.reader-page--text-shadow.reader-page--transparent-pages .reader-body:not(.reader-body--paged),
.reader-page--text-shadow.reader-page--transparent-pages .reader-page-sheet:not(.reader-page-sheet--measure) .reader-html {
    text-shadow: 0 1px 2px color-mix(in srgb, var(--reader-bg) 36%, transparent);
}

.reader-page:not(.reader-page--text-shadow) .reader-body,
.reader-page:not(.reader-page--text-shadow) .reader-page-sheet .reader-html,
.reader-page:not(.reader-page--text-shadow) .reader-status-bar {
    text-shadow: none !important;
}

@media (max-width: 640px) {

    .reader-mobile-spacing-target.is-active {
        border-color: color-mix(in srgb, var(--reader-accent) 42%, var(--reader-border));
        background: var(--reader-accent-soft);
        color: var(--reader-accent);
    }

    .reader-search-toolbar :deep(.q-btn) {
        min-height: 44px;
    }

    .reader-cover,
    .reader-html :deep(.reader-cover),
    .reader-body--paged .reader-cover,
    .reader-body--paged .reader-html :deep(.reader-cover) {
        width: 140px;
        max-width: 46vw;
    }

    .reader-html :deep(p),
    .reader-paragraph {
        text-align: left;
    }
}

@keyframes reader-reflow-anchor-pulse {
    0% {
        background-color: color-mix(in srgb, var(--reader-accent) 30%, transparent);
        box-shadow:
            0 0 0 4px color-mix(in srgb, var(--reader-accent) 24%, transparent),
            0 0 22px color-mix(in srgb, var(--reader-accent) 30%, transparent);
    }
    55% {
        background-color: color-mix(in srgb, var(--reader-accent) 16%, transparent);
        box-shadow:
            0 0 0 2px color-mix(in srgb, var(--reader-accent) 14%, transparent),
            0 0 14px color-mix(in srgb, var(--reader-accent) 16%, transparent);
    }
    100% {
        background-color: transparent;
        box-shadow: none;
    }
}
</style>
