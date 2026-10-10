//Названия жанров по коду для страниц книги, автора и серии. Дерево загружается один раз.
import {tGenre} from './i18n';

let treePromise = null;
let codeNames = new Map();

export function loadGenres(api) {
    if (!treePromise) {
        treePromise = api.getGenreTree()
            .then((result) => {
                codeNames = new Map();
                for (const section of (result && result.genreTree) || []) {
                    for (const genre of section.value || [])
                        codeNames.set(genre.value, genre.name);
                }
                return codeNames;
            })
            .catch((e) => {
                treePromise = null;
                throw e;
            });
    }
    return treePromise;
}

export function genreName(code = '') {
    const value = String(code || '').trim();
    return tGenre(value, codeNames.get(value) || value);
}

export function bookGenres(book = {}) {
    return String(book.genre || '').split(',').map(code => code.trim()).filter(Boolean);
}

//Все жанры библиотеки для выбора: [{value: код, label: название}] по алфавиту
export function allGenres() {
    return [...codeNames.keys()]
        .map(code => ({value: code, label: genreName(code)}))
        .filter(item => item.label && !/^\?+$/.test(item.label))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}
