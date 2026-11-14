const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const balanceController = require('../controllers/balanceController');
const { rateLimitHandler, userKey } = require('../utils/rateLimit');

// Top-up membuat invoice di payment gateway, jadi dibatasi per akun.
const topupCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak permintaan top-up. Coba lagi nanti.' },
});

// Polling status top-up punya key per user. Route ini juga di-skip dari global
// limiter supaya kuota request lain tidak habis oleh layar pembayaran yang
// dibiarkan terbuka.
const topupStatusLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak permintaan status top-up. Tunggu sebentar.' },
});

router.get('/', balanceController.getBalance);
router.post('/topup', topupCreateLimiter, balanceController.createTopup);
router.get('/topup/pending', balanceController.getPendingTopup);
router.post('/topup/cancel', balanceController.cancelPendingTopup);
router.get('/topup/:id/status', topupStatusLimiter, balanceController.getTopupStatus);
router.get('/history', balanceController.getHistory);

module.exports = router;
