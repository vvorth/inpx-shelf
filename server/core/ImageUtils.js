const fs = require('fs-extra');
const path = require('path');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');

const utils = require('./utils');
const externalTools = require('./ExternalTools');
const {runProcess} = require('./ConversionRuntime');
const {t} = require('./i18n');

function contentType(buf) {
    if ((buf.length >= 2 && buf[0] == 0xff && buf[1] == 0x0a)
        || (buf.length >= 12 && buf.subarray(0, 12).equals(Buffer.from('0000000c4a584c200d0a870a', 'hex'))))
        return 'image/jxl';

    if (buf.length >= 8 && buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4e && buf[3] == 0x47)
        return 'image/png';

    if (buf.length >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff)
        return 'image/jpeg';

    if (buf.length >= 6 && buf.slice(0, 6).toString() == 'GIF89a')
        return 'image/gif';

    if (buf.length >= 6 && buf.slice(0, 6).toString() == 'GIF87a')
        return 'image/gif';

    if (buf.length >= 12 && buf.slice(0, 4).toString() == 'RIFF' && buf.slice(8, 12).toString() == 'WEBP')
        return 'image/webp';

    return 'application/octet-stream';
}

function shouldSkipToolError(err, command) {
    if (externalTools.isMissingToolError(err))
        return true;

    if (process.platform === 'win32')
        return false;

    const commandText = String(command || (err && err.command) || '');
    const stderr = String((err && (err.stderr || err.message)) || '');
    if (/\.exe$/i.test(commandText))
        return true;

    return /MZ[\s\S]*(?:not found|Syntax error)/i.test(stderr);
}

// Внешний конвертер: пробуем кандидатов по очереди, отсутствующие пропускаем.
async function convertWithTool(buf, tempDir, inputExt, outputExt, commands, toolArgs, toolCode, helpMessage) {
    const id = utils.randomHexString(30);
    const inputFile = `${tempDir}/${id}.${inputExt}`;
    const outputFile = `${tempDir}/${id}.${outputExt}`;

    try {
        await fs.writeFile(inputFile, buf);
        let lastError = null;

        for (const command of commands) {
            try {
                if (shouldSkipToolError(null, command))
                    continue;

                await runProcess(command, toolArgs(inputFile, outputFile));
                return await fs.readFile(outputFile);
            } catch (err) {
                lastError = (err.code === 'ENOENT' ? externalTools.createMissingToolError(toolCode, helpMessage) : err);
                if (shouldSkipToolError(lastError, command))
                    continue;

                throw lastError;
            }
        }

        throw (lastError || externalTools.createMissingToolError(toolCode, helpMessage));
    } finally {
        await fs.remove(inputFile);
        await fs.remove(outputFile);
    }
}

function jxlToImage(buf, tempDir, toolDirs = [], converterPaths = null, extension = 'png') {
    return convertWithTool(buf, tempDir, 'jxl', extension, externalTools.djxlCommandCandidates(toolDirs, converterPaths),
        (input, output) => [input, output], 'INPX_MISSING_DJXL', externalTools.missingDjxlMessage());
}

async function normalizeForEpub(buf, fileName, tempDir, toolDirs = [], converterPaths = null) {
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const type = contentType(buf);
    if (type === 'image/jxl') {
        if (!['png', 'jpg', 'jpeg'].includes(extension))
            throw new Error(t('errors.epubUnsupportedImage', {name: fileName}));
        return await jxlToImage(buf, tempDir, toolDirs, converterPaths, extension);
    }
    if (type === 'image/webp' && extension === 'png')
        return await webpToPng(buf, tempDir, toolDirs, converterPaths);
    return buf;
}

function webpToPng(buf, tempDir, toolDirs = [], converterPaths = null) {
    return convertWithTool(buf, tempDir, 'webp', 'png', externalTools.dwebpCommandCandidates(toolDirs, converterPaths),
        (input, output) => [input, '-o', output], 'INPX_MISSING_DWEBP', externalTools.missingDwebpMessage());
}

async function normalizeForFb2(buf, tempDir, toolDirs = [], converterPaths = null) {
    const type = contentType(buf);
    if (type === 'image/jxl')
        return {data: await jxlToImage(buf, tempDir, toolDirs, converterPaths), contentType: 'image/png'};
    if (type === 'image/webp')
        return {data: await webpToPng(buf, tempDir, toolDirs, converterPaths), contentType: 'image/png'};

    return {data: buf, contentType: type};
}

// Pure JS on purpose: native image modules don't survive the pkg standalone builds.
const maxDecodePixels = 25*1000*1000;

function decodeRgba(buf) {
    const type = contentType(buf);
    if (type === 'image/jpeg') {
        const {width, height, data} = jpeg.decode(buf, {useTArray: true, formatAsRGBA: true,
            maxResolutionInMP: maxDecodePixels/1000/1000, maxMemoryUsageInMB: 256});
        return {width, height, data};
    }
    if (type === 'image/png') {
        const {width, height, data} = PNG.sync.read(buf);
        return {width, height, data};
    }
    throw new Error(t('errors.coverFormatUnsupported', {type}));
}

// Area-average downscale, alpha composited over white (JPEG has no transparency).
function downscaleRgba(image, width, height) {
    const {width: sw, height: sh, data: src} = image;
    const out = Buffer.alloc(width*height*4);
    for (let oy = 0; oy < height; oy++) {
        const y0 = Math.floor(oy*sh/height);
        const y1 = Math.max(y0 + 1, Math.floor((oy + 1)*sh/height));
        for (let ox = 0; ox < width; ox++) {
            const x0 = Math.floor(ox*sw/width);
            const x1 = Math.max(x0 + 1, Math.floor((ox + 1)*sw/width));
            let r = 0, g = 0, b = 0;
            for (let y = y0; y < y1; y++) {
                let i = (y*sw + x0)*4;
                for (let x = x0; x < x1; x++, i += 4) {
                    const a = src[i + 3]/255;
                    r += src[i]*a + 255*(1 - a);
                    g += src[i + 1]*a + 255*(1 - a);
                    b += src[i + 2]*a + 255*(1 - a);
                }
            }
            const n = (y1 - y0)*(x1 - x0);
            const o = (oy*width + ox)*4;
            out[o] = Math.round(r/n);
            out[o + 1] = Math.round(g/n);
            out[o + 2] = Math.round(b/n);
            out[o + 3] = 255;
        }
    }
    return {width, height, data: out};
}

// Fits a JPEG or PNG image inside maxWidth x maxHeight (never enlarging it) and returns a JPEG.
// Returns null when the source is already a JPEG that fits, so the caller can send it as is.
function fitToJpeg(buf, maxWidth, maxHeight, quality = 85) {
    const image = decodeRgba(buf);
    if (!image.width || !image.height || image.width*image.height > maxDecodePixels)
        throw new Error(t('errors.coverSizeInvalid', {width: image.width, height: image.height}));

    const scale = Math.min(1, maxWidth/image.width, maxHeight/image.height);
    if (scale === 1 && contentType(buf) === 'image/jpeg')
        return null;

    const width = Math.max(1, Math.round(image.width*scale));
    const height = Math.max(1, Math.round(image.height*scale));
    return jpeg.encode(downscaleRgba(image, width, height), quality).data;
}

module.exports = {
    contentType,
    fitToJpeg,
    webpToPng,
    normalizeForFb2,
    normalizeForEpub,
};
