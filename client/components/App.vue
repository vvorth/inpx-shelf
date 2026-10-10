<template>
    <div class="fit row">
        <Api ref="api" v-model="accessGranted" />
        <Notify ref="notify" />
        <StdDialog ref="stdDialog" />

        <AppShell v-if="accessGranted" class="col" :bare="isBareRoute">
            <router-view v-slot="{ Component }">
                <keep-alive>
                    <component :is="Component" />
                </keep-alive>
            </router-view>
        </AppShell>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from './vueComponent.js';

//import * as utils from '../share/utils';
import q from '../quasar';
import {setLang} from '../share/i18n';
import Notify from './share/Notify.vue';
import StdDialog from './share/StdDialog.vue';

import Api from './Api/Api.vue';
import AppShell from './Shell/AppShell.vue';

const componentOptions = {
    components: {
        Api,
        Notify,
        StdDialog,

        AppShell,
    },
    watch: {
        darkTheme(newValue) {
            this.applyTheme(newValue);
        },
        uiLang(newValue) {
            this.applyLang(newValue);
        },
        '$route.path'() {
            this.applyPwaManifest();
        },
    },

};
class App {
    _options = componentOptions;
    accessGranted = false;

    created() {
        this.commit = this.$store.commit;

        //root route
        let cachedRoute = '';
        let cachedPath = '';
        this.$root.getRootRoute = () => {
            if (this.$route.path != cachedPath) {
                cachedPath = this.$route.path;
                const m = cachedPath.match(/^(\/[^/]*).*$/i);
                cachedRoute = (m ? m[1] : this.$route.path);
            }
            return cachedRoute;
        }

        this.$root.isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent);
        this.$root.setAppTitle = this.setAppTitle;

        //global keyHooks
        this.keyHooks = [];
        this.keyHook = (event) => {
            for (const hook of this.keyHooks)
                hook(event);
        }

        this.$root.addKeyHook = (hook) => {
            if (this.keyHooks.indexOf(hook) < 0)
                this.keyHooks.push(hook);
        }

        this.$root.removeKeyHook = (hook) => {
            const i = this.keyHooks.indexOf(hook);
            if (i >= 0)
                this.keyHooks.splice(i, 1);
        }

        document.addEventListener('keyup', (event) => {
            this.keyHook(event);
        });
        document.addEventListener('keypress', (event) => {
            this.keyHook(event);
        });
        document.addEventListener('keydown', (event) => {
            this.keyHook(event);
        });        
    }

    mounted() {
        this.$root.api = this.$refs.api;
        this.$root.notify = this.$refs.notify;
        this.$root.stdDialog = this.$refs.stdDialog;

        this.applyTheme(this.darkTheme);
        this.applyLang(this.uiLang);
        this.applyPwaManifest();
        this.setAppTitle();
    }

    get config() {
        return this.$store.state.config;
    }

    get rootRoute() {
        return this.$root.getRootRoute();
    }

    get isBareRoute() {
        return !!(this.$route.meta && this.$route.meta.bare);
    }

    get isReaderRoute() {
        return this.$route.path === '/reader';
    }

    get settings() {
        return this.$store.state.settings;
    }

    get darkTheme() {
        return !!this.settings.darkTheme;
    }

    get uiLang() {
        return this.settings.uiLang || '';
    }

    applyTheme(value) {
        this.$q.dark.set(!!value);
    }

    applyLang(value) {
        const lang = setLang(value);
        this.$q.lang.set(q.langs[lang] || q.langs.ru);
    }

    applyPwaManifest() {
        const manifest = document.querySelector('link[rel="manifest"]');
        if (!manifest)
            return;

        manifest.setAttribute('href', this.isReaderRoute ? 'reader.webmanifest?v=reader-icon-4' : 'manifest.webmanifest?v=catalog-icon-4');
        const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        if (appleTitle)
            appleTitle.setAttribute('content', this.isReaderRoute ? 'INPX Reader' : 'INPX Web');

        const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
        if (appleIcon)
            appleIcon.setAttribute('href', this.isReaderRoute ? 'reader-icon-192.png?v=reader-icon-4' : 'pwa-icon-192.png?v=catalog-icon-4');

        let favicon = document.querySelector('link[rel="icon"]');
        if (!favicon) {
            favicon = document.createElement('link');
            favicon.setAttribute('rel', 'icon');
            document.head.appendChild(favicon);
        }
        favicon.setAttribute('type', 'image/x-icon');
        favicon.setAttribute('href', this.isReaderRoute ? 'reader-favicon.ico?v=reader-icon-4' : 'favicon.ico?v=catalog-icon-4');
    }

    setAppTitle(title) {
        if (title) {
            document.title = title;
        }
    }
}

