//Окружение читалки, пока её маршрут активен: слушатели окна, часы строки состояния, запрет сна экрана.
//Маршруты keep-alive: при уходе со страницы всё это отключается (detach), иначе экран никогда не гаснет.
export default class ReaderEnvironment {
    //handlers: {beforeunload, fullscreenchange, resize, keydown, visibilitychange, pagehide, viewportResize}
    constructor({handlers = {}, onClockTick = () => {}} = {}) {
        this.handlers = handlers;
        this.onClockTick = onClockTick;
        this.attached = false;
        this.clockTimer = null;
        this.wakeLock = null;
        this.wakeLockRequested = false;
    }

    listeners() {
        const h = this.handlers;
        return [
            [window, 'beforeunload', h.beforeunload],
            [document, 'fullscreenchange', h.fullscreenchange],
            [window, 'resize', h.resize],
            [window, 'keydown', h.keydown],
            [document, 'visibilitychange', h.visibilitychange],
            [window, 'pagehide', h.pagehide],
            [window.visualViewport, 'resize', h.viewportResize],
        ].filter(([target, , handler]) => target && handler);
    }

    attach() {
        if (this.attached)
            return;
        this.attached = true;
        for (const [target, event, handler] of this.listeners())
            target.addEventListener(event, handler);
        this.startClock();
        this.requestWakeLock();// no await
    }

    detach() {
        this.attached = false;
        for (const [target, event, handler] of this.listeners())
            target.removeEventListener(event, handler);
        this.stopClock();
        this.releaseWakeLock();// no await
    }

    startClock() {
        this.stopClock();
        this.onClockTick();
        this.clockTimer = setInterval(() => this.onClockTick(), 30000);
    }

    stopClock() {
        if (!this.clockTimer)
            return;

        clearInterval(this.clockTimer);
        this.clockTimer = null;
    }

    async requestWakeLock() {
        this.wakeLockRequested = true;
        const supported = !!(navigator && navigator.wakeLock && navigator.wakeLock.request);
        if (!supported || document.visibilityState !== 'visible')
            return false;

        try {
            if (this.wakeLock)
                return true;

            const lock = await navigator.wakeLock.request('screen');
            // Читалку успели закрыть, пока ждали разрешения
            if (!this.wakeLockRequested) {
                lock.release().catch(() => {});
                return false;
            }
            this.wakeLock = lock;
            lock.addEventListener('release', () => {
                if (this.wakeLock === lock)
                    this.wakeLock = null;
            });
            return true;
        } catch (e) {
            this.wakeLock = null;
            return false;
        }
    }

    async releaseWakeLock() {
        this.wakeLockRequested = false;
        const lock = this.wakeLock;
        this.wakeLock = null;
        if (lock && typeof lock.release === 'function') {
            try {
                await lock.release();
            } catch (e) {
                //
            }
        }
    }
}
