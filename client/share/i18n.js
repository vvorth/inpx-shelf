import { reactive } from 'vue';

import i18n from '../../shared/i18nEngine.js';

//Тексты интерфейса - в shared/locales/<lang>.json, в коде только ключи: t('settings.darkTheme').
//Язык хранится в реактивном состоянии, поэтому шаблоны и вычисляемые свойства перерисовываются при смене языка.
const locales = {ru: 'ru-RU', en: 'en-US'};
const ruFamily = new Set(['ru', 'uk', 'be', 'kk']);
const langCookie = 'inpx_lang';

const state = reactive({lang: i18n.fallbackLang, isoDates: true});
const localeLoads = {};
let requestedLang = '';

export function detectLang() {
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    for (const value of langs) {
        const code = String(value || '').toLowerCase().split('-')[0];
        if (ruFamily.has(code))
            return 'ru';
        if (i18n.normalizeLang(code))
            return code;
    }
    return i18n.fallbackLang;
}

export function resolveLang(value) {
    return i18n.normalizeLang(value) || detectLang();
}

//Словарь языка - отдельный кусок сборки: второй язык не загружается, пока его не выберут
function loadLocale(lang) {
    if (!localeLoads[lang]) {
        localeLoads[lang] = import(`../../shared/locales/${lang}.json`)
            .then(module => i18n.addLocale(lang, module.default))
            .catch((error) => {
                delete localeLoads[lang];
                throw error;
            });
    }
    return localeLoads[lang];
}

//Язык меняется, когда его словарь загружен; если загрузить не удалось, остаётся прежний
//(следующий вызов попробует снова). Возвращает действующий язык.
export async function setLang(value) {
    const lang = resolveLang(value);
    requestedLang = lang;
    try {
        await loadLocale(lang);
    } catch (e) {
        return state.lang;
    }
    //пока словарь загружался, могли выбрать другой язык
    if (requestedLang !== lang)
        return state.lang;

    state.lang = lang;
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('lang', state.lang);
        //язык нужен и серверу для HTTP-ответов (например, ошибок скачивания)
        document.cookie = `${langCookie}=${state.lang}; path=/; max-age=31536000; SameSite=Lax`;
    }
    return state.lang;
}

export function getLang() {
    return state.lang;
}

export function getLocale() {
    return locales[state.lang] || locales[i18n.fallbackLang];
}

export function setIsoDates(value) {
    state.isoDates = (value !== false);
}

//Дата и время: по умолчанию ISO и 24 часа (2026-10-08 14:25), иначе региональный формат браузера
//(а не языка интерфейса: английский интерфейс не означает американский формат).
//Из options берётся состав (дата, время, секунды) и часовой пояс.
export function formatDateTime(value, options = {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) {
    const date = (value instanceof Date ? value : new Date(Number(value) || value));
    if (Number.isNaN(date.getTime()))
        return '';
    if (!state.isoDates)
        return date.toLocaleString(undefined, options);

    const parts = {};
    const format = new Intl.DateTimeFormat('en-US', {timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    for (const part of format.formatToParts(date))
        parts[part.type] = part.value;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}${options.second ? `:${parts.second}` : ''}`;
    if (!options.hour)
        return day;
    return (options.day || options.month ? `${day} ${time}` : time);
}

export function t(key, params) {
    return i18n.translate(state.lang, key, params);
}

//Помечает ключ перевода в константах уровня модуля, которые вычисляются до выбора языка;
//переводить такие ключи нужно при выводе через t().
export function tk(key) {
    return key;
}

//Текст, пришедший с сервера: описание сообщения {key, params, fallback} (витрины, журнал событий),
//время {time} (форматируется в браузере),
//ключ перевода или обычная строка (она возвращается как есть).
//Параметры тоже могут быть описаниями или массивами описаний (склеиваются через запятую).
export function tm(message) {
    if (message && typeof message === 'object' && message.time)
        return formatDateTime(message.time);
    if (message && typeof message === 'object' && message.key) {
        const params = {};
        for (const [name, value] of Object.entries(message.params || {}))
            params[name] = (Array.isArray(value) ? value.map(tm).join(', ') : tm(value));
        return (i18n.hasKey(message.key) || !message.fallback ? t(message.key, params) : String(message.fallback));
    }
    message = String(message == null ? '' : message);
    return (i18n.hasKey(message) ? t(message) : message);
}

//Текст ошибки: ошибки общих с сервером модулей несут ключ перевода и параметры (i18nKey, i18nParams)
export function tError(error) {
    if (error && error.i18nKey)
        return tm({key: error.i18nKey, params: error.i18nParams});
    return tm(error && error.message !== undefined ? error.message : error);
}

export function uiLangOptions() {
    return [
        {label: t('common.automatic'), value: ''},
        {label: t('langNames.ru'), value: 'ru'},
        {label: t('langNames.en'), value: 'en'},
    ];
}

//Название жанра по его коду; name - название с сервера на случай неизвестного кода
export function tGenre(code, name = '') {
    const key = `genres.${code}`;
    return (i18n.hasKey(key) ? t(key) : (name || code));
}

//Дерево жанров с сервера [{id, name, value: [{name, value: code}]}] в текущем языке
export function translateGenreTree(tree) {
    if (!Array.isArray(tree))
        return tree;

    return tree.map((section) => {
        const sectionKey = `genreSections.${section.id}`;
        return {
            ...section,
            name: (section.id && i18n.hasKey(sectionKey) ? t(sectionKey) : section.name),
            value: (Array.isArray(section.value)
                ? section.value.map(g => ({...g, name: tGenre(g.value, g.name)}))
                : section.value),
        };
    });
}

export default {
    install(app) {
        app.config.globalProperties.$t = t;
        app.config.globalProperties.$tm = tm;
    },
};
