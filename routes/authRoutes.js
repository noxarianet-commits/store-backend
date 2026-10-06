const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');
const verifyUser = require('../middleware/verifyUser');

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Limiter per-IP ini PELENGKAP, bukan pertahanan utama. Di Vercel store
// express-rate-limit default-nya in-memory, jadi tiap cold start me-reset
// counter dan batasnya jadi per-instance. Lapisan sesungguhnya ada di database:
// OTPExpires (10 menit) + max_attempts 5 + cooldown resend 60 detik per email
// (lihat services/otpService.js).

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Mengirim email = menghasilkan biaya dan bisa dipakai untuk menyuntik spam ke
// banyak alamat, jadi dibatasi lebih ketat daripada endpoint verify.
const otpSendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'Terlalu banyak permintaan kode verifikasi. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Verifikasi kode perlu longgar: satu orang sah bisa salah ketik beberapa kali
// (dan memang punya 5 percobaan di database). Batas di sini hanya menahan
// request otomatis yang membombardir endpoint.
const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: {
        success: false,
        error: 'Terlalu banyak percobaan verifikasi. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Registrasi (2 langkah, OTP wajib) ────────────────────────────────────────

// Catatan: /register TIDAK mengembalikan token. Token baru diterbitkan oleh
// /register/verify setelah kepemilikan email terbukti.
router.post('/register', otpSendLimiter, authController.register);
router.post('/register/verify', otpVerifyLimiter, authController.verifyRegistration);
router.post('/register/resend', otpSendLimiter, authController.resendRegistrationOtp);

// ── Lupa password (2 langkah, OTP wajib) ─────────────────────────────────────

router.post('/forgot-password', otpSendLimiter, authController.forgotPassword);
router.post('/forgot-password/verify', otpVerifyLimiter, authController.verifyResetPassword);
router.post('/forgot-password/resend', otpSendLimiter, authController.resendResetOtp);

// ── Login & profil ───────────────────────────────────────────────────────────

router.post('/login', loginLimiter, authController.login);
router.get('/profile', verifyUser, authController.getProfile);
router.put('/profile', verifyUser, authController.updateProfile);
router.put('/password', verifyUser, authController.changePassword);
router.get('/orders', verifyUser, authController.getUserOrders);

module.exports = router;