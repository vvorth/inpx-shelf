// Прогресс чтения из профиля (user.readerProgress): прочитана ли книга, читается ли сейчас
const {reachesReadMark} = require('../../shared/readMark');

function isProgressRead(progress) {
    return !!progress && progress.read === true;
}

// A read book is not in progress, whatever its percent.
function isReadingInProgress(progress) {
    return !!progress && progress.hidden !== true && !isProgressRead(progress);
}

function readerProgressOf(user) {
    return (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {});
}

module.exports = {reachesReadMark, isProgressRead, isReadingInProgress, readerProgressOf};
