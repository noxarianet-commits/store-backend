/**
 * Helpers for values that will be sent to PostgreSQL BIGINT columns.
 *
 * PostgreSQL rejects strings such as "SHP60" with:
 *   22P02 invalid input syntax for type bigint
 *
 * Supabase/PostgREST does not know the column type before the query reaches
 * Postgres, so the guard must happen here, in application code.
 */

const BIGINT_RE = /^[1-9]\d*$/;

/**
 * Return a canonical, non-zero decimal string when `value` is a valid BIGINT
 * identifier. Return null for anything else.
 *
 * Strings are returned instead of numbers to avoid losing precision for IDs
 * above Number.MAX_SAFE_INTEGER.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toBigIntId(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }

    const raw = String(value ?? '').trim();
    return BIGINT_RE.test(raw) ? raw : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBigIntId(value) {
    return toBigIntId(value) !== null;
}

module.exports = { toBigIntId, isBigIntId };
