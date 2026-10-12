// Текст из HTML библиотеки (справки об авторах) и нормализация имён авторов для сравнения

function stripHtml(html) {
    return (html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAuthorText(value) {
    return stripHtml(value)
        .toLowerCase()
        .replace(/ё/g, 'е')//i18n-ignore: нормализация
        .replace(/[()[\]{}.,;:!?'"`«»]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {stripHtml, normalizeAuthorText};
