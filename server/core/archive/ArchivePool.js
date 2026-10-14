//Потоки архивов: распаковка синхронная и не должна держать основной поток. Два потока - чтобы обложки
//не ждали долгую распаковку большого solid-архива. Простаивающие потоки закрываются и отдают память.
const {Worker} = require('worker_threads');
const childCode = require('./ArchiveChild');

const poolSize = 2;
const idleMs = 5*60*1000;
//большой solid-архив на медленном диске распаковывается долго
const callTimeoutMs = 30*60*1000;

class ArchiveWorker {
    constructor() {
        this.requestId = 0;
        this.listeners = new Map();
        this.worker = null;
        this.idleTimer = null;
    }

    get pending() {
        return this.listeners.size;
    }

    start() {
        const worker = new Worker(childCode, {eval: true});
        worker.on('message', (mes) => {
            const listener = this.listeners.get(mes.requestId);
            if (listener) {
                this.listeners.delete(mes.requestId);
                listener(mes);
            }
            this.scheduleIdle();
        });
        const failAll = (message) => {
            if (this.worker !== worker)
                return;
            this.worker = null;
            for (const listener of this.listeners.values())
                listener({error: message});
            this.listeners.clear();
        };
        worker.on('error', e => failAll(e.message));
        worker.on('exit', () => failAll('Archive worker stopped'));
        this.worker = worker;
    }

    //Поток держит процесс, только пока ждёт ответа: иначе простаивающий поток не даёт процессу завершиться
    scheduleIdle() {
        clearTimeout(this.idleTimer);
        if (this.listeners.size)
            return;
        if (this.worker)
            this.worker.unref();
        this.idleTimer = setTimeout(() => this.stop(), idleMs);
        this.idleTimer.unref();
    }

    stop() {
        clearTimeout(this.idleTimer);
        const worker = this.worker;
        if (worker && !this.listeners.size) {
            this.worker = null;
            worker.terminate().catch(() => {});
        }
    }

    call(action, args) {
        if (!this.worker)
            this.start();
        clearTimeout(this.idleTimer);
        const worker = this.worker;
        worker.ref();

        return new Promise((resolve, reject) => {
            const requestId = ++this.requestId;
            //зависший вызов не прервать: поток останавливается, его вызовы завершаются ошибкой
            const timer = setTimeout(() => {
                const listeners = [...this.listeners.values()];
                this.listeners.clear();
                this.worker = null;
                worker.terminate().catch(() => {});
                for (const listener of listeners)
                    listener({error: `Archive operation timed out: ${action}`});
            }, callTimeoutMs);
            timer.unref();
            this.listeners.set(requestId, (mes) => {
                clearTimeout(timer);
                if (mes.error)
                    reject(new Error(mes.error));
                else
                    resolve(mes.result);
            });
            worker.postMessage({requestId, action, args});
        });
    }
}

const workers = Array.from({length: poolSize}, () => new ArchiveWorker());

function call(action, ...args) {
    const worker = workers.reduce((best, item) => (item.pending < best.pending ? item : best));
    return worker.call(action, args);
}

module.exports = {call};
