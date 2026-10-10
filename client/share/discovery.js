//Витрины: подписи «почему рекомендуем» и отзывы на рекомендации.
import {t, tMessage} from './i18n';
import {genreName, bookGenres} from './genres';

const sensitiveGenre = /(?:erotic|erotica|sex|adult|porn|hentai|bdsm|18\+|эрот|секс|порн|интим)/i;
const activityCounter = /^(?:В чтении|В списках|Прочитано):\s*\d+$/i;

//Книга из внешней витрины, которой нет в библиотеке: ведёт на сайт источника
export function isExternalOnly(book = {}) {
    return book.discoveryMissingLocal === true;
}

//Причина рекомендации для показа: без счётчиков активности и без названий чужих списков;
//для книг деликатных жанров - нейтральная формулировка
export function discoveryReason(book = {}) {
    const raw = String(book.discoveryReason || '').trim();
    if (!raw)
        return '';

    const codes = bookGenres(book);
    const sensitive = codes.some(code => sensitiveGenre.test(`${code} ${genreName(code)}`));
    const parts = raw.split(/\s+·\s+/).map(part => part.trim()).filter(Boolean);
    const hadCounters = parts.some(part => activityCounter.test(part));
    let result = parts
        .filter(part => !activityCounter.test(part))
        .map((part) => {
            if (/^Из списка «[^»]+»/i.test(part))
                return t('На основе вашей библиотеки');
            if (sensitive && /^(?:Вы выбрали жанр|Похожие жанры):/i.test(part))
                return t('Учитывает ваши читательские интересы');
            return tMessage(part);
        });
    if (hadCounters)
        result.unshift(t('Популярно у читателей'));
    result = [...new Set(result)].join(' · ');

    if (!sensitive) {
        for (const code of codes) {
            const label = genreName(code);
            if (label && label !== code)
                result = result.replace(new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), label);
        }
    }
    return result;
}

export function feedbackOptions() {
    return [
        {kind: 'not_interested', label: t('Неинтересно'), icon: 'la la-eye-slash'},
        {kind: 'more_like_this', label: t('Больше похожих'), icon: 'la la-thumbs-up'},
        {kind: 'dislike_author', label: t('Не люблю этого автора'), icon: 'la la-user-slash'},
        {kind: 'dislike_genre', label: t('Не мой жанр'), icon: 'la la-tags'},
        {kind: 'already_read', label: t('Уже читал(а)'), icon: 'la la-check'},
        {kind: 'ignore_for_taste', label: t('Не учитывать во вкусах'), icon: 'la la-balance-scale'},
    ];
}

export function feedbackMessage(kind) {
    const messages = {
        more_like_this: t('Будем показывать больше похожих книг.'),
        dislike_author: t('Автор будет реже появляться в рекомендациях.'),
        dislike_genre: t('Этот жанр будет реже появляться в рекомендациях.'),
        already_read: t('Книга убрана из рекомендаций.'),
        ignore_for_taste: t('Книга больше не влияет на ваши вкусы и остаётся доступной в библиотеке.'),
        not_interested: t('Книга скрыта из персональных витрин.'),
    };
    return messages[kind] || messages.not_interested;
}
