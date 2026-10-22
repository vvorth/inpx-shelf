const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const net = require('net');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const {setTimeout: sleep} = require('timers/promises');
const yazl = require('yazl');
const {PNG} = require('pngjs');

async function writeZip(file, entries) {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(file);
    const complete = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        zip.outputStream.on('error', reject);
    });
    zip.outputStream.pipe(output);
    for (const [name, data] of Object.entries(entries))
        zip.addBuffer(Buffer.from(data), name);
    zip.end();
    await complete;
}

const bookTitle = 'Packaged smoke book';
const cover = PNG.sync.write(Object.assign(new PNG({width: 2, height: 3}), {data: Buffer.alloc(2*3*4, 0x80)}));

// One FB2 with an embedded cover in smoke.zip (the archive of smoke.inp): books and covers come out through
// 7z-wasm in the archive worker, as in a real library. Returns the book's _uid (SHA-256 of its INPX line).
async function createFixture(dir) {
    await fs.ensureDir(dir);
    const fb2 = '<?xml version="1.0" encoding="utf-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">' +
        `<description><title-info><genre>sf</genre><author><first-name>Smoke</first-name><last-name>Tester</last-name></author><book-title>${bookTitle}</book-title>` +
        '<lang>en</lang><coverpage><image l:href="#cover.png"/></coverpage></title-info></description>' +
        `<body><section><p>${bookTitle} text.</p></section></body><binary id="cover.png" content-type="image/png">${cover.toString('base64')}</binary></FictionBook>`;
    await writeZip(path.join(dir, 'smoke.zip'), {'1.fb2': fb2});
    const row = ['Tester,Smoke:', 'sf:', bookTitle, '', '0', '1', String(Buffer.byteLength(fb2)), '1', '0', 'fb2', '2026-09-14', 'en', '0', ''].join('\x04');
    await writeZip(path.join(dir, 'smoke.inpx'), {
        'collection.info': 'Smoke library\n',
        'version.info': '20260914',
        'smoke.inp': row + '\n',
    });
    await fs.writeJson(path.join(dir, 'config.json'), {
        loggingEnabled: false,
        opds: {enabled: true},
    });
    return require('crypto').createHash('sha256').update(row).digest('base64');
}

//пароль администратора задаётся только окружением (adminPassword не читается из config.json)
const adminPassword = 'local-smoke-fixture';

async function unusedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

// HTTP API end to end: the session cookie and CSRF token from GET api/config, a login that sets a new session cookie.
async function checkApi(url) {
    const headers = {'X-Inpx-Api': '1'};
    const ping = await fetch(`${url}/api/ping`, {headers});
    assert.strictEqual(ping.status, 200);
    assert.match((await ping.json()).message, /inpx-shelf/);
    const configResponse = await fetch(`${url}/api/config`, {headers});
    assert.strictEqual(configResponse.status, 200);
    assert.strictEqual(configResponse.headers.get('cache-control'), 'no-store');
    const cookie = String(configResponse.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^inpx_web_session=/);
    const config = await configResponse.json();
    assert.strictEqual(config.profileAuthorized, false);
    const login = await fetch(`${url}/api/session`, {method: 'POST', body: JSON.stringify({login: 'admin', password: adminPassword}),
        headers: {...headers, cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken}});
    const result = await login.json();
    assert.strictEqual(login.status, 200, JSON.stringify(result));
    assert.strictEqual(result.userId, 'admin');
    const signedIn = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(signedIn, /^inpx_web_session=/);
    assert.notStrictEqual(signedIn, cookie);
    const after = await (await fetch(`${url}/api/config`, {headers: {...headers, cookie: signedIn}})).json();
    assert.deepStrictEqual([after.profileAuthorized, after.currentUserId], [true, 'admin']);
    return signedIn;
}

// The public book link (/book/by-uid redirects to the prepared file) and the embedded cover.
async function checkBook(url, cookie, uid) {
    const query = `uid=${encodeURIComponent(uid)}`;
    const link = await fetch(`${url}/book/by-uid?${query}`, {headers: {cookie}, redirect: 'manual'});
    assert.strictEqual(link.status, 302, await link.text());
    const book = await fetch(new URL(link.headers.get('location'), url), {headers: {cookie}});
    assert.strictEqual(book.status, 200);
    assert.match(String(book.headers.get('content-type')), /^application\/x-fictionbook\+xml/);
    assert.match(await book.text(), new RegExp(`<book-title>${bookTitle}</book-title>`));
    const coverResponse = await fetch(`${url}/cover/by-uid?${query}`, {headers: {cookie}});
    assert.strictEqual(coverResponse.status, 200);
    assert.strictEqual(coverResponse.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await coverResponse.arrayBuffer()).equals(cover), 'The embedded cover');
}

