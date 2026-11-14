const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/paymentController');
const optionalUser = require('../middleware/optionalUser');
const { ipKey, paymentKey, rateLimitHandler, userKey } = require('../utils/rateLimit');

// Pembuatan payment: pengguna login dibatasi per akun; tamu per IP tetapi
// dengan batas yang lebih longgar karena satu IP publik operator (CGNAT)
// dipakai banyak pembeli.
const createPaymentUserLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 jam
    max: 20,
    keyGenerator: userKey,
    skip: (req) => !req.user,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request pembuatan order. Harap tunggu 1 jam.' },
});

const createPaymentGuestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 jam
    max: 120,
    keyGenerator: ipKey,
    skip: (req) => !!req.user,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request pembuatan order dari jaringan ini. Harap tunggu 1 jam.' },
});

/**
 * POST /api/payments/create
 * Buat order baru + invoice QRIS atau menggunakan saldo balance.
 * Public/Optional auth, rate-limited.
 */
router.post(
    '/create',
    optionalUser,
    createPaymentGuestLimiter,
    createPaymentUserLimiter,
    paymentController.createPayment
);

// Polling status order: key per pengguna (fallback IP untuk tamu), bukan per
// IP murni. Satu layar pembayaran yang terbuka tidak boleh menghabiskan kuota
// pengguna lain di jaringan seluler yang sama.
const statusPollingLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 menit
    max: 240,
    keyGenerator: paymentKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request pengecekan status. Harap tunggu sebentar.' },
});

/**
 * GET /api/payments/status/:orderId
 * Cek status order (polling dari frontend).
 * Akses wajib dibuktikan: req.user.id pemilik order ATAU header X-Order-Token
 * yang diberikan ke pembeli saat order dibuat.
 */
router.get(
    '/status/:orderId',
    optionalUser,
    statusPollingLimiter,
    paymentController.getPaymentStatus
);

// Cancel memakai key yang sama (user, fallback IP untuk tamu) supaya tamu
// yang membatalkan invoice-nya sendiri tidak saling menghabiskan kuota per IP.
const cancelLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 jam
    max: 30,
    keyGenerator: paymentKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request pembatalan. Harap tunggu 1 jam.' },
});

/**
 * POST /api/payments/cancel
 * Batalkan invoice payment gateway (status → expired/cancelled).
 * Akses wajib dibuktikan dengan cara yang sama seperti /status/:orderId.
 */
router.post('/cancel', optionalUser, cancelLimiter, paymentController.cancelPayment);

module.exports = router;
