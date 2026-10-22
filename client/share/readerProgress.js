//Выбор позиции чтения: сервер, сводка профиля или копия в браузере, сброс прогресса по поколению.
//Без состояния читалки: поколение по умолчанию передаётся явно, чтобы правила проверялись тестом.

function normalize(progress = {}, generationFallback = 0) {
    const percent = Number(progress && progress.percent);
    const sectionId = String((progress && progress.sectionId) || '').trim();
    const pageIndex = Number(progress && progress.pageIndex);
    const textOffset = Number(progress && progress.textOffset);
    const textSnippet = String((progress && progress.textSnippet) || '').trim().slice(0, 240);
    const updatedAt = String((progress && progress.updatedAt) || '').trim();
    const generation = Number(progress && progress.generation);
    return {
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
        sectionId,
        pageIndex: Number.isFinite(pageIndex) ? Math.max(0, Math.round(pageIndex)) : 0,
        textOffset: Number.isFinite(textOffset) ? Math.max(-1, Math.round(textOffset)) : -1,
        textSnippet,
        updatedAt,
        generation: Number.isFinite(generation)
            ? Math.max(0, Math.round(generation))
            : Math.max(0, Math.round(Number(generationFallback || 0) || 0)),
    };
}

//Как на сервере (server/core/ReaderProgress.js): от 99.9% книга прочитана
const READ_PERCENT = 0.999;

function isRead(progress = {}) {
    return normalize(progress || {}).percent >= READ_PERCENT;
}

//Отметка «прочитано»: percent 1, место в книге (глава, страница, текст) остаётся
function markRead(progress = {}, updatedAt = '', generation = 0) {
    return Object.assign(normalize(progress || {}, generation), {percent: 1, updatedAt});
}

//Снятие отметки: то же место, доля прочитанного - по нему (viewPercent).
//Места нет или оно в самом конце книги - начало, как у непрочитанной
function unmarkRead(progress = {}, viewPercent = 0, updatedAt = '', generation = 0) {
    const current = normalize(progress || {}, generation);
    const percent = Math.max(0, Math.min(1, Number(viewPercent) || 0));
    const placed = !!(current.sectionId || current.pageIndex > 0 || current.textOffset >= 0 || current.textSnippet);
    if (!placed || percent >= READ_PERCENT)
        return Object.assign(normalize({}, current.generation), {updatedAt});
    return Object.assign(current, {percent, updatedAt});
}

function hasPlace(progress = {}) {
    const normalized = normalize(progress || {});
    return !!(
        normalized.pageIndex > 0
        || normalized.percent > 0.0001
        || normalized.sectionId
    );
}

function merge(primary = {}, secondary = {}, options = {}) {
    const first = normalize(primary || {}, options.generation);
    const second = normalize(secondary || {}, options.generation);
    const firstHasPlace = hasPlace(first);
    const secondHasPlace = hasPlace(second);
    if (secondHasPlace && !firstHasPlace)
        return second;
    if (firstHasPlace && !secondHasPlace)
        return first;

    const firstTime = Date.parse(first.updatedAt || '');
    const secondTime = Date.parse(second.updatedAt || '');
    if (
        options.preferSecondaryRecentForward
        && Number.isFinite(firstTime)
        && Number.isFinite(secondTime)
        && firstTime > secondTime
        && firstTime - secondTime < 120000
        && (
            second.pageIndex > first.pageIndex
            || second.percent > first.percent + 0.0001
        )
    )
        return second;

    if (Number.isFinite(firstTime) && Number.isFinite(secondTime) && firstTime !== secondTime)
        return (secondTime > firstTime ? second : first);

    if (Number.isFinite(secondTime) && !Number.isFinite(firstTime))
        return second;
    if (Number.isFinite(firstTime) && !Number.isFinite(secondTime))
        return first;

    if (Math.abs((second.percent || 0) - (first.percent || 0)) > 0.0001)
        return (second.percent > first.percent ? second : first);

    if (second.sectionId && !first.sectionId)
        return second;

    return first;
}

function samePosition(first = {}, second = {}) {
    const a = normalize(first || {});
    const b = normalize(second || {});
    return (
        a.pageIndex === b.pageIndex
        && a.textOffset === b.textOffset
        && a.textSnippet === b.textSnippet
        && Math.abs(a.percent - b.percent) <= 0.0001
        && a.sectionId === b.sectionId
    );
}

