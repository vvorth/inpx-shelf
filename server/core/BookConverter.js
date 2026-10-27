const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const utils = require('./utils');
const {ConversionRuntime, runProcess: run} = require('./ConversionRuntime');
const runtime = new ConversionRuntime();
const externalTools = require('./ExternalTools');
const {bundledBinDir} = externalTools;

const validatedFb2cngConfigs = new Set();
const conversionCacheSchema = 'v2';
const targetFormats = new Set(['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf']);
const fb2cngFormats = new Map([
    ['epub', 'epub2'],
    ['epub3', 'epub3'],
    ['kepub', 'kepub'],
    ['kfx', 'kfx'],
    ['azw8', 'azw8'],
]);
const fb2cngOutputExtensions = new Map([
    ['epub3', 'epub'],
    ['kepub', 'kepub.epub'],
]);

function getConvertedExtension(fileType) {
    const normalizedFileType = String(fileType || '').toLowerCase();
    const outputExtension = fb2cngOutputExtensions.get(normalizedFileType) || normalizedFileType;
    return outputExtension;
}

function getConvertedFileName(originalFileName, format) {
    const ext = path.extname(originalFileName);
    const base = (ext ? originalFileName.slice(0, -ext.length) : originalFileName);
    const extNew = getConvertedExtension(format);
    return `${base}.${extNew}`;
}

function bundledToolPath(fileName) {
    const dir = bundledBinDir();
    return dir ? path.join(dir, fileName) : '';
}

function localToolPath(fileName) {
    return path.join(process.cwd(), 'bin', fileName);
}

const fbcFileName = process.platform === 'win32' ? 'fbc.exe' : 'fbc';
const mutoolFileName = process.platform === 'win32' ? 'mutool.exe' : 'mutool';
function fb2cngCommandCandidates(converterPaths = null) {
    return [
        ...externalTools.configuredToolCandidates(externalTools.resolveConverterPaths(converterPaths), ['fb2cng', 'fbc']),
        bundledToolPath(fbcFileName),
        localToolPath(fbcFileName),
        'fbc',
        '/usr/local/bin/fbc',
        '/usr/bin/fbc',
    ].filter(Boolean);
}

function mutoolCommandCandidates(converterPaths = null) {
    return [
        ...externalTools.configuredToolCandidates(externalTools.resolveConverterPaths(converterPaths), ['mutool', 'mupdf']),
        bundledToolPath(mutoolFileName),
        localToolPath(mutoolFileName),
        'mutool',
        '/usr/bin/mutool',
        '/usr/local/bin/mutool',
    ].filter(Boolean);
}

