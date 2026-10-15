<template>
    <div
        v-if="reader.bookUid && reader.isCompactLayout"
        ref="readerMobileFooter"
        class="reader-mobile-footer"
        :style="reader.readerMobileFooterStyle"
        :class="{
            'reader-mobile-footer--settings': reader.controlsOpen,
        }"
    >
        <div
            v-if="reader.showCompactStatusBar && !reader.controlsOpen"
            class="reader-status-bar"
            :class="reader.statusBarClass"
            :style="reader.statusBarStyle"
        >
            <q-icon
                v-if="reader.showCompactPagedBuildIndicator"
                class="la la-spinner icon-rotate reader-status-bar-spinner"
                size="14px"
            />
            <span class="reader-status-main">
                {{ reader.showCompactPagedBuildIndicator ? reader.compactStatusBarBuildText : reader.compactStatusBarText }}
            </span>
            <span v-if="reader.activePreferences.statusBarClock" class="reader-status-clock">{{ reader.statusClockText }}</span>
            <div v-if="reader.activePreferences.statusBarProgressBar" class="reader-status-progress">
                <div :style="{width: `${reader.statusBarProgressPercent}%`}"></div>
            </div>
        </div>

        <div
            v-if="!reader.controlsOpen"
            class="reader-mobile-bar"
            :class="{
                'reader-mobile-bar--with-contents': reader.hasContentsMenu,
                'reader-mobile-bar--hidden': reader.compactChromeHidden,
            }"
        >
            <q-btn
                flat
                no-caps
                stack
                icon="la la-bookmark"
                :label="reader.uiText.myPlaces"
                class="reader-mobile-btn"
                @click="reader.openPlacesDialog(reader.defaultPlacesTab)"
            />
            <q-btn
                v-if="reader.hasContentsMenu"
                flat
                no-caps
                stack
                icon="la la-list"
                :label="reader.uiText.contents"
                class="reader-mobile-btn"
                @click="reader.toggleContentsDialog"
            />
            <q-btn
                flat
                no-caps
                stack
                icon="la la-sliders-h"
                :label="reader.uiText.settings"
                class="reader-mobile-btn"
                :class="{'is-active': reader.controlsOpen}"
                @click="reader.toggleControls"
            />
            <q-btn
                flat
                no-caps
                stack
                :icon="reader.fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                :label="reader.uiText.screen"
                class="reader-mobile-btn"
                @click="reader.toggleFullscreen"
            />
        </div>
    </div>

    <div
        v-if="reader.bookUid && reader.showCompactPagedBuildOverlay"
        class="reader-compact-build-overlay"
        :class="{'reader-compact-build-overlay--above-chrome': !reader.compactChromeHidden}"
    >
        <div class="reader-status-bar" :class="reader.statusBarClass" :style="reader.statusBarStyle">
            <q-icon class="la la-spinner icon-rotate reader-status-bar-spinner" size="14px" />
            <span class="reader-status-main">{{ reader.compactStatusBarBuildText }}</span>
        </div>
    </div>

    <div
        v-if="reader.bookUid && reader.showDesktopStatusBar"
        class="reader-desktop-footer"
        :class="{'reader-desktop-footer--edge': reader.activePreferences.statusBarAlign === 'edge'}"
    >
        <div class="reader-status-bar reader-status-bar--desktop" :class="reader.statusBarClass" :style="reader.statusBarStyle">
            <template v-if="reader.showDesktopPagedBuildIndicator">
                <q-icon class="la la-spinner icon-rotate reader-status-bar-spinner" size="14px" />
                <span class="reader-status-main">{{ reader.compactStatusBarBuildText }}</span>
                <span v-if="reader.activePreferences.statusBarClock" class="reader-status-clock">{{ reader.statusClockText }}</span>
                <div v-if="reader.activePreferences.statusBarProgressBar" class="reader-status-progress">
                    <div :style="{width: `${reader.statusBarProgressPercent}%`}"></div>
                </div>
            </template>
            <template v-else>
                <span class="reader-status-main">{{ reader.desktopStatusBarText }}</span>
                <span v-if="reader.activePreferences.statusBarClock" class="reader-status-clock">{{ reader.statusClockText }}</span>
                <div v-if="reader.activePreferences.statusBarProgressBar" class="reader-status-progress">
                    <div :style="{width: `${reader.statusBarProgressPercent}%`}"></div>
                </div>
            </template>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//Нижние панели читалки: на телефоне - строка состояния и кнопки (места, оглавление, настройки, экран),
//плашка перестройки страниц, на компьютере - строка состояния. Состояние и обработчики остаются в Reader,
//сюда приходит его экземпляр
class ReaderFooter {
    _props = {
        reader: {type: Object, required: true},
    };
}

export default vueComponent(ReaderFooter);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.reader-mobile-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 8px calc(8px + env(safe-area-inset-bottom));
    border-top: 0;
    background: linear-gradient(to top, color-mix(in srgb, var(--reader-bg) 96%, transparent), transparent);
}

.reader-compact-build-overlay {
    position: absolute;
    right: 8px;
    bottom: calc(10px + env(safe-area-inset-bottom));
    left: 8px;
    z-index: 18;
    display: flex;
    justify-content: center;
    pointer-events: none;
}

.reader-compact-build-overlay--above-chrome {
    bottom: calc(96px + env(safe-area-inset-bottom));
}

.reader-compact-build-overlay .reader-status-bar {
    width: min(100%, 520px);
    flex-wrap: nowrap;
}

