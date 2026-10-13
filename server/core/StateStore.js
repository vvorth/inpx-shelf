//Служебное состояние сервера, которое не входит в БД библиотеки и переживает её пересборку:
//какие книги уже подготовлены в кеше файлов (хеш файла, размер, версия обработки)
//сессии входа по общему паролю доступа и какой книге принадлежит файл, отданный читалке (хеш KOReader).
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
                CREATE TABLE IF NOT EXISTS book_file(uid TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, asset_version TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS access(token TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS book_file_hash ON book_file(hash);
                CREATE TABLE IF NOT EXISTS kosync_document(hash TEXT PRIMARY KEY, uid TEXT NOT NULL);`);
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

    //Книга по имени файла в кеше (тот же файл у дублей - любая из них)
    getBookFileUid(hash) {
        const row = this.open().prepare('SELECT uid FROM book_file WHERE hash = ? LIMIT 1').get(String(hash));
        return (row ? row.uid : '');
    }

    //Хеш KOReader (partial MD5 отданного файла) → книга
    getKosyncDocument(hash) {
        const row = this.open().prepare('SELECT uid FROM kosync_document WHERE hash = ?').get(String(hash));
        return (row ? row.uid : '');
    }

    putKosyncDocument(hash, uid) {
        this.open().prepare('INSERT OR REPLACE INTO kosync_document(hash, uid) VALUES (?, ?)').run(String(hash), String(uid));
    }

    //Сессии общего пароля доступа: [{id: токен, value: {time, used}}]
    getAccessRows() {
        return this.open().prepare('SELECT token, value FROM access').all().map(row => ({id: row.token, value: JSON.parse(row.value)}));
    }

    putAccess(token, value) {
        this.open().prepare('INSERT OR REPLACE INTO access(token, value) VALUES (?, ?)').run(String(token), JSON.stringify(value));
    }

    deleteAccess(token) {
        this.open().prepare('DELETE FROM access WHERE token = ?').run(String(token));
    }

    clearAccess() {
        this.open().exec('DELETE FROM access');
    }

    getSetting(key) {
        const row = this.open().prepare('SELECT value FROM setting WHERE key = ?').get(String(key));
        return (row ? row.value : null);
    }

    setSetting(key, value) {
        this.open().prepare('INSERT OR REPLACE INTO setting(key, value) VALUES (?, ?)').run(String(key), String(value));
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = StateStore;
