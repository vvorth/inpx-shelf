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

//localStorage бросает при переполнении квоты, в приватном окне и при заблокированных данных сайта:
//без него приложение работает, просто настройки не сохраняются
function safe(action, fallback) {
    return (...args) => {
        try {
            return action(window.localStorage, ...args);
        } catch (e) {
            return fallback;
        }
    };
}

const safeStorage = {
    getItem: safe((storage, key) => storage.getItem(key), null),
    setItem: safe((storage, key, value) => storage.setItem(key, value)),
    removeItem: safe((storage, key) => storage.removeItem(key)),
};

const vuexLocal = new VuexPersistence({
    storage: safeStorage,
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
