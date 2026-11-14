const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const ticketController = require('../controllers/ticketController');
const ticketAccess = require('../middleware/ticketAccess');
const verifyUser = require('../middleware/verifyUser');
const optionalUser = require('../middleware/optionalUser');
const { ipKey, rateLimitHandler, ticketKey, userKey } = require('../utils/rateLimit');

// Tiket baru: 5 per jam per user login. Tamu tetap dibatasi per IP, tetapi
// longgar supaya pengguna lain di CGNAT operator yang sama tidak ikut kena.
const createTicketUserLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: userKey,
    skip: (req) => !req.user,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Terlalu banyak tiket dibuat. Harap tunggu 1 jam.' },
});

const createTicketGuestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: ipKey,
    skip: (req) => !!req.user,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Terlalu banyak tiket dibuat dari jaringan ini. Harap tunggu 1 jam.' },
});

// Pesan dalam tiket: 30 per 10 menit per user (fallback IP untuk tamu).
const ticketMessageLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyGenerator: ticketKey,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Terlalu banyak pesan. Harap tunggu sebentar.' },
});

// Tiket milik user yang login.
router.get('/', verifyUser, ticketController.listMine);

// Buat tiket — tamu maupun user login (optionalUser). optionalUser harus jalan
// lebih dulu supaya limiter bisa memakai identitas user.
router.post(
    '/',
    optionalUser,
    createTicketGuestLimiter,
    createTicketUserLimiter,
    ticketController.create
);

// Akses per tiket: optionalUser + ticketAccess (JWT user atau X-Ticket-Token / ?token=).
router.get('/:ticketNumber/stream', optionalUser, ticketAccess, ticketController.stream);
router.get('/:ticketNumber', optionalUser, ticketAccess, ticketController.detail);
router.post(
    '/:ticketNumber/messages',
    optionalUser,
    ticketMessageLimiter,
    ticketAccess,
    ticketController.addMessage
);
router.patch('/:ticketNumber/reopen', optionalUser, ticketAccess, ticketController.reopen);

module.exports = router;