//Позиция с другого устройства (браузер, Kobo, KOReader) против своей (local). Новее и далеко (другая глава
//или дальше 1%) - не переходим молча: remote - куда предложить перейти, progress - своя позиция.
//Своего места нет (новое устройство) или разница мала - progress по правилам merge, remote = null
function chooseRemote(local = {}, remote = {}, options = {}) {
    const own = normalize(local || {}, options.generation);
    const chosen = merge(remote, own, Object.assign({preferSecondaryRecentForward: true}, options));
    if (!hasPlace(own) || samePosition(chosen, own))
        return {progress: chosen, remote: null};

    const otherChapter = !!(own.sectionId && chosen.sectionId && own.sectionId !== chosen.sectionId);
    if (otherChapter || Math.abs(chosen.percent - own.percent) > 0.01)
        return {progress: own, remote: chosen};
    return {progress: chosen, remote: null};
}

//Ответ на сохранение позиции (sent): что хранит сервер (saved). 'saved' - нашу позицию.
//'force' - сервер оставил более старую: так быть не должно, повторить с force.
//'keep' - другая позиция с тем же временем: ничего не делаем.
//'remote' - новее или без времени: позиция с другого устройства, решает chooseRemote, затирать её нельзя
function saveOutcome(sent = {}, saved = {}) {
    if (samePosition(saved, sent))
        return 'saved';

    const sentTime = Date.parse(normalize(sent || {}).updatedAt || '');
    const savedTime = Date.parse(normalize(saved || {}).updatedAt || '');
    if (Number.isFinite(sentTime) && Number.isFinite(savedTime)) {
        if (savedTime < sentTime)
            return 'force';
        if (savedTime === sentTime)
            return 'keep';
    }
    return 'remote';
}

function shouldUpload(serverProgress = {}, restoredProgress = {}) {
    const server = normalize(serverProgress || {});
    const restored = normalize(restoredProgress || {});
    if (!hasPlace(restored))
        return false;

    if (samePosition(server, restored))
        return false;

    if (!hasPlace(server))
        return true;

    const serverTime = Date.parse(server.updatedAt || '');
    const restoredTime = Date.parse(restored.updatedAt || '');
    if (Number.isFinite(restoredTime) && Number.isFinite(serverTime))
        return restoredTime >= serverTime;
    if (Number.isFinite(restoredTime) && !Number.isFinite(serverTime))
        return true;
    if (Number.isFinite(serverTime) && !Number.isFinite(restoredTime))
        return false;

    return (
        restored.pageIndex > server.pageIndex
        || restored.percent > server.percent + 0.0001
    );
}

function afterReset(progress = null, resetAt = '', generation = 0) {
    if (!progress || typeof progress !== 'object')
        return null;

    const expectedGeneration = Math.max(0, parseInt(generation, 10) || 0);
    const progressGeneration = Math.max(0, parseInt(progress.generation, 10) || 0);
    if (expectedGeneration > 0)
        return (progressGeneration === expectedGeneration) ? progress : null;

    const resetTime = Date.parse(String(resetAt || '').trim());
    if (!Number.isFinite(resetTime))
        return progress;

    const progressTime = Date.parse(String(progress.updatedAt || '').trim());
    return (Number.isFinite(progressTime) && progressTime > resetTime) ? progress : null;
}

//Позиция при открытии книги из ответа getReaderState (state), сводки профиля и копии в браузере (stored).
//Сброшенное позже (поколение или progressResetAt) не в счёт. dropStored - копию в браузере пора стереть,
//upload - открытая позиция новее серверной и её надо отправить
function opening(state = {}, profileProgress = null, storedProgress = null) {
    const empty = {percent: 0, sectionId: '', pageIndex: 0, textOffset: -1, textSnippet: '', updatedAt: ''};
    const resetAt = String((state && state.progressResetAt) || '').trim();
    const generation = Math.max(0, parseInt(state && state.progressGeneration, 10) || 0);
    const stateProgress = afterReset(Object.assign({}, empty, (state && state.progress) || {}), resetAt, generation)
        || Object.assign({}, empty);
    const stored = afterReset(storedProgress, resetAt, generation);
    const remote = hasPlace(stateProgress)
        ? stateProgress
        : merge(stateProgress, afterReset(profileProgress, resetAt, generation), {generation});
    const choice = chooseRemote(stored, remote, {generation});
    return {
        generation,
        progress: choice.progress,
        remote: choice.remote,
        upload: shouldUpload(normalize(stateProgress, generation), choice.progress),
        dropStored: !!(storedProgress && !stored),
    };
}

//Копия прогресса в localStorage не растёт бесконечно: остаются limit самых свежих книг
function trimMap(map = {}, limit = 500) {
    const entries = Object.entries(map || {});
    if (entries.length <= limit)
        return map;

    const time = progress => Date.parse((progress && progress.updatedAt) || '') || 0;
    entries.sort((a, b) => time(b[1]) - time(a[1]));
    return Object.fromEntries(entries.slice(0, limit));
}

module.exports = {normalize, isRead, markRead, unmarkRead, hasPlace, merge, samePosition, chooseRemote, saveOutcome, shouldUpload, afterReset, opening, trimMap};
