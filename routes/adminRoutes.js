const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const pushController = require('../controllers/pushController');
const verifyAdmin = require('../middleware/verifyAdmin');
const { accountKey, ipKey, rateLimitHandler } = require('../utils/rateLimit');

// Login admin: 5 percobaan per username per 15 menit, plus pagar per-IP yang
// longgar supaya admin di jaringan bersama tidak terkunci oleh percobaan
// orang lain.
const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: accountKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan login, coba lagi dalam 15 menit.' },
});

const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan login dari jaringan ini, coba lagi nanti.' },
});

// POST /api/admin/login — rate limited
router.post('/login', loginIpLimiter, loginAccountLimiter, adminController.login);

// PUT /api/admin/password — protected
router.put('/password', verifyAdmin, adminController.changePassword);

// Settings — full map for the admin dashboard (public /api/settings is allowlisted)
router.get('/settings', verifyAdmin, settingsController.listAdmin);

// User Management Routes — protected
router.get('/users', verifyAdmin, adminController.getUsers);
router.patch('/users/:id/balance', verifyAdmin, adminController.adjustBalance);
router.patch('/users/:id/limit', verifyAdmin, adminController.updateLimit);
router.patch('/users/:id/status', verifyAdmin, adminController.toggleStatus);

// Balance Transactions Routes — protected
router.get('/balance-transactions', verifyAdmin, adminController.getBalanceTransactions);
router.get('/balance-transactions/stats', verifyAdmin, adminController.getBalanceTransactionStats);

// Push Notification Routes — protected
// Broadcast mengirim ke SEMUA perangkat aktif, jadi dibatasi ketat.
const broadcastLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    handler: rateLimitHandler,
    message: { success: false, code: 'RATE_LIMITED', error: 'Terlalu banyak broadcast. Coba lagi dalam 10 menit.' },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/push/broadcast', verifyAdmin, broadcastLimiter, pushController.broadcast);
router.get('/push/history', verifyAdmin, pushController.history);
router.get('/push/stats', verifyAdmin, pushController.stats);

module.exports = router;

