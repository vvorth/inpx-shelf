// Прогресс чтения из профиля (user.readerProgress): прочитана ли книга, читается ли сейчас

// A book read to 99.9% or more counts as read, not in progress.
const READ_PERCENT = 0.999;

function isReadingInProgress(progress) {
    return !!progress && progress.hidden !== true && !((Number(progress.percent) || 0) >= READ_PERCENT);
}

function readerProgressOf(user) {
    return (user && user.readerProgress && typeof(user.readerProgress) === 'object' ? user.readerProgress : {});
}

module.exports = {READ_PERCENT, isReadingInProgress, readerProgressOf};
