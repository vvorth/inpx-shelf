//Тесты чистых модулей читалки (без DOM)
const assert = require('assert');

//Копия прогресса в браузере хранит только самые свежие книги
async function testReaderProgressMapIsCapped() {
    const readerProgress = require('../client/share/readerProgress');
    const at = minutes => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
    const small = {a: {updatedAt: at(1)}};
    assert.strictEqual(readerProgress.trimMap(small, 2), small);

    const trimmed = readerProgress.trimMap({
        old: {updatedAt: at(1)},
        newest: {updatedAt: at(30)},
        broken: {},
        middle: {updatedAt: at(10)},
    }, 2);
    assert.deepStrictEqual(Object.keys(trimmed).sort(), ['middle', 'newest']);
}

//Копия в браузере: фон хранится один раз, позицию дальше по книге не затирает недостроенная разбивка
async function testReaderStorageKeepsBackgroundOnceAndForwardProgress() {
    const readerStorage = require('../client/share/readerStorage');
    const items = new Map();
    global.localStorage = {
        getItem: key => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
    };
    try {
        readerStorage.writePreferences('u1', {theme: 'sepia', backgroundImage: 'data:image/png;base64,AAAA'});
        const stored = JSON.parse(items.get('inpx.reader.preferences.v1'));
        assert.strictEqual(stored.byUser.u1.backgroundImage, 'data:image/png;base64,AAAA');
        assert.strictEqual(stored.preferences.backgroundImage, undefined);
        assert.strictEqual(readerStorage.readPreferences('u1').theme, 'sepia');

        const at = seconds => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
        readerStorage.writeProgress('u1', 'book', {pageIndex: 50, percent: 0.5, updatedAt: at(0)});
        readerStorage.writeProgress('u1', 'book', {pageIndex: 3, percent: 0.03, updatedAt: at(5)}, {protectForward: true});
        assert.strictEqual(readerStorage.readProgress('u1', 'book').pageIndex, 50);
        readerStorage.writeProgress('u1', 'book', {pageIndex: 3, percent: 0.03, updatedAt: at(6)});
        assert.strictEqual(readerStorage.readProgress('u1', 'book').pageIndex, 3);

        readerStorage.clearProgress('u1', 'book');
        assert.strictEqual(readerStorage.readProgress('u1', 'book'), null);
    } finally {
        delete global.localStorage;
    }
}

//Отметка «прочитано» не стирает место, снятие отметки возвращает к нему
async function testReaderReadMarkKeepsPlace() {
    const readerProgress = require('../client/share/readerProgress');
    const place = {percent: 0.42, sectionId: 'section-7', pageIndex: 84, textOffset: 1200, textSnippet: 'Глава седьмая', generation: 2};

    const read = readerProgress.markRead(place, 't1');
    assert.strictEqual(read.percent, 1);
    assert.strictEqual(readerProgress.isRead(read), true);
    assert.deepStrictEqual([read.sectionId, read.pageIndex, read.textOffset, read.textSnippet, read.generation, read.updatedAt],
        ['section-7', 84, 1200, 'Глава седьмая', 2, 't1']);

    const unread = readerProgress.unmarkRead(read, 0.42, 't2');
    assert.deepStrictEqual(unread, Object.assign({}, readerProgress.normalize(place), {updatedAt: 't2'}));
    assert.strictEqual(readerProgress.isRead(unread), false);

    //место в самом конце книги или без места - снова с начала
    const fromEnd = readerProgress.unmarkRead(read, 1, 't3');
    assert.deepStrictEqual([fromEnd.percent, fromEnd.pageIndex, fromEnd.sectionId, fromEnd.textOffset, fromEnd.generation, fromEnd.updatedAt],
        [0, 0, '', -1, 2, 't3']);
    assert.strictEqual(readerProgress.hasPlace(readerProgress.unmarkRead({percent: 1}, 0.5, 't4')), false);
}

