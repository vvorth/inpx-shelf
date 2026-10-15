//Действия с книгой (скачать, читать, отправить, ссылка) - общие для каталога и страницы книги.
//vm - любой компонент: нужны vm.$root.api, vm.$root.notify, vm.$root.stdDialog, vm.$router, vm.$store.

import * as utils from './utils';
import {t} from './i18n';
import readerStorage from './readerStorage';

const defaultConversionFormats = ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf'];

export function bookUid(book = {}) {
    return String(book._uid || book.bookUid || '').trim();
}

//адреса страниц книги, автора и серии
export function bookRoute(book = {}) {
    return `/book/${encodeURIComponent(bookUid(book))}`;
}

export function authorRoute(name = '') {
    return `/author/${encodeURIComponent(name || '')}`;
}

export function seriesRoute(name = '') {
    return `/series/${encodeURIComponent(name || '')}`;
}

//отметки книг (прочитано, прогресс, в списке): {_uid: state}; null, если сервер не ответил
export async function loadBookStates(api, books = []) {
    const uids = [...new Set(books.map(bookUid).filter(Boolean))];
    if (!uids.length)
        return {};
    try {
        const result = await api.getBookStates(uids);
        return (result && result.states) || {};
    } catch (e) {
        return null;
    }
}

//библиотека книги - только если их подключено несколько: с одной библиотекой это лишний текст
export function librarySourceName(config = {}, book = {}) {
    const sources = (Array.isArray(config.librarySources) ? config.librarySources : []).filter(item => item.enabled !== false);
    if (sources.length < 2 || !book.sourceId)
        return '';
    const source = sources.find(item => item.id === book.sourceId);
    return (source ? source.name : book.sourceId);
}

export function conversionFormats(config = {}, book = {}) {
    if (config.conversionEnabled === false)
        return [];

    const formats = (Array.isArray(config.conversionFormats) ? config.conversionFormats : defaultConversionFormats)
        .map(format => String(format || '').toLowerCase())
        .filter(Boolean);
    const ext = String(book.ext || '').toLowerCase();
    if (ext === 'fb2')
        return formats;
    if (ext === 'epub')
        return formats.filter(format => format === 'pdf');
    return [];
}

export function coverUrl(config = {}, book = {}) {
    if (book.discoveryCoverUrl)
        return book.discoveryCoverUrl;

    const root = config.rootPathStatic || '';
    const uid = bookUid(book);
    if (uid)
        return `${root}/cover/by-uid?uid=${encodeURIComponent(uid)}`;
    return '';
}

export function directDownloadHref(config = {}, settings = {}, book = {}, format = '') {
    const root = String(config.rootPathStatic || '').replace(/\/$/, '');
    const params = new URLSearchParams();
    params.set('uid', bookUid(book));
    if (format)
        params.set('format', format);
    else if (settings.downloadAsZip)
        params.set('zip', '1');

    return `${window.location.origin}${root}/book/by-uid?${params.toString()}`;
}

export function canReadOnline(config = {}, book = {}) {
    return !!(config.onlineReaderEnabled && String(book.ext || '').toLowerCase() === 'fb2');
}

