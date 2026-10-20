import { createStore } from 'vuex';
import VuexPersistence from 'vuex-persist';

import root from './root.js';

const debug = process.env.NODE_ENV !== 'production';

//В localStorage - только настройки. Конфигурация сервера (csrfToken, профили, интеграции) приходит заново
//с get-config; профиль сервер узнаёт по HttpOnly-cookie сессии. Токен профиля прежних версий отбрасывается.
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
