const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

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

    await fs.writeFile(verFile, publicVersion);
    await fs.remove(zipFile);
};

module.exports.applyRootPath = applyRootPath;
