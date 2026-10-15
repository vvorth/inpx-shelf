//Связь с сервером по WebSocket: какие ошибки означают потерю соединения и как часто переподключаться.

const connectionErrors = new Set(['errors.wsClosed', 'errors.wsConnectFailed', 'errors.wsNoResponse']);

//Действия, которые можно повторить после обрыва связи: только чтение (их же сервер считает readOnlyActions).
//Изменение могло дойти до сервера до обрыва, и повтор выполнил бы его дважды
const retrySafeActions = new Set([
    'test', 'get-config', 'get-worker-state', 'get-author-book-list', 'get-author-info', 'get-series-book-list',
    'get-genre-tree', 'get-discovery-shelves', 'get-admin-dashboard', 'get-admin-dashboard-metrics', 'get-admin-events',
    'export-admin-settings', 'get-book-link', 'get-author-aliases', 'admin-author-names-status', 'catalog-names',
    'catalog-search', 'catalog-suggest', 'get-book', 'get-book-states', 'get-book-info', 'get-reader-state',
    'get-user-reading-library', 'get-reading-stats', 'get-reading-lists', 'get-user-profiles', 'get-reading-list',
    'get-reading-now', 'export-reading-lists', 'get-kobo-devices',
]);

function errorKey(error) {
    return String((error && error.message !== undefined ? error.message : error) || '');
}

export function isConnectionError(error) {
    return connectionErrors.has(errorKey(error));
}

//Без соединения запрос не был отправлен, его можно повторить любой; иначе - только чтение
export function canRetryRequest(action, error) {
    const key = errorKey(error);
    return key === 'errors.wsConnectFailed' || (connectionErrors.has(key) && retrySafeActions.has(String(action || '')));
}

//Пауза перед попыткой attempt (с 0): 1, 2, 4 … 30 с, со случайным разбросом, чтобы вкладки
//после перезапуска сервера не подключались все разом
export function reconnectDelay(attempt, random = Math.random) {
    const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt));
    return Math.round(base * (0.5 + random() / 2));
}
