const crypto = require('crypto');
const supabase = require('../supabase');
const ticketStreamService = require('../services/ticketStreamService');
const { safeEqual } = require('../utils/secureCompare');
const { normalizePhoneNumber } = require('../utils/phoneUtils');

const CATEGORIES = ['umum', 'pesanan', 'pembayaran', 'produk', 'akun', 'lainnya'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const LIMITS = { subject: 200, body: 4000, name: 100, email: 254, wa: 30 };

/** Trim string; kembalikan '' untuk non-string/null. */
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** Nomor tiket human-facing: TK-YYYYMMDD-XXXX (hex acak). */
function generateTicketNumber() {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `TK-${ymd}-${rand}`;
}

/** Token bukti kepemilikan tiket untuk tamu. */
function generateTicketAccessToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** Buang access_token dari baris tiket sebelum dikirim ke client. */
function publicTicket(ticket) {
    if (!ticket) return ticket;
    const { access_token, ...rest } = ticket;
    return rest;
}

/**
 * POST /api/tickets (Public / optional user)
 * Membuat tiket baru + pesan pertama. Tamu menerima access_token yang
 * disimpan browser dan dikirim balik lewat header X-Ticket-Token.
 */
async function create(req, res) {
    try {
        const body = req.body || {};

        // Honeypot: field ini invisible bagi manusia. Terisi = bot.
        if (str(body.website)) {
            return res.status(400).json({ success: false, error: 'Permintaan tidak valid.' });
        }

        // Lama waktu mengisi form (dihitung client, bebas clock skew).
        // Bot mengirim hampir instan; manusia butuh > 1.5 detik.
        const elapsedMs = Number(body.elapsed_ms);
        if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 1500) {
            return res.status(400).json({ success: false, error: 'Permintaan tidak valid.' });
        }

        const isLoggedIn = Boolean(req.user && req.user.id);

        const name = (isLoggedIn ? req.user.display_name : str(body.guest_name)).slice(0, LIMITS.name);
        const email = (isLoggedIn && req.user.email ? req.user.email : str(body.guest_email)).toLowerCase().slice(0, LIMITS.email);
        const wa = normalizePhoneNumber(str(body.guest_wa)).slice(0, LIMITS.wa);
        const subject = str(body.subject).slice(0, LIMITS.subject);
        const messageBody = str(body.body).slice(0, LIMITS.body + 1);
        const category = CATEGORIES.includes(str(body.category)) ? str(body.category) : 'umum';
        // Prioritas adalah alat admin — pelanggan selalu masuk sebagai 'normal'
        // supaya label urgent/high tidak kehilangan makna.
        const priority = 'normal';

        if (!name) {
            return res.status(400).json({ success: false, error: 'Nama wajib diisi.' });
        }
        if (!subject) {
            return res.status(400).json({ success: false, error: 'Subjek wajib diisi.' });
        }
        if (!messageBody) {
            return res.status(400).json({ success: false, error: 'Pesan wajib diisi.' });
        }
        if (messageBody.length > LIMITS.body) {
            return res.status(400).json({ success: false, error: `Pesan maksimal ${LIMITS.body} karakter.` });
        }
        if (!isLoggedIn && !email && !wa) {
            return res.status(400).json({ success: false, error: 'Isi minimal email atau nomor WhatsApp agar CS bisa menghubungi Anda.' });
        }

        // Opsional: kaitkan ke pesanan, tapi hanya bila terbukti milik pemohon.
        let orderId = str(body.order_id) || null;
        if (orderId) {
            const { data: order, error: orderError } = await supabase
                .from('orders')
                .select('id, user_id, email, wa_number, order_access_token')
                .eq('id', orderId)
                .maybeSingle();

            if (orderError) throw orderError;
            if (!order) {
                return res.status(400).json({ success: false, error: 'Pesanan tidak ditemukan.' });
            }

            const ownsOrder =
                (isLoggedIn && order.user_id && req.user.id === order.user_id) ||
                (email && order.email && order.email.toLowerCase() === email) ||
                (wa && order.wa_number && normalizePhoneNumber(order.wa_number) === wa) ||
                safeEqual(req.headers['x-order-token'], order.order_access_token);

            if (!ownsOrder) {
                // 404 (bukan 403) supaya keberadaan pesanan orang lain tidak bocor.
                return res.status(404).json({ success: false, error: 'Pesanan tidak ditemukan.' });
            }
        }

        // Insert dengan retry bila nomor tiket bentrok (unique violation 23505).
        let ticket = null;
        let lastInsertError = null;
        for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
            const { data, error } = await supabase
                .from('tickets')
                .insert({
                    ticket_number: generateTicketNumber(),
                    user_id: isLoggedIn ? req.user.id : null,
                    guest_name: name,
                    guest_email: email || null,
                    guest_wa: wa || null,
                    order_id: orderId,
                    category,
                    subject,
                    status: 'open',
                    priority,
                    access_token: generateTicketAccessToken(),
                    last_message_at: new Date().toISOString(),
                    last_message_by: 'user',
                })
                .select('*')
                .single();

            if (!error) {
                ticket = data;
                break;
            }
            lastInsertError = error;
            if (error.code !== '23505') throw error;
        }

        if (!ticket) throw lastInsertError || new Error('Gagal membuat nomor tiket unik.');

        const { data: firstMessage, error: messageError } = await supabase
            .from('ticket_messages')
            .insert({ ticket_id: ticket.id, author: 'user', body: messageBody })
            .select('id, author, body, created_at')
            .single();

        if (messageError) {
            // Jangan tinggalkan tiket kosong bila pesan pertama gagal disimpan.
            await supabase.from('tickets').delete().eq('id', ticket.id);
            throw messageError;
        }

        ticketStreamService.publish(ticket.id, 'created', {
            ticket_id: ticket.id,
            ticket: publicTicket(ticket),
            message: firstMessage,
        });

        return res.status(201).json({
            success: true,
            data: {
                ...publicTicket(ticket),
                access_token: ticket.access_token,
                first_message: firstMessage,
            },
        });
    } catch (err) {
        console.error('[TicketController] create error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal membuat tiket. Silakan coba lagi.' });
    }
}

