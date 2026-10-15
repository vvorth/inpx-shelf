//Переводы со всеми языками сразу - для сервера и проверок (движок - shared/i18nEngine.js).
//Веб-интерфейс берёт движок без словарей и загружает только выбранный язык (client/share/i18n.js).
const i18n = require('./i18nEngine');

i18n.addLocale('en', require('./locales/en.json'));
i18n.addLocale('ru', require('./locales/ru.json'));

module.exports = i18n;
