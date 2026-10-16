<template>
    <div
        v-show="reader.bookUid && reader.showToolbarActions"
        ref="readerToolbarActions"
        class="reader-toolbar-actions"
        :class="{
            'reader-toolbar-actions--mobile-sheet': reader.isCompactLayout,
        }"
    >
        <div class="reader-controls-header">
            <div class="tabs reader-controls-tabs">
                <button type="button" class="tab" :class="{'is-active': reader.readerControlsTab === 'text'}" @click="reader.setReaderControlsTab('text')">{{ reader.uiText.controlsText }}</button>
                <button type="button" class="tab" :class="{'is-active': reader.readerControlsTab === 'page'}" @click="reader.setReaderControlsTab('page')">{{ reader.uiText.controlsPage }}</button>
                <button type="button" class="tab" :class="{'is-active': reader.readerControlsTab === 'status'}" @click="reader.setReaderControlsTab('status')">{{ reader.uiText.controlsStatus }}</button>
            </div>

            <div class="reader-controls-state">
                <q-btn
                    v-if="reader.readerSettingsReflowPending"
                    flat
                    dense
                    no-caps
                    icon="la la-sync-alt"
                    class="reader-rebuild-btn"
                    :disable="reader.layoutRefreshing || reader.isPagedBuildPending"
                    @click="reader.applyPendingReaderSettingsReflow"
                >
                    {{ reader.uiText.rebuildPages }}
                </q-btn>
                <div class="reader-progress-text">
                    {{ reader.displayProgressPercent }}%<span v-if="reader.showDisplayPagedPageCounter"> | {{ reader.displayCurrentPage }}/{{ reader.displayTotalPages }}</span>
                </div>
            </div>
        </div>

        <div class="reader-controls-body">
            <template v-if="reader.readerControlsTab === 'text'">
                <section class="reader-controls-group reader-controls-group--mode">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsView }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsTheme }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'dark'}" @click="reader.setTheme('dark')">{{ reader.uiText.themeDark }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'sepia'}" @click="reader.setTheme('sepia')">{{ reader.uiText.themeSepia }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'light'}" @click="reader.setTheme('light')">{{ reader.uiText.themeLight }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.preferences.theme === 'eink'}" @click="reader.setTheme('eink')">{{ reader.uiText.themeEink }}</q-btn>
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsFont }}</div>
                        <q-select
                            :model-value="reader.selectedFontFamily"
                            :options="reader.fontFamilyOptions"
                            class="reader-font-select"
                            behavior="menu"
                            :dark="reader.preferences.theme === 'dark'"
                            popup-content-class="reader-font-menu"
                            :popup-content-style="reader.readerDialogStyle"
                            borderless
                            dense
                            options-dense
                            emit-value
                            map-options
                            dropdown-icon="la la-angle-down"
                            @update:model-value="reader.setFontFamily"
                        />
                    </div>
                </section>

                <section class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsTypography }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsFontSize }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-minus" @click="reader.changeFontSize(-1)" />
                            <div class="reader-stepper-value">{{ reader.activePreferences.fontSize }}px</div>
                            <q-btn flat dense round icon="la la-plus" @click="reader.changeFontSize(1)" />
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsLineHeight }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-minus" @click="reader.changeLineHeight(-0.05)" />
                            <div class="reader-stepper-value">{{ reader.activePreferences.lineHeight.toFixed(2) }}</div>
                            <q-btn flat dense round icon="la la-plus" @click="reader.changeLineHeight(0.05)" />
                        </div>
                    </div>
                </section>

                <section class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsWidth }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsTextWidth }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-compress" @click="reader.changeContentWidth(-40)" />
                            <div class="reader-stepper-value">{{ reader.activePreferences.contentWidth }}px</div>
                            <q-btn flat dense round icon="la la-expand" @click="reader.changeContentWidth(40)" />
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsTextWidthMode }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.contentWidthMode !== 'viewport'}" @click="reader.setContentWidthMode('fixed')">{{ reader.uiText.widthFixed }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.contentWidthMode === 'viewport'}" @click="reader.setContentWidthMode('viewport')">{{ reader.uiText.widthViewport }}</q-btn>
                        </div>
                    </div>
                </section>

                <section v-if="reader.preferences.theme === 'eink'" class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsInk }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.einkContrast }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-minus" @click="reader.changeEinkContrast(-4)" />
                            <div class="reader-stepper-value">{{ reader.activePreferences.einkContrast }}%</div>
                            <q-btn flat dense round icon="la la-plus" @click="reader.changeEinkContrast(4)" />
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.einkPaper }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-minus" @click="reader.changeEinkPaperTone(-2)" />
                            <div class="reader-stepper-value">{{ reader.activePreferences.einkPaperTone }}%</div>
                            <q-btn flat dense round icon="la la-plus" @click="reader.changeEinkPaperTone(2)" />
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.einkInk }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-minus" @click="reader.changeEinkInkTone(2)" />
                            <div class="reader-stepper-value">{{ 100 - reader.activePreferences.einkInkTone }}%</div>
                            <q-btn flat dense round icon="la la-plus" @click="reader.changeEinkInkTone(-2)" />
                        </div>
                    </div>
                </section>

                <section class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsReset }}</div>
                    <div class="reader-reset-control">
                        <q-btn
                            flat
                            dense
                            no-caps
                            icon="la la-undo"
                            @click="reader.resetReaderAppearance"
                        >
                            {{ reader.uiText.resetReaderAppearance }}
                        </q-btn>
                        <div class="reader-control-hint">{{ reader.uiText.resetReaderAppearanceHint }}</div>
                    </div>
                </section>
            </template>

            <template v-else-if="reader.readerControlsTab === 'page'">
                <section class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsMode }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsReadMode }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.readMode === 'scroll'}" @click="reader.setReadMode('scroll')">{{ reader.uiText.readModeScroll }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.readMode === 'paged'}" @click="reader.setReadMode('paged')">{{ reader.uiText.readModePages }}</q-btn>
                        </div>
                    </div>

                    <template v-if="reader.activePreferences.readMode === 'paged'">
                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.controlsPageFlow }}</div>
                            <div class="reader-theme-switch">
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pagedDirection === 'vertical'}" @click="reader.setPagedDirection('vertical')">{{ reader.uiText.directionVertical }}</q-btn>
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pagedDirection === 'horizontal'}" @click="reader.setPagedDirection('horizontal')">{{ reader.uiText.directionHorizontal }}</q-btn>
                            </div>
                        </div>

                        <div v-if="!reader.isCompactLayout" class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.controlsSpread }}</div>
                            <div class="reader-theme-switch">
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pagedSpreadMode !== 'dual'}" @click="reader.setPagedSpreadMode('single')">{{ reader.uiText.spreadSingle }}</q-btn>
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pagedSpreadMode === 'dual'}" @click="reader.setPagedSpreadMode('dual')">{{ reader.uiText.spreadDual }}</q-btn>
                            </div>
                        </div>
                    </template>
                </section>

                <section v-if="reader.activePreferences.readMode === 'paged'" class="reader-controls-group reader-controls-group--spacing">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsSpacing }}</div>

                    <div v-if="reader.activePreferences.pagedSpreadMode === 'dual' && !reader.isCompactLayout" class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.pageGap }}</div>
                        <div class="reader-stepper">
                            <q-btn flat dense round icon="la la-compress-arrows-alt" @click="reader.changeDualPageGap(-8)" />
                            <div class="reader-stepper-value">{{ reader.dualPageGap }}px</div>
                            <q-btn flat dense round icon="la la-expand-arrows-alt" @click="reader.changeDualPageGap(8)" />
                        </div>
                    </div>

                    <div v-if="reader.isCompactLayout" class="reader-mobile-spacing-control">
                        <div class="reader-mobile-spacing-stepper">
                            <div class="reader-mobile-spacing-active">{{ reader.activeMobileSpacingControl.label }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changeMobileSpacingControl(-4)" />
                                <div class="reader-stepper-value">{{ reader.activeMobileSpacingControl.value }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changeMobileSpacingControl(4)" />
                            </div>
                        </div>

                        <div class="reader-mobile-spacing-targets">
                            <button
                                v-for="item in reader.mobileSpacingControls"
                                :key="item.key"
                                type="button"
                                class="reader-mobile-spacing-target"
                                :class="{'is-active': item.key === reader.mobileSpacingControl}"
                                @click="reader.setMobileSpacingControl(item.key)"
                            >
                                <span>{{ item.label }}</span>
                                <strong>{{ item.value }}px</strong>
                            </button>
                        </div>
                    </div>

                    <div v-else class="reader-spacing-grid">
                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pagePaddingTop }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePagePadding('top', -4)" />
                                <div class="reader-stepper-value">{{ reader.pagePaddingTop }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePagePadding('top', 4)" />
                            </div>
                        </div>

                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pagePaddingBottom }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePagePadding('bottom', -4)" />
                                <div class="reader-stepper-value">{{ reader.pagePaddingBottom }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePagePadding('bottom', 4)" />
                            </div>
                        </div>

                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pagePaddingLeft }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePagePadding('left', -4)" />
                                <div class="reader-stepper-value">{{ reader.pagePaddingLeft }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePagePadding('left', 4)" />
                            </div>
                        </div>

                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pagePaddingRight }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePagePadding('right', -4)" />
                                <div class="reader-stepper-value">{{ reader.pagePaddingRight }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePagePadding('right', 4)" />
                            </div>
                        </div>

                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pageOuterGapTop }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePageOuterGap('top', -4)" />
                                <div class="reader-stepper-value">{{ reader.pageOuterGapTop }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePageOuterGap('top', 4)" />
                            </div>
                        </div>

                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.pageOuterGapBottom }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changePageOuterGap('bottom', -4)" />
                                <div class="reader-stepper-value">{{ reader.pageOuterGapBottom }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changePageOuterGap('bottom', 4)" />
                            </div>
                        </div>
                    </div>
                </section>

                <section v-if="reader.activePreferences.readMode === 'paged'" class="reader-controls-group reader-controls-group--animation">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsAnimation }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsAnimationType }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimation === 'none'}" @click="reader.setPageAnimation('none')">{{ reader.uiText.animationNone }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimation === 'soft'}" @click="reader.setPageAnimation('soft')">{{ reader.uiText.animationSoft }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimation === 'slide'}" @click="reader.setPageAnimation('slide')">{{ reader.uiText.animationSlide }}</q-btn>
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsAnimationSpeed }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimationSpeed === 'fast'}" @click="reader.setPageAnimationSpeed('fast')">{{ reader.uiText.speedFast }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimationSpeed === 'normal'}" @click="reader.setPageAnimationSpeed('normal')">{{ reader.uiText.speedNormal }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.pageAnimationSpeed === 'slow'}" @click="reader.setPageAnimationSpeed('slow')">{{ reader.uiText.speedSlow }}</q-btn>
                        </div>
                    </div>
                </section>
            </template>

            <template v-else-if="reader.readerControlsTab === 'status'">
                <section class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsStatusField }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsStatusVisibility }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.showStatusBar}" @click="reader.setStatusBarVisible(true)">{{ reader.uiText.statusBarOn }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': !reader.activePreferences.showStatusBar}" @click="reader.setStatusBarVisible(false)">{{ reader.uiText.statusBarOff }}</q-btn>
                        </div>
                    </div>

                    <template v-if="reader.activePreferences.showStatusBar">
                        <div class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.statusSize }}</div>
                            <div class="reader-stepper">
                                <q-btn flat dense round icon="la la-minus" @click="reader.changeStatusBarSize(-1)" />
                                <div class="reader-stepper-value">{{ reader.statusBarSize }}px</div>
                                <q-btn flat dense round icon="la la-plus" @click="reader.changeStatusBarSize(1)" />
                            </div>
                        </div>

                        <div v-if="!reader.isCompactLayout" class="reader-control-field">
                            <div class="reader-control-label">{{ reader.uiText.controlsStatusPosition }}</div>
                            <div class="reader-theme-switch">
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarAlign !== 'edge'}" @click="reader.setStatusBarAlign('center')">{{ reader.uiText.statusAlignCenter }}</q-btn>
                                <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarAlign === 'edge'}" @click="reader.setStatusBarAlign('edge')">{{ reader.uiText.statusAlignEdge }}</q-btn>
                            </div>
                        </div>
                    </template>
                </section>

                <section v-if="reader.activePreferences.showStatusBar" class="reader-controls-group">
                    <div class="reader-controls-group-title">{{ reader.uiText.controlsStatusContent }}</div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsClock }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarClock}" @click="reader.setStatusBarOption('statusBarClock', true)">{{ reader.uiText.statusClockOn }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': !reader.activePreferences.statusBarClock}" @click="reader.setStatusBarOption('statusBarClock', false)">{{ reader.uiText.statusClockOff }}</q-btn>
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsProgressBar }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarProgressBar}" @click="reader.setStatusBarOption('statusBarProgressBar', true)">{{ reader.uiText.statusProgressOn }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': !reader.activePreferences.statusBarProgressBar}" @click="reader.setStatusBarOption('statusBarProgressBar', false)">{{ reader.uiText.statusProgressOff }}</q-btn>
                        </div>
                    </div>

                    <div v-if="reader.activePreferences.statusBarProgressBar" class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsProgressPosition }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarProgressPosition !== 'side'}" @click="reader.setStatusBarProgressPosition('bottom')">{{ reader.uiText.statusProgressBottom }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarProgressPosition === 'side'}" @click="reader.setStatusBarProgressPosition('side')">{{ reader.uiText.statusProgressSide }}</q-btn>
                        </div>
                    </div>

                    <div class="reader-control-field">
                        <div class="reader-control-label">{{ reader.uiText.controlsRemaining }}</div>
                        <div class="reader-theme-switch">
                            <q-btn flat dense no-caps :class="{'is-active': reader.activePreferences.statusBarRemaining}" @click="reader.setStatusBarOption('statusBarRemaining', true)">{{ reader.uiText.statusRemainingOn }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': !reader.activePreferences.statusBarRemaining}" @click="reader.setStatusBarOption('statusBarRemaining', false)">{{ reader.uiText.statusRemainingOff }}</q-btn>
                        </div>
                    </div>
                </section>
            </template>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

//Часть шаблона Reader.vue: состояние и обработчики остаются в Reader, сюда приходит его экземпляр
class ReaderSettingsPanel {
    _props = {
        reader: {type: Object, required: true},
    };
}

export default vueComponent(ReaderSettingsPanel);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.reader-icon-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-toolbar-actions {
    position: absolute;
    top: calc(100% + 8px);
    right: 16px;
    z-index: 45;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    box-sizing: border-box;
    width: min(760px, calc(100vw - 32px));
    max-height: min(72vh, 620px);
    margin: 0;
    padding: 12px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    contain: none;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface) 96%, var(--reader-bg) 4%);
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.24);
    backdrop-filter: blur(14px);
    scrollbar-width: thin;
}

