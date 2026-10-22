//Чтение INPX для БД библиотеки: фильтр filter.json и сведения о коллекции.
//Порядок и отбор записей те же, что у прежнего DbCreator: id книг и их _uid не меняются.
const fs = require('fs-extra');
const InpxParser = require('../InpxParser');
const libraryFs = require('../LibraryFs');
const utils = require('../utils');

const emptyFieldValue = '?';

async function loadInpxFilter(config) {
    const file = config.inpxFilterFile;
    if (!file || !await fs.pathExists(file))
        return null;

    const filter = JSON.parse(await fs.readFile(file, 'utf8'));
    if (filter.includeAuthors)
        filter.includeSet = new Set(filter.includeAuthors.map(a => a.toLowerCase()));
    if (filter.excludeAuthors)
        filter.excludeSet = new Set(filter.excludeAuthors.map(a => a.toLowerCase()));
    return filter;
}

//Функция отбора записей; filter.filter - произвольный JS, разрешается только явным флагом
function makeRecordFilter(config, inpxFilter) {
    if (!inpxFilter)
        return () => true;

    let recFilter = () => true;
    if (inpxFilter.filter) {
        if (!config.allowUnsafeFilter)
            throw new Error(`Unsafe property 'filter' detected in ${config.inpxFilterFile}. Please specify '--unsafe-filter' param if you know what you're doing.`);
        recFilter = new Function(`'use strict'; return ${inpxFilter.filter}`)();
    }

    return (rec) => {
        const author = (rec.author || emptyFieldValue).toLowerCase();
        if (inpxFilter.excludeSet && author.split(',').some(a => inpxFilter.excludeSet.has(a)))
            return false;
        return recFilter(rec) && (!inpxFilter.includeSet || inpxFilter.includeSet.has(author));
    };
}

//Сведения о коллекции: одна библиотека - её collection.info, несколько - сводка по источникам
function makeInpxInfo(parserInfos, inpxFilter) {
    const inpxInfo = (parserInfos.length === 1
        ? Object.assign({}, parserInfos[0].info)
        : {
            collection: parserInfos.map(source => source.name).join(' + '),
            version: parserInfos.map(source => source.info && source.info.version).filter(Boolean).join(' + '),
            structure: (parserInfos[0].info || {}).structure,
            recStruct: (parserInfos[0].info || {}).recStruct,
            sources: parserInfos.map(source => ({
                id: source.id,
                name: source.name,
                inpx: source.inpx,
                libDir: source.libDir,
                collection: source.info && source.info.collection,
                version: source.info && source.info.version,
            })),
        });
    if (inpxFilter && inpxFilter.info) {
        if (inpxFilter.info.collection)
            inpxInfo.collection = inpxFilter.info.collection;
        if (inpxFilter.info.version)
            inpxInfo.version = inpxFilter.info.version;
    }
    return inpxInfo;
}

//Импорт всех библиотек в начатую сборку (index - CatalogIndex после beginBuild). Идёт в потоке сборки: разбор 700 тыс.
//строк INPX не держит основной поток. Пропуск повторов _uid и порядок id - в insertBooks.
//filterConfig - {inpxFilterFile, allowUnsafeFilter}; overrides - правки метаданных по _uid; onProgress(0..0.9)
async function importLibrary(index, {sources, filterConfig, overrides}, onProgress = () => {}) {
    const inpxFilter = await loadInpxFilter(filterConfig);
    const filter = makeRecordFilter(filterConfig, inpxFilter);
    const parserInfos = [];
    let recsLoaded = 0;
    for (const [i, source] of sources.entries()) {
        let totalFiles = 0;
        const onFile = async(state) => {
            if (state.totalFiles)
                totalFiles = state.totalFiles;
            if (totalFiles)
                onProgress(Math.min(0.9, (i + (state.current || 0) / totalFiles) / sources.length * 0.9));
        };
        const onChunk = async(chunk) => {
            const rows = [];
            for (const rec of chunk) {
                rec.sourceId = source.id;
                //путь книги, выходящий за каталог библиотеки, отсеивается, как строка, не прошедшая фильтр
                if (!libraryFs.isSafeRelativePath(rec.folder) || !libraryFs.isSafeRelativePath(rec.file) || !filter(rec))
                    continue;
                const override = overrides[rec._uid];
                if (override) {
                    //как WebWorker.applyMetadataOverrideToBook: поля правки поверх полей INPX
                    rec.shown = {};
                    for (const field of ['title', 'author', 'series', 'serno'])
                        rec.shown[field] = (utils.hasProp(override, field) ? override[field] : rec[field]);
                }
                rows.push(rec);
            }
            recsLoaded += chunk.length;
            index.insertBooks(rows);
        };

        const parser = new InpxParser();
        await parser.parse(source.inpx, onFile, onChunk);
        parserInfos.push({id: source.id, name: source.name, inpx: source.inpx, libDir: source.libDir, info: parser.info});
    }
    return {recsLoaded, inpxInfo: JSON.stringify(makeInpxInfo(parserInfos, inpxFilter))};
}

module.exports = {loadInpxFilter, makeRecordFilter, makeInpxInfo, importLibrary};
