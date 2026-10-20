//Поток индекса каталога: принимает {requestId, action, args} и вызывает метод CatalogIndex.
//Код потока - строка (как в jembadb), чтобы работать внутри pkg; модуль индекса подключается по абсолютному пути.
const {isMainThread} = require('worker_threads');

//статический require, чтобы pkg включил модуль в сборку
if (!isMainThread)
    require('./CatalogIndex');

module.exports = `
const {parentPort} = require('worker_threads');
const CatalogIndex = require('./CatalogIndex');

const index = new CatalogIndex();
//ход импорта INPX - сообщением без requestId
index.onProgress = progress => parentPort.postMessage({progress});

//importLibrary асинхронный (чтение INPX), остальные методы синхронные
parentPort.on('message', async(mes) => {
    let result = {};
    try {
        if (typeof index[mes.action] !== 'function')
            throw new Error('Action not found: ' + mes.action);
        result.result = await index[mes.action](...(mes.args || []));
    } catch (e) {
        result = {error: e.message};
    }
    result.requestId = mes.requestId;
    parentPort.postMessage(result);
});
`.replace("'./CatalogIndex'", `'${__dirname.replace(/\\/g, '/')}/CatalogIndex'`);
