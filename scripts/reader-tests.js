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

//Копия в браузере: позицию дальше по книге не затирает недостроенная разбивка
async function testReaderStorageKeepsForwardProgress() {
    const readerStorage = require('../client/share/readerStorage');
    const items = new Map();
    global.localStorage = {
        getItem: key => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
    };
    try {
        readerStorage.writePreferences('u1', {theme: 'sepia'});
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

//Позиция в браузере - своя у каждого пользователя: чужая (или общая без пользователя) не открывается и не уходит в профиль
async function testReaderStorageKeepsProgressPerUser() {
    const readerStorage = require('../client/share/readerStorage');
    const items = new Map();
    global.localStorage = {
        getItem: key => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
    };
    try {
        const at = seconds => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
        //общая карта из прежних версий: в ней позиции всех, кто читал в этом браузере
        items.set('inpx.reader.progress.v1', JSON.stringify({progress: {book: {pageIndex: 7, percent: 0.07, updatedAt: at(0)}}}));
        assert.strictEqual(readerStorage.readProgress('u2', 'book'), null);
        assert.strictEqual(readerStorage.readProgress('', 'book').pageIndex, 7);

        readerStorage.writeProgress('u1', 'book', {pageIndex: 50, percent: 0.5, updatedAt: at(1)});
        assert.strictEqual(readerStorage.readProgress('u1', 'book').pageIndex, 50);
        assert.strictEqual(readerStorage.readProgress('u2', 'book'), null);
        assert.strictEqual(readerStorage.readProgress('', 'book').pageIndex, 7, 'A user does not fill the shared map');

        readerStorage.writeProgress('', 'other', {pageIndex: 3, percent: 0.03, updatedAt: at(2)});
        assert.strictEqual(readerStorage.readProgress('', 'other').pageIndex, 3);
        assert.strictEqual(readerStorage.readProgress('u1', 'other'), null);

        //протекция позиции сравнивает только со своей: чужая дальше по книге не мешает записи
        readerStorage.writeProgress('u2', 'book', {pageIndex: 2, percent: 0.02, updatedAt: at(3)}, {protectForward: true});
        assert.strictEqual(readerStorage.readProgress('u2', 'book').pageIndex, 2);
        assert.strictEqual(readerStorage.readProgress('u1', 'book').pageIndex, 50);
    } finally {
        delete global.localStorage;
    }
}

//Отметка «прочитано» - отдельный флаг: место и доля не меняются ни при отметке, ни при снятии
async function testReaderReadMarkKeepsPlace() {
    const readerProgress = require('../client/share/readerProgress');
    const place = {percent: 0.42, sectionId: 'section-7', pageIndex: 84, textOffset: 1200, textSnippet: 'Глава седьмая', updatedAt: 't0', generation: 2};

    const read = readerProgress.markRead(place);
    assert.strictEqual(readerProgress.isRead(read), true);
    assert.deepStrictEqual(read, Object.assign(readerProgress.normalize(place), {read: true}), 'only the flag changes');
    assert.strictEqual(readerProgress.isRead(place), false);
    assert.strictEqual(readerProgress.isRead({percent: 1}), false, 'percent alone is not a read mark');

    const unread = readerProgress.unmarkRead(read);
    assert.deepStrictEqual(unread, Object.assign(readerProgress.normalize(place), {read: false}));
    assert.strictEqual(readerProgress.isRead(unread), false);

    //книга без места: отметка не создаёт его
    assert.strictEqual(readerProgress.hasPlace(readerProgress.markRead({}, 3)), false);
    assert.strictEqual(readerProgress.markRead({}, 3).generation, 3);

    //отметку при открытии берём с сервера: копия в браузере могла её не застать
    const opened = readerProgress.opening({progress: Object.assign({}, place, {read: true}), progressGeneration: 2}, null,
        Object.assign({}, place, {pageIndex: 85, read: false}));
    assert.deepStrictEqual([opened.progress.read, opened.progress.percent], [true, 0.42]);
}

//Чтение до 95% ставит отметку только переходом снизу, как на сервере (shared/readMark.js)
async function testReaderReadMarkCrossing() {
    const readerProgress = require('../client/share/readerProgress');
    const {READ_AUTO_PERCENT, reachesReadMark} = require('../shared/readMark');
    assert.strictEqual(READ_AUTO_PERCENT, 0.95);
    assert.deepStrictEqual([reachesReadMark(0.94, 0.95), reachesReadMark(0.3, 0.98), reachesReadMark(0.96, 0.97), reachesReadMark(0.5, 0.94)],
        [true, true, false, false]);

    const progress = {percent: 0.9, pageIndex: 90, read: false};
    const finished = readerProgress.withPercent(progress, 0.96);
    assert.deepStrictEqual([finished.percent, finished.read, finished.pageIndex], [0.96, true, 90]);
    assert.strictEqual(readerProgress.withPercent(finished, 0.5).read, true, 'going back keeps the mark');
    const unmarked = readerProgress.unmarkRead(finished);
    assert.strictEqual(readerProgress.withPercent(unmarked, 0.99).read, false, 'no new mark above the threshold after an unmark');
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

//Ответ на сохранение: более новую позицию с другого устройства не затираем, force - только если сервер оставил старее
async function testReaderSaveOutcome() {
    const readerProgress = require('../client/share/readerProgress');
    const at = minutes => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
    const sent = {percent: 0.2, sectionId: 'section-3', pageIndex: 20, updatedAt: at(10)};
    const other = {percent: 0.63, sectionId: 'section-9', pageIndex: 63};

    assert.strictEqual(readerProgress.saveOutcome(sent, Object.assign({}, sent, {updatedAt: at(11)})), 'saved');
    assert.strictEqual(readerProgress.saveOutcome(sent, Object.assign({updatedAt: at(30)}, other)), 'remote', 'A newer position is not forced over');
    assert.strictEqual(readerProgress.saveOutcome(sent, Object.assign({updatedAt: at(5)}, other)), 'force');
    assert.strictEqual(readerProgress.saveOutcome(sent, Object.assign({updatedAt: at(10)}, other)), 'keep');

    //без времени - не force: решает chooseRemote, а там позиция со временем новее
    assert.strictEqual(readerProgress.saveOutcome(sent, Object.assign({updatedAt: 'broken'}, other)), 'remote');
    assert.strictEqual(readerProgress.saveOutcome(Object.assign({}, sent, {updatedAt: ''}), Object.assign({updatedAt: at(5)}, other)), 'remote');
    assert.strictEqual(readerProgress.saveOutcome(sent, {}), 'remote');
    assert.strictEqual(readerProgress.chooseRemote(sent, Object.assign({updatedAt: ''}, other)).remote, null);
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

//Запасная разбивка абзаца не теряет текст: короткое начало перед длинным предложением раньше пропадало
async function testReaderFallbackChunksKeepText() {
    const {splitTextIntoReadableChunks} = require('../client/share/readerPaging');
    const cases = [
        'Да. ' + 'а'.repeat(417) + '. Конец.',
        'Да. ' + 'б'.repeat(500) + '. Нет.',
        'Раз. Два. Три. ' + 'в '.repeat(400),
        Array.from({length: 40}, (_, i) => `Предложение номер ${i}.`).join(' '),
    ];
    for (const text of cases) {
        for (const [target, min] of [[420, 140], [220, 90]]) {
            const chunks = splitTextIntoReadableChunks(text, target, min);
            assert.strictEqual(chunks.join(' '), text.replace(/\s+/g, ' ').trim(), `${text.slice(0, 20)} at ${target}`);
        }
    }
}

//Абзац, разрезанный на странице, склеивается с пробелами только там, где они были
async function testReaderInlineTokensKeepSpacing() {
    const {joinInlineTokens} = require('../client/share/readerPaging');
    const tokens = [
        {html: 'сказал', gap: false}, {html: '<em>он</em>', gap: true}, {html: '.', gap: false},
        {html: '<strong>Г</strong>', gap: true}, {html: 'лава', gap: false},
    ];
    assert.strictEqual(joinInlineTokens(tokens), 'сказал <em>он</em>. <strong>Г</strong>лава');
    //слова без разметки (gap не задан) разделяются пробелами, как раньше
    assert.strictEqual(joinInlineTokens([{html: 'a'}, {html: 'b'}]), 'a b');
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

//Книга открывается на готовых страницах, только если оставшиеся страницы не дадут другой ответ поиска
async function testReaderPartialPagesRestoreOnlyFinalMatch() {
    const {isSnippetMatchFinal} = require('../client/share/readerPaging');
    //все совпадения фрагмента в книге из 10 страниц и место, сохранённое на странице preferred
    const search = (matches, preferred, count) => {
        let best = -1;
        let bestDistance = Infinity;
        for (const index of matches.filter(item => item < count)) {
            const distance = (preferred >= 0 ? Math.abs(index - preferred) : 0);
            if (best < 0 || distance < bestDistance) {
                best = index;
                bestDistance = distance;
            }
        }
        return {best, bestDistance};
    };
    const cases = [[[3], 5], [[1, 6], 5], [[1, 9], 5], [[4, 6], 5], [[2, 8], -1], [[0, 7], 3], [[], 2]];
    for (const [matches, preferred] of cases) {
        const final = search(matches, preferred, 10).best;
        for (let count = 1; count <= 10; count += 1) {
            const partial = search(matches, preferred, count);
            if (isSnippetMatchFinal(count, preferred, partial.best, partial.bestDistance))
                assert.strictEqual(partial.best, final, `matches ${matches} preferred ${preferred} count ${count}`);
        }
        if (final >= 0)
            assert.ok(isSnippetMatchFinal(10, preferred, final, search(matches, preferred, 10).bestDistance));
    }
    //место на 5-й странице, фрагмент найден на 1-й: ждём, пока не станет ясно, что на 6-9 его нет ближе
    assert.strictEqual(isSnippetMatchFinal(6, 5, 1, 4), false);
    assert.strictEqual(isSnippetMatchFinal(9, 5, 1, 4), true);
}

module.exports = [
    testReaderFindLastFitMatchesBinarySearch,
    testReaderFallbackChunksKeepText,
    testReaderInlineTokensKeepSpacing,
    testReaderPartialPagesRestoreOnlyFinalMatch,
    testReaderOpeningProgress,
    testReaderPagedStageMustMatchSignature,
    testReaderProgressMapIsCapped,
    testReaderReadMarkKeepsPlace,
    testReaderReadMarkCrossing,
    testReaderStorageKeepsProgressPerUser,
    testReaderRemoteProgressChoice,
    testReaderSaveOutcome,
    testReaderScrollAnchor,
    testReaderStorageKeepsForwardProgress,
];
