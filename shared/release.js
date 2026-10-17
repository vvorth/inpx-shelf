//Сравнение версий релизов вида 26.9.3 и 26.10.0: сервер ищет новый выпуск, клиент показывает значок обновления.
//Метка сборки после "+" (26.10.0+dev.b95beaa) на порядок не влияет; суффикс после "-" остался от версий 1.x.

function normalizeVersionTag(value = '') {
    return String(value || '').trim().replace(/^v/i, '').replace(/\+.*$/, '');
}

function parseReleaseVersion(value = '') {
    const normalized = normalizeVersionTag(value);
    const [mainPart, prePart = ''] = normalized.split('-', 2);
    const main = mainPart.split('.').map(part => parseInt(part || '0', 10) || 0);
    while (main.length < 3)
        main.push(0);

    let pre = null;
    if (prePart) {
        const match = prePart.match(/^([a-z]+)(?:[.-]?(\d+))?$/i);
        pre = match
            ? {label: String(match[1] || '').toLowerCase(), num: parseInt(match[2] || '0', 10) || 0}
            : {label: prePart.toLowerCase(), num: 0};
    }

    return {main, pre};
}

function compareReleaseVersions(left = '', right = '') {
    const a = parseReleaseVersion(left);
    const b = parseReleaseVersion(right);

    for (let i = 0; i < 3; i++) {
        if (a.main[i] !== b.main[i])
            return (a.main[i] > b.main[i] ? 1 : -1);
    }

    if (!a.pre && !b.pre)
        return 0;
    if (!a.pre)
        return 1;
    if (!b.pre)
        return -1;
    if (a.pre.label !== b.pre.label)
        return a.pre.label.localeCompare(b.pre.label);
    if (a.pre.num !== b.pre.num)
        return (a.pre.num > b.pre.num ? 1 : -1);

    return 0;
}

module.exports = {normalizeVersionTag, compareReleaseVersions};
