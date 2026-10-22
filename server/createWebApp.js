const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {promisify} = require('util');
const _ = require('lodash');

const ZipReader = require('./core/ZipReader');
const utils = require('./core/utils');
const webAppDir = require('../build/appdir');

//сборка ссылается на /<webAppDir>: при rootPath подменяем пути один раз при распаковке, до старта сервера
async function applyRootPath(config) {
    if (!config.rootPathStatic)
        return;

    const re = new RegExp(`/${webAppDir}`, 'g');
    await utils.findFiles(async(file) => {
        if (['.html', '.js', '.css'].includes(path.extname(file))) {
            const content = await fs.readFile(file, 'utf8');
            await fs.writeFile(file, content.replace(re, `${config.rootPathStatic}/${webAppDir}`));
        }
    }, config.publicDir);
}

//шрифты woff/woff2, картинки и архивы уже сжаты и в список не входят
const compressibleFile = /\.(js|css|html|json|svg|webmanifest|txt|ico|ttf|eot|otf)$/i;

//Сжатые копии (.br, .gz) рядом с файлами готовятся один раз на версию, после подстановки rootPath: сервер отдаёт их
//готовыми (static.js), без сжатия на каждый запрос и без копий в памяти. Копия, которая не меньше файла, не пишется
async function precompress(config) {
    const gzip = promisify(zlib.gzip);
    const brotli = promisify(zlib.brotliCompress);
    const files = [];
    await utils.findFiles(async(file) => {
        if (compressibleFile.test(file))
            files.push(file);
    }, config.publicDir);

    //по 4 файла - по числу потоков libuv: быстрее, а память кодировщиков brotli не копится
    for (let i = 0; i < files.length; i += 4) {
        await Promise.all(files.slice(i, i + 4).map(async(file) => {
            const data = await fs.readFile(file);
            const packed = await Promise.all([
                gzip(data, {level: zlib.constants.Z_BEST_COMPRESSION}),
                brotli(data, {params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
                }}),
            ]);
            for (const [ext, packedData] of [['.gz', packed[0]], ['.br', packed[1]]]) {
                if (packedData.length < data.length)
                    await fs.writeFile(file + ext, packedData);
            }
        }));
    }
}

//Незаконченная распаковка (сбой, другой экземпляр) старше этого срока - мусор
const staleExtractMs = 60*60*1000;

async function removeStaleExtracts(publicDir) {
    const parent = path.dirname(publicDir);
    const re = new RegExp(`^${_.escapeRegExp(path.basename(publicDir))}\\.[0-9a-f]+\\.tmp$`);
    for (const name of await fs.readdir(parent)) {
        const dir = path.join(parent, name);
        const stat = (re.test(name) ? await fs.stat(dir).catch(() => null) : null);
        if (stat && Date.now() - stat.mtimeMs > staleExtractMs)
            await fs.remove(dir);
    }
}

//webApp - для тестов; по умолчанию сборка клиента из dist/public.json
module.exports = async(config, webApp = require('../dist/public.json')) => {
    const verFile = `${config.publicDir}/version.txt`;
    const publicVersion = [
        config.version,
        config.rootPathStatic,
        crypto.createHash('sha1').update(webApp.data).digest('hex').substring(0, 12),
    ].join(':');

    if (await fs.pathExists(verFile)) {
        const curPublicVersion = await fs.readFile(verFile, 'utf8');
        if (curPublicVersion == publicVersion)
            return;
    }

    //Распаковка во временный каталог рядом и переименование: сбой посередине или второй экземпляр
    //не оставляют недораспакованное приложение под рабочим именем
    await fs.ensureDir(path.dirname(config.publicDir));
    await removeStaleExtracts(config.publicDir);
    const token = crypto.randomBytes(6).toString('hex');
    const extractDir = `${config.publicDir}.${token}.tmp`;
    const zipFile = `${config.tempDir}/public.${token}.zip`;
    const extractConfig = {...config, publicDir: extractDir};
    try {
        await fs.writeFile(zipFile, webApp.data, {encoding: 'base64'});
        const zipReader = new ZipReader();
        await zipReader.open(zipFile);
        try {
            await zipReader.extractAllToDir(extractDir);
        } finally {
            await zipReader.close();
        }
        await applyRootPath(extractConfig);
        await precompress(extractConfig);
        await fs.writeFile(`${extractDir}/version.txt`, publicVersion);

        //прежняя версия уходит под временное имя: рабочий каталог отсутствует лишь между двумя rename
        const oldDir = `${config.publicDir}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        if (await fs.pathExists(config.publicDir))
            await fs.rename(config.publicDir, oldDir);
        try {
            await fs.rename(extractDir, config.publicDir);
        } catch (error) {
            //другой экземпляр успел положить ту же версию
            if (!await fs.pathExists(verFile) || await fs.readFile(verFile, 'utf8') !== publicVersion)
                throw error;
        }
        await fs.remove(oldDir);
    } finally {
        await fs.remove(extractDir);
        await fs.remove(zipFile);
    }
};

module.exports.applyRootPath = applyRootPath;
module.exports.precompress = precompress;
module.exports.compressibleFile = compressibleFile;
