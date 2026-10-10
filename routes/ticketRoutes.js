const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const ticketController = require('../controllers/ticketController');
const ticketAccess = require('../middleware/ticketAccess');
const verifyUser = require('../middleware/verifyUser');
const optionalUser = require('../middleware/optionalUser');

// Tiket baru: 5 per jam per IP — cukup untuk pemakaian wajar, menahan spam.
const createTicketLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Terlalu banyak tiket dibuat. Harap tunggu 1 jam.' },
});

// Pesan dalam tiket: 30 per 10 menit per IP.
const ticketMessageLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Terlalu banyak pesan. Harap tunggu sebentar.' },
});

// Tiket milik user yang login.
router.get('/', verifyUser, ticketController.listMine);

// Buat tiket — tamu maupun user login (optionalUser).
router.post('/', createTicketLimiter, optionalUser, ticketController.create);

// Akses per tiket: optionalUser + ticketAccess (JWT user atau X-Ticket-Token / ?token=).
router.get('/:ticketNumber/stream', optionalUser, ticketAccess, ticketController.stream);
router.get('/:ticketNumber', optionalUser, ticketAccess, ticketController.detail);
router.post('/:ticketNumber/messages', ticketMessageLimiter, optionalUser, ticketAccess, ticketController.addMessage);
router.patch('/:ticketNumber/reopen', optionalUser, ticketAccess, ticketController.reopen);

module.exports = router;
