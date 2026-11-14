const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const authController = require('../controllers/authController');
const mobileCatalogController = require('../controllers/mobileCatalogController');
const mobileOrderController = require('../controllers/mobileOrderController');
const mobileBillController = require('../controllers/mobileBillController');
const pushController = require('../controllers/pushController');
const verifyAppUser = require('../middleware/verifyAppUser');
const { emailKey, ipKey, rateLimitHandler, userKey } = require('../utils/rateLimit');

function setAppAuthContext(req, res, next) {
    req.authClient = 'android';
    req.authTokenExpiry = '30d';
    req.channel = 'app';
    next();
}

// Login/OTP: key per email + pagar per IP yang longgar. Pengguna seluler
// berbagi IP publik lewat CGNAT, jadi limit per-IP yang ketat akan mengunci
// pengguna lain di jaringan yang sama.
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak percobaan login dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
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
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan kode verifikasi dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpSendEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan kode verifikasi. Coba lagi nanti.',
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
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak percobaan verifikasi dari jaringan ini. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpVerifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: emailKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak percobaan verifikasi. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const orderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak pembuatan pesanan. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const billInquiryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak cek tagihan. Tunggu sebentar.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const orderDetailLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan status pesanan.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Registrasi push token — aplikasi memanggil sekali per sesi + saat token
// di-rotasi FCM, jadi batasnya longgar tapi tetap ada.
const deviceLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyGenerator: userKey,
    handler: rateLimitHandler,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan perangkat. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Config publik dipanggil setiap cold start aplikasi. Beri pagar per-IP yang
// longgar (dan lewati global limiter di server.js) supaya satu IP operator
// tidak memblokir pengguna lain hanya karena banyak yang membuka aplikasi.
const configLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3000,
    keyGenerator: ipKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan konfigurasi. Coba lagi nanti.',
    },
});

// ── Public: config and authentication ──────────────────────────────────────
router.get('/config', configLimiter, mobileCatalogController.getConfig);

router.post('/auth/login', loginIpLimiter, loginEmailLimiter, setAppAuthContext, authController.login);
router.post('/auth/register', otpSendIpLimiter, otpSendEmailLimiter, setAppAuthContext, authController.register);
router.post('/auth/register/verify', otpVerifyIpLimiter, otpVerifyEmailLimiter, setAppAuthContext, authController.verifyRegistration);
router.post('/auth/register/resend', otpSendIpLimiter, otpSendEmailLimiter, setAppAuthContext, authController.resendRegistrationOtp);
router.post('/auth/forgot-password', otpSendIpLimiter, otpSendEmailLimiter, authController.forgotPassword);
router.post('/auth/forgot-password/verify', otpVerifyIpLimiter, otpVerifyEmailLimiter, authController.verifyResetPassword);
router.post('/auth/forgot-password/resend', otpSendIpLimiter, otpSendEmailLimiter, authController.resendResetOtp);

// ── Everything below requires an app token ─────────────────────────────────
router.use(verifyAppUser);

router.get('/me', authController.getProfile);
router.put('/me', authController.updateProfile);
router.put('/me/password', authController.changePassword);

router.get('/home', mobileCatalogController.getHome);
router.get('/products', mobileCatalogController.listProducts);
router.get('/products/:id', mobileCatalogController.getProductById);
router.post('/products/validate', mobileCatalogController.validateProduct);

router.post('/bills/inquiry', billInquiryLimiter, mobileBillController.inquire);

router.post('/orders', orderLimiter, mobileOrderController.create);
router.get('/orders', mobileOrderController.list);
router.get('/orders/:id', orderDetailLimiter, mobileOrderController.getById);
router.post('/orders/:id/cancel', mobileOrderController.cancel);

// ── Push notification devices ───────────────────────────────────────────────
router.post('/devices', deviceLimiter, pushController.registerDevice);
router.delete('/devices', deviceLimiter, pushController.unregisterDevice);
router.get('/devices', deviceLimiter, pushController.listDevices);

module.exports = router;
