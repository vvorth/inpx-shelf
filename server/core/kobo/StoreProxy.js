const {log, rootPath, syncTokenHeader} = require('./common');

const storeTimeoutMs = 10000;
// Allow-lists, both ways: what the firmware sends and the store needs, and what the device needs back.
// x-kobo-* device headers pass too, except the sync token: ours means nothing to the store, and the store's
// would make the device start a full resync. mergeStoreSync passes the store's token on purpose.
// Content-Length and Content-Encoding are left to fetch() and express: the body is already decoded.
const storeRequestHeaders = new Set(['authorization', 'user-agent', 'accept', 'accept-language', 'content-type',
    'if-none-match', 'if-modified-since', 'range', 'x-requested-with']);
// Location: redirects are not followed (`redirect: 'manual'`), the device follows them itself.
const storeResponseHeaders = new Set(['content-type', 'content-language', 'cache-control', 'expires', 'etag',
    'last-modified', 'location']);

function relayed(name, allowed) {
    name = name.toLowerCase();
    return allowed.has(name) || (name.startsWith('x-kobo-') && name !== syncTokenHeader);
}

// Kobo Store proxy for devices that opted in. Mixed into KoboService.prototype: `this` is the service.
module.exports = {
    storeTarget(req, token) {
        const prefix = `${rootPath(this.config)}/${token}`;
        const url = String(req.originalUrl || '');
        const rest = (url.startsWith(prefix) ? url.slice(prefix.length) : url);
        return `${this.storeUrl}${rest || '/'}`;
    },

    async storeRequest(req, token, extraHeaders = {}) {
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (relayed(key, storeRequestHeaders) && value !== undefined)
                headers[key] = (Array.isArray(value) ? value.join(', ') : String(value));
        }
        for (const [key, value] of Object.entries(extraHeaders)) {
            if (value)
                headers[key] = value;
            else
                delete headers[key];
        }
        const hasBody = !['GET', 'HEAD'].includes(req.method) && req.rawBody && req.rawBody.length;
        return await fetch(this.storeTarget(req, token), {
            method: req.method,
            headers,
            body: (hasBody ? req.rawBody : undefined),
            redirect: 'manual',
            signal: AbortSignal.timeout(storeTimeoutMs),
        });
    },

    async relayStoreResponse(res, response) {
        for (const [key, value] of response.headers) {
            if (relayed(key, storeResponseHeaders))
                res.set(key, value);
        }
        res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    },

    // Requests inpx-shelf does not answer itself go to the Kobo Store when the device
    // opted in (purchased books, store pages); otherwise they get `fallback`.
    async storeOr(req, res, device, token, fallback) {
        if (!device.storeProxy)
            return fallback();
        // The firmware turns redirected POSTs into GETs, so only GETs are redirected.
        if (req.method === 'GET')
            return res.redirect(307, this.storeTarget(req, token));
        try {
            await this.relayStoreResponse(res, await this.storeRequest(req, token));
        } catch (e) {
            log(LM_WARN, `Kobo: store request ${req.method} ${req.path} failed: ${e.message}`);
            if (!res.headersSent)
                fallback();
        }
    },

    async mergeStoreSync(req, token, storeToken) {
        const response = await this.storeRequest(req, token, {[syncTokenHeader]: storeToken});
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const items = await response.json();
        const headers = {};
        for (const name of ['x-kobo-sync-mode', 'x-kobo-recent-reads']) {
            const value = response.headers.get(name);
            if (value)
                headers[name] = value;
        }
        return {
            items: (Array.isArray(items) ? items : []),
            token: response.headers.get(syncTokenHeader) || storeToken,
            more: response.headers.get('x-kobo-sync') === 'continue',
            headers,
        };
    },
};
