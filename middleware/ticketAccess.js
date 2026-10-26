const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const { safeEqual } = require('../utils/secureCompare');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * authorizeTicketAccess — memuat tiket dari :ticketNumber dan memastikan
 * pemanggil berhak membacanya. Menempelkan baris tiket ke req.ticket.
 *
 * Caller sah bila salah satu terpenuhi:
 *   1. req.user.id cocok dengan ticket.user_id (user login), atau
 *   2. X-Ticket-Token / ?token= cocok dengan ticket.access_token (tamu).
 *
 * Endpoint SSE tidak bisa mengirim header custom lewat EventSource, jadi
 * token dan JWT juga diterima via query string KHUSUS untuk endpoint stream.
 * Nilai token sudah 32 byte acak dan koneksi TLS-terminated di reverse proxy.
 *
 * Penolakan disamarkan jadi 404 supaya penyerang tidak bisa membedakan
 * "tiket tidak ada" dari "tiket bukan milikmu" — sama seperti authorizeOrderAccess
 * di paymentController.js.
 */
async function authorizeTicketAccess(req, res, next) {
    try {
        const ticketNumber = req.params.ticketNumber;
        if (!ticketNumber) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
        }

        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('ticket_number', ticketNumber)
            .maybeSingle();

        if (error) throw error;
        if (!ticket) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
        }

        // Jalur 1: user login. optionalUser hanya membaca header, jadi saat
        // kosong kita coba ?jwt= (dipakai EventSource di endpoint stream).
        let user = req.user || null;
        if (!user) {
            const rawJwt = req.query.jwt
                || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
            if (rawJwt && JWT_SECRET) {
                try {
                    const decoded = jwt.verify(rawJwt, JWT_SECRET);
                    if (decoded.type === 'user') user = decoded;
                } catch (err) {
                    // Token invalid/expired — perlakukan sebagai tamu, bukan error.
                }
            }
        }

        if (user && ticket.user_id && user.id === ticket.user_id) {
            req.ticket = ticket;
            return next();
        }

        // Jalur 2: access token (header untuk API biasa, query untuk SSE).
        const provided = req.headers['x-ticket-token'] || req.query.token;
        if (ticket.access_token && safeEqual(provided, ticket.access_token)) {
            req.ticket = ticket;
            return next();
        }

        return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
    } catch (err) {
        console.error('[TicketAccess] error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat tiket.' });
    }
}

module.exports = authorizeTicketAccess;
