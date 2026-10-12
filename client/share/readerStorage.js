//Копия настроек и прогресса читалки в localStorage: общая и по пользователям (byUser).
//Ошибки хранилища (квота, приватный режим) не мешают чтению: запись просто пропускается.
const readerProgress = require('./readerProgress');

const preferencesKey = 'inpx.reader.preferences.v1';
const progressKey = 'inpx.reader.progress.v1';

function storage() {
    return (typeof localStorage === 'undefined' ? null : localStorage);
}

function readJson(key) {
    const raw = storage().getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
}

function byUserOf(parsed) {
    return (parsed.byUser && typeof parsed.byUser === 'object') ? parsed.byUser : {};
}

function progressOf(parsed) {
    return (parsed.progress && typeof parsed.progress === 'object') ? parsed.progress : {};
}

function readPreferences(userId = '') {
    if (!storage())
        return null;

    try {
        const parsed = readJson(preferencesKey);
        return (userId && byUserOf(parsed)[userId]) || parsed.preferences || null;
    } catch (e) {
        return null;
    }
}

function writePreferences(userId = '', preferences = {}) {
    if (!storage())
        return;

    try {
        const parsed = readJson(preferencesKey);
        const byUser = byUserOf(parsed);
        const copy = JSON.parse(JSON.stringify(preferences || {}));
        if (userId)
            byUser[userId] = copy;

        // Фон (data URL до 4 МБ) хранится один раз: в копии пользователя, а не ещё и в общей
        const shared = Object.assign({}, copy);
        if (userId) {
            delete shared.backgroundImage;
            delete shared.backgroundImageName;
        }
        storage().setItem(preferencesKey, JSON.stringify({preferences: shared, byUser}));
    } catch (e) {
        // ignore storage failures
    }
}

function readProgress(userId = '', bookUid = '') {
    if (!storage() || !bookUid)
        return null;

    try {
        const parsed = readJson(progressKey);
        const byUser = byUserOf(parsed);
        const bucket = (userId && byUser[userId] && typeof byUser[userId] === 'object')
            ? byUser[userId]
            : progressOf(parsed);
        const progress = bucket[bookUid];
        return progress && typeof progress === 'object' ? progress : null;
    } catch (e) {
        return null;
    }
}

//options: {all: true, bookUids: [...]} — сброс всего прогресса пользователя
function clearProgress(userId = '', bookUid = '', options = {}) {
    if (!storage())
        return;

    try {
        if (!storage().getItem(progressKey))
            return;

        const parsed = readJson(progressKey);
        const byUser = byUserOf(parsed);
        const globalProgress = progressOf(parsed);
        const normalizedBookUid = String(bookUid || '').trim();
        const knownBookUids = Array.isArray(options && options.bookUids)
            ? options.bookUids.map((uid) => String(uid || '').trim()).filter(Boolean)
            : [];

        if (options && options.all === true) {
            Object.keys(globalProgress).forEach((uid) => delete globalProgress[uid]);
            if (userId)
                byUser[userId] = {};
            knownBookUids.forEach((uid) => delete globalProgress[uid]);
        } else if (normalizedBookUid) {
            delete globalProgress[normalizedBookUid];
            if (userId && byUser[userId] && typeof byUser[userId] === 'object')
                delete byUser[userId][normalizedBookUid];
        }

        storage().setItem(progressKey, JSON.stringify({progress: globalProgress, byUser}));
    } catch (e) {
        // ignore storage failures
    }
}

//protectForward: страницы ещё строятся — не затирать недавнюю (до 2 минут) позицию дальше по книге
function writeProgress(userId = '', bookUid = '', progress = {}, {protectForward = false, generation = 0} = {}) {
    if (!storage() || !bookUid)
        return;

    try {
        const parsed = readJson(progressKey);
        const byUser = byUserOf(parsed);
        const nextProgress = readerProgress.normalize(progress, generation);
        const globalProgress = progressOf(parsed);
        const existingBucket = (userId && byUser[userId] && typeof byUser[userId] === 'object')
            ? byUser[userId]
            : globalProgress;
        const existingProgress = readerProgress.normalize(existingBucket[bookUid] || {}, generation);
        if (protectForward) {
            const existingTime = Date.parse(existingProgress.updatedAt || '');
            const nextTime = Date.parse(nextProgress.updatedAt || '');
            if (
                Number.isFinite(existingTime)
                && Number.isFinite(nextTime)
                && nextTime > existingTime
                && nextTime - existingTime < 120000
                && (
                    existingProgress.pageIndex > nextProgress.pageIndex
                    || existingProgress.percent > nextProgress.percent + 0.0001
                )
            )
                return;
        }

        if (userId) {
            const scoped = (byUser[userId] && typeof byUser[userId] === 'object') ? byUser[userId] : {};
            scoped[bookUid] = nextProgress;
            byUser[userId] = readerProgress.trimMap(scoped);
        }

        globalProgress[bookUid] = nextProgress;

        storage().setItem(progressKey, JSON.stringify({
            progress: readerProgress.trimMap(globalProgress),
            byUser,
        }));
    } catch (e) {
        // ignore storage failures
    }
}

module.exports = {readPreferences, writePreferences, readProgress, clearProgress, writeProgress};
