//Запрос к HTTP API: метод, адрес и тело - по таблице shared/apiRoutes.js. Адрес относительный: страница приложения всегда <root>/
import apiRoutes from '../../../shared/apiRoutes.js';

//Ответ JSON возвращается как есть, в том числе {error} с кодом 4xx/5xx: его разбирает Api.request.
//body - файл для действий-загрузок; timeoutSecs не задан - ждём сколько нужно (загрузка большого файла)
export async function call(action, params = {}, {timeoutSecs = 0, headers = {}, body} = {}) {
    const request = apiRoutes.encode(action, params);
    const query = apiRoutes.queryString(request.query);
    const init = {method: request.method, credentials: 'same-origin', headers: Object.assign({'X-Inpx-Api': '1'}, headers)};
    if (apiRoutes.routeFor(action).upload) {
        init.headers['Content-Type'] = 'application/octet-stream';
        init.body = body;
    } else if (request.method === 'POST') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(request.body);
    }

    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = (timeoutSecs ? setTimeout(() => controller.abort(), timeoutSecs*1000) : null);
    try {
        let response;
        try {
            response = await fetch(`api/${request.path}${query ? `?${query}` : ''}`, init);
        } catch (e) {
            throw new Error(controller.signal.aborted ? 'errors.apiNoResponse' : 'errors.apiConnectFailed');
        }

        let result;
        try {
            result = await response.json();
        } catch (e) {
            throw new Error(controller.signal.aborted ? 'errors.apiNoResponse' : 'errors.apiBadResponse');
        }
        //не объект - не ответ сервера (например, страница прокси)
        if (!result || typeof result !== 'object')
            throw new Error('errors.apiBadResponse');
        return result;
    } finally {
        clearTimeout(timer);
    }
}