const dockerDataDir = '/usr/local/bin/.inpx-web';

// mode: binary, command (the image with an explicit command, as in the docs) or entrypoint (the default
// entrypoint with PUID/PGID and the data volume: the privilege drop and chown are checked).
async function run(target, mode) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-binary-smoke-'));
    const library = path.join(dir, 'library');
    const containerName = `inpx-smoke-${process.pid}-${Date.now()}`;
    let child;
    let exited;
    let output = '';
    try {
        const uid = await createFixture(library);
        const port = await unusedPort();
        let command;
        let args;
        if (mode === 'binary') {
            command = path.resolve(target);
            args = [`--data-dir=${path.join(dir, 'data')}`, `--lib-dir=${library}`,
                `--config=${path.join(library, 'config.json')}`, '--host=127.0.0.1', `--port=${port}`];
        } else {
            command = 'docker';
            args = ['run', '--rm', '--name', containerName, '-p', `127.0.0.1:${port}:12380`, '-e', `INPX_ADMIN_PASSWORD=${adminPassword}`,
                '--mount', `type=bind,source=${library},target=/library,readonly`];
            if (mode === 'command') {
                // DATA_DIR: the entrypoint gives /data to the app user before running the command
                args.push('--tmpfs', '/data', '-e', 'DATA_DIR=/data', target,
                    'sh', '-c', 'cp /library/config.json /data/config.json && exec inpx-shelf --data-dir=/data --config=/data/config.json --lib-dir=/library --host=0.0.0.0 --port=12380');
            } else {
                args.push('-e', 'PUID=1000', '-e', 'PGID=1000', target);
            }
        }
        const env = {...process.env, INPX_LIBRARY_SOURCES: '', LIBRARY_SOURCES: '',
            INPX_REQUIRE_AUTH: 'false', INPX_AUTH_MODE: 'local', INPX_ENABLE_CONVERSION: 'false', INPX_ADMIN_PASSWORD: adminPassword};
        child = spawn(command, args, {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        exited = new Promise(resolve => {
            child.once('exit', resolve);
            child.once('error', error => { output += error.message; resolve(); });
        });
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', data => { output = (output + data).slice(-16000); });
        const url = `http://127.0.0.1:${port}`;
        let ready = false;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && child.exitCode === null) {
            try {
                const response = await fetch(`${url}/ready`, {signal: AbortSignal.timeout(2000)});
                if (response.ok && (await response.json()).ready) {
                    ready = true;
                    break;
                }
            } catch (error) { /* Startup may not have bound the port yet. */ }
            await sleep(250);
        }
        assert.ok(ready, `Packaged application did not index the fixture and become ready:\n${output}`);
        const health = await fetch(`${url}/health`);
        assert.strictEqual(health.status, 200);
        assert.strictEqual((await health.json()).version, require('../package.json').version);
        const home = await fetch(url);
        assert.strictEqual(home.status, 200);
        assert.match(await home.text(), /<html/i);
        // login is always required: OPDS answers with a Basic challenge
        const opds = await fetch(`${url}/opds`);
        assert.strictEqual(opds.status, 401);
        assert.match(String(opds.headers.get('www-authenticate')), /^Basic/);
        const cookie = await checkApi(url);
        await checkBook(url, cookie, uid);
        if (mode === 'entrypoint') {
            // config.json is written by the app itself: its owner is the user the app runs as
            const {stdout} = await promisify(execFile)('docker', ['exec', containerName, 'stat', '-c', '%u:%g',
                dockerDataDir, `${dockerDataDir}/config.json`], {windowsHide: true, timeout: 15000});
            assert.deepStrictEqual(stdout.trim().split('\n'), ['1000:1000', '1000:1000']);
        }
        console.log(`ok packaged application: indexing, health, web UI, OPDS, HTTP API, book and cover (${mode === 'binary' ? target : `${target}, ${mode}`})`);
    } finally {
        if (mode !== 'binary')
            await promisify(execFile)('docker', ['rm', '-f', containerName], {windowsHide: true, timeout: 15000}).catch(() => {});
        if (child && child.exitCode === null)
            child.kill();
        if (exited) {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            try { await exited; } finally { clearTimeout(timer); }
        }
        await fs.remove(dir);
    }
}

async function main() {
    const [target, imageName] = process.argv.slice(2);
    if (!target || (target === '--image' && !imageName))
        throw new Error('Usage: node scripts/binary-smoke-test.js <binary> | --image <local-image>');
    if (target === '--image') {
        await run(imageName, 'command');
        await run(imageName, 'entrypoint');
    } else {
        await run(target, 'binary');
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
