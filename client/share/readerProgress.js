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

function shouldUpload(serverProgress = {}, restoredProgress = {}) {
    const server = normalize(serverProgress || {});
    const restored = normalize(restoredProgress || {});
    if (!hasPlace(restored))
        return false;

    const differs = (
        server.pageIndex !== restored.pageIndex
        || server.textOffset !== restored.textOffset
        || String(server.textSnippet || '') !== String(restored.textSnippet || '')
        || Math.abs((server.percent || 0) - (restored.percent || 0)) > 0.0001
        || String(server.sectionId || '') !== String(restored.sectionId || '')
    );
    if (!differs)
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

//Копия прогресса в localStorage не растёт бесконечно: остаются limit самых свежих книг
function trimMap(map = {}, limit = 500) {
    const entries = Object.entries(map || {});
    if (entries.length <= limit)
        return map;

    const time = progress => Date.parse((progress && progress.updatedAt) || '') || 0;
    entries.sort((a, b) => time(b[1]) - time(a[1]));
    return Object.fromEntries(entries.slice(0, limit));
}

module.exports = {normalize, hasPlace, merge, shouldUpload, afterReset, trimMap};
