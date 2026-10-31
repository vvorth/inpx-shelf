//Поток сканирования папки с книгами: вызовы FolderScan как промисы. Создаётся на одну синхронизацию.
const {Worker} = require('worker_threads');
const childCode = require('./FolderScanChild');

class FolderScanThread {
    constructor() {
        this.requestId = 0;
        this.listeners = new Map();
        this.worker = new Worker(childCode, {eval: true});

        //строки журнала из потока: onLog(level, text), level - info или warn
        this.onLog = null;
        this.worker.on('message', (mes) => {
            if (mes.log) {
                if (this.onLog)
                    this.onLog(mes.log.level, mes.log.text);
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
        this.worker.on('exit', () => failAll('Folder scan worker stopped'));
    }

    call(action, ...args) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Folder scan worker stopped'));
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

module.exports = FolderScanThread;
