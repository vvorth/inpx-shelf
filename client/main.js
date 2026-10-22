/* global __INPX_WEB_BUILD_ID__ */
import { createApp } from 'vue';

import router from './router';
import store from './store';
import q from './quasar';
import i18n, {setLang, setIsoDates, t} from './share/i18n';

import App from './components/App.vue';
import {bookRoute, authorRoute, seriesRoute} from './share/bookActions';
import {appUpdate} from './share/appUpdate';

//словарь языка загружается параллельно с проверкой версии сборки, приложение монтируется после него
const langReady = setLang(store.state.settings.uiLang);
setIsoDates(store.state.settings.isoDates);

const currentBuildId = (typeof __INPX_WEB_BUILD_ID__ !== 'undefined'
    ? String(__INPX_WEB_BUILD_ID__ || '').trim()
    : '');
const appBuildCheckTimeoutMs = 3000;
const appReloadMaxAttempts = 3;
const appReloadRetryWindowMs = 5*60*1000;
let appMounted = false;
let versionMonitorStarted = false;
let serviceWorkerSetupStarted = false;

function appBasePath() {
    const base = document.querySelector('base');
    const basePath = base
        ? new URL(base.getAttribute('href') || '/', window.location.href).pathname
        : new URL('.', window.location.href).pathname;
    return basePath.replace(/\/?$/, '/');
}

function appReloadStorageKey() {
    return `inpx-web-build-reload:${appBasePath()}`;
}

async function clearKnownAppCaches() {
    if (!('caches' in window))
        return;

    const keys = await window.caches.keys();
    await Promise.allSettled(keys
        .filter(key => key.startsWith('inpx-web-'))
        .map(key => window.caches.delete(key)));
}

async function unregisterScopedServiceWorkers() {
    if (!('serviceWorker' in navigator))
        return;

    const registrations = await navigator.serviceWorker.getRegistrations();
    const currentScope = new URL(appBasePath(), window.location.origin).href;
    await Promise.allSettled(registrations
        .filter(registration => registration.scope === currentScope)
        .map(registration => registration.unregister()));
}

async function clearBrowserAppCache() {
    // CacheStorage and service-worker cleanup must stay independent: a failure
    // in one browser API must not prevent the other recovery path from running.
    return await Promise.allSettled([
        clearKnownAppCaches(),
        unregisterScopedServiceWorkers(),
    ]);
}

function cacheResetTarget() {
    const url = new URL(window.location.href);
    let shouldClear = url.searchParams.has('clearAppCache');
    url.searchParams.delete('clearAppCache');

    const hashQueryIndex = url.hash.indexOf('?');
    if (hashQueryIndex >= 0) {
        const hashPath = url.hash.substring(0, hashQueryIndex);
        const hashParams = new URLSearchParams(url.hash.substring(hashQueryIndex + 1));
        if (hashParams.has('clearAppCache')) {
            shouldClear = true;
            hashParams.delete('clearAppCache');
            const nextHashQuery = hashParams.toString();
            url.hash = `${hashPath}${nextHashQuery ? `?${nextHashQuery}` : ''}`;
        }
    }

    if (!shouldClear)
        return null;

    for (const key of ['appBuild', 'appReloadAttempt', 'appReloadAt'])
        url.searchParams.delete(key);
    url.searchParams.set('appCacheReset', Date.now().toString());
    return url;
}

async function handleRequestedCacheReset() {
    const target = cacheResetTarget();
    if (!target)
        return false;

    await clearBrowserAppCache();
    window.location.replace(target.toString());
    return true;
}

function removeReloadMarkers() {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['appBuild', 'appCacheReset', 'appReloadAttempt', 'appReloadAt']) {
        if (!url.searchParams.has(key))
            continue;
        url.searchParams.delete(key);
        changed = true;
    }
    if (changed)
        window.history.replaceState({}, '', url.toString());
}

