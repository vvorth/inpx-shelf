//Архив в S3 как файл ФС 7-Zip (WebAssembly). 7-Zip читает синхронно внутри потока архивов, а S3 отвечает
//асинхронно: запрос уходит потоку-загрузчику, поток архивов ждёт ответа в Atomics.wait (в потоке это можно).
const {Worker, MessageChannel, receiveMessageOnPort} = require('worker_threads');
const {isMainThread} = require('worker_threads');

//статический require, чтобы pkg включил модуль в сборку
if (!isMainThread)
    require('../S3Fs');

//Код загрузчика - строка, как у ArchiveChild: так поток работает и внутри pkg
const fetcherCode = `
const {workerData} = require('worker_threads');
const {S3Fs} = require('${__dirname.replace(/\\/g, '/')}/../S3Fs');
const s3 = new S3Fs();
const {port, signal} = workerData;
const sig = new Int32Array(signal);

port.on('message', async({id, action, uri, offset, length}) => {
    let message;
    const transfer = [];
    try {
        const result = await s3[action](uri, offset, length);
        message = {id, result};
        if (result instanceof Uint8Array) {
            //Buffer из пула может делить ArrayBuffer с другими: передаём свою копию
            message.result = new Uint8Array(result);
            transfer.push(message.result.buffer);
        }
    } catch (e) {
        message = {id, error: e.message, code: e.code};
    }
    port.postMessage(message, transfer);
    Atomics.store(sig, 0, 1);
    Atomics.notify(sig, 0);
});
`;

const blockSize = 256*1024;
const maxCacheBytes = 32*1024*1024;
const requestTimeoutMs = 2*60*1000;
//LRU блоков: `${etag}:${uri}:${n}` -> Uint8Array. Общий для вызовов: каждый вызов - новый экземпляр 7-Zip
const blocks = new Map();
let cacheBytes = 0;
let bridge = null;
let requestId = 0;

function getBridge() {
    if (!bridge) {
        const {port1, port2} = new MessageChannel();
        const signal = new SharedArrayBuffer(4);
        const worker = new Worker(fetcherCode, {eval: true, workerData: {port: port2, signal}, transferList: [port2]});
        worker.unref();
        worker.on('error', () => { bridge = null; });
        worker.on('exit', () => { bridge = null; });
        bridge = {port: port1, sig: new Int32Array(signal)};
    }
    return bridge;
}

function call(action, uri, offset, length) {
    const {port, sig} = getBridge();
    const id = ++requestId;
    Atomics.store(sig, 0, 0);
    port.postMessage({id, action, uri, offset, length});
    const deadline = Date.now() + requestTimeoutMs;
    for (;;) {
        const wait = deadline - Date.now();
        if (wait <= 0 || Atomics.wait(sig, 0, 0, wait) === 'timed-out')
            throw new Error(`S3 request timed out: ${uri}`);
        Atomics.store(sig, 0, 0);
        //ответы на запросы, брошенные по таймауту, пропускаем
        for (let item = receiveMessageOnPort(port); item; item = receiveMessageOnPort(port)) {
            const message = item.message;
            if (message.id !== id)
                continue;
            if (message.error)
                throw Object.assign(new Error(message.error), {code: message.code});
            return message.result;
        }
    }
}

function cacheGet(id) {
    const data = blocks.get(id);
    if (data) {
        blocks.delete(id);
        blocks.set(id, data);
    }
    return data;
}

function cachePut(id, data) {
    blocks.set(id, data);
    cacheBytes += data.length;
    while (cacheBytes > maxCacheBytes) {
        const [oldId, old] = blocks.entries().next().value;
        blocks.delete(oldId);
        cacheBytes -= old.length;
    }
}

function open(uri) {
    const {size, etag} = call('head', uri);
    const blockId = n => `${etag}:${uri}:${n}`;

    //Недостающие блоки подряд загружаются одним запросом: последовательное чтение solid-блока - не по GET на блок
    const load = (first, last) => {
        let n = first;
        while (n <= last) {
            if (cacheGet(blockId(n))) {
                n++;
                continue;
            }
            let end = n;
            while (end < last && !blocks.has(blockId(end + 1)))
                end++;
            const start = n*blockSize;
            const data = call('readRange', uri, start, Math.min(size, (end + 1)*blockSize) - start);
            for (let i = n; i <= end; i++)
                cachePut(blockId(i), data.subarray((i - n)*blockSize, (i - n + 1)*blockSize));
            n = end + 1;
        }
    };

    const read = (target, offset, length, position) => {
        length = Math.max(0, Math.min(length, size - position));
        if (!length)
            return 0;
        load(Math.floor(position/blockSize), Math.floor((position + length - 1)/blockSize));
        let done = 0;
        while (done < length) {
            const pos = position + done;
            const data = blocks.get(blockId(Math.floor(pos/blockSize)));
            const from = pos % blockSize;
            const n = Math.min(length - done, data.length - from);
            target.set(data.subarray(from, from + n), offset + done);
            done += n;
        }
        return length;
    };

    return {size, read, error: null};
}

//Файл только для чтения в ФС Emscripten, по образцу FS.createLazyFile. Ошибка S3 запоминается в file.error:
//7-Zip видит EIO, а вызывающий получает исходную причину
function createNode(sz, dir, name, uri) {
    const file = open(uri);
    const node = sz.FS.createFile(dir, name, {}, true, false);
    node.contents = new Uint8Array(0);
    Object.defineProperty(node, 'usedBytes', {get: () => file.size});
    node.stream_ops = Object.assign({}, node.stream_ops, {
        read: (stream, buffer, offset, length, position) => {
            try {
                //buffer - HEAP8 (Int8Array): копируем байты как есть через Uint8Array
                return file.read(new Uint8Array(buffer.buffer, buffer.byteOffset), offset, length, position);
            } catch (e) {
                file.error = e;
                throw new sz.FS.ErrnoError(29);
            }
        },
        write: () => { throw new sz.FS.ErrnoError(63); },
        mmap: () => { throw new sz.FS.ErrnoError(43); },
    });
    return file;
}

module.exports = {createNode, blockSize};
