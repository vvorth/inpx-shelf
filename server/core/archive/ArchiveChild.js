//Поток архивов: принимает {requestId, action, args} и вызывает функцию SevenZipEngine.
//Код потока - строка (как у CatalogIndexChild), чтобы работать внутри pkg; модуль подключается по абсолютному пути.
const {isMainThread} = require('worker_threads');

//статический require, чтобы pkg включил модуль в сборку
if (!isMainThread)
    require('./SevenZipEngine');

module.exports = `
const {parentPort} = require('worker_threads');
const engine = require('./SevenZipEngine');

parentPort.on('message', async(mes) => {
    let result = {};
    try {
        if (typeof engine[mes.action] !== 'function')
            throw new Error('Action not found: ' + mes.action);
        result.result = await engine[mes.action](...(mes.args || []));
    } catch (e) {
        result = {error: e.message};
    }
    result.requestId = mes.requestId;
    parentPort.postMessage(result);
});
`.replace("'./SevenZipEngine'", `'${__dirname.replace(/\\/g, '/')}/SevenZipEngine'`);
