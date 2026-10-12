//Списки чтения текущего профиля, загруженные заранее: окно «Добавить в список» показывает их сразу,
//не дожидаясь ответа сервера. Обновляется в фоне при входе, при открытии окна и после сохранения.
import {reactive} from 'vue';

const state = reactive({
    userKey: '',
    lists: [],
    loaded: false,
});

let pending = null;

export function readingListsCache() {
    return state;
}

function switchUser(userKey) {
    if (state.userKey !== userKey) {
        state.userKey = userKey;
        state.lists = [];
        state.loaded = false;
        pending = null;
    }
}

//ответ getReadingLists('') уже получен: кладём его в кэш без повторного запроса
export function setReadingLists(userKey, response) {
    switchUser(userKey);
    if (!userKey)
        return;
    state.lists = ((response && response.lists) || []).map(item => ({
        id: item.id,
        name: item.name,
        visibility: item.visibility,
        bookCount: item.bookCount,
        readCount: item.readCount,
    }));
    state.loaded = true;
}

export function refreshReadingLists(api, userKey = '') {
    switchUser(userKey);
    if (!userKey)
        return Promise.resolve([]);
    if (pending)
        return pending;

    pending = api.getReadingLists('')
        .then((response) => {
            if (state.userKey === userKey)
                setReadingLists(userKey, response);
            return state.lists;
        })
        .catch(() => state.lists)
        .finally(() => {
            pending = null;
        });
    return pending;
}