//Позиция с другого устройства: новее и далеко - спросить, без своего места - перейти, рядом - без вопроса
async function testReaderRemoteProgressChoice() {
    const readerProgress = require('../client/share/readerProgress');
    const at = minutes => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
    const local = {percent: 0.2, sectionId: 'section-3', pageIndex: 20, updatedAt: at(10)};

    const far = readerProgress.chooseRemote(local, {percent: 0.63, sectionId: 'section-9', pageIndex: 63, updatedAt: at(30)});
    assert.strictEqual(far.progress.pageIndex, 20, 'Stay on the local place until the reader decides');
    assert.strictEqual(far.remote.pageIndex, 63);

    //Kobo и KOReader присылают только долю прочитанного
    const device = readerProgress.chooseRemote(local, {percent: 0.215, updatedAt: at(30)});
    assert.strictEqual(device.remote.percent, 0.215, 'More than 1% away asks even without a chapter');

    const near = readerProgress.chooseRemote(local, {percent: 0.205, sectionId: 'section-3', pageIndex: 21, updatedAt: at(30)});
    assert.strictEqual(near.remote, null);
    assert.strictEqual(near.progress.pageIndex, 21, 'A close newer position is taken silently');

    const older = readerProgress.chooseRemote(local, {percent: 0.63, sectionId: 'section-9', pageIndex: 63, updatedAt: at(5)});
    assert.deepStrictEqual([older.remote, older.progress.pageIndex], [null, 20], 'An older remote position is ignored');

    const fresh = readerProgress.chooseRemote(null, {percent: 0.63, sectionId: 'section-9', pageIndex: 63, updatedAt: at(30)});
    assert.deepStrictEqual([fresh.remote, fresh.progress.pageIndex], [null, 63], 'A fresh device jumps without asking');

    //«Остаться здесь» делает свою позицию новее: вопрос не возвращается
    const stayed = Object.assign({}, local, {updatedAt: at(31)});
    assert.strictEqual(readerProgress.chooseRemote(stayed, far.remote).remote, null);
    assert.strictEqual(readerProgress.shouldUpload(far.remote, stayed), true);
}

//Позиция при открытии: сервер, сводка профиля, копия в браузере; сброшенное позже не в счёт
async function testReaderOpeningProgress() {
    const readerProgress = require('../client/share/readerProgress');
    const at = minutes => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

    const fresh = readerProgress.opening({progress: {percent: 0.3, sectionId: 'section-4', pageIndex: 30, updatedAt: at(10), generation: 2}, progressGeneration: '2'});
    assert.deepStrictEqual([fresh.generation, fresh.progress.pageIndex, fresh.remote, fresh.upload, fresh.dropStored], [2, 30, null, false, false],
        'A new device opens the server position without asking');

    const local = {percent: 0.6, sectionId: 'section-8', pageIndex: 60, updatedAt: at(20), generation: 2};
    const ahead = readerProgress.opening({progress: {percent: 0.3, sectionId: 'section-4', pageIndex: 30, updatedAt: at(10), generation: 2}, progressGeneration: 2}, null, local);
    assert.deepStrictEqual([ahead.progress.pageIndex, ahead.remote, ahead.upload], [60, null, true], 'A newer browser copy wins and is uploaded');

    const remote = readerProgress.opening({progress: {percent: 0.9, sectionId: 'section-12', pageIndex: 90, updatedAt: at(30), generation: 2}, progressGeneration: 2}, null, local);
    assert.deepStrictEqual([remote.progress.pageIndex, remote.remote.pageIndex, remote.upload], [60, 90, false], 'A far newer server position is offered');

    //без места на сервере - сводка профиля (Kobo, другой браузер)
    const profile = readerProgress.opening({progress: {}}, {percent: 0.45, sectionId: 'section-6', pageIndex: 45, updatedAt: at(5)});
    assert.strictEqual(profile.progress.pageIndex, 45);

    //прогресс другого поколения (сброшен на другом устройстве) не в счёт, копия в браузере стирается
    const stale = readerProgress.opening({progress: {percent: 0.3, pageIndex: 30, updatedAt: at(10), generation: 1}, progressGeneration: 2});
    assert.strictEqual(readerProgress.hasPlace(stale.progress), false);
    const reset = readerProgress.opening({progress: {}, progressGeneration: 3}, null, local);
    assert.deepStrictEqual([reset.dropStored, readerProgress.hasPlace(reset.progress), reset.upload], [true, false, false]);
    const resetAt = readerProgress.opening({progress: {percent: 0.2, updatedAt: at(1)}, progressResetAt: at(15)}, null, {percent: 0.5, updatedAt: at(16)});
    assert.deepStrictEqual([resetAt.progress.percent, resetAt.dropStored], [0.5, false], 'Only what was saved before the reset is dropped');
}

