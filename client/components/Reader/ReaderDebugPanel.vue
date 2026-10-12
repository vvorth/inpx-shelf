<template>
    <div class="reader-debug-panel">
        <div class="reader-debug-title">Reader Debug</div>
        <div>mode: {{ compact ? 'mobile' : 'desktop' }} / {{ paged ? 'paged' : 'scroll' }}</div>
        <div>page: {{ currentPage }}/{{ totalPages }}</div>
        <div>measure available: {{ debug.measureAvailableHeight }}px</div>
        <div>measure content: {{ debug.measureContentHeight }}px</div>
        <div>measure overflow: {{ debug.measureOverflowPx }}px</div>
        <div>sheet height: {{ debug.liveSheetHeight }}px</div>
        <div>sheet bottom safe: {{ debug.liveSafeBottom }}px</div>
        <div>text last bottom: {{ debug.liveTextBottom }}px</div>
        <div>live overflow: {{ debug.liveOverflowPx }}px</div>
        <div>clip base: {{ debug.baseBottomClipCompensation }}px</div>
        <div>clip dynamic: {{ dynamicClip }}px</div>
        <div>clip total: {{ debug.totalBottomClipCompensation }}px</div>
        <div>safety inset: {{ debug.pagedContentSafetyInset }}px</div>
        <div>font/line: {{ fontSize }} / {{ lineHeight }}</div>
        <template v-if="debug.paginationStats">
            <div>pagination: {{ debug.paginationStats.status }} / {{ debug.paginationStats.durationMs }}ms</div>
            <div>units: {{ debug.paginationStats.fastUnits }} fast / {{ debug.paginationStats.domUnits }} dom / {{ debug.paginationStats.totalUnits }} total</div>
            <div>splits: {{ debug.paginationStats.fastSplits }} fast / {{ debug.paginationStats.domSplits }} dom</div>
            <div v-if="debug.paginationStats.fallbackRoots && debug.paginationStats.fallbackRoots.length">fallback: {{ debug.paginationStats.fallbackRoots.join(', ') }}</div>
        </template>
        <div class="reader-debug-actions">
            <button class="reader-debug-btn" @click.stop="$emit('adjust', -1)">- line</button>
            <button class="reader-debug-btn" @click.stop="$emit('adjust', 1)">+ line</button>
            <button class="reader-debug-btn" @click.stop="$emit('reset')">reset</button>
        </div>
    </div>
</template>

<script>
//Отладочная панель разбивки на страницы (?debugReader=1): только показ метрик и подстройка нижнего отступа
import vueComponent from '../vueComponent.js';

const componentOptions = {
    emits: ['adjust', 'reset'],
};

class ReaderDebugPanel {
    _options = componentOptions;
    _props = {
        debug: {type: Object, required: true},
        compact: Boolean,
        paged: Boolean,
        currentPage: {type: [Number, String], default: 1},
        totalPages: {type: [Number, String], default: 1},
        dynamicClip: {type: [Number, String], default: 0},
        fontSize: {type: [Number, String], default: 0},
        lineHeight: {type: [Number, String], default: 0},
    };
}

export default vueComponent(ReaderDebugPanel);
</script>

<style scoped>
.reader-debug-panel {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 26;
    width: min(92vw, 320px);
    padding: 10px 12px;
    border: 1px solid rgba(255, 120, 120, 0.45);
    border-radius: 14px;
    background: rgba(25, 12, 12, 0.88);
    color: #ffe9d8;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.24);
    font: 12px/1.35 Consolas, "Courier New", monospace;
    pointer-events: none;
}

.reader-debug-title {
    margin-bottom: 6px;
    color: #ffb38a;
    font-weight: 700;
}

.reader-debug-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    pointer-events: auto;
}

.reader-debug-btn {
    padding: 4px 8px;
    border: 1px solid rgba(255, 179, 138, 0.35);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: #ffe9d8;
    font: inherit;
    cursor: pointer;
}

@media (max-width: 640px) {
    .reader-debug-panel {
        top: calc(env(safe-area-inset-top, 0px) + 82px);
        right: 8px;
        bottom: auto;
        max-height: min(48dvh, 360px);
        overflow-y: auto;
    }
}
</style>
