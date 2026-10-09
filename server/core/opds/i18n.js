const {AsyncLocalStorage} = require('async_hooks');

const en = require('./i18n.en');
const genresEn = require('../../../shared/genres.en');

//Строки OPDS пишутся в коде по-русски и служат ключами перевода (как в client/share/i18n.js).
//Язык выбирается на каждый запрос и хранится в AsyncLocalStorage,
//т.к. страницы OPDS - общие объекты, обслуживающие параллельные запросы.
const sourceLang = 'ru';
const dictionaries = {en: en.strings};
const textDictionaries = {en: en.texts};
const genreDictionaries = {en: genresEn};
const ruFamily = new Set(['ru', 'uk', 'be', 'kk']);

const storage = new AsyncLocalStorage();

function normalizeLang(value) {
    value = String(value || '').trim().toLowerCase();
    if (value === sourceLang || dictionaries[value])
        return value;
    return '';
}

function langFromAcceptLanguage(header) {
    const langs = String(header || '')
        .split(',')
        .map((part) => {
            const [tag, ...params] = part.trim().split(';');
            const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
            return {code: tag.trim().toLowerCase().split('-')[0], q: (q ? parseFloat(q.substring(2)) : 1)};
        })
        .filter(item => item.code && item.code !== '*' && item.q > 0)
        .sort((a, b) => b.q - a.q);

    for (const {code} of langs) {
        if (ruFamily.has(code))
            return sourceLang;
        if (dictionaries[code])
            return code;
    }
    return (langs.length ? 'en' : '');
}

//Порядок: opds.lang в конфиге, переменная INPX_OPDS_LANG, язык интерфейса по умолчанию (uiDefaults.uiLang),
//заголовок Accept-Language читалки, иначе русский.
function resolveLang(config = {}, req = null) {
    return normalizeLang(config.opds && config.opds.lang)
        || normalizeLang(process.env.INPX_OPDS_LANG)
        || normalizeLang(config.uiDefaults && config.uiDefaults.uiLang)
        || langFromAcceptLanguage(req && req.headers && req.headers['accept-language'])
        || sourceLang;
}

function run(lang, fn) {
    return storage.run({lang: normalizeLang(lang) || sourceLang}, fn);
}

function getLang() {
    const store = storage.getStore();
    return (store ? store.lang : sourceLang);
}

function interpolate(text, params) {
    if (!params)
        return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
}

function t(text, params) {
    text = String(text == null ? '' : text);
    const lang = getLang();
    let result = text;
    if (lang !== sourceLang) {
        const translated = (dictionaries[lang] || {})[text];
        if (typeof translated === 'function')
            return translated(params || {});
        if (typeof translated === 'string')
            result = translated;
    }
    return interpolate(result, params);
}

//Крупный текст (памятка и т.п.) целиком по идентификатору
function tText(id, sourceText) {
    const lang = getLang();
    if (lang !== sourceLang) {
        const dict = textDictionaries[lang];
        if (dict && typeof dict[id] === 'string')
            return dict[id];
    }
    return sourceText;
}

function tGenre(code, name) {
    const lang = getLang();
    if (lang !== sourceLang) {
        const dict = genreDictionaries[lang];
        if (dict && dict.genres[code])
            return dict.genres[code];
    }
    return name;
}

function tGenreSection(name) {
    const lang = getLang();
    if (lang !== sourceLang) {
        const dict = genreDictionaries[lang];
        if (dict && dict.sections[name])
            return dict.sections[name];
    }
    return name;
}

module.exports = {
    sourceLang,
    resolveLang,
    langFromAcceptLanguage,
    run,
    getLang,
    t,
    tText,
    tGenre,
    tGenreSection,
};
