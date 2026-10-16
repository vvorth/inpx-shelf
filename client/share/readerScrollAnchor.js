//Место чтения в ленте - смещение символа от начала текста книги: оно не зависит от переноса строк и переживает
//смену шрифта, ширины и размера окна. Без DOM: на входе длины текстовых узлов разметки, правила проверяются тестом.

//смещение от начала текста для offset в index-м текстовом узле
function textOffset(lengths = [], index = 0, offset = 0) {
    let total = 0;
    for (let i = 0; i < index && i < lengths.length; i++)
        total += lengths[i];
    return total + offset;
}

//текстовый узел и смещение в нём для смещения от начала текста; вне текста - null
function textPosition(lengths = [], offset = -1) {
    if (!(offset >= 0))
        return null;

    let start = 0;
    for (let index = 0; index < lengths.length; index++) {
        if (offset < start + lengths[index])
            return {index, offset: offset - start};
        start += lengths[index];
    }
    return null;
}

//доля текста до смещения и обратно: место при смене режима, где смещения ленты и страниц не совпадают
function textPercent(lengths = [], offset = 0) {
    const total = textOffset(lengths, lengths.length, 0);
    return (total > 0 ? Math.max(0, Math.min(1, offset / total)) : 0);
}

function percentPosition(lengths = [], percent = 0) {
    const total = textOffset(lengths, lengths.length, 0);
    const share = Math.max(0, Math.min(1, Number(percent) || 0));
    return textPosition(lengths, Math.round(share * Math.max(0, total - 1)));
}

//Начало фрагмента в тексте узлов: узлы стыкуются через пробел, пробелы схлопываются - как во фрагменте якоря
//(getReaderTextSnippetFromPosition). Берётся самый длинный найденный префикс, из повторов - ближайший к узлу near;
//не найден - null
function findText(texts = [], snippet = '', near = 0) {
    let text = '';
    const map = [];
    texts.forEach((value, index) => {
        for (let offset = 0; offset <= value.length; offset++) {
            if (offset === value.length || /\s/.test(value[offset])) {
                if (text && !text.endsWith(' ')) {
                    text += ' ';
                    map.push(null);
                }
                continue;
            }
            const lower = value[offset].toLowerCase();
            text += lower;
            for (let i = 0; i < lower.length; i++)
                map.push({index, offset});
        }
    });

    const needle = String(snippet || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const length of [180, 120, 80, 48, 24]) {
        const part = needle.slice(0, length);
        if (part.length < 12)
            continue;
        let best = null;
        for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
            if (!best || Math.abs(map[at].index - near) < Math.abs(best.index - near))
                best = map[at];
        }
        if (best)
            return best;
    }
    return null;
}

//Пока читатель не прокрутил ленту, место прежнее: новый якорь взял бы начало строки и туда-обратно сдвигал бы на строку
function keepsPlace(anchor = null, scrollTop = 0) {
    return !!(anchor && anchor.mode === 'scroll' && anchor.textOffset >= 0
        && Math.abs(Math.round(Number(scrollTop) || 0) - anchor.scrollTop) <= 1);
}

module.exports = {textOffset, textPosition, textPercent, percentPosition, findText, keepsPlace};
