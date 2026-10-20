//7-Zip, собранный в WebAssembly (7z-wasm): читает zip любого метода сжатия (Deflate, PPMd, LZMA, BZip2...), 7z, rar.
//Работает внутри потока архивов (ArchiveChild): callMain синхронный и занимает поток на всё время распаковки.
//Архив читается с диска через NODEFS или из S3 (S3File), целиком в память не загружается.
const fs = require('fs');
const path = require('path');
const SevenZip = require('7z-wasm/7zz.umd.js');
const {isS3} = require('../S3Fs');
const {createNode} = require('./S3File');

//7-Zip не рассчитан на повторный вызов main в одном процессе: его статическое состояние портится, и через
//несколько десятков вызовов экземпляр падает (memory access out of bounds). Поэтому каждый вызов получает новый
//экземпляр; скомпилированный модуль общий, новый экземпляр стоит ~7 мс.
let wasmModule = null;
let output = [];
let mountId = 0;

async function load() {
    if (!wasmModule)
        wasmModule = await WebAssembly.compile(fs.readFileSync(path.join(path.dirname(require.resolve('7z-wasm/7zz.umd.js')), '7zz.wasm')));
    return await SevenZip({
        print: line => output.push(line),
        printErr: line => output.push(line),
        instantiateWasm(imports, done) {
            WebAssembly.instantiate(wasmModule, imports).then(instance => done(instance, wasmModule));
            return {};
        },
    });
}

//Каталог реальной ФС, подключённый на время вызова
function mount(sz, dir) {
    const point = `/m${++mountId}`;
    sz.FS.mkdir(point);
    sz.FS.mount(sz.NODEFS, {root: dir}, point);
    return point;
}

function unmount(sz, point) {
    try {
        sz.FS.unmount(point);
        sz.FS.rmdir(point);
    } catch (e) {
        //точка уже снята
    }
}

//Строки вывода 7-Zip без заставки и прогресса: из них собирается текст ошибки
function meaningfulLines() {
    return output
        .filter(line => line.trim() && !line.includes('\b') && !/^7-Zip |^ \d+-bit |^Scanning |^Listing archive|^Extracting archive|^--$|^Path = |^Type = /.test(line))
        .map(line => line.trim());
}

function run(sz, args) {
    output = [];
    let code = 0;
    let crashed = false;
    try {
        code = sz.callMain(args);
    } catch (e) {
        //exit() внутри 7-Zip приходит исключением ExitStatus, исключение C++ - числом (указателем)
        code = (e && Number.isInteger(e.status) ? e.status : 2);
        crashed = !(e && Number.isInteger(e.status));
    }
    if (code !== 0) {
        const lines = meaningfulLines();
        const errors = lines.filter(line => /error|unsupported|cannot|can not|errno/i.test(line));
        const message = (errors.length ? errors : lines.slice(-2)).join('; ');
        throw new Error(`7-Zip: ${message || (crashed ? 'cannot read the archive (damaged or unsupported)' : `exit code ${code}`)}`);
    }
    return output.join('\n');
}

function withArchive(sz, file, task) {
    if (isS3(file)) {
        const point = `/s3${++mountId}`;
        sz.FS.mkdir(point);
        const name = path.posix.basename(file);
        const s3File = createNode(sz, point, name, file);
        try {
            return task(`${point}/${name}`);
        } catch (e) {
            throw s3File.error || Object.assign(e, {message: e.message.split(`${point}/${name}`).join(file)});
        }
    }

    const dir = path.dirname(path.resolve(file));
    const point = mount(sz, dir);
    try {
        return task(`${point}/${path.basename(file)}`);
    } catch (e) {
        e.message = e.message.split(`${point}/`).join(`${dir}/`);
        throw e;
    } finally {
        unmount(sz, point);
    }
}

function removeTree(sz, dir) {
    for (const name of sz.FS.readdir(dir)) {
        if (name === '.' || name === '..')
            continue;
        const item = `${dir}/${name}`;
        if (sz.FS.isDir(sz.FS.lstat(item).mode))
            removeTree(sz, item);
        else
            sz.FS.unlink(item);
    }
    sz.FS.rmdir(dir);
}

