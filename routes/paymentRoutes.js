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

/**
 * GET /api/payments/status/:orderId
 * Cek status order (polling dari frontend).
 * Public, tidak butuh auth.
 */
router.get('/status/:orderId', paymentController.getPaymentStatus);

/**
 * POST /api/payments/cancel
 * Batalkan invoice FinCloud (status → expired/cancelled).
 * Public, rate-limited.
 */
router.post('/cancel', createPaymentLimiter, paymentController.cancelPayment);

module.exports = router;
