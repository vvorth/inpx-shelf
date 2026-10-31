//Поток сканирования папки: принимает {requestId, action, args} и вызывает функцию FolderScan.
//Код потока - строка, как у CatalogIndexChild, чтобы работать внутри pkg; модуль подключается по абсолютному пути.
const {isMainThread} = require('worker_threads');

//статический require, чтобы pkg включил модуль в сборку
if (!isMainThread)
    require('./FolderScan');

module.exports = `
const {parentPort} = require('worker_threads');
const FolderScan = require('./FolderScan');

const log = (level, text) => parentPort.postMessage({log: {level, text}});
const actions = {
    build: (source, dataDir) => FolderScan.build(source, dataDir, log),
};

parentPort.on('message', async(mes) => {
    let result = {};
    try {
        if (typeof actions[mes.action] !== 'function')
            throw new Error('Action not found: ' + mes.action);
        result.result = await actions[mes.action](...(mes.args || []));
    } catch (e) {
        result = {error: e.message};
    }
    result.requestId = mes.requestId;
    parentPort.postMessage(result);
});
`.replace("'./FolderScan'", `'${__dirname.replace(/\\/g, '/')}/FolderScan'`);