export default vueComponent(App);
//-----------------------------------------------------------------------------
</script>

<style scoped>
</style>

<style>
body, html, #app {    
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font: normal 14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    letter-spacing: 0;
}

body {
    --q-primary: #1f5c50;
    --q-secondary: #1f5c50;
    --app-bg: #f4f6f5;
    --app-surface: #ffffff;
    --app-surface-2: #eef3f1;
    --app-surface-3: #e9eeec;
    --app-text: #18201d;
    --app-muted: #5c6863;
    --app-border: #d6dcd9;
    --app-link: #1f5c50;
    --app-primary: #1f5c50;
    --app-on-primary: #ffffff;
    --app-accent-soft: #dcebe6;
    --app-secondary: #1f5c50;
    --app-accent: #9a5b00;
    --app-danger: #a33a2a;
    --app-shadow: 0 16px 42px rgba(24, 32, 29, 0.12);
    --app-radius: 6px;
    --app-font-serif: Literata, Georgia, "Times New Roman", serif;
    --shell-rail-width: 232px;
    background: var(--app-bg);
    color: var(--app-text);
}

.root {
    background: var(--app-bg);
    color: var(--app-text);
}

.q-field--outlined .q-field__control {
    border-radius: 8px;
    background: var(--app-surface);
    min-height: 42px;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
}

.q-field--outlined .q-field__control::before {
    border-color: var(--app-border);
}

.q-field--outlined .q-field__control:hover::before {
    border-color: var(--app-muted);
}

.q-field--focused .q-field__control {
    box-shadow: 0 0 0 3px rgba(31, 92, 80, 0.16);
}

.q-field--focused .q-field__control::after {
    border-color: var(--app-primary);
}

.q-field__label,
.q-field__native {
    color: var(--app-text);
}

.q-btn {
    border-radius: 8px;
    font-weight: 650;
    letter-spacing: 0;
}

.q-btn.bg-primary {
    background: var(--app-primary) !important;
}

.q-btn.bg-secondary {
    background: var(--app-secondary) !important;
}

.q-btn-toggle {
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(31, 92, 80, 0.18);
}

.q-btn-toggle .q-btn {
    min-height: 34px;
}

.q-menu,
.q-dialog__inner > div {
    border-radius: 8px;
    box-shadow: var(--app-shadow);
}

.bg-white {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
}

.bg-cyan-2 {
    background: var(--app-surface-2) !important;
    color: var(--app-text) !important;
}

.bg-yellow-1 {
    background: var(--app-accent-soft) !important;
    color: var(--app-primary) !important;
}

.bg-green-4 {
    background: var(--app-primary) !important;
    color: var(--app-on-primary) !important;
}

.text-green,
.text-green-10 {
    color: var(--app-primary) !important;
}

.text-blue-10,
.text-primary {
    color: var(--app-link) !important;
}

.clickable,
a {
    color: var(--app-link);
}

.clickable,
.clickable2,
.button,
.q-btn {
    transition: background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease, filter 0.18s ease;
}

.odd-item {
    background-color: var(--app-surface-3) !important;
}

.odd-item,
.book-view {
    border-radius: 8px;
}

.separator {
    border-bottom-color: var(--app-border) !important;
}

.book-row {
    border-left: 2px solid rgba(31, 92, 80, 0.16);
    padding-left: 10px;
}

body.body--dark .book-row {
    border-left-color: rgba(111, 191, 169, 0.24);
}

.q-tooltip {
    border-radius: 8px;
}

