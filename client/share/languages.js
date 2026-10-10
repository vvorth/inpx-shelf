//«Мои языки»: какие языки книг показывать в каталоге, на страницах автора и серии, на главной.
//У вошедшего профиля хранятся на сервере (языки вкуса витрин), у гостя - в этом браузере.
//Пустой список - ещё не выбирали: показываем язык интерфейса. ['*'] - все языки.
import {getLang} from './i18n';
import {isSignedIn, currentProfile} from './session';

export const allLanguages = '*';

export function storedLanguages(config = {}, settings = {}) {
    const list = (isSignedIn(config) ? currentProfile(config).libraryLanguages : settings.libraryLanguages);
    return (Array.isArray(list) ? list : []).map(code => String(code || '').trim().toLowerCase()).filter(Boolean);
}

//{all: true} или {all: false, codes: Set}
export function myLanguages(config = {}, settings = {}) {
    const list = storedLanguages(config, settings);
    if (list.includes(allLanguages))
        return {all: true, codes: new Set(), list: []};
    const codes = (list.length ? list : [getLang()]);
    return {all: false, codes: new Set(codes), list: codes};
}

export function bookLang(book = {}) {
    return String(book.lang || '').trim().toLowerCase();
}

export function languageMatches(book, languages) {
    return languages.all || languages.codes.has(bookLang(book));
}

//Значение поля «Язык» старого поиска по полям
export function langDefaultFor(languages) {
    return (languages.all ? '' : languages.list.join(','));
}

export async function saveMyLanguages(vm, codes = []) {
    const list = (codes.includes(allLanguages) ? [allLanguages] : [...new Set(codes.map(code => String(code).toLowerCase()))].slice(0, 10));
    const config = vm.$store.state.config;
    if (isSignedIn(config)) {
        await vm.$root.api.updateDiscoveryPreferences({taste: {languages: list}});
        await vm.$root.api.updateConfig();
    } else {
        vm.$store.commit('setSettings', {libraryLanguages: list});
    }
}

let displayNames = null;
let displayLang = '';

export function languageName(code = '') {
    const value = String(code || '').trim();
    if (!value)
        return '';
    try {
        const lang = getLang();
        if (!displayNames || displayLang !== lang) {
            displayNames = new Intl.DisplayNames([lang], {type: 'language'});
            displayLang = lang;
        }
        const name = displayNames.of(value);
        return (name && name !== value ? name[0].toUpperCase() + name.slice(1) : value);
    } catch (e) {
        return value;
    }
}
