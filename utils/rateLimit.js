const jwt = require('jsonwebtoken');

const { getClientIp } = require('./clientIp');
const { logger } = require('./logger');

const MAX_EMAIL_LENGTH = 254;

function tokenFromRequest(req) {
    const value = req.headers?.authorization || req.headers?.['x-admin-token'];
    if (!value) return null;

    const token = String(value);
    return token.startsWith('Bearer ') ? token.slice(7) : token;
}

function ipKey(req) {
    return `ip:${getClientIp(req)}`;
}

/**
 * Key global: pakai identitas kalau token valid, supaya pengguna di belakang
 * CGNAT operator tidak saling menghabiskan kuota. Token diverifikasi di sini
 * (bukan hanya di-decode) karena key ini hanya boleh memakai identitas asli.
 */
function identityKey(req) {
    const token = tokenFromRequest(req);

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded?.id) {
                if (decoded.type === 'admin') return `admin:${decoded.id}`;
                if (decoded.type === 'user') return `user:${decoded.id}`;
            }
        } catch {
            // Token kedaluwarsa/tidak valid tetap harus kena limit sebagai tamu.
        }
    }

    return null;
}

function globalKey(req) {
    return identityKey(req) || ipKey(req);
}

function userKey(req) {
    return req.user?.id ? `user:${req.user.id}` : ipKey(req);
}

function emailKey(req) {
    const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
        .slice(0, MAX_EMAIL_LENGTH);

    return email ? `email:${email}` : ipKey(req);
}

// Admin login memakai username, bukan email.
function accountKey(req) {
    const account = String(req.body?.email || req.body?.username || '')
        .trim()
        .toLowerCase()
        .slice(0, MAX_EMAIL_LENGTH);

    return account ? `account:${account}` : ipKey(req);
}

// Tamu tetap dikunci per IP. Token order/tiket tidak dipakai sebagai key
// karena belum diverifikasi di titik ini: penyerang bisa merotasi token acak
// untuk membuat bucket baru dan menghindari limit.
function paymentKey(req) {
    return req.user?.id ? `user:${req.user.id}` : ipKey(req);
}

function ticketKey(req) {
    return req.user?.id ? `user:${req.user.id}` : ipKey(req);
}

function retryAfterSeconds(req, fallback = 60) {
    const resetTime = req.rateLimit?.resetTime;

    if (resetTime instanceof Date) {
        return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
    }

    if (typeof resetTime === 'number') {
        return Math.max(1, Math.ceil((resetTime - Date.now()) / 1000));
    }

    return fallback;
}

/**
 * Handler 429 yang seragam: sertakan Retry-After, kode mesin, dan request_id
 * supaya aplikasi bisa berhenti polling dan menampilkan hitung mundur.
 */
function rateLimitHandler(req, res, next, options) {
    const retryAfter = retryAfterSeconds(req);
    const message = options?.message;
    const error = typeof message === 'string'
        ? message
        : (message?.error || 'Terlalu banyak request, silakan coba lagi nanti.');

    // Hanya catat tipe key (user/email/ip/...), bukan nilainya, supaya log
    // tidak menyimpan email atau identitas pengguna.
    const key = String(req.rateLimit?.key || '');
    const keyType = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'unknown';

    logger.warn('rate_limited', {
        method: req.method,
        path: req.path,
        keyType,
        // IP hasil resolusi key (bukan header mentah) berguna untuk memastikan
        // Nginx/Cloudflare meneruskan IP pengunjung yang benar.
        ip: getClientIp(req),
        retryAfter,
        requestId: req.id,
    });

    res.set('Retry-After', String(retryAfter));
    res.status(options?.statusCode || 429).json({
        success: false,
        code: 'RATE_LIMITED',
        error,
        retry_after: retryAfter,
        request_id: req.id,
    });
}

module.exports = {
    accountKey,
    emailKey,
    globalKey,
    ipKey,
    paymentKey,
    rateLimitHandler,
    retryAfterSeconds,
    ticketKey,
    userKey,
};
