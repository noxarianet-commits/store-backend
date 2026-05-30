const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/adminController');
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

module.exports = router;
