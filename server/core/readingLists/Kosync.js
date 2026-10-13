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
