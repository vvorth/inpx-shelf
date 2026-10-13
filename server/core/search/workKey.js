//Ключ произведения: издания одной книги в поиске (флажок «Скрыть копии») показываются одной карточкой.
//Совпадают название (без пометки в скобках в конце: «(роман)», «(сборник)»), набор авторов (фамилия и имя), язык,
//серия и номер в серии; регистр, ё/е и пунктуация не важны. Считается при построении БД библиотеки.
const {normalize} = require('./textNorm');

//под такими названиями у одного автора выходят разные сборники: их не объединяем, с томами и без
const genericTitles = new Set([
    'стихотворения', 'стихи', 'рассказы', 'повести', 'повести и рассказы', 'рассказы и повести', 'избранное', 'избранные произведения',//i18n-ignore: данные поиска
    'сборник', 'сочинения', 'собрание сочинений', 'полное собрание сочинений', 'пьесы', 'статьи', 'письма', 'дневники', 'сказки', 'поэмы',//i18n-ignore: данные поиска
    'poems', 'selected poems', 'stories', 'short stories', 'collected stories', 'selected works', 'collected works', 'complete works',
    'essays', 'letters', 'diaries', 'plays',
]);
//слова и номера томов: «Собрание сочинений. Том 3», «в 5 томах», «Т. 2», «Vol. II»
const volumeWord = /^(\d+|[ivxlc]+|в|том|тома|томах|т|книга|кн|часть|ч|выпуск|вып|volume|vol|book|part)$/;//i18n-ignore: данные поиска

function isGenericTitle(title) {
    return genericTitles.has(title.split(' ').filter(word => !volumeWord.test(word)).join(' '));
}

//null - книга без названия или автора и сборник с общим названием ни с чем не объединяются
function workKey(book = {}) {
    const title = normalize(String(book.title || '').replace(/\s*\([^()]*\)\s*$/, ''));
    const authors = String(book.author || '').split(',')
        .map(name => normalize(name).split(' ').slice(0, 2).join(' '))
        .filter(Boolean);
    if (!title || !authors.length || isGenericTitle(title))
        return null;

    return [
        [...new Set(authors)].sort().join('|'), title, String(book.lang || '').trim().toLowerCase(),
        normalize(book.series), (book.series ? Number(book.serno) || 0 : 0),
    ].join('\t');
}

module.exports = {workKey};
