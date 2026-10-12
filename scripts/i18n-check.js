#!/usr/bin/env node
//Проверка переводов (shared/locales/<lang>.json):
// - ключи, используемые в коде (t, $t, tk, msg, keyError и т.п.), есть во всех языках;
// - во всех языках одинаковый набор ключей, одинаковые параметры {name}, правильные формы множественного числа;
// - в словарях нет неиспользуемых ключей;
// - в коде нет русского текста интерфейса (кроме комментариев, данных жанров и строк с пометкой i18n-ignore).
//Использование: node scripts/i18n-check.js
const fs = require('fs');
const path = require('path');

const i18n = require('../shared/i18n');

const root = path.resolve(__dirname, '..');
const codeDirs = ['client', 'server', 'shared'];
//файлы с данными, а не с текстом интерфейса
const dataFiles = new Set(['server/core/genres/genresText.js']);
//ключи, которые строятся в коде динамически
const dynamicPrefixes = ['genres.', 'genreSections.'];
const pluralCategories = {ru: ['one', 'few', 'many', 'other'], en: ['one', 'other']};
const cyrillic = /[А-Яа-яЁё]/;

function walk(dir, result = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!['node_modules', 'locales'].includes(entry.name) && !entry.name.startsWith('.'))
                walk(fullPath, result);
        } else if (/\.(vue|js)$/.test(entry.name)) {
            result.push(fullPath);
        }
    }
    return result;
}

function flatten(node, prefix = '', result = new Map()) {
    for (const [name, value] of Object.entries(node)) {
        const key = (prefix ? `${prefix}.${name}` : name);
        const isPlural = value && typeof value === 'object' && !Array.isArray(value) && value.other !== undefined
            && Object.keys(value).every(name => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(name));
        if (value && typeof value === 'object' && !Array.isArray(value) && !isPlural)
            flatten(value, key, result);
        else
            result.set(key, value);
    }
    return result;
}

function texts(value) {
    if (Array.isArray(value))
        return [value.join('\n')];
    if (value && typeof value === 'object')
        return Object.values(value);
    return [String(value)];
}

function params(value) {
    const result = new Set();
    for (const text of texts(value)) {
        for (const m of text.matchAll(/\{(\w+)\}/g))
            result.add(m[1]);
    }
    return result;
}

//код без комментариев (строки сохраняются, чтобы номера строк совпадали)
function stripComments(text) {
    return text
        .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function main() {
    const problems = [];
    const locales = {};
    for (const lang of i18n.supportedLangs)
        locales[lang] = flatten(i18n.locales[lang]);

    //1. одинаковые ключи, параметры и формы множественного числа во всех языках
    const allKeys = new Set();
    for (const map of Object.values(locales))
        map.forEach((value, key) => allKeys.add(key));
    for (const key of allKeys) {
        const values = {};
        for (const lang of i18n.supportedLangs) {
            if (!locales[lang].has(key))
                problems.push(`missing in ${lang}.json: ${key}`);
            else
                values[lang] = locales[lang].get(key);
        }
        const langs = Object.keys(values);
        for (const lang of langs) {
            const value = values[lang];
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const required = pluralCategories[lang] || ['other'];
                const missing = required.filter(c => value[c] === undefined);
                if (missing.length)
                    problems.push(`plural forms missing in ${lang}.json: ${key} (${missing.join(', ')})`);
            }
        }
        if (langs.length > 1) {
            const base = [...params(values[langs[0]])].sort().join(',');
            for (const lang of langs.slice(1)) {
                const other = [...params(values[lang])].sort().join(',');
                if (other !== base)
                    problems.push(`placeholders differ for ${key}: ${langs[0]} {${base}} vs ${lang} {${other}}`);
            }
        }
    }

    //2. ключи в коде и русский текст в коде
    const usedKeys = new Set();
    const callRe = /(?<![\w$])(?:\$t|t|tk|msg|keyError|i18n\.t|\$tm|tm)\(\s*'([a-zA-Z]\w*(?:\.[\w-]+)+)'/g;
    const literalRe = /'([a-zA-Z]\w*(?:\.[\w-]+)+)'/g;
    for (const file of codeDirs.flatMap(dir => walk(path.join(root, dir)))) {
        //posix-путь: на Windows path.relative даёт обратные слэши, и dataFiles не совпадал бы
        const rel = path.relative(root, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        const code = stripComments(text);

        for (const m of code.matchAll(callRe)) {
            usedKeys.add(m[1]);
            if (!locales[i18n.fallbackLang].has(m[1])) {
                const line = code.substring(0, m.index).split('\n').length;
                problems.push(`unknown key ${m[1]} (${rel}:${line})`);
            }
        }
        //ключи, передаваемые как строки (заголовки OPDS, подписи fb2, сообщения состояния и т.п.)
        for (const m of code.matchAll(literalRe)) {
            if (allKeys.has(m[1]))
                usedKeys.add(m[1]);
        }

        if (dataFiles.has(rel))
            continue;
        const lines = text.split('\n');
        code.split('\n').forEach((line, index) => {
            if (cyrillic.test(line) && !lines[index].includes('i18n-ignore'))
                problems.push(`russian text in code (${rel}:${index + 1}): ${lines[index].trim().substring(0, 100)}`);
        });
    }

    //3. неиспользуемые ключи
    for (const key of allKeys) {
        if (!usedKeys.has(key) && !dynamicPrefixes.some(prefix => key.startsWith(prefix)))
            problems.push(`unused key: ${key}`);
    }

    for (const lang of i18n.supportedLangs)
        console.log(`[${lang}] keys: ${locales[lang].size}`);
    for (const problem of problems)
        console.log(`  ${problem}`);
    console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
    process.exitCode = (problems.length ? 1 : 0);
}

main();
