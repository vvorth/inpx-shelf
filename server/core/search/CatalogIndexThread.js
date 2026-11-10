//Обёртка над потоком индекса каталога: вызовы методов CatalogIndex как промисы.
const {Worker} = require('worker_threads');
const childCode = require('./CatalogIndexChild');

class CatalogIndexThread {
    constructor() {
        this.requestId = 0;
        this.listeners = new Map();
        this.worker = this.start();

        this.onProgress = null;
        this.worker.on('message', (mes) => {
            if (mes.progress !== undefined) {
                if (this.onProgress)
                    this.onProgress(mes.progress);
                return;
            }
            const listener = this.listeners.get(mes.requestId);
            if (listener) {
                this.listeners.delete(mes.requestId);
                listener(mes);
            }
        });

        const failAll = (message) => {
            for (const listener of this.listeners.values())
                listener({error: message});
            this.listeners.clear();
            this.worker = null;
        };
        this.worker.on('error', (e) => failAll(e.message));
        this.worker.on('exit', (code, signal) => failAll(this.stoppedMessage + (signal ? ` (${signal})` : (code ? ` (exit code ${code})` : ''))));
    }

    //исполнитель вызовов; CatalogIndexProcess запускает вместо потока процесс
    start() {
        return new Worker(childCode, {eval: true});
    }

    get stoppedMessage() {
        return 'Catalog index worker stopped';
    }

    send(mes) {
        this.worker.postMessage(mes);
    }

    call(action, ...args) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error(this.stoppedMessage));
                return;
            }

            const requestId = ++this.requestId;
            this.listeners.set(requestId, (mes) => (mes.error ? reject(new Error(mes.error)) : resolve(mes.result)));
            this.send({requestId, action, args});
        });
    }

    async terminate() {
        if (this.worker) {
            const worker = this.worker;
            this.worker = null;
            await worker.terminate();
        }
    }
}

module.exports = CatalogIndexThread;