.reader-desktop-footer {
    display: flex;
    justify-content: center;
    flex: 0 0 auto;
    padding: 6px 16px 12px;
    background: linear-gradient(to top, color-mix(in srgb, var(--reader-bg) 94%, transparent), transparent);
}

.reader-desktop-footer--edge {
    justify-content: flex-end;
}

.reader-status-bar--desktop {
    justify-content: center;
    min-width: 180px;
    max-width: min(620px, 100%);
}

.reader-mobile-bar--hidden {
    visibility: hidden;
    pointer-events: none;
}

.reader-mobile-bar {
    display: flex;
    margin: 0 -8px calc(-8px - env(safe-area-inset-bottom));
    padding: 2px 0 env(safe-area-inset-bottom);
    border-top: 1px solid var(--reader-border);
    background: var(--reader-surface);
}

.reader-mobile-btn {
    flex: 1 1 0;
    min-width: 0;
    min-height: 56px;
    padding: 6px 4px;
    border-radius: 0;
    background: transparent;
    color: var(--reader-muted);
}

.reader-mobile-btn :deep(.q-btn__content) {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    min-height: 100%;
    line-height: 1.08;
    overflow: hidden;
}

.reader-mobile-btn :deep(.q-icon) {
    font-size: 19px;
    margin: 0;
}

.reader-mobile-btn :deep(.block) {
    display: block;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    font-size: 10.5px;
    font-weight: 760;
    letter-spacing: 0;
    text-align: center;
    text-wrap: balance;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: normal;
    hyphens: auto;
}

.reader-mobile-btn.is-active {
    color: var(--reader-accent);
}

.reader-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding: var(--reader-status-padding-y, 4px) var(--reader-status-padding-x, 10px);
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface);
    color: var(--reader-muted);
    font-size: var(--reader-status-font-size, 12px);
    font-weight: 600;
}

.reader-status-main {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-mobile-footer .reader-status-main {
    flex-basis: 0;
}

.reader-status-clock {
    flex: 0 0 auto;
    color: var(--reader-text);
    font-variant-numeric: tabular-nums;
}

.reader-status-progress {
    flex: 1 0 100%;
    height: var(--reader-status-progress-height, 4px);
    border-radius: 999px;
    background: color-mix(in srgb, var(--reader-muted) 20%, transparent);
    overflow: hidden;
}

.reader-status-bar--progress-side .reader-status-progress {
    flex: 0 0 clamp(86px, 18vw, 150px);
    order: 8;
}

.reader-status-progress div {
    height: 100%;
    border-radius: inherit;
    background: var(--reader-accent);
}

.reader-status-bar-spinner {
    flex: 0 0 auto;
    opacity: 0.9;
}

.reader-theme-eink .reader-mobile-bar,
.reader-theme-eink .reader-status-bar {
    box-shadow: none;
}

.reader-theme-eink .reader-mobile-bar,
.reader-theme-eink .reader-status-bar {
    backdrop-filter: none;
}

.reader-theme-sepia .reader-mobile-footer,
.reader-theme-light .reader-mobile-footer,
.reader-theme-sepia .reader-desktop-footer,
.reader-theme-light .reader-desktop-footer {
    background:
        linear-gradient(
            to top,
            color-mix(in srgb, var(--reader-bg) 90%, var(--reader-surface-2) 10%) 0%,
            color-mix(in srgb, var(--reader-bg) 84%, var(--reader-surface) 16%) 28%,
            color-mix(in srgb, var(--reader-bg) 90%, transparent) 62%,
            transparent 100%
        );
    gap: 10px;
    padding-top: 14px;
    box-shadow:
        inset 0 1px 0 color-mix(in srgb, var(--reader-text) 12%, transparent),
        inset 0 12px 24px color-mix(in srgb, var(--reader-bg) 82%, transparent);
}

.reader-theme-sepia .reader-mobile-footer,
.reader-theme-sepia .reader-desktop-footer {
    background:
        linear-gradient(
            to top,
            color-mix(in srgb, var(--reader-bg) 84%, var(--reader-surface-2) 16%) 0%,
            color-mix(in srgb, var(--reader-bg) 76%, var(--reader-surface) 24%) 28%,
            color-mix(in srgb, var(--reader-bg) 88%, transparent) 62%,
            transparent 100%
        );
}

.reader-page--transparent-status .reader-mobile-footer,
.reader-page--transparent-status .reader-desktop-footer {
    background: transparent !important;
    box-shadow: none;
}

.reader-page--transparent-status .reader-status-bar {
    border-color: color-mix(in srgb, var(--reader-border) 48%, transparent) !important;
    background: transparent !important;
    box-shadow: none !important;
    color: var(--reader-text);
}

.reader-page--text-shadow.reader-page--transparent-status .reader-status-bar {
    text-shadow: 0 1px 2px color-mix(in srgb, var(--reader-bg) 42%, transparent);
}

.reader-page:not(.reader-page--text-shadow) .reader-status-bar {
    text-shadow: none !important;
}

@media (max-width: 640px) {

    .reader-mobile-footer--settings {
        flex: 0 0 var(--reader-mobile-settings-height, min(46dvh, 388px));
        height: var(--reader-mobile-settings-height, min(46dvh, 388px));
        min-height: 0;
        gap: 0;
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
        pointer-events: none;
    }

    .reader-mobile-bar {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .reader-mobile-bar--with-contents {
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .reader-mobile-btn {
        min-height: 52px;
    }

    .reader-mobile-btn :deep(.q-icon) {
        font-size: 18px;
    }

    .reader-mobile-btn :deep(.block) {
        font-size: 10px;
    }
}
</style>
