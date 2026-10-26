const crypto = require('crypto');

/**
 * Perbandingan string yang aman terhadap timing attack.
 * Dipakai untuk membandingkan token akses (tiket/order) yang rahasia.
 * Returns true hanya bila keduanya string identik.
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (err) {
        return false;
    }
}

module.exports = { safeEqual };
