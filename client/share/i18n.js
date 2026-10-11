import { reactive } from 'vue';

import i18n from '../../shared/i18n.js';

//Тексты интерфейса - в shared/locales/<lang>.json, в коде только ключи: t('settings.darkTheme').
//Язык хранится в реактивном состоянии, поэтому шаблоны и вычисляемые свойства перерисовываются при смене языка.
const locales = {ru: 'ru-RU', en: 'en-US'};
const ruFamily = new Set(['ru', 'uk', 'be', 'kk']);
const langCookie = 'inpx_lang';

const state = reactive({lang: i18n.fallbackLang});

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

export function setLang(value) {
    state.lang = resolveLang(value);
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

export function t(key, params) {
    return i18n.translate(state.lang, key, params);
}

//Помечает ключ перевода в константах уровня модуля, которые вычисляются до выбора языка;
//переводить такие ключи нужно при выводе через t().
export function tk(key) {
    return key;
}

//Текст, пришедший с сервера: описание сообщения {key, params, fallback} (витрины, журнал событий),
//ключ перевода или обычная строка (она возвращается как есть).
//Параметры тоже могут быть описаниями или массивами описаний (склеиваются через запятую).
export function tm(message) {
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
