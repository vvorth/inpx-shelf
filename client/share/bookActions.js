//Действия с книгой (скачать, читать, отправить, ссылка) - общие для каталога и страницы книги.
//vm - любой компонент: нужны vm.$root.api, vm.$root.notify, vm.$root.stdDialog, vm.$router, vm.$store.
import axios from 'axios';

import * as utils from './utils';
import {t, tHtml} from './i18n';

const defaultConversionFormats = ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf'];

export function bookUid(book = {}) {
    return String(book._uid || book.bookUid || '').trim();
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

async function errorMessage(error) {
    if (error.response && error.response.data) {
        const responseData = error.response.data;
        if (typeof(responseData) === 'string')
            return responseData;

        if (responseData && typeof(responseData.text) === 'function') {
            try {
                return await responseData.text();
            } catch(e) {
                // ignore
            }
        }
    }

    return error.message;
}

//options.liberamaReady / options.submitUrl - встраивание в liberama, только для каталога
export async function runBookAction(vm, book, action, format = '', options = {}) {
    const root = vm.$root;
    const api = root.api;
    const config = vm.$store.state.config;
    const settings = vm.$store.state.settings;

    if (format && config.conversionEnabled === false) {
        root.stdDialog.alert(t('Конвертация книг отключена в текущем образе.'), t('Информация'));
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
            root.notify.success(`${t('Книга отправлена в Telegram')}${format ? ` (${format.toUpperCase()})` : ''}`);
            return null;
        }

        if (action == 'sendEmail') {
            await api.sendBookEmail(bookUid(book), format);
            root.notify.success(`${t('Книга отправлена на email')}${format ? ` (${format.toUpperCase()})` : ''}`);
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
            await axios.head(href);
        }

        if (format)
            href += `/${format}`;

        if (action == 'copyLink') {
            if (await utils.copyTextToClipboard(href))
                root.notify.success(t('Ссылка успешно скопирована'));
            else
                root.stdDialog.alert(tHtml('copyLinkFailed',
`Копирование ссылки не удалось. Пожалуйста, попробуйте еще раз.
<br><br>
<b>Пояснение</b>: вероятно, браузер запретил копирование, т.к. прошло<br>
слишком много времени с момента нажатия на кнопку (инициация<br>
пользовательского события). Сейчас ссылка уже закеширована,<br>
поэтому повторная попытка должна быть успешной.`), t('Ошибка'));
        } else if (action == 'readBook') {
            if (options.liberamaReady && options.submitUrl) {
                options.submitUrl(href);
                return null;
            }

            const bookReadLink = config.bookReadLink;
            if (!bookReadLink) {
                root.stdDialog.alert(t('Встроенная читалка пока поддерживает только FB2.'), t('Информация'));
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
        root.stdDialog.alert(await errorMessage(e), t('Ошибка'));
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
        vm.$root.notify.success(read ? t('Помечено прочитанными: {n}', {n: count}) : t('Отметка снята: {n}', {n: count}));
        return true;
    } catch (e) {
        vm.$root.stdDialog.alert(e.message, t('Ошибка'));
        return false;
    }
}

//Авторы книги из поля INPX "Фамилия Имя Отчество,Соавтор"
export function bookAuthors(book = {}) {
    return String(book.author || '').split(',').map(name => name.trim()).filter(Boolean);
}
