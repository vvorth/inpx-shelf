//Процесс сборки БД библиотеки (CatalogIndexProcess): принимает {requestId, action, args} и вызывает метод CatalogIndex,
//как поток CatalogIndexChild. Необработанная ошибка завершает процесс: ждущие вызовы в сервере получают отказ.
const CatalogIndex = require('./CatalogIndex');

const index = new CatalogIndex();
//ход импорта INPX - сообщением без requestId
index.onProgress = progress => process.send({progress});

process.on('message', async(mes) => {
    let result = {};
    try {
        if (typeof index[mes.action] !== 'function')
            throw new Error('Action not found: ' + mes.action);
        result.result = await index[mes.action](...(mes.args || []));
    } catch (e) {
        result = {error: e.message};
    }
    result.requestId = mes.requestId;
    process.send(result);
});

//сервер остановлен или упал: сборку некому принять
process.on('disconnect', () => process.exit(0));
