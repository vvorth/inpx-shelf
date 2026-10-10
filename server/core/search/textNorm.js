//Нормализация текста для поискового индекса и запросов: регистр, ё/е, пунктуация.
//Индекс и запрос нормализуются одной функцией, поэтому «Ёлка», «елка» и «ЁЛКА!» совпадают.

function normalize(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function tokens(text = '') {
    const value = normalize(text);
    return value ? value.split(' ') : [];
}

//Запрос, набранный в неправильной раскладке: ghbdtn -> привет и обратно
const latinKeys = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const cyrillicKeys = 'йцукенгшщзхъфывапролджэячсмитьбюё';

function switchLayout(text = '') {
    const value = String(text || '').toLowerCase();
    const latin = (value.match(/[a-z]/g) || []).length;
    const cyrillic = (value.match(/[а-яё]/g) || []).length;
    const [from, to] = (latin >= cyrillic ? [latinKeys, cyrillicKeys] : [cyrillicKeys, latinKeys]);

    let result = '';
    for (const char of value) {
        const index = from.indexOf(char);
        result += (index >= 0 ? to[index] : char);
    }
    return result;
}

//Расстояние Дамерау-Левенштейна (перестановка соседних букв считается одной правкой)
function editDistance(a = '', b = '', max = Infinity) {
    if (Math.abs(a.length - b.length) > max)
        return max + 1;

    const rows = [];
    for (let i = 0; i <= a.length; i++) {
        rows.push(new Array(b.length + 1).fill(0));
        rows[i][0] = i;
    }
    for (let j = 0; j <= b.length; j++)
        rows[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        let rowMin = Infinity;
        for (let j = 1; j <= b.length; j++) {
            const cost = (a[i - 1] === b[j - 1] ? 0 : 1);
            let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                value = Math.min(value, rows[i - 2][j - 2] + 1);
            rows[i][j] = value;
            rowMin = Math.min(rowMin, value);
        }
        if (rowMin > max)
            return max + 1;
    }

    return rows[a.length][b.length];
}

//Сколько опечаток допускаем в слове: короткие слова должны совпадать точно
function allowedTypos(word = '') {
    if (word.length <= 3)
        return 0;
    if (word.length <= 6)
        return 1;
    return 2;
}

function trigrams(word = '') {
    const result = [];
    for (let i = 0; i + 3 <= word.length; i++)
        result.push(word.substring(i, i + 3));
    return [...new Set(result)];
}

module.exports = {normalize, tokens, switchLayout, editDistance, allowedTypos, trigrams};
