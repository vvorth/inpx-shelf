const fs = require('fs-extra');
const profilePassword = require('../ProfilePassword');
const {t} = require('../i18n');

function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

// Profiles: lookup, OPDS access, passwords. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    ensureUniqueUserName(users, name, excludeId = '') {
        const duplicate = users.find((item) => item.id !== excludeId && item.name.toLowerCase() === name.toLowerCase());
        if (duplicate)
            throw new Error(t('errors.userNameExists'));
    },

    ensureUniqueUserLogin(users, login, excludeId = '') {
        if (!login)
            return;

        const duplicate = users.find((item) => item.id !== excludeId && item.login === login);
        if (duplicate)
            throw new Error(t('errors.userLoginExists'));
    },

    async getUsers(currentUserId = '') {
        const {data, user} = await this.resolveUser(currentUserId);
        return {
            users: data.users,
            currentUser: user,
        };
    },

    async getUser(userId = '') {
        const {user} = await this.resolveUser(userId);
        return user;
    },

    // Exact lookup: unlike resolveUser, an unknown id does not fall back to the first profile.
    // Asked on every Kobo request: reads the cached copy in place instead of cloning the store.
    async hasUser(userId = '') {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId)
            return false;
        const stat = await fs.stat(this.file).catch(() => null);
        const fresh = stat && this.loaded && this.loaded.stamp === this.fileStamp(stat) && !this.config.resetAdminPassword;
        const data = (fresh ? this.loaded.data : await this.load());
        return data.users.some((item) => item.id === normalizedUserId);
    },

    async findUserByLogin(login = '') {
        const normalizedLogin = this.validateLogin(login);
        if (!normalizedLogin)
            return null;

        const data = await this.load();
        return data.users.find((item) => item.login === normalizedLogin) || null;
    },

    async getOpdsUsers() {
        const data = await this.load();
        const stats = new Map();

        for (const item of data.lists) {
            if (item.visibility !== 'opds')
                continue;

            const count = stats.get(item.userId) || 0;
            stats.set(item.userId, count + 1);
        }

        const progressCounts = new Map();
        for (const item of data.users) {
            const progressMap = (item && item.readerProgress && typeof(item.readerProgress) === 'object' ? item.readerProgress : {});
            const count = Object.values(progressMap).filter((progress) => progress && progress.hidden !== true).length;
            if (count)
                progressCounts.set(item.id, count);
        }

        return data.users
            .filter((item) => item.opdsEnabled && (stats.has(item.id) || progressCounts.has(item.id)))
            .map((item) => ({
                id: item.id,
                publicId: item.login || item.id,
                name: item.name,
                opdsAuthEnabled: item.opdsAuthEnabled === true,
                opdsListCount: stats.get(item.id) || 0,
                opdsProgressCount: progressCounts.get(item.id) || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    },

    async getOpdsUser(publicId = '') {
        const normalized = String(publicId || '').trim();
        if (!normalized)
            return null;

        const data = await this.load();
        const user = data.users.find((item) => item.id === normalized || item.login === normalized);
        if (!user || user.opdsEnabled === false)
            return null;

        return user;
    },

    async verifyOpdsPassword(publicId = '', login = '', password = '') {
        const user = await this.getOpdsUser(publicId);
        if (!user || user.opdsAuthEnabled !== true)
            return {user, authorized: true};

        if (!user.login || !user.passwordHash)
            return {user, authorized: false};

        const normalizedLogin = this.normalizeLogin(login);
        return {
            user,
            authorized: normalizedLogin === user.login && await this.verifyUserPassword(user.id, password),
        };
    },

    // Runs outside the store lock (see the loop at the end of ReadingListStore.js): scrypt takes ~0.3 s and must not hold up other requests.
    async verifyUserPassword(userId, password) {
        const user = await this.getPasswordRecord(userId);
        if (!user || !user.passwordHash || !await profilePassword.verify(user.passwordHash, user.login, password))
            return false;
        if (profilePassword.isLegacy(user.passwordHash))
            await this.upgradePasswordHash(userId, user.passwordHash, await profilePassword.hash(password));
        return true;
    },

    async getPasswordRecord(userId) {
        const user = (await this.load()).users.find(item => item.id === userId);
        return (user ? {login: user.login, passwordHash: user.passwordHash} : null);
    },

    // Unless the password changed while it was being checked.
    async upgradePasswordHash(userId, previousHash, passwordHash) {
        const data = await this.load();
        const user = data.users.find(item => item.id === userId);
        if (user && user.passwordHash === previousHash) {
            user.passwordHash = passwordHash;
            await this.save(data);
        }
    },

    async createUser(profile = {}) {
        const data = await this.load();
        const normalizedName = this.validateUserName(profile.name);
        this.ensureUniqueUserName(data.users, normalizedName);
        const normalizedLogin = this.validateLogin(profile.login);
        this.ensureUniqueUserLogin(data.users, normalizedLogin);

        const user = this.normalizeUser({
            name: normalizedName,
            login: normalizedLogin,
            passwordHash: String(profile.passwordHash || '').trim(),
            emailTo: profile.emailTo,
            telegramChatId: profile.telegramChatId,
            opdsEnabled: profile.opdsEnabled,
            opdsAuthEnabled: profile.opdsAuthEnabled,
            isAdmin: profile.isAdmin === true,
        });
        if (user.opdsAuthEnabled && (!user.login || !user.passwordHash))
            throw new Error(t('errors.opdsCredentialsRequired'));
        //без пароля requireAdmin пропустил бы любого, кто выбрал этот профиль
        if (user.isAdmin && (!user.login || !user.passwordHash))
            throw new Error(t('errors.adminCredentialsRequired'));

        data.users.push(user);
        await this.save(data);
        return user;
    },

    async updateUser(userId, patch = {}) {
        const {data, user: target} = await this.resolveUser(userId);

        const nextName = this.validateUserName(utilsHasProp(patch, 'name') ? patch.name : target.name);
        const nextLogin = this.validateLogin(utilsHasProp(patch, 'login') ? patch.login : target.login);
        if (nextLogin !== target.login && profilePassword.isLegacy(target.passwordHash)
            && (!String(patch.passwordHash || '').trim() || patch.passwordHash === target.passwordHash))
            throw new Error(t('errors.loginChangeNeedsPassword'));
        this.ensureUniqueUserName(data.users, nextName, target.id);
        this.ensureUniqueUserLogin(data.users, nextLogin, target.id);

        target.name = nextName;
        target.login = nextLogin;
        if (utilsHasProp(patch, 'passwordHash'))
            target.passwordHash = String(patch.passwordHash || '').trim();
        if (utilsHasProp(patch, 'emailTo'))
            target.emailTo = String(patch.emailTo || '').trim();
        if (utilsHasProp(patch, 'telegramChatId'))
            target.telegramChatId = String(patch.telegramChatId || '').trim();
        if (utilsHasProp(patch, 'opdsEnabled'))
            target.opdsEnabled = (patch.opdsEnabled !== false);
        if (utilsHasProp(patch, 'opdsAuthEnabled'))
            target.opdsAuthEnabled = (patch.opdsAuthEnabled === true);
        if (utilsHasProp(patch, 'readerPreferences'))
            target.readerPreferences = this.normalizeReaderPreferences(patch.readerPreferences);
        if (utilsHasProp(patch, 'isAdmin')) {
            //первый профиль - главный администратор из конфига (applyAdminBootstrap): без него запуск выбрал бы другого
            if (target.isAdmin && patch.isAdmin !== true && data.users[0] && data.users[0].id === target.id)
                throw new Error(t('errors.cannotRemoveMainAdmin'));
            target.isAdmin = (patch.isAdmin === true);
        }
        if (target.opdsAuthEnabled && (!target.login || !target.passwordHash))
            throw new Error(t('errors.opdsCredentialsRequired'));
        if (target.isAdmin && (!target.login || !target.passwordHash))
            throw new Error(t('errors.adminCredentialsRequired'));
        target.updatedAt = this.nowIso();

        await this.save(data);
        return target;
    },

    async deleteUser(userId) {
        const data = await this.load();
        if (data.users.length <= 1)
            throw new Error(t('errors.cannotDeleteLastUser'));

        const index = data.users.findIndex((item) => item.id === userId);
        if (index < 0)
            throw new Error(t('errors.userNotFound'));

        if (data.users[index].isAdmin)
            throw new Error(t('errors.cannotDeleteAdmin'));

        const [removed] = data.users.splice(index, 1);
        data.lists = data.lists.filter((item) => item.userId !== removed.id);

        await this.save(data);
        return {
            success: true,
            nextUserId: data.users[0] ? data.users[0].id : '',
        };
    },
};