.reader-controls-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.reader-controls-state {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
}

.reader-rebuild-btn {
    flex: 0 0 auto;
    min-height: 30px;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--reader-accent) 36%, var(--reader-border));
    border-radius: var(--reader-radius);
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
    font-size: 12px;
    font-weight: 800;
}

.reader-controls-body {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    width: 100%;
}

.reader-controls-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: color-mix(in srgb, var(--reader-surface) 90%, var(--reader-surface-2) 10%);
}

.reader-controls-group-title {
    font-size: 12px;
    font-weight: 800;
    color: var(--reader-text);
}

.reader-control-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.reader-control-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--reader-muted);
    padding-left: 2px;
}

.reader-spacing-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.reader-reset-control {
    display: grid;
    gap: 6px;
}

.reader-reset-control :deep(.q-btn) {
    min-height: 34px;
    padding: 3px 10px;
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    font-size: 12px;
    font-weight: 650;
    line-height: 1.2;
    letter-spacing: 0;
}

.reader-reset-control :deep(.q-icon) {
    font-size: 18px;
}

.reader-control-hint {
    color: var(--reader-muted);
    font-size: 11px;
    line-height: 1.35;
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

.reader-controls-tabs {
    flex: 1 1 auto;
    min-width: 0;
}

.reader-controls-tabs .tab,
.reader-dialog-tabs .tab {
    cursor: pointer;
}

.reader-stepper {
    flex-wrap: nowrap;
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

.reader-stepper :deep(.q-btn--round) {
    padding: 0;
}

.reader-theme-switch :deep(.q-btn.is-active) {
    background: var(--reader-accent);
    color: var(--reader-on-accent);
}

.reader-font-select {
    width: 100%;
    min-width: 0;
    max-width: none;
    background: var(--reader-surface-2);
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    color: var(--reader-text);
}

.reader-font-select :deep(.q-field__control) {
    min-height: 32px;
    height: 32px;
    border-radius: var(--reader-radius);
    color: var(--reader-text);
    padding: 0 8px 0 12px;
    background: transparent;
}

.reader-font-select :deep(.q-field__control::before),
.reader-font-select :deep(.q-field__control::after) {
    display: none;
}

.reader-font-select :deep(.q-field__native),
.reader-font-select :deep(.q-field__append) {
    min-height: 32px;
    color: var(--reader-text);
}

.reader-font-select :deep(.q-field__native) {
    font-size: 12px;
    font-weight: 700;
    line-height: 32px;
    padding: 0;
}

.reader-font-select :deep(.q-field__append) {
    padding-left: 6px;
}

:global(.reader-font-menu) {
    border: 1px solid var(--reader-border);
    border-radius: var(--reader-radius);
    background: var(--reader-surface-2);
    color: var(--reader-text);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
    overflow: hidden;
}

.reader-stepper-value,
.reader-progress-text {
    min-width: 40px;
    text-align: center;
    font-size: 12px;
    font-weight: 700;
    color: var(--reader-muted);
}

.reader-progress-text {
    flex: 0 0 auto;
    padding: 0 2px;
    white-space: nowrap;
}

.reader-home-tab-list .tab {
    cursor: pointer;
}

.reader-mobile-btn.is-active {
    color: var(--reader-accent);
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

@media (max-width: 900px) {

    .reader-toolbar-actions {
        left: 10px;
        right: 10px;
        width: auto;
        justify-content: flex-start;
    }

    .reader-controls-header {
        flex-direction: column;
        align-items: stretch;
    }

    .reader-controls-state {
        justify-content: space-between;
        width: 100%;
    }

    .reader-progress-text {
        text-align: left;
    }
}

@media (max-width: 640px) {

    .reader-toolbar-actions {
        position: fixed;
        left: 4px;
        right: 4px;
        top: auto;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);
        z-index: 70;
        align-items: stretch;
        flex-direction: column;
        justify-content: flex-start;
        gap: 8px;
        width: auto;
        max-height: min(44vh, 372px);
        max-height: min(44dvh, 372px);
        margin: 0;
        padding: 18px 10px 10px;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        contain: none;
        border: 1px solid var(--reader-border);
        border-radius: var(--reader-radius-lg);
        background: color-mix(in srgb, var(--reader-surface) 96%, var(--reader-bg) 4%);
        box-shadow: 0 -14px 44px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(14px);
    }

    .reader-toolbar-actions::before {
        content: "";
        position: absolute;
        top: 7px;
        left: 50%;
        width: 42px;
        height: 4px;
        border-radius: var(--reader-radius);
        background: color-mix(in srgb, var(--reader-muted) 44%, transparent);
        transform: translateX(-50%);
    }

    .reader-controls-body {
        grid-template-columns: 1fr;
        gap: 8px;
    }

    .reader-controls-group {
        padding: 9px;
        border-radius: var(--reader-radius);
    }

    .reader-spacing-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 5px;
    }

    .reader-spacing-grid .reader-control-label {
        min-height: 22px;
        line-height: 1.12;
        font-size: 10px;
    }

    .reader-spacing-grid .reader-stepper {
        min-height: 32px;
        border-radius: var(--reader-radius);
    }

    .reader-spacing-grid .reader-stepper :deep(.q-btn) {
        min-height: 30px;
        min-width: 28px;
        padding: 0;
    }

    .reader-spacing-grid .reader-stepper-value {
        min-width: 34px;
        font-size: 11px;
    }

    .reader-mobile-spacing-control {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
    }

    .reader-mobile-spacing-stepper {
        display: grid;
        grid-template-columns: minmax(86px, 1fr) minmax(0, 1.4fr);
        align-items: center;
        gap: 8px;
    }

    .reader-mobile-spacing-active {
        min-width: 0;
        color: var(--reader-text);
        font-size: 12px;
        font-weight: 800;
        line-height: 1.1;
    }

    .reader-mobile-spacing-targets {
        display: flex;
        gap: 5px;
        min-width: 0;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        scrollbar-width: none;
    }

    .reader-mobile-spacing-targets::-webkit-scrollbar {
        display: none;
    }

    .reader-mobile-spacing-target {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 5px 9px;
        border: 1px solid var(--reader-border);
        border-radius: var(--reader-radius);
        background: var(--reader-surface-2);
        color: var(--reader-muted);
        font: inherit;
        font-size: 11px;
        font-weight: 800;
        line-height: 1;
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

    .reader-controls-tabs {
        flex-wrap: nowrap;
        overflow-x: auto;
    }

    .reader-theme-switch :deep(.q-btn),
    .reader-stepper :deep(.q-btn) {
        min-height: 36px;
    }

    .reader-reset-control :deep(.q-btn) {
        min-height: 44px;
    }

    .reader-font-select :deep(.q-field__control) {
        min-height: 44px;
        height: 44px;
    }

    .reader-progress-text {
        width: 100%;
        min-width: 0;
        text-align: left;
        padding-left: 4px;
        white-space: normal;
    }
}
</style>
