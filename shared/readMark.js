//Отметка «прочитано» - отдельный флаг read в прогрессе профиля, доля прочитанного её не задаёт.
//Сама она ставится, когда чтение доходит до READ_AUTO_PERCENT: сервер (браузер, Kobo, KOReader) и читалка считают одинаково.
const READ_AUTO_PERCENT = 0.95;

//Только переход снизу: снятая на 96% отметка не возвращается, пока чтение не уйдёт ниже порога и не перейдёт его снова
function reachesReadMark(before = 0, after = 0) {
    return (Number(before) || 0) < READ_AUTO_PERCENT && (Number(after) || 0) >= READ_AUTO_PERCENT;
}

module.exports = {READ_AUTO_PERCENT, reachesReadMark};
