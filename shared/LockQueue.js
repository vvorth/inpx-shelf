//Очередь на одну блокировку: get() ждёт, пока её не вернут через ret(); errAll() отклоняет всех ждущих
class LockQueue {
    constructor(queueSize = 100) {
        this.queueSize = queueSize;
        this.freed = true;
        this.waitingQueue = [];
    }

    //async
    get() {
        return new Promise((resolve, reject) => {
            if (this.freed) {
                this.freed = false;
                resolve();
                return;
            }

            if (this.waitingQueue.length < this.queueSize) {
                this.waitingQueue.push({resolve, reject});
            } else {
                reject(new Error('Lock queue is too long'));
            }
        });
    }

    //блокировка переходит к первому ждущему, без него освобождается
    ret() {
        if (this.waitingQueue.length) {
            this.waitingQueue.shift().resolve();
        } else {
            this.freed = true;
        }
    }

    errAll(error = 'rejected') {
        while (this.waitingQueue.length) {
            this.waitingQueue.shift().reject(new Error(error));
        }
    }
}

module.exports = LockQueue;