//options.liberamaReady / options.submitUrl - встраивание в liberama, только для каталога
export async function runBookAction(vm, book, action, format = '', options = {}) {
    const root = vm.$root;
    const api = root.api;
    const config = vm.$store.state.config;
    const settings = vm.$store.state.settings;

    if (format && config.conversionEnabled === false) {
        root.stdDialog.alert(t('list.bookConversionDisabledImage'), t('common.information'));
        return null;
    }

    try {
        if (action == 'bookInfo' || action == 'authorInfo') {
            const response = await api.getBookInfo(bookUid(book));
            if (response.bookInfo && response.bookInfo.book && response.bookInfo.book.size > 0)
                book.size = response.bookInfo.book.size;
            return response.bookInfo;
        }

        if (action == 'sendTelegram') {
            await api.sendBookTelegram(bookUid(book), format);
            root.notify.success(`${t('list.bookSentTelegram')}${format ? ` (${format.toUpperCase()})` : ''}`);
            return null;
        }

        if (action == 'sendEmail') {
            await api.sendBookEmail(bookUid(book), format);
            root.notify.success(`${t('list.bookSentEmail')}${format ? ` (${format.toUpperCase()})` : ''}`);
            return null;
        }

        if (action == 'download') {
            window.location.href = directDownloadHref(config, settings, book, format);
            return null;
        }

        if (action == 'readBook' && canReadOnline(config, book)) {
            vm.$router.push({path: '/reader', query: {bookUid: bookUid(book)}});
            return null;
        }

        //подготовка
        const response = await api.getBookLink(bookUid(book));
        let href = `${window.location.origin}${response.link}`;

        //downloadAsZip
        if (settings.downloadAsZip && !format && action == 'copyLink') {
            href += '/zip';
            //подождем формирования zip-файла
            const zipResponse = await fetch(href, {method: 'HEAD'});
            if (!zipResponse.ok)
                throw new Error(`HTTP ${zipResponse.status} ${zipResponse.statusText}`.trim());
        }

        if (format)
            href += `/${format}`;

        if (action == 'copyLink') {
            if (await utils.copyTextToClipboard(href))
                root.notify.success(t('list.linkCopied'));
            else
                root.stdDialog.alert(t('list.copyLinkFailedHtml'), t('common.error'), {html: true});
        } else if (action == 'readBook') {
            if (options.liberamaReady && options.submitUrl) {
                options.submitUrl(href);
                return null;
            }

            const bookReadLink = config.bookReadLink;
            if (!bookReadLink) {
                root.stdDialog.alert(t('common.builtReaderCurrentlySupports'), t('common.information'));
                return null;
            }

            let url = bookReadLink;
            if (bookReadLink.indexOf('${DOWNLOAD_LINK}') >= 0) {
                url = bookReadLink.replace('${DOWNLOAD_LINK}', href);
            } else if (bookReadLink.indexOf('${DOWNLOAD_URI}') >= 0) {
                const hrefUrl = new URL(href);
                url = bookReadLink.replace('${DOWNLOAD_URI}', hrefUrl.pathname + hrefUrl.search + hrefUrl.hash);
            }

            window.open(url, '_blank');
        }
    } catch(e) {
        root.stdDialog.alert(e.message, t('common.error'));
    }

    return null;
}

export async function markBooksRead(vm, bookUids = [], read = true) {
    const normalized = Array.from(new Set((Array.isArray(bookUids) ? bookUids : [bookUids])
        .map(uid => String(uid || '').trim())
        .filter(Boolean)));
    if (!normalized.length)
        return false;

    try {
        const result = await vm.$root.api.markReaderBooksRead(normalized, read);
        const count = (result && result.changedBooks) || normalized.length;
        vm.$root.notify.success(read ? t('list.markedRead', {n: count}) : t('common.unmarked', {n: count}));
        return true;
    } catch (e) {
        vm.$root.stdDialog.alert(e.message, t('common.error'));
        return false;
    }
}

//«Забыть» книги: из профиля уходит всё о них - прогресс, закладки, история, места в своих списках.
//books - [{bookUid, title}]; confirmOptions - вид окна подтверждения (у читалки свой)
export async function forgetBooks(vm, books = [], confirmOptions = {}) {
    const uids = Array.from(new Set(books.map(book => String(book.bookUid || book._uid || '').trim()).filter(Boolean)));
    if (!uids.length)
        return false;

    const question = (uids.length === 1
        ? t('reader.forgetBookConfirm', {title: books[0].title || t('common.untitled')})
        : t('reader.forgetBooksConfirm', {n: uids.length}));
    if (!await vm.$root.stdDialog.confirm(question, t('reader.forgetBook'), confirmOptions))
        return false;

    try {
        await vm.$root.api.forgetBooks(uids);
        const {settings, config} = vm.$store.state;
        const userId = String(settings.currentUserId || config.currentUserId || '').trim();
        for (const uid of uids)
            readerStorage.clearProgress(userId, uid);
        vm.$root.notify.success(t('reader.forgetSuccess', {n: uids.length}));
        return true;
    } catch (e) {
        vm.$root.stdDialog.alert(e.message, t('common.error'));
        return false;
    }
}

//Авторы книги из поля INPX "Фамилия Имя Отчество,Соавтор"
export function bookAuthors(book = {}) {
    return String(book.author || '').split(',').map(name => name.trim()).filter(Boolean);
}