body.body--dark {
    --q-primary: #6fbfa9;
    --q-secondary: #6fbfa9;
    --q-accent: #e0a957;
    --app-bg: #121715;
    --app-surface: #1a201e;
    --app-surface-2: #18231f;
    --app-surface-3: #232b28;
    --app-text: #e6ece9;
    --app-muted: #98a59f;
    --app-border: #313b37;
    --app-link: #6fbfa9;
    --app-primary: #6fbfa9;
    --app-on-primary: #0d1d18;
    --app-accent-soft: #1f3a33;
    --app-secondary: #6fbfa9;
    --app-accent: #e0a957;
    --app-danger: #e8806f;
    --app-shadow: 0 14px 42px rgba(0, 0, 0, 0.55);
    background: var(--app-bg);
    color: var(--app-text);
}

body.body--dark .root {
    background: var(--app-bg);
    color: var(--app-text);
}

body.body--dark .bg-white:not(.std-dialog-card--reader),
body.body--dark .bg-yellow-1 {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
}

body.body--dark .bg-cyan-2 {
    background: var(--app-surface-2) !important;
    color: var(--app-text) !important;
}

body.body--dark .bg-green-4 {
    background: var(--app-primary) !important;
    color: var(--app-on-primary) !important;
}

body.body--dark .bg-primary {
    background: var(--app-primary) !important;
}

body.body--dark .bg-secondary {
    background: var(--app-secondary) !important;
    color: var(--app-on-primary) !important;
}

body.body--dark .text-black,
body.body--dark .text-grey-8,
body.body--dark .text-grey-6,
body.body--dark .text-grey-5 {
    color: #d8e1ea !important;
}

body.body--dark .text-green,
body.body--dark .text-green-10,
body.body--dark .text-positive {
    color: var(--app-link) !important;
}

body.body--dark .text-blue-10,
body.body--dark .text-primary {
    color: var(--app-link) !important;
}

body.body--dark .text-red,
body.body--dark .text-negative {
    color: #ff8a8a !important;
}

body.body--dark .text-warning {
    color: var(--app-accent) !important;
}

body.body--dark .clickable,
body.body--dark a {
    color: var(--app-link);
}

body.body--dark .tool-panel {
    background:
        linear-gradient(180deg, rgba(111, 191, 169, 0.06) 0%, rgba(111, 191, 169, 0.02) 100%),
        var(--app-surface) !important;
    border-bottom-color: var(--app-border);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
}

body.body--dark .separator {
    border-bottom-color: var(--app-border);
}

body.body--dark .odd-item {
    background-color: var(--app-surface-3) !important;
}

body.body--dark [style*="color: #555"],
body.body--dark [style*="color: blue"] {
    color: var(--app-link) !important;
}

body.body--dark .button {
    border: 1px solid rgba(148, 163, 184, 0.22);
}

body.body--dark .button:hover {
    opacity: 1;
    filter: brightness(1.12);
}

body.body--dark .q-btn-toggle {
    box-shadow: 0 0 0 1px rgba(111, 191, 169, 0.24);
}

body.body--dark .q-btn-toggle .q-btn {
    background: #1c2224;
    color: var(--app-text);
}

body.body--dark .q-btn-toggle .q-btn.bg-primary {
    background: var(--app-primary) !important;
    color: var(--app-on-primary) !important;
}

body.body--dark .q-dialog__inner > div:not(.std-dialog-card--reader) {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}

body.body--dark .q-menu {
    background: var(--app-surface);
    color: var(--app-text);
}

body.body--dark .q-item.q-router-link--active,
body.body--dark .q-item--active {
    color: var(--app-link);
}

body.body--dark .q-field__control,
body.body--dark .q-field__native,
body.body--dark .q-field__label {
    color: var(--app-text);
}

body.body--dark .q-field--outlined .q-field__control {
    background: #171a1c;
}

body.body--dark .q-field--outlined .q-field__control::before {
    border-color: var(--app-border);
}

body.body--dark .q-field--outlined .q-field__control:hover::before {
    border-color: var(--app-accent);
}

body.body--dark .q-field--focused .q-field__control::after {
    border-color: var(--app-primary);
}

body.body--dark .std-dialog-card--reader .q-field__control,
body.body--dark .std-dialog-card--reader .q-field__native,
body.body--dark .std-dialog-card--reader .q-field__label,
body.body--dark .std-dialog-card--reader .q-field__append,
body.body--dark .std-dialog-card--reader .q-icon {
    color: var(--reader-text) !important;
}

