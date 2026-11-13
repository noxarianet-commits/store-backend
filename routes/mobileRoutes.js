const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();

const authController = require('../controllers/authController');
const mobileCatalogController = require('../controllers/mobileCatalogController');
const mobileOrderController = require('../controllers/mobileOrderController');
const mobileBillController = require('../controllers/mobileBillController');
const pushController = require('../controllers/pushController');
const verifyAppUser = require('../middleware/verifyAppUser');

function setAppAuthContext(req, res, next) {
    req.authClient = 'android';
    req.authTokenExpiry = '30d';
    req.channel = 'app';
    next();
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpSendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan kode verifikasi. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
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
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
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
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
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
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
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
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
    message: {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Terlalu banyak permintaan perangkat. Coba lagi nanti.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Public: config and authentication ──────────────────────────────────────
router.get('/config', mobileCatalogController.getConfig);

router.post('/auth/login', loginLimiter, setAppAuthContext, authController.login);
router.post('/auth/register', otpSendLimiter, setAppAuthContext, authController.register);
router.post('/auth/register/verify', otpVerifyLimiter, setAppAuthContext, authController.verifyRegistration);
router.post('/auth/register/resend', otpSendLimiter, setAppAuthContext, authController.resendRegistrationOtp);
router.post('/auth/forgot-password', otpSendLimiter, authController.forgotPassword);
router.post('/auth/forgot-password/verify', otpVerifyLimiter, authController.verifyResetPassword);
router.post('/auth/forgot-password/resend', otpSendLimiter, authController.resendResetOtp);

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
