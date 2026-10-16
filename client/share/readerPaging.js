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

//Страница с фрагментом найдена среди первых count готовых страниц и останется ответом, когда разбивка
//дойдёт до конца: ищется ближайшая к preferredIndex, при равенстве - первая, а любая следующая страница
//не ближе count - preferredIndex
function isSnippetMatchFinal(count = 0, preferredIndex = -1, bestIndex = -1, bestDistance = Infinity) {
    if (!(bestIndex >= 0) || bestIndex >= count)
        return false;
    if (!(preferredIndex >= 0) || bestDistance === 0)
        return true;
    return count - preferredIndex >= bestDistance;
}

//Запасная разбивка абзаца без замеров: куски около targetLength по границам предложений, длинное предложение - по словам.
//Склейка кусков через пробел даёт исходный текст (с нормализованными пробелами)
function splitTextIntoReadableChunks(text = '', targetLength = 420, minChunkLength = 140) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source)
        return [];

    const sentenceParts = source.match(/[^.!?…]+(?:[.!?…]+|$)/g) || [source];
    const chunks = [];
    let current = '';

    const pushCurrent = () => {
        const value = String(current || '').trim();
        if (value)
            chunks.push(value);
        current = '';
    };

    const pushWords = (sentence = '') => {
        const words = String(sentence || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length)
            return;

        let part = '';
        for (const word of words) {
            const candidate = (part ? `${part} ${word}` : word);
            if (part && candidate.length > targetLength) {
                chunks.push(part);
                part = word;
            } else {
                part = candidate;
            }
        }

        if (part)
            chunks.push(part);
    };

    for (const sentence of sentenceParts.map((item) => String(item || '').trim()).filter(Boolean)) {
        const candidate = (current ? `${current} ${sentence}` : sentence);
        if (!current || candidate.length <= targetLength) {
            current = candidate;
            continue;
        }

        if (current.length >= minChunkLength) {
            pushCurrent();
        }

        if (sentence.length > targetLength) {
            if (current)
                pushCurrent();
            pushWords(sentence);
        } else {
            //короткий кусок (меньше minChunkLength) не теряется: он идёт в начало следующего
            current = (current ? `${current} ${sentence}` : sentence);
        }
    }

    if (current)
        pushCurrent();

    return chunks.filter(Boolean);
}

//Слова абзаца с разметкой обратно в html: пробел только там, где он был в тексте (token.gap).
//Иначе «сказал <em>он</em>.» после разреза на странице превращалось в «сказал он .»
function joinInlineTokens(tokens = []) {
    return tokens.map((token, index) => `${(index > 0 && token.gap !== false) ? ' ' : ''}${token.html}`).join('').trim();
}

module.exports = {
    isPagedStageCurrent,
    findLastFit,
    isSnippetMatchFinal,
    splitTextIntoReadableChunks,
    joinInlineTokens,
};
