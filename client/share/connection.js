//Связь с сервером по HTTP API: какие ошибки означают потерю соединения и как часто проверять связь снова.
import apiRoutes from '../../shared/apiRoutes.js';

const connectionErrors = new Set(['errors.apiConnectFailed', 'errors.apiNoResponse', 'errors.apiBadResponse']);

function errorKey(error) {
    return String((error && error.message !== undefined ? error.message : error) || '');
}

export function isConnectionError(error) {
    return connectionErrors.has(errorKey(error));
}

//После обрыва повторяется только чтение (GET): изменение могло дойти до сервера, и повтор выполнил бы его дважды
export function canRetryRequest(action, error) {
    return isConnectionError(error) && apiRoutes.isRead(String(action || ''));
}

//Пауза перед попыткой attempt (с 0): 1, 2, 4 … 30 с, со случайным разбросом, чтобы вкладки
//после перезапуска сервера не подключались все разом
export function reconnectDelay(attempt, random = Math.random) {
    const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt));
    return Math.round(base * (0.5 + random() / 2));
}
