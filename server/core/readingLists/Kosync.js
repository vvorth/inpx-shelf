const crypto = require('crypto');

// Documents kept per profile; the oldest go first. Unmapped KOReader books are stored too.
const documentLimit = 2000;

function keyHash(key = '') {
    return crypto.createHash('sha256').update(String(key).toLowerCase()).digest('hex');
}

// KOReader progress sync (kosync) of a profile. Mixed into ReadingListStore.prototype: `this` is the store.
// KOReader sends md5(password) as its key: only a hash of that key is stored.
module.exports = {
    async createKosyncPassword(userId = '') {
        const {data, user} = await this.resolveUser(userId);
        const password = crypto.randomBytes(8).toString('hex');
        user.kosyncKeyHash = keyHash(crypto.createHash('md5').update(password).digest('hex'));
        user.updatedAt = this.nowIso();
        await this.save(data);
        return password;
    },

    async findKosyncUser(key = '') {
        if (!/^[0-9a-f]{32}$/i.test(String(key)))
            return null;
        const hash = keyHash(key);
        return (await this.load()).users.find(user => user.kosyncKeyHash === hash) || null;
    },

    // document is a validated hex digest, safe as an object key.
    async getKosyncProgress(userId = '', document = '') {
        const {user} = await this.resolveUser(userId);
        const rows = user.kosyncProgress || {};
        return (Object.hasOwn(rows, document) ? rows[document] : null);
    },

    // Backup rows in the shape putKosyncProgress stores; the newer timestamp of a document wins.
    mergeKosyncProgress(current, incoming) {
        const rows = Object.assign({}, (current && typeof(current) === 'object' ? current : {}));
        for (const [document, row] of Object.entries(incoming).slice(0, documentLimit)) {
            const percentage = Number(row && row.percentage);
            if (!/^[0-9a-f]{32}$/.test(document) || typeof(row.progress) !== 'string' || !Number.isFinite(percentage)
                || !Number.isInteger(row.timestamp) || (Object.hasOwn(rows, document) && rows[document].timestamp >= row.timestamp))
                continue;
            rows[document] = {
                progress: row.progress.slice(0, 1024), percentage: Math.max(0, Math.min(1, percentage)),
                device: String(row.device || '').slice(0, 128), device_id: String(row.device_id || '').slice(0, 128),
                timestamp: row.timestamp, bookUid: String(row.bookUid || '').slice(0, 256),
            };
        }
        const keys = Object.keys(rows);
        keys.sort((a, b) => (rows[a].timestamp || 0) - (rows[b].timestamp || 0));
        for (const key of keys.slice(0, Math.max(0, keys.length - documentLimit)))
            delete rows[key];
        return rows;
    },

    async putKosyncProgress(userId = '', document = '', row = {}) {
        const {data, user} = await this.resolveUser(userId);
        const rows = user.kosyncProgress = (user.kosyncProgress && typeof(user.kosyncProgress) === 'object' ? user.kosyncProgress : {});
        rows[document] = row;
        const keys = Object.keys(rows);
        if (keys.length > documentLimit) {
            keys.sort((a, b) => (rows[a].timestamp || 0) - (rows[b].timestamp || 0));
            for (const key of keys.slice(0, keys.length - documentLimit))
                delete rows[key];
        }
        await this.save(data);
        return row;
    },
};
