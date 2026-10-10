const express = require('express');
const router = express.Router();

const adminTicketController = require('../controllers/adminTicketController');
const verifyAdmin = require('../middleware/verifyAdmin');

/**
 * EventSource tidak bisa mengirim header Authorization, jadi khusus endpoint
 * stream admin menerima token lewat ?token=. Token tidak di-log di app ini,
 * hanya berlaku untuk route stream (bukan seluruh /api/admin), dan koneksi
 * TLS-terminated. Selain itu perilakunya identik dengan verifyAdmin.
 */
function verifyAdminStream(req, res, next) {
    if (!req.headers['authorization'] && req.query.token) {
        req.headers['authorization'] = `Bearer ${req.query.token}`;
    }
    return verifyAdmin(req, res, next);
}

// Route statis HARUS di atas /:ticketNumber agar tidak tertangkap sebagai nomor tiket.
router.get('/stream', verifyAdminStream, adminTicketController.stream);
router.get('/stats', verifyAdmin, adminTicketController.stats);

router.get('/', verifyAdmin, adminTicketController.list);
router.get('/:ticketNumber', verifyAdmin, adminTicketController.detail);
router.post('/:ticketNumber/messages', verifyAdmin, adminTicketController.reply);
router.patch('/:ticketNumber', verifyAdmin, adminTicketController.update);

module.exports = router;
