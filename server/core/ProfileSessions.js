const {withFileTransaction} = require('./FilePersistence');
const i18n = require('./i18n');
const {t} = i18n;
const {isReadingInProgress} = require('./ReaderProgress');

const minPasswordLength = 10;

function getUserDisplayName(user = {}) {
    const name = String(user.name || '').trim();
    if (isAnonymousDefaultUser(user))
        return t('profiles.defaultAnonymousName');
    if (user.id === 'admin' && i18n.allTranslations('profiles.defaultAdminName').includes(name))
        return t('profiles.defaultAdminName');
    return name;
}

function isAnonymousDefaultUser(user = {}) {
    //имена профиля по умолчанию на любом языке (они сохраняются в данных при создании профиля)
    const defaultNames = i18n.allTranslations('profiles.defaultAnonymousName').concat(i18n.allTranslations('profiles.legacyMainName'));
    const name = String(user.name || '').trim();
    return user.id === 'default' && defaultNames.includes(name) && !user.login && !user.passwordHash;
}

const issuedTokens = new WeakSet();

// Профили читателей: вход по паролю, сессии профилей, проверка прав (requireAdmin), создание и правка профилей.
// Подмешивается в WebWorker.prototype: `this` - воркер.
module.exports = {
    //профили и вход не зависят от БД библиотеки: работают и пока она строится впервые
    async getUserProfiles(currentUserId = '') {
        const {users, currentUser} = await this.readingListStore.getUsers(currentUserId);
        return {
            users: users
                .map((item, index) => ({
                    id: item.id,
                    name: getUserDisplayName(item),
                    login: item.login || '',
                    requiresLogin: !!item.passwordHash,
                    anonymousProfile: isAnonymousDefaultUser(item),
                    isAdmin: !!item.isAdmin,
                    //главный администратор - первый профиль, его восстанавливает adminLogin из конфига
                    mainAdmin: index === 0 && !!item.isAdmin,
                    opdsEnabled: item.opdsEnabled !== false,
                    opdsAuthEnabled: !!item.opdsPasswordHash,
                    currentReadingCount: Object.values(item.readerProgress || {}).filter(isReadingInProgress).length,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                }))
                .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
            currentUserId: (currentUser ? currentUser.id : ''),
        };
    },

    //пароли, которые задают люди; сгенерированные (админ, KOReader) длиннее
    async hashProfilePassword(login, password) {
        if (String(password || '').length < minPasswordLength)
            throw new Error(t('errors.passwordTooShort', {min: minPasswordLength}));
        return require('./ProfilePassword').hash(password);
    },

    //Токен профиля - объект на один запрос: его выдаёт ProfileAccess.resolve, проверив cookie сессии.
    //Клиент его не подделает: строки и чужие объекты в issuedTokens нет
    profileToken(userId) {
        const token = Object.freeze({userId});
        issuedTokens.add(token);
        return token;
    },

    getProfileSessionUser(token) {
        return (issuedTokens.has(token) ? token.userId : '');
    },

    async getEffectiveUser(userId = '', profileAccessToken = '') {
        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (sessionUserId)
            return await this.readingListStore.getUser(sessionUserId);

        return await this.readingListStore.getUser(userId);
    },

    async requireAuthorizedUser(userId = '', profileAccessToken = '') {
        const requestedUser = await this.readingListStore.getUser(userId);
        if (!requestedUser.passwordHash)
            return requestedUser;

        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        if (!sessionUserId || sessionUserId !== requestedUser.id)
            throw new Error('need_profile_login');

        return requestedUser;
    },

    async requireAdmin(userId = '', profileAccessToken = '') {
        const user = await this.requireAuthorizedUser(userId, profileAccessToken);
        if (!user.isAdmin)
            throw new Error(t('errors.adminOnlyProfiles'));
        return user;
    },

    //Профиль без пароля открыт любому, кто его выберет: постоянные учётные данные (логин, пароль, ссылки устройств)
    //и адреса отправки для него задаёт только вошедший администратор
    async isProtectedProfile(user, profileAccessToken = '') {
        if (user.passwordHash)
            return true;
        const sessionUserId = this.getProfileSessionUser(profileAccessToken);
        const admin = (sessionUserId ? (await this.readingListStore.load()).users.find(item => item.id === sessionUserId) : null);
        return !!(admin && admin.isAdmin);
    },

    async getAuthorizedUserOrNull(userId = '', profileAccessToken = '') {
        const user = await this.getEffectiveUser(userId, profileAccessToken);
        if (!user || isAnonymousDefaultUser(user))
            return null;
        if (user.passwordHash && this.getProfileSessionUser(profileAccessToken) !== user.id)
            return null;
        return user;
    },

    async getCurrentUserProfile(userId = '', profileAccessToken = '') {
        const user = await this.getEffectiveUser(userId, profileAccessToken);
        const anonymousProfile = isAnonymousDefaultUser(user);
        const profileAuthorized = (!anonymousProfile && (!user.passwordHash || this.getProfileSessionUser(profileAccessToken) === user.id));
        const readingSummary = (profileAuthorized && this.myState === 'normal' ? await this.buildUserReadingSummary(user, 48) : {count: 0, items: []});
        return {
            currentUserId: user.id,
            profileAuthorized,
            currentUserProfile: {
                id: user.id,
                name: getUserDisplayName(user),
                login: user.login || '',
                hasPassword: !!user.passwordHash,
                anonymousProfile,
                isAdmin: !!user.isAdmin,
                emailTo: (profileAuthorized ? user.emailTo || '' : ''),
                telegramChatId: (profileAuthorized ? user.telegramChatId || '' : ''),
                opdsEnabled: user.opdsEnabled !== false,
                opdsAuthEnabled: !!user.opdsPasswordHash,
                kosyncPasswordSet: !!user.kosyncKeyHash,
                readerPreferences: (profileAuthorized ? this.readingListStore.normalizeReaderPreferences(user.readerPreferences) : null),
                currentReading: readingSummary.items,
                currentReadingCount: readingSummary.count,
                //«Мои языки» хранятся в языках вкуса витрин: один список для каталога и рекомендаций
                libraryLanguages: (profileAuthorized ? this.readingListStore.normalizeDiscoveryPreferences(user.discoveryPreferences).taste.languages : []),
            },
        };
    },

    //Пароль (scrypt, ~0.3 с) проверяется вне блокировки хранилища профилей. Если за это время
    //у профиля сменили пароль или логин или удалили его (sessionsValidAfter сдвинулся), вход не состоится.
    //sessionsValidAfter - нижняя граница createdAt новой сессии: вход в ту же миллисекунду, что и смена пароля, действителен
    async loginUserProfile(login = '', password = '') {
        const user = await this.readingListStore.findUserByLogin(login);
        const userId = (user ? user.id : '');
        //неизвестный логин проверяется так же долго, как известный (verifyUserPassword)
        const verified = await this.readingListStore.verifyUserPassword(userId, password);
        const current = (verified && user ? (await this.readingListStore.load()).users.find(item => item.id === userId) : null);
        if (!current || current.login !== user.login || current.sessionsValidAfter !== user.sessionsValidAfter)
            throw new Error(t('errors.invalidLogin'));
        return {userId, sessionsValidAfter: current.sessionsValidAfter};
    },

    async createUserProfile(profile = {}) {
        this.checkMyState();
        return {user: await this.readingListStore.createUser(profile)};
    },

    async updateUserProfile(userId, patch = {}) {
        this.checkMyState();
        return {user: await this.readingListStore.updateUser(userId, patch)};
    },

    async deleteUserProfile(userId) {
        this.checkMyState();
        return withFileTransaction(this.readingListStore.file, async() => {
            const result = await this.readingListStore.deleteUser(userId);
            if (this.koboService)
                await this.koboService.store.deleteUserDevices(userId);
            return result;
        });
    },
};
