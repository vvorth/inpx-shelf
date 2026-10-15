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

module.exports = [
    testReaderProgressMapIsCapped,
    testReaderReadMarkKeepsPlace,
    testReaderRemoteProgressChoice,
    testReaderStorageKeepsBackgroundOnceAndForwardProgress,
];