body.body--dark .std-dialog-card--reader .q-field--outlined .q-field__control {
    background: var(--reader-surface-2) !important;
}

body.body--dark .std-dialog-card--reader .q-field--outlined .q-field__control::before {
    border-color: var(--reader-border) !important;
}

body.body--dark .std-dialog-card--reader .q-field--focused .q-field__control::after {
    border-color: var(--reader-accent) !important;
}

body.body--dark pre {
    color: var(--app-text);
}

/* --- Страницы приложения: заголовок, карточки, формы, таблицы --- */
.page {
    height: 100%;
    overflow-y: auto;
    background: var(--app-bg);
    color: var(--app-text);
}

.page-body {
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 1180px;
    margin: 0 auto;
    padding: 28px 28px 40px;
}

.page-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
}

.page-eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    color: var(--app-accent);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.page-title {
    margin: 0;
    font-family: var(--app-font-serif);
    font-size: 26px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0;
}

.page-actions,
.card-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.page-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 24px;
    border: 1px dashed var(--app-border);
    border-radius: var(--app-radius);
    color: var(--app-muted);
}

.page-empty--inline {
    padding: 16px;
}

.section-layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
}

.section-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 0;
}

.section-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--app-radius);
    background: none;
    color: var(--app-text) !important;
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
}

.section-nav-item:hover {
    background: var(--app-surface-3);
}

.section-nav-item.is-active {
    background: var(--app-accent-soft);
    color: var(--app-primary) !important;
    font-weight: 600;
}

.section-nav-sep {
    height: 1px;
    margin: 8px 0;
    background: var(--app-border);
}

.section-content,
.card-stack {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
}

.card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 20px;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}

.card-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: 0;
}

.card-hint {
    color: var(--app-muted);
    font-size: 13px;
    line-height: 1.45;
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    max-width: 760px;
}

.toggle-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 2px 16px;
}

.copy-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.copy-value {
    flex: 1 1 260px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: var(--app-radius);
    background: var(--app-surface-3);
    overflow-x: auto;
    white-space: nowrap;
    font-size: 13px;
}

.notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border-radius: var(--app-radius);
    background: var(--app-accent-soft);
}

.table-wrap {
    overflow-x: auto;
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius);
    background: var(--app-surface);
}

.data-table {
    width: 100%;
    border-collapse: collapse;
}

.data-table th {
    padding: 9px 12px;
    border-bottom: 1px solid var(--app-border);
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-align: left;
    text-transform: uppercase;
    white-space: nowrap;
}

.data-table td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--app-border);
    vertical-align: middle;
}

.data-table tr:last-child td {
    border-bottom: 0;
}

.progress {
    height: 6px;
    border-radius: 3px;
    background: var(--app-surface-3);
    overflow: hidden;
}

.progress i {
    display: block;
    height: 100%;
    background: var(--app-primary);
}

.pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 99px;
    background: var(--app-surface-3);
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
}

.pill--accent {
    background: var(--app-accent-soft);
    color: var(--app-primary);
}

.num {
    font-variant-numeric: tabular-nums;
}

@media (max-width: 899px) {
    .page-body {
        padding: 18px 16px 28px;
        gap: 18px;
    }

    .page-title {
        font-size: 22px;
    }

    .section-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 14px;
    }

    .section-nav {
        position: static;
        flex-direction: row;
        overflow-x: auto;
        gap: 4px;
    }

    .section-nav-item {
        flex: none;
        white-space: nowrap;
    }

    .section-nav-sep {
        width: 1px;
        height: auto;
        margin: 0 4px;
    }

    .hide-narrow {
        display: none;
    }
}

.dborder {
    border: 2px solid yellow;
}

.icon-rotate {
    vertical-align: middle;
    animation: rotating 2s linear infinite;
}

.q-dialog__inner--minimized {
    padding: 10px !important;
}

.q-dialog__inner--minimized > div {
    max-height: 100% !important;
    max-width: 800px !important;
}

@keyframes rotating { 
    from { 
        transform: rotate(0deg); 
    } to { 
        transform: rotate(360deg); 
    }
}

</style>
