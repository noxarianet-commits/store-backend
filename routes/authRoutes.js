const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');
const verifyUser = require('../middleware/verifyUser');
const { emailKey, ipKey, rateLimitHandler } = require('../utils/rateLimit');

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Limit utama dikunci per email, bukan per IP. Pengguna seluler berada di
// belakang CGNAT: satu IP publik dipakai banyak orang, jadi limit per-IP yang
// ketat akan mengunci pengguna yang tidak bersalah. Lapisan pertahanan
// sesungguhnya tetap ada di database: OTP kedaluwarsa 10 menit, max_attempts 5,
// dan cooldown resend 60 detik per email (services/otpService.js).
//
// Limiter per-IP tetap dipasang sebagai pagar anti-abuse, tetapi dengan batas
// yang jauh lebih longgar.

const loginEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan login dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Mengirim email = menghasilkan biaya dan bisa dipakai untuk menyuntik spam ke
// banyak alamat. Batas per email menyelamatkan kuota; batas per IP tetap ada
// tetapi longgar supaya satu IP operator tidak memblokir pendaftaran orang lain.
const otpSendEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak permintaan kode verifikasi. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpSendIpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak permintaan kode verifikasi dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Verifikasi kode perlu longgar: satu orang sah bisa salah ketik beberapa kali
// (dan memang punya 5 percobaan di database). Batas di sini hanya menahan
// request otomatis yang membombardir endpoint.
const otpVerifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan verifikasi. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpVerifyIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan verifikasi dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Registrasi (2 langkah, OTP wajib) ────────────────────────────────────────

// Catatan: /register TIDAK mengembalikan token. Token baru diterbitkan oleh
// /register/verify setelah kepemilikan email terbukti.
router.post('/register', otpSendIpLimiter, otpSendEmailLimiter, authController.register);
router.post('/register/verify', otpVerifyIpLimiter, otpVerifyEmailLimiter, authController.verifyRegistration);
router.post('/register/resend', otpSendIpLimiter, otpSendEmailLimiter, authController.resendRegistrationOtp);

// ── Lupa password (2 langkah, OTP wajib) ─────────────────────────────────────

router.post('/forgot-password', otpSendIpLimiter, otpSendEmailLimiter, authController.forgotPassword);
router.post('/forgot-password/verify', otpVerifyIpLimiter, otpVerifyEmailLimiter, authController.verifyResetPassword);
router.post('/forgot-password/resend', otpSendIpLimiter, otpSendEmailLimiter, authController.resendResetOtp);

// ── Login & profil ───────────────────────────────────────────────────────────

router.post('/login', loginIpLimiter, loginEmailLimiter, authController.login);
router.get('/profile', verifyUser, authController.getProfile);
router.put('/profile', verifyUser, authController.updateProfile);
router.put('/password', verifyUser, authController.changePassword);
router.get('/orders', verifyUser, authController.getUserOrders);

module.exports = router;