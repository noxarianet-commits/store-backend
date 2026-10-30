const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const verifyAdmin = require('../middleware/verifyAdmin');

// Login rate limiter: only 5 attempts per 15 minutes
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Terlalu banyak percobaan login, coba lagi dalam 15 menit.' },
});

// POST /api/admin/login — rate limited
router.post('/login', loginLimiter, adminController.login);

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

module.exports = router;