function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof(value) === 'object') {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function fb2cngConfigError(configPath, message) {
    const error = new Error(`Invalid fb2cng config "${configPath}": ${message}`);
    error.code = 'INPX_INVALID_FB2CNG_CONFIG';
    return error;
}

async function readFb2cngConfig(configPath = '') {
    const rawPath = String(configPath || '').trim();
    if (!rawPath)
        return {path: '', fingerprint: 'default'};

    const resolvedPath = path.resolve(rawPath);
    let stat;
    try {
        stat = await fs.stat(resolvedPath);
        await fs.access(resolvedPath, fs.constants.R_OK);
    } catch (err) {
        throw fb2cngConfigError(resolvedPath, 'file does not exist or is not readable');
    }

    if (!stat.isFile())
        throw fb2cngConfigError(resolvedPath, 'path is not a regular file');

    let content;
    try {
        content = await fs.readFile(resolvedPath);
    } catch (err) {
        throw fb2cngConfigError(resolvedPath, 'file cannot be read');
    }

    const fingerprint = crypto.createHash('sha256')
        .update(resolvedPath)
        .update('\0')
        .update(content)
        .digest('hex');
    return {path: resolvedPath, fingerprint};
}

async function validateFb2cngConfig(configInfo, converterPaths = null, runner = runFirst) {
    if (!configInfo || !configInfo.path)
        return;

    const commands = fb2cngCommandCandidates(converterPaths);
    const validationKey = crypto.createHash('sha256')
        .update(configInfo.fingerprint)
        .update('\0')
        .update(stableStringify(commands))
        .digest('hex');
    if (validatedFb2cngConfigs.has(validationKey))
        return;

    try {
        await runner(commands, ['--config', configInfo.path, 'dumpconfig']);
    } catch (err) {
        if (err.code === 'INPX_CONVERSION_TIMEOUT')
            throw err;
        throw fb2cngConfigError(configInfo.path, err.message);
    }
    validatedFb2cngConfigs.add(validationKey);
}

async function getConversionCacheInfo({cacheBasePath, inputFile = '', sourceFileName = '', format, config = {}}) {
    const normalizedFormat = String(format || '').toLowerCase();
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!cacheBasePath)
        throw new Error('Conversion cache base path is empty');
    if (!canConvertSourceTo(sourceExt, normalizedFormat))
        throw new Error(`Unsupported convert format: ${sourceExt || 'unknown'} -> ${normalizedFormat}`);

    const usesFb2cng = sourceExt === '.fb2' && fb2cngFormats.has(normalizedFormat);
    const fb2cngConfig = usesFb2cng
        ? await readFb2cngConfig(config.fb2cngConfigPath)
        : {path: '', fingerprint: 'not-used'};
    const signature = stableStringify({
        schema: conversionCacheSchema,
        format: normalizedFormat,
        sourceExt,
        fb2cngConfigFingerprint: fb2cngConfig.fingerprint,
        fb2cngVersion: usesFb2cng ? String(config.fb2cngVersion || '') : '',
        converterPaths: config.converterPaths || {},
    });
    const fingerprint = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
    const extension = getConvertedExtension(normalizedFormat);

    return {
        filePath: `${cacheBasePath}.converted-${conversionCacheSchema}-${normalizedFormat}-${fingerprint}.${extension}`,
        fingerprint,
        fb2cngConfig,
        format: normalizedFormat,
        sourceExt,
        usesFb2cng,
    };
}

function canConvertTo(format) {
    return targetFormats.has((format || '').toLowerCase());
}

function canConvertSourceTo(sourceExt, format) {
    sourceExt = String(sourceExt || '').toLowerCase().replace(/^\./, '');
    format = String(format || '').toLowerCase();

    if (!canConvertTo(format))
        return false;
    if (sourceExt === 'fb2')
        return true;

    return sourceExt === 'epub' && format === 'pdf';
}

async function runFirst(commands, args, options = {}) {
    let lastError = null;

    for (const command of commands) {
        try {
            await run(command, args, options);
            return;
        } catch(e) {
            lastError = e;
            if (e.code !== 'ENOENT')
                throw e;
        }
    }

    throw (lastError || new Error('converter not found'));
}

async function convertWithFb2cng(inputFile, outputFile, format, converterPaths = null, fb2cngConfigPath = null) {
    const outputDir = `${outputFile}.fb2cng`;
    const fb2cngFormat = fb2cngFormats.get(format);
    const configInfo = await readFb2cngConfig(fb2cngConfigPath);
    await validateFb2cngConfig(configInfo, converterPaths);
    const fb2cngArgs = [
        ...(configInfo.path ? ['--config', configInfo.path] : []),
        'convert', '--to', fb2cngFormat, '--overwrite', inputFile, outputDir,
    ];

    await fs.remove(outputDir);
    await fs.ensureDir(outputDir);
    try {
        await runFirst(fb2cngCommandCandidates(converterPaths), fb2cngArgs);

        const outputExtension = `.${getConvertedExtension(format)}`;
        const firstMatchedFile = (await fs.readdir(outputDir))
            .find(file => file.toLowerCase().endsWith(outputExtension));
        const converted = firstMatchedFile ? path.join(outputDir, firstMatchedFile) : undefined;

        if (!converted)
            throw new Error(`fb2cng did not produce ${format}`);

        await fs.move(converted, outputFile, {overwrite: true});
    } finally {
        await fs.remove(outputDir);
    }
}

