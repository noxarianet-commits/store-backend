const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/paymentController');

// Rate limiter khusus untuk pembuatan payment (mencegah spam)
const createPaymentLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 jam
    max: 20,
    message: { error: 'Terlalu banyak request pembuatan order. Harap tunggu 1 jam.' },
});

/**
 * POST /api/payments/create
 * Buat order baru + invoice QRIS di FinCloud.
 * Public, rate-limited.
 */
router.post('/create', createPaymentLimiter, paymentController.createPayment);

// Rate limiter khusus untuk polling status order (longgar untuk live polling frontend)
const statusPollingLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 menit
    max: 120, // max 120 request per menit per IP (sangat aman untuk polling 5-10s)
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request pengecekan status. Harap tunggu sebentar.' },
});

/**
 * GET /api/payments/status/:orderId
 * Cek status order (polling dari frontend).
 * Public, rate-limited khusus polling.
 */
router.get('/status/:orderId', statusPollingLimiter, paymentController.getPaymentStatus);

/**
 * POST /api/payments/cancel
 * Batalkan invoice FinCloud (status → expired/cancelled).
 * Public, rate-limited.
 */
router.post('/cancel', createPaymentLimiter, paymentController.cancelPayment);

module.exports = router;
