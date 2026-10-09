const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {withFileTransaction, writeFileAtomic} = require('../FilePersistence');

const storeVersion = 1;
const maxDevicesPerUser = 16;
const maxListsPerDevice = 32;

function hashToken(token = '') {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function makeToken() {
    return crypto.randomBytes(16).toString('hex');
}

function nowIso() {
    return new Date().toISOString();
}

// Kobo sync state lives apart from reading-lists.json: it is written on every
// device sync and must not churn the profile store or its backups.
class KoboStore {
    constructor(config) {
        this.config = config;
        this.file = path.join(config.dataDir, 'kobo-sync.json');
        this.data = null;
        this.tokenIndex = new Map();
    }

    makeDefaultData() {
        return {version: storeVersion, devices: [], states: {}};
    }

    normalizeDevice(item = {}) {
        const now = nowIso();
        const books = {};
        for (const [uuid, row] of Object.entries(item.books || {})) {
            if (!uuid || !row || typeof(row) !== 'object' || !row.bookUid)
                continue;
            books[uuid] = {
                bookUid: String(row.bookUid),
                stableKey: String(row.stableKey || row.bookUid),
                title: String(row.title || ''),
                convertTo: String(row.convertTo || ''),
                koboFormats: (Array.isArray(row.koboFormats) && row.koboFormats.length ? row.koboFormats.map(String) : ['EPUB']),
                size: Math.max(0, parseInt(row.size, 10) || 0),
                sentAt: String(row.sentAt || now),
                status: String(row.status || ''),
                listRead: row.listRead === true,
                detached: row.detached === true,
                deletedOnDevice: row.deletedOnDevice === true,
                fingerprint: String(row.fingerprint || ''),
                fileChanged: row.fileChanged === true,
                changedAt: String(row.changedAt || ''),
            };
        }

        return {
            id: String(item.id || '').trim() || crypto.randomBytes(8).toString('hex'),
            userId: String(item.userId || '').trim(),
            name: String(item.name || 'Kobo').trim().slice(0, 64) || 'Kobo',
            tokenHash: String(item.tokenHash || ''),
            listIds: Array.from(new Set((Array.isArray(item.listIds) ? item.listIds : [])
                .map(id => String(id || '').trim()).filter(Boolean))).slice(0, maxListsPerDevice),
            keepRemovedBooks: item.keepRemovedBooks === true,
            storeProxy: item.storeProxy === true,
            generation: Math.max(0, parseInt(item.generation, 10) || 0),
            createdAt: String(item.createdAt || now),
            updatedAt: String(item.updatedAt || now),
            lastSyncAt: String(item.lastSyncAt || ''),
            books,
            tags: (item.tags && typeof(item.tags) === 'object' ? item.tags : {}),
        };
    }

    normalizeData(raw) {
        const source = Object.assign(this.makeDefaultData(), raw || {});
        const devices = [];
        const seen = new Set();
        for (const item of (Array.isArray(source.devices) ? source.devices : [])) {
            const device = this.normalizeDevice(item);
            if (!device.userId || !device.tokenHash || seen.has(device.id))
                continue;
            seen.add(device.id);
            devices.push(device);
        }

        const states = {};
        for (const [userId, rows] of Object.entries(source.states || {})) {
            if (rows && typeof(rows) === 'object')
                states[userId] = rows;
        }

        return {version: storeVersion, devices, states};
    }

    rebuildIndex() {
        this.tokenIndex = new Map(this.data.devices.map(device => [device.tokenHash, device.id]));
    }

    async load() {
        if (this.data)
            return this.data;

        return await withFileTransaction(this.file, async() => {
            if (this.data)
                return this.data;

            let raw = null;
            if (await fs.pathExists(this.file)) {
                try {
                    raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
                } catch (e) {
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    await fs.copy(this.file, `${this.file}.broken-${stamp}`).catch(() => {});
                }
            }

            this.data = this.normalizeData(raw);
            this.rebuildIndex();
            return this.data;
        });
    }

    // All mutations go through here so the in-memory copy and the file never diverge.
    async mutate(task) {
        await this.load();
        return await withFileTransaction(this.file, async() => {
            const result = await task(this.data);
            this.rebuildIndex();
            await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
            return result;
        });
    }

    // Synchronous on purpose: Security.verifyRequiredAuth cannot await.
    findDeviceByToken(token = '') {
        if (!this.data || !token || !/^[0-9a-f]{32}$/.test(token))
            return null;
        const id = this.tokenIndex.get(hashToken(token));
        return (id ? this.data.devices.find(device => device.id === id) || null : null);
    }

    publicDevice(device) {
        const books = Object.values(device.books || {});
        return {
            id: device.id,
            name: device.name,
            listIds: device.listIds.slice(),
            keepRemovedBooks: device.keepRemovedBooks,
            storeProxy: device.storeProxy,
            createdAt: device.createdAt,
            updatedAt: device.updatedAt,
            lastSyncAt: device.lastSyncAt,
            bookCount: books.filter(row => !row.detached && !row.deletedOnDevice).length,
        };
    }

    async getDevices(userId = '') {
        await this.load();
        return this.data.devices.filter(device => device.userId === userId).map(device => this.publicDevice(device));
    }

    normalizeSettings(patch = {}) {
        const result = {};
        if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
            const name = String(patch.name || '').trim().slice(0, 64);
            if (!name)
                throw new Error('Название устройства не должно быть пустым');
            result.name = name;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'listIds')) {
            if (!Array.isArray(patch.listIds))
                throw new Error('listIds must be an array');
            result.listIds = Array.from(new Set(patch.listIds.map(id => String(id || '').trim()).filter(Boolean)));
            if (result.listIds.length > maxListsPerDevice)
                throw new Error(`Не больше ${maxListsPerDevice} списков на устройство`);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'keepRemovedBooks'))
            result.keepRemovedBooks = patch.keepRemovedBooks === true;
        if (Object.prototype.hasOwnProperty.call(patch, 'storeProxy'))
            result.storeProxy = patch.storeProxy === true;
        return result;
    }

    async createDevice(userId = '', settings = {}) {
        const token = makeToken();
        const device = await this.mutate(async(data) => {
            if (data.devices.filter(item => item.userId === userId).length >= maxDevicesPerUser)
                throw new Error(`Не больше ${maxDevicesPerUser} устройств на профиль`);
            const now = nowIso();
            const item = this.normalizeDevice(Object.assign({name: 'Kobo'}, this.normalizeSettings(settings), {
                userId, tokenHash: hashToken(token), createdAt: now, updatedAt: now,
            }));
            data.devices.push(item);
            return item;
        });
        return {device: this.publicDevice(device), token};
    }

    findOwnDevice(data, userId, deviceId) {
        const device = data.devices.find(item => item.id === deviceId && item.userId === userId);
        if (!device)
            throw new Error('Устройство не найдено');
        return device;
    }

    async updateDevice(userId = '', deviceId = '', patch = {}) {
        const device = await this.mutate(async(data) => {
            const item = this.findOwnDevice(data, userId, deviceId);
            Object.assign(item, this.normalizeSettings(patch), {updatedAt: nowIso()});
            return item;
        });
        return {device: this.publicDevice(device)};
    }

    async regenerateToken(userId = '', deviceId = '') {
        const token = makeToken();
        const device = await this.mutate(async(data) => {
            const item = this.findOwnDevice(data, userId, deviceId);
            item.tokenHash = hashToken(token);
            item.updatedAt = nowIso();
            return item;
        });
        return {device: this.publicDevice(device), token};
    }

    // Forget what the device was told; the next sync sends the whole list again.
    async resetDevice(userId = '', deviceId = '') {
        const device = await this.mutate(async(data) => {
            const item = this.findOwnDevice(data, userId, deviceId);
            item.books = {};
            item.tags = {};
            item.generation++;
            item.updatedAt = nowIso();
            return item;
        });
        return {device: this.publicDevice(device)};
    }

    async deleteDevice(userId = '', deviceId = '') {
        await this.mutate(async(data) => {
            this.findOwnDevice(data, userId, deviceId);
            data.devices = data.devices.filter(item => item.id !== deviceId);
        });
        return {success: true};
    }

    async deleteUserDevices(userId = '') {
        await this.load();
        if (!this.data.devices.some(item => item.userId === userId) && !this.data.states[userId])
            return;
        await this.mutate(async(data) => {
            data.devices = data.devices.filter(item => item.userId !== userId);
            delete data.states[userId];
        });
    }

    getState(userId = '', uuid = '') {
        const rows = (this.data && this.data.states[userId]) || {};
        return rows[uuid] || null;
    }

    async saveSync(deviceId, patch) {
        return await this.mutate(async(data) => {
            const device = data.devices.find(item => item.id === deviceId);
            if (!device)
                return null;
            patch(device, data);
            return device;
        });
    }
}

module.exports = KoboStore;
module.exports.hashToken = hashToken;
