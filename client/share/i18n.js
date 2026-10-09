import { reactive } from 'vue';

import en, {html as enHtml, patterns as enPatterns} from './i18n/en.js';
import genresEn from '../../shared/genres.en.js';

//Строки интерфейса пишутся в коде по-русски и служат ключами перевода.
//Словарь другого языка сопоставляет русской строке перевод (строку или функцию от параметров).
//Если перевода нет, показывается русская строка.
const sourceLang = 'ru';
const dictionaries = {en};
//Крупные HTML-фрагменты (справка и т.п.) переводятся целиком по идентификатору.
const htmlDictionaries = {en: enHtml};
//Шаблоны для сообщений с переменной частью, приходящих извне (ошибки сервера и т.п.).
const patternDictionaries = {en: enPatterns};
//Названия жанров: по коду жанра и по названию раздела.
const genreDictionaries = {en: genresEn};
const locales = {ru: 'ru-RU', en: 'en-US'};

export const uiLangOptions = [
    {label: 'Автоматически', value: ''},
    {label: 'Русский', value: 'ru'},
    {label: 'English', value: 'en'},
];

const state = reactive({lang: sourceLang});

function interpolate(text, params) {
    if (!params)
        return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
}

export function detectLang() {
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    for (const value of langs) {
        const code = String(value || '').toLowerCase().split('-')[0];
        if (['ru', 'uk', 'be', 'kk'].includes(code))
            return 'ru';
        if (dictionaries[code])
            return code;
    }
    return 'en';
}

export function resolveLang(value) {
    value = String(value || '');
    if (value === sourceLang || dictionaries[value])
        return value;
    return detectLang();
}

export function setLang(value) {
    state.lang = resolveLang(value);
    if (typeof document !== 'undefined')
        document.documentElement.setAttribute('lang', state.lang);
    return state.lang;
}

export function getLang() {
    return state.lang;
}

export function getLocale() {
    return locales[state.lang] || locales[sourceLang];
}

export function t(text, params) {
    text = String(text == null ? '' : text);
    let result = text;
    if (state.lang !== sourceLang) {
        const dict = dictionaries[state.lang];
        const translated = (dict ? dict[text] : undefined);
        if (typeof translated === 'function')
            return translated(params || {});
        if (typeof translated === 'string')
            result = translated;
    }
    return interpolate(result, params);
}

//Перевод сообщения, пришедшего извне (например, текст ошибки с сервера):
//сначала точное совпадение со словарем, затем шаблоны [RegExp, замена].
export function tMessage(message) {
    message = String(message == null ? '' : message);
    if (state.lang === sourceLang || !message)
        return message;

    const dict = dictionaries[state.lang];
    if (dict && typeof dict[message] === 'string')
        return dict[message];

    for (const [re, replacement] of (patternDictionaries[state.lang] || [])) {
        if (re.test(message))
            return message.replace(re, replacement);
    }
    return message;
}

//Название жанра по его коду (name - исходное русское название с сервера)
export function tGenre(code, name) {
    if (state.lang !== sourceLang) {
        const dict = genreDictionaries[state.lang];
        if (dict && dict.genres[code])
            return dict.genres[code];
    }
    return name;
}

//Дерево жанров с сервера [{name, value: [{name, value: code}]}] в текущем языке
export function translateGenreTree(tree) {
    if (state.lang === sourceLang || !Array.isArray(tree))
        return tree;

    const dict = genreDictionaries[state.lang] || {genres: {}, sections: {}};
    return tree.map(section => ({
        ...section,
        name: dict.sections[section.name] || section.name,
        value: (Array.isArray(section.value)
            ? section.value.map(g => ({...g, name: dict.genres[g.value] || g.name}))
            : section.value),
    }));
}

//Помечает строку как ключ перевода без перевода (для констант уровня модуля,
//которые вычисляются до выбора языка); переводить такие строки нужно при выводе через t().
export function tk(text) {
    return text;
}

export function tHtml(id, sourceHtml) {
    if (state.lang !== sourceLang) {
        const dict = htmlDictionaries[state.lang];
        if (dict && typeof dict[id] === 'string')
            return dict[id];
    }
    return sourceHtml;
}

export default {
    install(app) {
        app.config.globalProperties.$t = t;
        app.config.globalProperties.$tm = tMessage;
    },
};
