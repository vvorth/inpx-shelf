const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const vm = require('vm');

// Запускает client/assets/sw.js в песочнице и возвращает ключи, которые попали в кэш после навигации.
async function runServiceWorkerNavigation(pathname, contentType, status = 200) {
    const source = await fs.readFile(path.resolve(__dirname, '../client/assets/sw.js'), 'utf8');
    const listeners = {};
    const cached = [];
    const response = {
        ok: status >= 200 && status < 300,
        headers: {get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null)},
        clone() { return this; },
    };
    const self = {
        registration: {scope: 'http://host/'},
        location: {origin: 'http://host'},
        addEventListener: (type, fn) => { listeners[type] = fn; },
    };
    const caches = {open: async() => ({put: async(key) => { cached.push(key); }})};
    vm.runInNewContext(source, {self, caches, URL, Request: function(request) { return request; }, fetch: async() => response});

    let responded;
    listeners.fetch({request: {method: 'GET', mode: 'navigate', url: `http://host${pathname}`}, respondWith: (p) => { responded = p; }});
    assert.strictEqual(await responded, response);
    await new Promise(resolve => setImmediate(resolve));
    return cached;
}

// Скачивание книги или резервной копии (в ней secret.key) — тоже навигация: оно не должно оседать в кэше как index.html.
async function testServiceWorkerCachesOnlyAppShellNavigation() {
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html; charset=utf-8'), ['/index.html']);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/admin-backups/backup.zip', 'application/zip'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/book/1.fb2', 'application/octet-stream'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/app-reset', 'text/html'), []);
    assert.deepStrictEqual(await runServiceWorkerNavigation('/', 'text/html', 503), []);
}

// Пароль доступа клиент хэширует сам (по http нет crypto.subtle), сервер сравнивает hex: результат должен совпадать с Node.
async function testClientSha256MatchesNode() {
    const {sha256Hex} = require('../shared/sha256');
    const crypto = require('crypto');
    assert.strictEqual(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const value of ['', 'пароль', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'p\u{1F600}'.repeat(300)])
        assert.strictEqual(sha256Hex(value), crypto.createHash('sha256').update(value, 'utf8').digest('hex'), `length ${value.length}`);
}

module.exports = [testServiceWorkerCachesOnlyAppShellNavigation, testClientSha256MatchesNode];
