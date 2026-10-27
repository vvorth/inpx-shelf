const {AsyncLocalStorage} = require('async_hooks');

const i18n = require('../../shared/i18n');

//Переводы на сервере. Язык выбирается на каждый запрос (API, HTTP, OPDS) и хранится
//в AsyncLocalStorage: объекты сервера общие и обслуживают параллельные запросы.
//Тексты - в shared/locales/<lang>.json (см. shared/i18n.js).
const storage = new AsyncLocalStorage();
const langCookie = 'inpx_lang';

//Язык вне запросов (фоновые задачи, значения по умолчанию при создании данных)
let defaultLang = 'ru';

function setDefaultLang(config = {}) {
    defaultLang = i18n.normalizeLang(config.uiDefaults && config.uiDefaults.uiLang) || 'ru';
}

function cookieLang(req) {
    const header = String((req && req.headers && req.headers.cookie) || '');
    const m = header.match(new RegExp(`(?:^|;\\s*)${langCookie}=([a-z]+)`));
    return (m ? i18n.normalizeLang(m[1]) : '');
}

//Язык веб-интерфейса: язык из запроса клиента, cookie, язык по умолчанию из конфига, Accept-Language
function resolveRequestLang(config = {}, req = null, requested = '') {
    return i18n.normalizeLang(requested)
        || cookieLang(req)
        || i18n.normalizeLang(config.uiDefaults && config.uiDefaults.uiLang)
        || i18n.langFromAcceptLanguage(req && req.headers && req.headers['accept-language'])
        || defaultLang;
}

//Язык OPDS: opds.lang в конфиге (INPX_OPDS_LANG задаёт его в ConfigManager.applyEnvOverrides),
//язык интерфейса по умолчанию, Accept-Language читалки, иначе русский
function resolveOpdsLang(config = {}, req = null) {
    return i18n.normalizeLang(config.opds && config.opds.lang)
        || i18n.normalizeLang(config.uiDefaults && config.uiDefaults.uiLang)
        || i18n.langFromAcceptLanguage(req && req.headers && req.headers['accept-language'])
        || 'ru';
}

function run(lang, fn) {
    return storage.run({lang: i18n.normalizeLang(lang) || defaultLang}, fn);
}

function getLang() {
    const store = storage.getStore();
    return (store ? store.lang : defaultLang);
}

function t(key, params) {
    return i18n.translate(getLang(), key, params);
}

//Описание сообщения для клиента: текст переводится в браузере на текущем языке интерфейса.
//Нужно там, где результат кэшируется или сохраняется (витрины, журнал событий).
function msg(key, params) {
    return (params ? {key, params} : {key});
}

//Текст из описания {key, params}, ключа или обычной строки (обычная строка возвращается как есть)
function render(value) {
    if (value && typeof value === 'object' && value.key) {
        const params = {};
        for (const [name, param] of Object.entries(value.params || {}))
            params[name] = (Array.isArray(param) ? param.map(render).join(', ') : render(param));
        return (i18n.hasKey(value.key) || !value.fallback ? t(value.key, params) : String(value.fallback));
    }
    if (typeof value === 'string' && i18n.hasKey(value))
        return t(value);
    return (value == null ? '' : String(value));
}

//Значение ключа на всех языках (например, чтобы узнать имя по умолчанию в уже сохраненных данных)
function allTranslations(key) {
    return i18n.supportedLangs.map(lang => i18n.translate(lang, key));
}

function tGenre(code, name) {
    const key = `genres.${code}`;
    return (i18n.hasKey(key) ? t(key) : (name || code));
}

function tGenreSection(id, name) {
    const key = `genreSections.${id}`;
    return (id && i18n.hasKey(key) ? t(key) : name);
}

//express-middleware: язык для HTTP-запросов веб-интерфейса
function httpMiddleware(config) {
    return (req, res, next) => run(resolveRequestLang(config, req), next);
}

module.exports = {
    setDefaultLang,
    resolveRequestLang,
    resolveOpdsLang,
    run,
    getLang,
    t,
    msg,
    render,
    allTranslations,
    tGenre,
    tGenreSection,
    httpMiddleware,
};
