//Одна и та же книга в другой библиотеке (или после правки INPX) получает другой _uid: он считается по всей строке INPX.
//Списки, прогресс и закладки хранят заметку о книге (название, автор, язык, серия, дата, libid) и по ней находят
//ту же книгу среди записей текущей библиотеки.
const {normalize} = require('./textNorm');

function bookNote(book = {}) {
    return {
        title: String(book.title || ''), author: String(book.author || ''), lang: String(book.lang || '').trim().toLowerCase(),
        series: String(book.series || ''), serno: Number(book.serno) || 0, date: String(book.date || ''), libid: String(book.libid || ''),
    };
}

//фамилия и имя первого автора: отчество в разных библиотеках то есть, то нет
function firstAuthor(author = '') {
    return normalize(String(author).split(',')[0]).split(' ').slice(0, 2).join(' ');
}

//Шаги сужают выбор, только если кто-то из кандидатов совпал; оставшиеся после всех шагов - копии одного текста,
//из них берётся запись с наименьшим libid, чтобы выбор не менялся от раза к разу.
const steps = [
    (note, book) => book.libid === note.libid,
    (note, book) => String(book.lang || '').trim().toLowerCase() === note.lang,
    (note, book) => normalize(book.series) === normalize(note.series) && (Number(book.serno) || 0) === note.serno,
    (note, book) => book.date === note.date,
];

//candidates - записи с тем же нормализованным названием; null - книги в библиотеке нет
function matchBook(note = {}, candidates = []) {
    const author = firstAuthor(note.author);
    const title = normalize(note.title);
    if (!author || !title)
        return null;

    let found = candidates.filter(book => book && normalize(book.title) === title && firstAuthor(book.author) === author);
    for (const step of steps) {
        if (found.length < 2)
            break;
        const narrowed = found.filter(book => step(note, book));
        if (narrowed.length)
            found = narrowed;
    }
    if (found.length < 2)
        return found[0] || null;

    return found.slice().sort((a, b) => (Number(a.libid) || 0) - (Number(b.libid) || 0) || String(a._uid).localeCompare(String(b._uid)))[0];
}

module.exports = {bookNote, matchBook, normalizeTitle: normalize};
