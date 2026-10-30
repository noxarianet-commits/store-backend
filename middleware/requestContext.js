const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const storage = new AsyncLocalStorage();

/**
 * Attach a request ID to every request and keep it available to the logger
 * through AsyncLocalStorage.
 *
 * Do not log request/response bodies here. This middleware only establishes
 * correlation; controllers decide what is safe to log.
 */
function requestContext(req, res, next) {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.trim()
        ? incoming.trim().slice(0, 128)
        : crypto.randomUUID();

    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);

    const store = {
        requestId,
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
    };

    storage.run(store, next);
}

function getRequestContext() {
    return storage.getStore() || {};
}

module.exports = { requestContext, getRequestContext };
