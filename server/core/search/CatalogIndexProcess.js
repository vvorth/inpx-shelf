//Сборка БД библиотеки в отдельном процессе (вызовы как у CatalogIndexThread): память сборки (пик ~1.7 ГБ)
//возвращается системе, когда процесс завершается, а в общей куче с потоком glibc держала бы её часть.
const path = require('path');
const childProcess = require('child_process');
const CatalogIndexThread = require('./CatalogIndexThread');

class CatalogIndexProcess extends CatalogIndexThread {
    //spawn, а не fork: в pkg перехвачен только spawn, и бинарник запускает скрипт из снимка вместо сервера.
    //Из execArgv - только предел кучи. В pkg он не передаётся: бинарник принял бы флаг за имя скрипта,
    //а его опции (max-old-space-size) и так действуют в процессе сборки
    start() {
        const execArgv = (process.pkg ? [] : process.execArgv.filter(arg => arg.startsWith('--max-old-space-size=')));
        this.process = childProcess.spawn(process.execPath, [...execArgv, path.join(__dirname, 'CatalogIndexProcessChild.js')], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true,
        });
        return this.process;
    }

    get stoppedMessage() {
        return 'Catalog index process stopped';
    }

    send(mes) {
        this.worker.send(mes);
    }

    //Останавливает процесс и ждёт его завершения; worker обнуляется и при ошибке IPC, поэтому - по this.process
    async terminate() {
        this.worker = null;
        const child = this.process;
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
            return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
    }
}

module.exports = CatalogIndexProcess;
