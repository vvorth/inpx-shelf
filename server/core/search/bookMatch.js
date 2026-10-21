//Одна и та же книга в другой библиотеке (или после правки INPX) получает другой _uid: он считается по всей строке INPX.
//Списки, прогресс и закладки хранят заметку о книге (название, автор, язык, серия, дата, libid): по ней пропавшая книга
//показывается в списках и по ней ищутся возможные замены среди книг включённых библиотек.
const {normalize} = require('./textNorm');
const {sameAuthor, sameWorkAuthor} = require('./WorkTitles');

function bookNote(book = {}) {
    return {
        title: String(book.title || ''), author: String(book.author || ''), lang: String(book.lang || '').trim().toLowerCase(),
        series: String(book.series || ''), serno: Number(book.serno) || 0, date: String(book.date || ''), libid: String(book.libid || ''),
        sourceId: String(book.sourceId || ''),
    };
}

//фамилия и имя первого автора: отчество в разных библиотеках то есть, то нет
function firstAuthor(author = '') {
    return normalize(String(author).split(',')[0]).split(' ').slice(0, 2).join(' ');
}

//Признаки по важности: у кандидата, совпавшего по более важному, место выше; дальше - по наименьшему libid
const steps = [
    (note, book) => book.libid === note.libid,
    //то же название выше перевода под другим названием
    (note, book) => normalize(book.title) === normalize(note.title),
    (note, book) => String(book.lang || '').trim().toLowerCase() === note.lang,
    (note, book) => normalize(book.series) === normalize(note.series) && (Number(book.serno) || 0) === note.serno,
    (note, book) => book.date === note.date,
];

//Возможные замены пропавшей книги: все записи с тем же названием и первым автором, лучшие совпадения первыми.
//Ничего не отбрасывается и не выбирается само: замену выбирает читатель.
//candidates - записи с нормализованным названием из названий книги; work - то же произведение по Wikidata
//(WorkTitles.sameWork): его названия на других языках и авторы, под чьими именами книга может быть записана
function rankReplacements(note = {}, candidates = [], work = {}) {
    const author = firstAuthor(note.author);
    const title = normalize(note.title);
    if (!author || !title)
        return [];

    const titles = new Set([title, ...(work.titles || [])]);
    const workAuthors = work.authors || [];
    //порядок слов имени в библиотеках разный: «Конан Дойль Артур» и «Дойль Артур Конан»
    const noteFirst = String(note.author).split(',')[0];
    const byAuthor = book => firstAuthor(book.author) === author
        || sameAuthor(book.author, noteFirst) || sameAuthor(noteFirst, String(book.author).split(',')[0])
        || workAuthors.some(name => sameWorkAuthor(book.author, name));
    const score = book => steps.reduce((total, step, index) => total + (step(note, book) ? 1 << (steps.length - 1 - index) : 0), 0);
    return candidates
        .filter(book => book && titles.has(normalize(book.title)) && byAuthor(book))
        .map(book => ({book, score: score(book)}))
        .sort((a, b) => (b.score - a.score) || (Number(a.book.libid) || 0) - (Number(b.book.libid) || 0) || String(a.book._uid).localeCompare(String(b.book._uid)))
        .map(item => item.book);
}

module.exports = {bookNote, rankReplacements, normalizeTitle: normalize};
