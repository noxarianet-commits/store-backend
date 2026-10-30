/**
 * Small structured logger for production observability.
 *
 * Goals:
 * - One line per event, JSON in production.
 * - Levels (error/warn/info/debug) controlled by LOG_LEVEL.
 * - Automatic redaction of credentials and customer identifiers.
 * - Correlation IDs from middleware/requestContext.js.
 * - No external dependency.
 */

const { getRequestContext } = require('../middleware/requestContext');

const LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

const DEFAULT_LEVEL = 'info';
const configuredLevel = String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
const currentLevel = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel)
    ? configuredLevel
    : 'info';

const SENSITIVE_KEY_RE = /(authorization|access[_-]?token|order[_-]?access[_-]?token|token|password|secret|api[_-]?key|signature|email|wa[_-]?number|phone|customer[_-]?name)/i;
const OTP_KEY_RE = /(^otp$)|(^otp_)|(_otp$)/i;
const PIN_KEY_RE = /(^pin$)|(^pin_)|(_pin$)/i;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 4;

function isSensitiveKey(key) {
    const normalized = String(key);
    return SENSITIVE_KEY_RE.test(normalized) ||
        OTP_KEY_RE.test(normalized) ||
        PIN_KEY_RE.test(normalized);
}

/**
 * Mask an email for application logs: user@example.com -> u***@example.com.
 * @param {unknown} value
 * @returns {string}
 */
function maskEmail(value) {
    const email = String(value ?? '').trim();
    const at = email.indexOf('@');
    if (at <= 0) return '[REDACTED_EMAIL]';
    return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}

function serializeError(error) {
    if (!(error instanceof Error)) return error;

    const out = {
        name: error.name,
        message: error.message,
    };

    if (error.code !== undefined) out.code = error.code;
    if (error.status !== undefined) out.status = error.status;
    // Stack traces are opt-in: set LOG_STACKS=true when debugging locally.
    if (process.env.LOG_STACKS === 'true' && error.stack) {
        out.stack = error.stack;
    }

    return out;
}

/**
 * Recursively redact sensitive values and cap depth/size.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;

    if (value instanceof Error) return serializeError(value);

    if (typeof value === 'string') {
        return value.length > MAX_STRING_LENGTH
            ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
            : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return '[Function]';

    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitize(item, depth + 1, seen));
    }

    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitize(item, depth + 1, seen);
        }
        return out;
    }

    return String(value);
}

function buildRecord(level, message, context) {
    const requestContext = getRequestContext();
    const merged = {
        ...requestContext,
        ...(context || {}),
    };

    return sanitize({
        ts: new Date().toISOString(),
        level,
        msg: String(message || ''),
        ...merged,
    });
}

function write(level, message, context) {
    if (LEVELS[level] > LEVELS[currentLevel]) return;

    const record = buildRecord(level, message, context);

    if (process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json') {
        const line = JSON.stringify(record);
        if (level === 'error') process.stderr.write(`${line}\n`);
        else process.stdout.write(`${line}\n`);
        return;
    }

    const prefix = `[${record.ts}] ${level.toUpperCase()} ${record.msg}`;
    const rest = { ...record };
    delete rest.ts;
    delete rest.level;
    delete rest.msg;

    const hasContext = Object.keys(rest).length > 0;
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (hasContext) target(prefix, rest);
    else target(prefix);
}

const sampledState = new Map();

const logger = {
    error(message, context) {
        write('error', message, context);
    },
    warn(message, context) {
        write('warn', message, context);
    },
    info(message, context) {
        write('info', message, context);
    },
    debug(message, context) {
        write('debug', message, context);
    },

    /**
     * Emit a diagnostic message at most once per interval for a given key.
     * Use for repetitive, non-critical warnings (cache misses, vendor
     * validation fallbacks, malformed public input).
     */
    sampled(level, key, intervalMs, message, context) {
        const now = Date.now();
        const last = sampledState.get(key) || 0;
        if (now - last < intervalMs) return;
        sampledState.set(key, now);
        write(level, message, context);
    },

    child(bindings = {}) {
        return {
            error: (message, context) => write('error', message, { ...bindings, ...(context || {}) }),
            warn: (message, context) => write('warn', message, { ...bindings, ...(context || {}) }),
            info: (message, context) => write('info', message, { ...bindings, ...(context || {}) }),
            debug: (message, context) => write('debug', message, { ...bindings, ...(context || {}) }),
            sampled: (level, key, intervalMs, message, context) => {
                logger.sampled(level, `${bindings.job || bindings.scope || 'default'}:${key}`, intervalMs, message, { ...bindings, ...(context || {}) });
            },
        };
    },
};

module.exports = {
    logger,
    sanitize,
    maskEmail,
    LEVELS,
};
