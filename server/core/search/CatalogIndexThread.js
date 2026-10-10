//Обёртка над потоком индекса каталога: вызовы методов CatalogIndex как промисы.
const {Worker} = require('worker_threads');
const childCode = require('./CatalogIndexChild');

class CatalogIndexThread {
    constructor() {
        this.requestId = 0;
        this.listeners = new Map();
        this.worker = new Worker(childCode, {eval: true});

        this.worker.on('message', (mes) => {
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
        this.worker.on('exit', () => failAll('Catalog index worker stopped'));
    }

    call(action, ...args) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Catalog index worker stopped'));
                return;
            }

            const requestId = ++this.requestId;
            this.listeners.set(requestId, (mes) => (mes.error ? reject(new Error(mes.error)) : resolve(mes.result)));
            this.worker.postMessage({requestId, action, args});
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
