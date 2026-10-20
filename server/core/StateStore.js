//Служебное состояние сервера, которое не входит в БД библиотеки и переживает её пересборку:
//какие книги уже подготовлены в кеше файлов (хеш файла, размер, версия обработки)
//какой книге принадлежит файл, отданный читалке (хеш KOReader), и сессии вошедших в профиль браузеров.
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
                DROP TABLE IF EXISTS access;
                DROP TABLE IF EXISTS setting;
                CREATE TABLE IF NOT EXISTS web_session(id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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

    //Сессии браузеров, вошедших в профиль: ключ - sha256 id из cookie, токен профиля не хранится
    getWebSession(idHash) {
        const row = this.open().prepare('SELECT user_id, csrf, created_at, updated_at FROM web_session WHERE id_hash = ?').get(String(idHash));
        return (row ? {userId: row.user_id, csrfToken: row.csrf, createdAt: row.created_at, updatedAt: row.updated_at} : null);
    }

    putWebSession(idHash, {userId, csrfToken, createdAt, updatedAt}) {
        this.open().prepare('INSERT OR REPLACE INTO web_session(id_hash, user_id, csrf, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(String(idHash), String(userId), String(csrfToken), Number(createdAt), Number(updatedAt));
    }

    deleteWebSession(idHash) {
        this.open().prepare('DELETE FROM web_session WHERE id_hash = ?').run(String(idHash));
    }

    deleteUserWebSessions(userId) {
        this.open().prepare('DELETE FROM web_session WHERE user_id = ?').run(String(userId));
    }

    deleteAllWebSessions() {
        this.open().prepare('DELETE FROM web_session').run();
    }

    purgeWebSessions(createdBefore, updatedBefore) {
        this.open().prepare('DELETE FROM web_session WHERE created_at < ? OR updated_at < ?').run(Number(createdBefore), Number(updatedBefore));
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = StateStore;
