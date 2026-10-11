//Служебное состояние сервера, которое не входит в БД библиотеки и переживает её пересборку:
//какие книги уже подготовлены в кеше файлов (хеш файла, размер, версия обработки).
//Маленькие точечные запросы - синхронно в основном потоке.
const path = require('path');
const {DatabaseSync} = require('node:sqlite');

class StateStore {
    constructor(config) {
        this.file = path.join(config.dataDir, 'state.sqlite');
        this.db = null;
    }

    open() {
        if (!this.db) {
            const db = new DatabaseSync(this.file);
            db.exec(`PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS book_file(uid TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, asset_version TEXT NOT NULL);`);
            this.db = db;
        }
        return this.db;
    }

    //Подготовленные файлы книг: [{id: uid, hash, size, assetVersion}]
    getBookFiles(uids = []) {
        if (!uids.length)
            return [];
        return this.open().prepare(`SELECT uid, hash, size, asset_version FROM book_file WHERE uid IN (SELECT value FROM json_each(?))`)
            .all(JSON.stringify(uids.map(String)))
            .map(row => ({id: row.uid, hash: row.hash, size: row.size, assetVersion: row.asset_version}));
    }

    putBookFile({id, hash, size, assetVersion}) {
        this.open().prepare('INSERT OR REPLACE INTO book_file(uid, hash, size, asset_version) VALUES (?, ?, ?, ?)')
            .run(String(id), String(hash), Number(size) || 0, String(assetVersion || ''));
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = StateStore;
