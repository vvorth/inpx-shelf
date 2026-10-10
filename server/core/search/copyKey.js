//Ключ «одной и той же книги» для режима «Скрыть копии»: автор (фамилия и имя) + название.
//Общий для старого поиска (DbSearcher) и индекса каталога.

function normalizeCopyKeyPart(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function authorCopyKey(value) {
    return normalizeCopyKeyPart(value)
        .split(/[;,\n]/)
        .map(author => author.trim().split(/\s+/).slice(0, 2).join(' '))
        .filter(Boolean)
        .join('|');
}

function copyKey(book = {}) {
    const title = normalizeCopyKeyPart(book.title);
    const author = authorCopyKey(book.author);

    if (title && author)
        return `copy:${author}|${title}`;
    if (title)
        return `copy-title:${title}`;

    return [
        'fallback',
        book.author || '',
        book.series || '',
        String(book.serno || 0),
        book.title || '',
    ].map(value => normalizeCopyKeyPart(value)).join('|');
}

module.exports = {normalizeCopyKeyPart, authorCopyKey, copyKey};
