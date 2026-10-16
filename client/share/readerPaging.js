//Правила разбивки режима страниц без DOM: проверяются тестами в scripts/reader-tests.js.

//Лист на экране совпадает с высотой страницы из подписи раскладки. Высоту листу задаёт CSS-переменная,
//которую Vue выставляет только при перерисовке: сразу после смены размера лист ещё старой высоты,
//и разбивка по нему легла бы в кэш под новой подписью (на 1366 - 422 страницы вместо 81)
function isPagedStageCurrent(stageHeight = 0, pageHeight = 0) {
    const stage = Math.round(Number(stageHeight) || 0);
    const page = Math.round(Number(pageHeight) || 0);
    return stage > 0 && page > 0 && Math.abs(stage - page) <= 1;
}

//Наибольший конец end из [low, high], при котором fits(end) (fits монотонна: больше слов - не уже), или -1.
//Итог тот же, что у двоичного поиска, но сперва проверяется догадка и её сосед: при верной догадке
//это два замера вместо log2(high - low). Догадка low - 1 значит «не войдёт ни одно слово»
function findLastFit(fits, low, high, guess = NaN) {
    let best = -1;
    let lo = low;
    let hi = high;
    const at = Math.round(Number(guess));
    if (Number.isFinite(at) && low <= high) {
        const probe = Math.max(low - 1, Math.min(high, at));
        if (probe < low) {
            if (!fits(low))
                return -1;
            best = low;
            lo = low + 1;
        } else if (fits(probe)) {
            best = probe;
            if (probe === high || !fits(probe + 1))
                return probe;
            best = probe + 1;
            lo = probe + 2;
        } else {
            if (probe === low || fits(probe - 1))
                return (probe === low ? -1 : probe - 1);
            hi = probe - 2;
        }
    }

    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

module.exports = {
    isPagedStageCurrent,
    findLastFit,
};
