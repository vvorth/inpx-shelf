const crypto = require('crypto');
const {getSourceLibDir} = require('./LibrarySources');

//папка библиотеки - по sourceId из настроек: другая папка источника - другие обложки
function coverCacheKey(book, config) {
    const identity = [book._uid, book.sourceId, getSourceLibDir(config, book.sourceId), book.folder, book.file, book.ext];
    return `book-v2-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

module.exports = {coverCacheKey};
