/**
 * Retry helper for READ-ONLY database operations.
 *
 * Never wrap inserts/updates/upserts here. Payment and fulfillment writes must
 * stay idempotent and must not be replayed by a generic retry helper.
 */

const TRANSIENT_CODES = new Set([
    'PGRST000', // connection to PostgREST failed
    'PGRST001', // internal PostgREST error
    'PGRST002', // schema cache unavailable
    'PGRST003', // statement timeout
    '08000',    // connection exception
    '08003',    // connection does not exist
    '08006',    // connection failure
    '40001',    // serialization failure
    '40P01',    // deadlock detected
    '53300',    // too many connections
    '57P01',    // admin shutdown
]);

const PERMANENT_CODES = new Set([
    '22P02', // invalid text representation (the bigint bug)
    '23505', // unique violation
    '23503', // foreign key violation
    '23502', // not null violation
    '42501', // insufficient privilege
    '42P01', // undefined table
    '42703', // undefined column
    'PGRST116', // no rows / multiple rows
]);

function isTransientError(error) {
    if (!error) return false;
    if (PERMANENT_CODES.has(String(error.code))) return false;
    return TRANSIENT_CODES.has(String(error.code));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a read-only operation with a small exponential backoff + jitter.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{retries?: number, baseDelayMs?: number, maxDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
async function withReadRetry(operation, { retries = 2, baseDelayMs = 100, maxDelayMs = 1000 } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isTransientError(error) || attempt === retries) throw error;

            const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
            const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.2));
            await sleep(exponential + jitter);
        }
    }

    throw lastError;
}

module.exports = {
    withReadRetry,
    isTransientError,
    TRANSIENT_CODES,
    PERMANENT_CODES,
};