//Место в ленте: смещение в тексте книги, поиск фрагмента у той же доли книги, прежнее место без прокрутки
async function testReaderScrollAnchor() {
    const readerScrollAnchor = require('../client/share/readerScrollAnchor');
    const lengths = [5, 0, 10, 3];
    assert.strictEqual(readerScrollAnchor.textOffset(lengths, 2, 4), 9);
    assert.deepStrictEqual(readerScrollAnchor.textPosition(lengths, 9), {index: 2, offset: 4});
    assert.deepStrictEqual(readerScrollAnchor.textPosition(lengths, 5), {index: 2, offset: 0}, 'An empty node is skipped');
    assert.strictEqual(readerScrollAnchor.textPosition(lengths, 18), null);
    assert.strictEqual(readerScrollAnchor.textPosition(lengths, -1), null);
    assert.strictEqual(readerScrollAnchor.textPercent(lengths, 9), 0.5);
    assert.deepStrictEqual(readerScrollAnchor.percentPosition(lengths, 0.5), {index: 2, offset: 4});
    assert.deepStrictEqual(readerScrollAnchor.percentPosition(lengths, 2), {index: 3, offset: 2});

    //узлы стыкуются через пробел, пробелы и регистр не важны; из повторов - ближайший к подсказке
    const texts = ['Глава первая. ', 'Он  шёл\nпо', 'дороге домой.', 'Пауза.', 'Он шёл по дороге домой.'];
    assert.deepStrictEqual(readerScrollAnchor.findText(texts, 'он шёл по дороге домой', 0), {index: 1, offset: 0});
    assert.deepStrictEqual(readerScrollAnchor.findText(texts, 'он шёл по дороге домой', 4), {index: 4, offset: 0});
    assert.deepStrictEqual(readerScrollAnchor.findText(texts, 'шёл по дороге домой и дальше', 0), null, 'A prefix shorter than 24 chars is not trusted');
    assert.deepStrictEqual(readerScrollAnchor.findText(texts, 'дороге домой. Пауза. Он шёл по дороге домой. И ещё', 0), {index: 2, offset: 0});

    //после восстановления и смены размера место прежнее, пока читатель не прокрутил
    const anchor = {mode: 'scroll', textOffset: 120, scrollTop: 5000};
    assert.strictEqual(readerScrollAnchor.keepsPlace(anchor, 5000.4), true);
    assert.strictEqual(readerScrollAnchor.keepsPlace(anchor, 4980), false);
    assert.strictEqual(readerScrollAnchor.keepsPlace(Object.assign({}, anchor, {mode: 'paged'}), 5000), false);
    assert.strictEqual(readerScrollAnchor.keepsPlace({mode: 'scroll', scrollTop: 5000}, 5000), false, 'An anchor without text offset is not kept');
}

//Разбивка не идёт по листу, который ещё не перерисован под высоту страницы из подписи раскладки
async function testReaderPagedStageMustMatchSignature() {
    const readerPaging = require('../client/share/readerPaging');
    //первое открытие на 1366x800: лист ещё минимальной высоты 180, подпись уже считает 611
    assert.strictEqual(readerPaging.isPagedStageCurrent(180, 611), false);
    assert.strictEqual(readerPaging.isPagedStageCurrent(611, 611), true);
    //дробная высота телефона (visualViewport) округляется так же, как в подписи
    assert.strictEqual(readerPaging.isPagedStageCurrent(714, 714.6), true);
    //скрытый или ещё не созданный лист
    assert.strictEqual(readerPaging.isPagedStageCurrent(0, 611), false);
    assert.strictEqual(readerPaging.isPagedStageCurrent(611, 0), false);
}

//Поиск конца куска абзаца с догадкой даёт тот же разрез, что двоичный поиск, при любой догадке
async function testReaderFindLastFitMatchesBinarySearch() {
    const {findLastFit} = require('../client/share/readerPaging');
    const binary = (fits, low, high) => {
        let best = -1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (fits(mid)) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return best;
    };
    for (let low = 1; low <= 3; low += 1) {
        for (let high = low; high <= 12; high += 1) {
            for (let limit = low - 1; limit <= high; limit += 1) {
                const fits = end => end <= limit;
                const expected = binary(fits, low, high);
                for (const guess of [NaN, low - 3, low - 1, low, limit - 1, limit, limit + 1, high, high + 5]) {
                    let calls = 0;
                    const counted = end => { calls += 1; return fits(end); };
                    assert.strictEqual(findLastFit(counted, low, high, guess), expected, `low ${low} high ${high} limit ${limit} guess ${guess}`);
                    if (guess === limit)
                        assert.ok(calls <= 2, 'A right guess costs at most two measurements');
                }
            }
        }
    }
}

module.exports = [
    testReaderFindLastFitMatchesBinarySearch,
    testReaderOpeningProgress,
    testReaderPagedStageMustMatchSignature,
    testReaderProgressMapIsCapped,
    testReaderReadMarkKeepsPlace,
    testReaderRemoteProgressChoice,
    testReaderScrollAnchor,
    testReaderStorageKeepsBackgroundOnceAndForwardProgress,
];
