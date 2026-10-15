//Связь с сервером по WebSocket: какие ошибки означают потерю соединения и как часто переподключаться.

const connectionErrors = new Set(['errors.wsClosed', 'errors.wsConnectFailed', 'errors.wsNoResponse']);

export function isConnectionError(error) {
    return connectionErrors.has(String((error && error.message !== undefined ? error.message : error) || ''));
}

//Пауза перед попыткой attempt (с 0): 1, 2, 4 … 30 с, со случайным разбросом, чтобы вкладки
//после перезапуска сервера не подключались все разом
export function reconnectDelay(attempt, random = Math.random) {
    const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt));
    return Math.round(base * (0.5 + random() / 2));
}
