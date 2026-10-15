const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {promisify} = require('util');

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

module.exports = async(config) => {
    const webApp = require('../dist/public.json');
    const verFile = `${config.publicDir}/version.txt`;
    const zipFile = `${config.tempDir}/public.zip`;
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

    await fs.remove(config.publicDir);

    // Extract the new web app bundle.
    await fs.writeFile(zipFile, webApp.data, {encoding: 'base64'});
    const zipReader = new ZipReader();
    await zipReader.open(zipFile);

    try {
        await zipReader.extractAllToDir(config.publicDir);
    } finally {
        await zipReader.close();
    }
    await applyRootPath(config);
    await precompress(config);

    await fs.writeFile(verFile, publicVersion);
    await fs.remove(zipFile);
};

module.exports.applyRootPath = applyRootPath;
module.exports.precompress = precompress;
module.exports.compressibleFile = compressibleFile;