/**
 * GET /api/tickets (verifyUser)
 * Daftar tiket milik user yang login.
 */
async function listMine(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        const { data, count, error } = await supabase
            .from('tickets')
            .select('id, ticket_number, subject, category, status, priority, order_id, last_message_at, last_message_by, closed_at, created_at, updated_at', { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('last_message_at', { ascending: false })
            .range(from, to);

        if (error) throw error;

        return res.json({
            success: true,
            data: data || [],
            pagination: {
                total: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit) || 1,
            },
        });
    } catch (err) {
        console.error('[TicketController] listMine error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat daftar tiket.' });
    }
}

/**
 * GET /api/tickets/:ticketNumber (optionalUser + ticketAccess)
 * Detail tiket + seluruh pesan + ringkasan pesanan (bila ada).
 * access_token TIDAK pernah dikembalikan di sini.
 */
async function detail(req, res) {
    try {
        const ticket = req.ticket;

        const { data: messages, error } = await supabase
            .from('ticket_messages')
            .select('id, author, body, created_at')
            .eq('ticket_id', ticket.id)
            .order('created_at', { ascending: true });

        if (error) throw error;

        let order = null;
        if (ticket.order_id) {
            const { data } = await supabase
                .from('orders')
                .select('id, product, variant, status, price, timestamp')
                .eq('id', ticket.order_id)
                .maybeSingle();
            order = data || null;
        }

        return res.json({
            success: true,
            data: { ...publicTicket(ticket), messages: messages || [], order },
        });
    } catch (err) {
        console.error('[TicketController] detail error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat tiket.' });
    }
}

/**
 * POST /api/tickets/:ticketNumber/messages (optionalUser + ticketAccess)
 * Kirim pesan dari sisi pelanggan. Tiket tertutup harus di-reopen dulu.
 */
async function addMessage(req, res) {
    try {
        const ticket = req.ticket;

        if (ticket.status === 'closed') {
            return res.status(400).json({ success: false, error: 'Tiket sudah ditutup. Buka kembali untuk mengirim pesan.' });
        }

        const body = str(req.body && req.body.body).slice(0, LIMITS.body + 1);
        if (!body) {
            return res.status(400).json({ success: false, error: 'Pesan wajib diisi.' });
        }
        if (body.length > LIMITS.body) {
            return res.status(400).json({ success: false, error: `Pesan maksimal ${LIMITS.body} karakter.` });
        }

        const { data: message, error: messageError } = await supabase
            .from('ticket_messages')
            .insert({ ticket_id: ticket.id, author: 'user', body })
            .select('id, author, body, created_at')
            .single();

        if (messageError) throw messageError;

        const { data: updated, error: updateError } = await supabase
            .from('tickets')
            .update({ last_message_at: new Date().toISOString(), last_message_by: 'user', status: 'open' })
            .eq('id', ticket.id)
            .select('*')
            .single();

        if (updateError) throw updateError;

        ticketStreamService.publish(ticket.id, 'message', {
            ticket_id: ticket.id,
            message,
            ticket: publicTicket(updated),
        });

        return res.status(201).json({ success: true, data: { message, ticket: publicTicket(updated) } });
    } catch (err) {
        console.error('[TicketController] addMessage error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal mengirim pesan.' });
    }
}

/**
 * PATCH /api/tickets/:ticketNumber/reopen (optionalUser + ticketAccess)
 * Buka kembali tiket yang sudah ditutup. Idempoten untuk tiket yang terbuka.
 */
async function reopen(req, res) {
    try {
        const ticket = req.ticket;

        if (ticket.status !== 'closed') {
            return res.json({ success: true, data: publicTicket(ticket) });
        }

        const { data: updated, error } = await supabase
            .from('tickets')
            .update({ status: 'open', closed_at: null })
            .eq('id', ticket.id)
            .select('*')
            .single();

        if (error) throw error;

        ticketStreamService.publish(ticket.id, 'status', {
            ticket_id: ticket.id,
            status: 'open',
            ticket: publicTicket(updated),
        });

        return res.json({ success: true, data: publicTicket(updated) });
    } catch (err) {
        console.error('[TicketController] reopen error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal membuka kembali tiket.' });
    }
}

/**
 * GET /api/tickets/:ticketNumber/stream (optionalUser + ticketAccess)
 * SSE: pelanggan menerima pesan baru dan perubahan status secara realtime.
 */
function stream(req, res) {
    ticketStreamService.subscribe(req, res, { ticketId: req.ticket.id });
}

module.exports = { create, listMine, detail, addMessage, reopen, stream, publicTicket, CATEGORIES, PRIORITIES };