async function convertWithMutool(inputFile, outputFile, converterPaths = null) {
    await runFirst(mutoolCommandCandidates(converterPaths), ['convert', '-o', outputFile, inputFile]);
}

async function convertPrepared(convertInput, outputFile, format, converterPaths = null, fb2cngConfigPath = null) {
    if (fb2cngFormats.has(format) && path.extname(convertInput).toLowerCase() === '.fb2') {
        await convertWithFb2cng(convertInput, outputFile, format, converterPaths, fb2cngConfigPath);
        return;
    }

    if (format === 'pdf' && ['.fb2', '.epub'].includes(path.extname(convertInput).toLowerCase())) {
        await convertWithMutool(convertInput, outputFile, converterPaths);
        return;
    }

    throw new Error(`Unsupported convert format: ${path.extname(convertInput) || 'unknown'} -> ${format}`);
}

async function convert({inputFile, outputFile, format, sourceFileName = '', converterPaths = null, fb2cngConfigPath = null}) {
    format = String(format || '').toLowerCase();
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!canConvertSourceTo(sourceExt, format))
        throw new Error(`Unsupported convert format: ${sourceExt || 'unknown'} -> ${format}`);

    await runtime.run(async() => {
        await fs.ensureDir(path.dirname(outputFile));
        let convertInput = inputFile;
        let tempInput = '';
        const workingOutput = `${outputFile}.work-${crypto.randomBytes(8).toString('hex')}.${getConvertedExtension(format)}`;
        const sourceExt = path.extname(sourceFileName || '').toLowerCase();

        try {
            if (sourceExt && sourceExt !== path.extname(inputFile).toLowerCase()) {
                tempInput = `${outputFile}.input-${crypto.randomBytes(8).toString('hex')}${sourceExt}`;
                await fs.copyFile(inputFile, tempInput);
                convertInput = tempInput;
            }
            await convertPrepared(convertInput, workingOutput, format, converterPaths, fb2cngConfigPath);
            await fs.rename(workingOutput, outputFile);
        } finally {
            await fs.remove(workingOutput);
            if (tempInput)
                await fs.remove(tempInput);
        }
    });
}

async function prepareConvertedFile({
    inputFile,
    cacheBasePath,
    format,
    sourceFileName,
    downFileName,
    config,
    unsupportedMessage = '',
    disabledMessage = '',
}) {
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!canConvertSourceTo(sourceExt, format))
        throw new Error(unsupportedMessage || `Unsupported convert format: ${sourceExt || 'unknown'} -> ${format}`);

    if (!config.conversionEnabled)
        throw new Error(disabledMessage || 'Book conversion is disabled');

    const cacheInfo = await getConversionCacheInfo({
        cacheBasePath,
        inputFile,
        sourceFileName,
        format,
        config,
    });

    // Concurrent requests share one conversion; the file appears in the cache only when complete.
    const created = await utils.prepareCachedFile(cacheInfo.filePath, temporaryFile => convert({
        inputFile,
        outputFile: temporaryFile,
        format: cacheInfo.format,
        sourceFileName,
        converterPaths: config.converterPaths,
        fb2cngConfigPath: config.fb2cngConfigPath,
    }));

    return {
        filePath: cacheInfo.filePath,
        downloadName: getConvertedFileName(downFileName, cacheInfo.format),
        created,
    };
}

module.exports = {
    targetFormats: [...targetFormats],
    configure: config => runtime.configure(config),
    canConvertTo,
    canConvertSourceTo,
    fb2cngCommandCandidates,
    mutoolCommandCandidates,
    convert,
    prepareConvertedFile,
    readFb2cngConfig,
    validateFb2cngConfig,
    getConversionCacheInfo,
    getConvertedFileName,
    getConvertedExtension,
};
