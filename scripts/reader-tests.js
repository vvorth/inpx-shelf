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

module.exports = [
    testReaderProgressMapIsCapped,
    testReaderStorageKeepsBackgroundOnceAndForwardProgress,
];
