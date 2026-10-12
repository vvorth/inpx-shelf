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

module.exports = [testServiceWorkerCachesOnlyAppShellNavigation];
