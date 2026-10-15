import { createStore } from 'vuex';
import VuexPersistence from 'vuex-persist';

import root from './root.js';

const debug = process.env.NODE_ENV !== 'production';

//В localStorage - только настройки. Конфигурация сервера (csrfToken, профили, интеграции) приходит заново
//с get-config, токен профиля не нужен: после перезагрузки сервер узнаёт профиль по HttpOnly-cookie сессии.
//accessToken (пароль библиотеки) остаётся: сервер проверяет только его, иначе пароль спрашивался бы при каждой загрузке
function persisted(state = {}) {
    const settings = Object.assign({}, state.settings);
    delete settings.profileAccessToken;
    return {settings};
}

const vuexLocal = new VuexPersistence({
    reducer: persisted,
    //прежние версии сохраняли всё состояние: лишнее отбрасываем уже при чтении
    restoreState: (key, storage) => {
        try {
            return persisted(JSON.parse(storage.getItem(key) || '{}'));
        } catch (e) {
            return {};
        }
    },
});

export default createStore(Object.assign({}, root, {
    modules: {
    },
    strict: debug,
    plugins: [vuexLocal.plugin]
}));
