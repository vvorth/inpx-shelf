//Движок переводов, общий для веб-интерфейса (client/share/i18n.js) и сервера (shared/i18n.js, server/core/i18n.js).
//Тексты хранятся в shared/locales/<lang>.json, ключи - семантические, с точками: 'settings.darkTheme'.
//Словари добавляются через addLocale: сервер загружает все сразу, браузер - только выбранный язык.
//
//Формат значений:
//  "строка с {параметрами}"
//  ["строка 1", "строка 2"]                          - многострочный текст (склеивается через \n)
//  {"one": "{n} книга", "few": "...", "many": "...", "other": "..."} - множественное число по параметру n
const locales = {};

const fallbackLang = 'en';
const supportedLangs = ['en', 'ru'];
const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

//Правила множественного числа (CLDR) для поддерживаемых языков.
//Свои, а не Intl.PluralRules: сборки Node без полных данных ICU выбирают правила английского.
const pluralRules = {
    en(n) {
        return (n === 1 ? 'one' : 'other');
    },
    ru(n) {
        if (!Number.isInteger(n))
            return 'other';
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11)
            return 'one';
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
            return 'few';
        return 'many';
    },
};

function normalizeLang(value) {
    value = String(value || '').trim().toLowerCase();
    return (supportedLangs.includes(value) ? value : '');
}

function lookup(lang, key) {
    let node = locales[lang];
    for (const part of String(key).split('.')) {
        if (!node || typeof node !== 'object' || Array.isArray(node))
            return undefined;
        node = node[part];
    }
    return node;
}

function isPlural(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.other === undefined)
        return false;
    return Object.keys(value).every(name => pluralCategories.has(name));
}

function isMessage(value) {
    return (typeof value === 'string' || Array.isArray(value) || isPlural(value));
}

function interpolate(text, params) {
    if (!params)
        return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
}

function format(lang, value, params) {
    if (Array.isArray(value))
        value = value.join('\n');
    if (isPlural(value)) {
        const n = Math.abs(Number(params && params.n));
        const rule = pluralRules[lang] || pluralRules[fallbackLang];
        value = value[rule(Number.isFinite(n) ? n : 0)] || value.other;
    }
    return interpolate(String(value), params);
}

//Перевод ключа; если в языке нет ключа - английский, если нет и там - сам ключ
function translate(lang, key, params) {
    lang = normalizeLang(lang) || fallbackLang;
    for (const l of (lang === fallbackLang ? [lang] : [lang, fallbackLang])) {
        const value = lookup(l, key);
        if (isMessage(value))
            return format(l, value, params);
    }
    return String(key);
}

//Наборы ключей во всех языках одинаковы (npm run test:i18n): проверяем любой загруженный словарь
function hasKey(key) {
    return (typeof key === 'string' && /^[a-zA-Z]\w*(\.[\w-]+)+$/.test(key) && Object.keys(locales).some(lang => isMessage(lookup(lang, key))));
}

function addLocale(lang, messages) {
    locales[lang] = messages;
}

//Первый поддерживаемый язык из заголовка Accept-Language; русский также для uk/be/kk
function langFromAcceptLanguage(header) {
    const ruFamily = new Set(['ru', 'uk', 'be', 'kk']);
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
            return 'ru';
        if (supportedLangs.includes(code))
            return code;
    }
    return (langs.length ? fallbackLang : '');
}

module.exports = {
    locales,
    supportedLangs,
    fallbackLang,
    addLocale,
    normalizeLang,
    translate,
    hasKey,
    langFromAcceptLanguage,
};
