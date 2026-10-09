#!/usr/bin/env node
//Проверка переводов интерфейса: собирает ключи t('...'), $t('...'), tk('...') и tHtml('id', ...)
//из клиентского кода и сравнивает их со словарями в client/share/i18n.
//Также проверяет словари OPDS (server/core/opds/i18n.*.js): ключи t('...'), tText('id', ...),
//заголовки разделов this.title = '...' и подписи полей fb2 (server/core/fb2/Fb2Parser.js).
//Использование: node scripts/i18n-check.js [--keys] [--unused]
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientDir = path.join(root, 'client');
const dictDir = path.join(clientDir, 'share', 'i18n');

function walk(dir, result = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (fullPath !== dictDir)
                walk(fullPath, result);
        } else if (/\.(vue|js)$/.test(entry.name)) {
            result.push(fullPath);
        }
    }
    return result;
}

function unescapeJs(raw) {
    return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (match, seq) => {
        if (seq[0] === 'u')
            return String.fromCodePoint(parseInt(seq.replace(/[u{}]/g, ''), 16));
        if (seq[0] === 'x')
            return String.fromCharCode(parseInt(seq.substring(1), 16));
        return ({n: '\n', t: '\t', r: '\r'})[seq] || seq;
    });
}

function collectKeys() {
    const keys = new Map();
    const htmlIds = new Map();
    const keyRe = /(?<![\w$.])(?:\$t|t|tk)\(\s*'((?:[^'\\\n]|\\.)*)'/g;
    const htmlRe = /(?<![\w$.])tHtml\(\s*'([^']+)'/g;

    for (const file of walk(clientDir)) {
        const rel = path.relative(root, file);
        const text = fs.readFileSync(file, 'utf8');
        for (const [re, map] of [[keyRe, keys], [htmlRe, htmlIds]]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text))) {
                const key = unescapeJs(m[1]);
                const line = text.substring(0, m.index).split('\n').length;
                if (!map.has(key))
                    map.set(key, []);
                map.get(key).push(`${rel}:${line}`);
            }
        }
    }
    return {keys, htmlIds};
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const {keys, htmlIds} = collectKeys();

    if (args.has('--keys')) {
        for (const key of keys.keys())
            console.log(JSON.stringify(key));
        return;
    }

    const cyrillic = /[А-Яа-яЁё]/;
    let failed = false;
    const langs = fs.readdirSync(dictDir).filter(name => /^[a-z]{2}\.js$/.test(name)).map(name => name.replace(/\.js$/, ''));
    for (const lang of langs) {
        const mod = await import(path.join(dictDir, `${lang}.js`));
        const dict = mod.default || {};
        const html = mod.html || {};

        const missing = [...keys.keys()].filter(key => cyrillic.test(key) && dict[key] === undefined);
        const missingHtml = [...htmlIds.keys()].filter(id => html[id] === undefined);
        console.log(`[${lang}] keys: ${keys.size}, translated: ${keys.size - missing.length}, missing: ${missing.length}, html missing: ${missingHtml.length}`);
        for (const key of missing)
            console.log(`  missing: ${JSON.stringify(key)}  (${keys.get(key)[0]})`);
        for (const id of missingHtml)
            console.log(`  missing html: ${id}  (${htmlIds.get(id)[0]})`);

        if (args.has('--unused')) {
            for (const key of Object.keys(dict)) {
                if (!keys.has(key))
                    console.log(`  unused: ${JSON.stringify(key)}`);
            }
        }

        if (missing.length || missingHtml.length)
            failed = true;
    }

    if (!checkOpds(args))
        failed = true;

    process.exitCode = (failed ? 1 : 0);
}

function collectOpdsKeys() {
    const opdsDir = path.join(root, 'server', 'core', 'opds');
    const files = fs.readdirSync(opdsDir).filter(name => /Page\.js$/.test(name)).map(name => path.join(opdsDir, name));
    const keys = new Map();
    const textIds = new Map();
    const add = (map, key, file, text, index) => {
        if (!map.has(key))
            map.set(key, []);
        map.get(key).push(`${path.relative(root, file)}:${text.substring(0, index).split('\n').length}`);
    };

    const fb2Parser = path.join(root, 'server', 'core', 'fb2', 'Fb2Parser.js');
    for (const file of files.concat([fb2Parser])) {
        const text = fs.readFileSync(file, 'utf8');
        const patterns = (file === fb2Parser
            ? [/label: '((?:[^'\\\n]|\\.)*)'/g]
            : [/(?<![\w$.])t\(\s*'((?:[^'\\\n]|\\.)*)'/g, /this\.title = '((?:[^'\\\n]|\\.)*)'/g]);
        for (const re of patterns) {
            let m;
            while ((m = re.exec(text)))
                add(keys, unescapeJs(m[1]), file, text, m.index);
        }
        const textRe = /(?<![\w$.])tText\(\s*'([^']+)'/g;
        let m;
        while ((m = textRe.exec(text)))
            add(textIds, m[1], file, text, m.index);
    }
    return {keys, textIds};
}

function checkOpds(args) {
    const {keys, textIds} = collectOpdsKeys();
    const cyrillic = /[А-Яа-яЁё]/;
    const opdsDir = path.join(root, 'server', 'core', 'opds');
    let ok = true;
    for (const name of fs.readdirSync(opdsDir).filter(name => /^i18n\.[a-z]{2}\.js$/.test(name))) {
        const lang = name.split('.')[1];
        const {strings = {}, texts = {}} = require(path.join(opdsDir, name));
        const missing = [...keys.keys()].filter(key => cyrillic.test(key) && strings[key] === undefined);
        const missingTexts = [...textIds.keys()].filter(id => texts[id] === undefined);
        console.log(`[opds ${lang}] keys: ${keys.size}, translated: ${keys.size - missing.length}, missing: ${missing.length}, texts missing: ${missingTexts.length}`);
        for (const key of missing)
            console.log(`  missing: ${JSON.stringify(key)}  (${keys.get(key)[0]})`);
        for (const id of missingTexts)
            console.log(`  missing text: ${id}  (${textIds.get(id)[0]})`);
        if (args.has('--unused')) {
            for (const key of Object.keys(strings)) {
                if (!keys.has(key))
                    console.log(`  unused: ${JSON.stringify(key)}`);
            }
        }
        if (missing.length || missingTexts.length)
            ok = false;
    }
    return ok;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 2;
});
