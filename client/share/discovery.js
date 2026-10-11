//Витрины: подписи «почему рекомендуем» и отзывы на рекомендации.
import {t, tm} from './i18n';
import {genreName, bookGenres} from './genres';

const sensitiveGenre = /(?:erotic|erotica|sex|adult|porn|hentai|bdsm|18\+|эрот|секс|порн|интим)/i;//i18n-ignore: фильтр по названиям жанров
const genreReasons = new Set(['discovery.reason.chosenGenre', 'discovery.reason.similarGenres']);

//Книга из внешней витрины, которой нет в библиотеке: ведёт на сайт источника
export function isExternalOnly(book = {}) {
    return book.discoveryMissingLocal === true;
}

//Причина рекомендации для показа: описания {key, params} с сервера переводятся здесь;
//для книг деликатных жанров - нейтральная формулировка
export function discoveryReason(book = {}) {
    const reasons = (Array.isArray(book.discoveryReasons) ? book.discoveryReasons : []);
    const sensitive = bookGenres(book).some(code => sensitiveGenre.test(`${code} ${genreName(code)}`));
    const result = reasons
        .map(reason => (sensitive && reason && genreReasons.has(reason.key) ? t('discovery.reason.readingInterests') : tm(reason)))
        .filter(Boolean);
    return [...new Set(result)].join(' · ');
}

export function feedbackOptions() {
    return [
        {kind: 'not_interested', label: t('common.notInterested'), icon: 'la la-eye-slash'},
        {kind: 'more_like_this', label: t('discovery.moreLikeThis'), icon: 'la la-thumbs-up'},
        {kind: 'dislike_author', label: t('book.dislikeAuthor'), icon: 'la la-user-slash'},
        {kind: 'dislike_genre', label: t('book.dislikeGenre'), icon: 'la la-tags'},
        {kind: 'already_read', label: t('discovery.alreadyRead'), icon: 'la la-check'},
        {kind: 'ignore_for_taste', label: t('discovery.dontUseForTastes'), icon: 'la la-balance-scale'},
    ];
}

export function feedbackMessage(kind) {
    const messages = {
        more_like_this: t('search.weShowMoreSimilar'),
        dislike_author: t('search.authorAppearLessOften'),
        dislike_genre: t('search.genreAppearLessOften'),
        already_read: t('search.bookRemovedRecommendations'),
        ignore_for_taste: t('search.bookNoLongerAffects'),
        not_interested: t('search.bookHiddenPersonalShowcases'),
    };
    return messages[kind] || messages.not_interested;
}