function parseListing(listing) {
    const result = [];
    let entry = null;
    let inEntries = false;
    const commit = () => {
        if (entry && entry.name)
            result.push(entry);
        entry = null;
    };

    for (const line of listing.split(/\r?\n/)) {
        if (/^-{5,}$/.test(line.trim())) {
            inEntries = true;
            continue;
        }
        if (!inEntries)
            continue;
        if (!line.trim()) {
            commit();
            continue;
        }

        const match = line.match(/^([^=]+) = (.*)$/);
        if (!match)
            continue;
        const key = match[1].trim();
        const value = match[2];
        entry = entry || {name: '', isDirectory: false, isLink: false, size: 0};
        if (key === 'Path')
            entry.name = value.replace(/\\/g, '/');
        else if (key === 'Size')
            entry.size = Number(value) || 0;
        else if (key === 'Folder')
            entry.isDirectory = entry.isDirectory || value === '+';
        else if (key === 'Attributes' && /^D/.test(value))
            entry.isDirectory = true;
        if (['Symbolic Link', 'Hard Link'].includes(key) || (key === 'Attributes' && /l[rwx-]{9}/.test(value)))
            entry.isLink = true;
    }
    commit();
    return result;
}

async function list(file) {
    const sz = await load();
    return withArchive(sz, file, archive => parseListing(run(sz, ['l', '-slt', '-sccUTF-8', '--', archive])));
}

function readTree(sz, dir, prefix = '', result = {}) {
    for (const name of sz.FS.readdir(dir)) {
        if (name === '.' || name === '..')
            continue;
        const item = `${dir}/${name}`;
        if (sz.FS.isDir(sz.FS.lstat(item).mode))
            readTree(sz, item, `${prefix}${name}/`, result);
        else
            result[`${prefix}${name}`] = Buffer.from(sz.FS.readFile(item));
    }
    return result;
}

//Распаковывает записи в память: {имя: Buffer}; записей, которых в архиве нет, в ответе нет.
//pattern - шаблон 7-Zip вместо имени (см. ZipReader.cp866Pattern): в ответе все подошедшие записи.
async function extract(file, names = [], pattern = '') {
    const sz = await load();
    const outDir = `/out${++mountId}`;
    sz.FS.mkdir(outDir);
    try {
        return withArchive(sz, file, (archive) => {
            //-spd: имена без шаблонов (* и ? в имени файла - обычные символы)
            run(sz, ['x', '-y', '-bd', '-sccUTF-8', `-o${outDir}`, ...(pattern ? ['--', archive, pattern] : ['-spd', '--', archive, ...names])]);
            const found = readTree(sz, outDir);
            return (pattern ? found : Object.fromEntries(names.filter(name => found[name]).map(name => [name, found[name]])));
        });
    } finally {
        removeTree(sz, outDir);
    }
}

//true - запись найдена и записана в outputFile. 7-Zip пишет прямо на диск через подключённый каталог: большая
//запись не копируется в память. Временный каталог рядом с outputFile - rename в пределах одной ФС.
async function extractToFile(file, name, outputFile) {
    const sz = await load();
    //resolve: на Windows путь с / вперемешку с \ не прошёл бы проверку startsWith ниже
    const tempDir = path.resolve(fs.mkdtempSync(`${outputFile}.`));
    const point = mount(sz, tempDir);
    try {
        //-spd: имя без шаблонов, как в extract
        withArchive(sz, file, archive => run(sz, ['x', '-y', '-bd', '-sccUTF-8', `-o${point}`, '-spd', '--', archive, name]));
        const extracted = path.join(tempDir, name);
        //имя с .. не должно указать на файл вне временного каталога
        if (!extracted.startsWith(tempDir + path.sep) || !fs.statSync(extracted, {throwIfNoEntry: false})?.isFile())
            return false;
        fs.renameSync(extracted, outputFile);
        return true;
    } finally {
        unmount(sz, point);
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
}

async function extractAll(file, outputDir) {
    const sz = await load();
    fs.mkdirSync(outputDir, {recursive: true});
    const point = mount(sz, path.resolve(outputDir));
    try {
        withArchive(sz, file, archive => run(sz, ['x', '-y', '-bd', '-sccUTF-8', `-o${point}`, '--', archive]));
    } finally {
        unmount(sz, point);
    }
}

module.exports = {list, extract, extractToFile, extractAll, parseListing};