function readReloadRecord(deployedBuildId) {
    const url = new URL(window.location.href);
    const markerBuildId = String(url.searchParams.get('appBuild') || '');
    const markerTime = Number(url.searchParams.get('appReloadAt'));
    const markerAge = Date.now() - markerTime;
    const markerFresh = (
        markerBuildId === deployedBuildId
        && Number.isFinite(markerTime)
        && markerAge >= 0
        && markerAge < appReloadRetryWindowMs
    );
    const markerAttempts = markerFresh
        ? Math.max(0, parseInt(url.searchParams.get('appReloadAttempt'), 10) || 0)
        : 0;
    let stored;

    try {
        stored = JSON.parse(window.sessionStorage.getItem(appReloadStorageKey()) || 'null');
    } catch (e) {
        stored = null;
    }

    const storedAge = stored ? Date.now() - Number(stored.time) : NaN;
    const storedFresh = !!(
        stored
        && stored.buildId === deployedBuildId
        && Number.isFinite(Number(stored.time))
        && storedAge >= 0
        && storedAge < appReloadRetryWindowMs
    );
    const storedAttempts = storedFresh ? Math.max(0, Number(stored.attempts) || 0) : 0;
    return {
        attempts: Math.max(markerAttempts, storedAttempts),
        time: Date.now(),
    };
}

function writeReloadRecord(deployedBuildId, record) {
    try {
        window.sessionStorage.setItem(appReloadStorageKey(), JSON.stringify({
            buildId: deployedBuildId,
            attempts: record.attempts,
            time: record.time,
        }));
    } catch (e) {
        // The URL markers still bound retries when sessionStorage is disabled.
    }
}

function clearReloadRecord() {
    try {
        window.sessionStorage.removeItem(appReloadStorageKey());
    } catch (e) {
        // Ignore unavailable sessionStorage.
    }
}

async function fetchDeployedBuildId() {
    try {
        const response = await fetch(`${appBasePath()}build-id.txt?check=${Date.now()}`, {
            cache: 'no-store',
            // старые браузеры (в т.ч. e-reader) без AbortSignal.timeout проверяют без таймаута
            signal: AbortSignal.timeout?.(appBuildCheckTimeoutMs),
        });
        if (!response.ok)
            return '';

        const deployedBuildId = (await response.text()).trim();
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const validBuildId = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}-\d{10,20}$/.test(deployedBuildId);
        return (contentType.startsWith('text/plain') && validBuildId) ? deployedBuildId : '';
    } catch (e) {
        return '';
    }
}

function appResetUrl() {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return `${appBasePath()}app-reset?return=${encodeURIComponent(returnTo)}`;
}

function showUpdateRecovery(deployedBuildId) {
    const host = document.getElementById('app');
    if (!host)
        return;

    const panel = document.createElement('main');
    panel.style.cssText = 'box-sizing:border-box;max-width:560px;margin:12vh auto;padding:24px;font:16px/1.5 system-ui,sans-serif;color:#2d2925';

    const title = document.createElement('h1');
    title.style.cssText = 'font-size:24px;margin:0 0 12px';
    title.textContent = t('app.updateFailedTitle');

    const message = document.createElement('p');
    message.textContent = t('app.updateFailedText');

    const versions = document.createElement('p');
    versions.style.cssText = 'font-size:13px;opacity:.7;word-break:break-all';
    versions.textContent = t('app.updateFailedBuilds', {current: currentBuildId || t('app.unknownBuild'), deployed: deployedBuildId});

    const resetLink = document.createElement('a');
    resetLink.href = appResetUrl();
    resetLink.style.cssText = 'display:inline-block;margin-top:8px;padding:12px 16px;border-radius:10px;background:#8f5725;color:#fff;text-decoration:none;font-weight:600';
    resetLink.textContent = t('app.clearCacheRetry');

    panel.append(title, message, versions, resetLink);
    host.replaceChildren(panel);
}

