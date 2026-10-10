//Вид списков книг: обложки, карточки с подробностями или строки. Один выбор на все страницы.
import {t} from './i18n';

export const bookViews = ['covers', 'cards', 'list'];

export function bookView(settings = {}) {
    const value = String(settings.bookView || '');
    return (bookViews.includes(value) ? value : 'covers');
}

export function bookViewOptions() {
    return [
        {icon: 'la la-th', value: 'covers', attrs: {'aria-label': t('Обложками'), title: t('Обложками')}},
        {icon: 'la la-th-large', value: 'cards', attrs: {'aria-label': t('Карточками'), title: t('Карточками')}},
        {icon: 'la la-list', value: 'list', attrs: {'aria-label': t('Списком'), title: t('Списком')}},
    ];
}
