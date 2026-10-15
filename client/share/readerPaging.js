//Правила разбивки режима страниц без DOM: проверяются тестами в scripts/reader-tests.js.

//Лист на экране совпадает с высотой страницы из подписи раскладки. Высоту листу задаёт CSS-переменная,
//которую Vue выставляет только при перерисовке: сразу после смены размера лист ещё старой высоты,
//и разбивка по нему легла бы в кэш под новой подписью (на 1366 - 422 страницы вместо 81)
function isPagedStageCurrent(stageHeight = 0, pageHeight = 0) {
    const stage = Math.round(Number(stageHeight) || 0);
    const page = Math.round(Number(pageHeight) || 0);
    return stage > 0 && page > 0 && Math.abs(stage - page) <= 1;
}

module.exports = {
    isPagedStageCurrent,
};