async function ensureCurrentAppBuild() {
    const deployedBuildId = await fetchDeployedBuildId();
    if (!deployedBuildId)
        return 'ready';

    if (!currentBuildId || deployedBuildId === currentBuildId) {
        clearReloadRecord();
        removeReloadMarkers();
        return 'ready';
    }

    const record = readReloadRecord(deployedBuildId);
    if (record.attempts >= appReloadMaxAttempts) {
        await langReady;
        showUpdateRecovery(deployedBuildId);
        return 'blocked';
    }

    record.attempts += 1;
    record.time = Date.now();
    writeReloadRecord(deployedBuildId, record);
    await clearBrowserAppCache();

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('appCacheReset');
    currentUrl.searchParams.set('appBuild', deployedBuildId);
    currentUrl.searchParams.set('appReloadAttempt', record.attempts.toString());
    currentUrl.searchParams.set('appReloadAt', record.time.toString());
    window.location.replace(currentUrl.toString());
    return 'reloading';
}

function mountApplication() {
    if (appMounted)
        return;

    appMounted = true;
    const app = createApp(App);
    app.use(i18n);
    app.use(router);
    app.use(store);
    app.use(q.quasar, q.options);
    //ссылки на книгу, автора и серию - в шаблонах любых страниц
    Object.assign(app.config.globalProperties, {bookLink: bookRoute, authorLink: authorRoute, seriesLink: seriesRoute});
    q.init();
    app.mount('#app');
}

async function newBuildDeployed() {
    const deployedBuildId = await fetchDeployedBuildId();
    return !!(deployedBuildId && currentBuildId && deployedBuildId !== currentBuildId);
}

function announceAppUpdate() {
    appUpdate.reload = () => ensureCurrentAppBuild();
    appUpdate.available = true;
}

//Открытое приложение само не перезагружается: в читалке, диалоге или форме это потеряло бы несохранённый ввод.
//Новая версия предлагается баннером; перезагрузка без спроса - только до запуска приложения (bootstrapApplication)
function startAppVersionMonitor() {
    if (versionMonitorStarted)
        return;
    versionMonitorStarted = true;
    let checking = false;

    const checkVersion = async() => {
        if (checking)
            return;
        checking = true;
        try {
            if (await newBuildDeployed())
                announceAppUpdate();
        } finally {
            checking = false;
        }
    };

    //кусок прежней сборки (страница, открытая впервые) удалён с сервера: открываем её уже в новой версии
    router.onError(async(error, to) => {
        const chunkFailed = error && (error.name === 'ChunkLoadError' || error.code === 'CSS_CHUNK_LOAD_FAILED');
        if (!chunkFailed || !await newBuildDeployed())
            return;
        window.history.replaceState(window.history.state, '', router.resolve(to).href);
        await ensureCurrentAppBuild();
    });

    window.addEventListener('focus', checkVersion);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden)
            checkVersion();
    });
    window.setInterval(checkVersion, 60*1000);
}

function setupServiceWorker() {
    if (serviceWorkerSetupStarted || !('serviceWorker' in navigator))
        return;
    serviceWorkerSetupStarted = true;

    const register = () => {
        const scopePath = appBasePath();
        navigator.serviceWorker.register(`${scopePath}sw.js`, {updateViaCache: 'none'})
            .then(registration => registration.update())
            .catch(() => {});
    };
    if (document.readyState === 'complete')
        register();
    else
        window.addEventListener('load', register, {once: true});

    //первая установка воркера страницу не меняет; смена воркера означает новую сборку - предлагаем перезагрузку
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController)
            announceAppUpdate();
    });
}

async function bootstrapApplication() {
    if (await handleRequestedCacheReset())
        return;

    const buildState = await ensureCurrentAppBuild();
    if (buildState !== 'ready')
        return;

    await langReady;
    mountApplication();
    startAppVersionMonitor();
    setupServiceWorker();
}

bootstrapApplication().catch(async() => {
    // A version endpoint failure must not make the application unavailable.
    await langReady;
    mountApplication();
    startAppVersionMonitor();
    setupServiceWorker();
});
