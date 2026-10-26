const supabase = require('../supabase');
const ticketStreamService = require('../services/ticketStreamService');
const { publicTicket, PRIORITIES } = require('./ticketController');

const STATUSES = ['open', 'pending', 'closed'];
const LIMITS = { body: 4000 };

/**
 * Kolom order yang aman ditampilkan ke admin di panel tiket.
 * SENGAJA tidak menyertakan account_details (kredensial game) dan
 * order_access_token — lihat peringatan di migrations/018_order_access_token.sql.
 */
const ADMIN_ORDER_COLUMNS = 'id, customer_name, email, wa_number, product, variant, status, price, pg_total, pg_provider, payment_type, vendor, vendor_status, error_message, timestamp';

function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * GET /api/admin/tickets
 * Daftar tiket dengan pagination, pencarian, filter status & prioritas.
 */
async function list(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        // Buang karakter yang merusak sintaks filter .or() PostgREST.
        const search = str(req.query.search).replace(/[,()%]/g, ' ').trim();
        const status = str(req.query.status).toLowerCase();
        const priority = str(req.query.priority).toLowerCase();

        let query = supabase
            .from('tickets')
            .select('id, ticket_number, subject, category, status, priority, order_id, guest_name, guest_email, guest_wa, user_id, last_message_at, last_message_by, closed_at, created_at, updated_at', { count: 'exact' });

        if (search) {
            query = query.or(
                `ticket_number.ilike.%${search}%,guest_name.ilike.%${search}%,guest_email.ilike.%${search}%,guest_wa.ilike.%${search}%,subject.ilike.%${search}%,order_id.ilike.%${search}%`
            );
        }
        if (STATUSES.includes(status)) query = query.eq('status', status);
        if (PRIORITIES.includes(priority)) query = query.eq('priority', priority);

        query = query.order('last_message_at', { ascending: false }).range(from, to);

        const { data, count, error } = await query;
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
        console.error('[AdminTicketController] list error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat daftar tiket.' });
    }
}

/**
 * GET /api/admin/tickets/stats
 * Hitungan per status + jumlah tiket open/pending berprioritas tinggi.
 * Dipakai badge sidebar dan header tab.
 */
async function stats(req, res) {
    try {
        const head = { count: 'exact', head: true };
        const [open, pending, closed, urgent] = await Promise.all([
            supabase.from('tickets').select('id', head).eq('status', 'open'),
            supabase.from('tickets').select('id', head).eq('status', 'pending'),
            supabase.from('tickets').select('id', head).eq('status', 'closed'),
            supabase.from('tickets').select('id', head).in('status', ['open', 'pending']).in('priority', ['high', 'urgent']),
        ]);

        const firstError = open.error || pending.error || closed.error || urgent.error;
        if (firstError) throw firstError;

        return res.json({
            success: true,
            data: {
                open: open.count || 0,
                pending: pending.count || 0,
                closed: closed.count || 0,
                urgent: urgent.count || 0,
                active: (open.count || 0) + (pending.count || 0),
            },
        });
    } catch (err) {
        console.error('[AdminTicketController] stats error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat statistik tiket.' });
    }
}

/**
 * GET /api/admin/tickets/:ticketNumber
 * Detail tiket + semua pesan + ringkasan pesanan terkait (kolom aman saja).
 */
async function detail(req, res) {
    try {
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('ticket_number', req.params.ticketNumber)
            .maybeSingle();

        if (error) throw error;
        if (!ticket) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
        }

        const { data: messages, error: messagesError } = await supabase
            .from('ticket_messages')
            .select('id, author, admin_id, body, created_at')
            .eq('ticket_id', ticket.id)
            .order('created_at', { ascending: true });

        if (messagesError) throw messagesError;

        let order = null;
        if (ticket.order_id) {
            const { data } = await supabase
                .from('orders')
                .select(ADMIN_ORDER_COLUMNS)
                .eq('id', ticket.order_id)
                .maybeSingle();
            order = data || null;
        }

        return res.json({
            success: true,
            data: { ...publicTicket(ticket), messages: messages || [], order },
        });
    } catch (err) {
        console.error('[AdminTicketController] detail error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal memuat tiket.' });
    }
}

/**
 * POST /api/admin/tickets/:ticketNumber/messages
 * Balas tiket sebagai admin. Tiket tertutup otomatis dibuka kembali.
 */
async function reply(req, res) {
    try {
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('ticket_number', req.params.ticketNumber)
            .maybeSingle();

        if (error) throw error;
        if (!ticket) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
        }

        const body = str(req.body && req.body.body).slice(0, LIMITS.body + 1);
        if (!body) {
            return res.status(400).json({ success: false, error: 'Balasan wajib diisi.' });
        }
        if (body.length > LIMITS.body) {
            return res.status(400).json({ success: false, error: `Balasan maksimal ${LIMITS.body} karakter.` });
        }

        const { data: message, error: messageError } = await supabase
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                author: 'admin',
                admin_id: req.admin && req.admin.id != null ? String(req.admin.id) : null,
                body,
            })
            .select('id, author, admin_id, body, created_at')
            .single();

        if (messageError) throw messageError;

        const patch = { last_message_at: new Date().toISOString(), last_message_by: 'admin' };
        // Balasan admin pada tiket tertutup otomatis membukanya kembali.
        if (ticket.status === 'closed') {
            patch.status = 'open';
            patch.closed_at = null;
        }

        const { data: updated, error: updateError } = await supabase
            .from('tickets')
            .update(patch)
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
        console.error('[AdminTicketController] reply error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal mengirim balasan.' });
    }
}

/**
 * PATCH /api/admin/tickets/:ticketNumber
 * Ubah status dan/atau prioritas tiket.
 */
async function update(req, res) {
    try {
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('ticket_number', req.params.ticketNumber)
            .maybeSingle();

        if (error) throw error;
        if (!ticket) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan.' });
        }

        const patch = {};

        if (req.body && req.body.status !== undefined) {
            const status = str(req.body.status).toLowerCase();
            if (!STATUSES.includes(status)) {
                return res.status(400).json({ success: false, error: 'Status tidak valid.' });
            }
            patch.status = status;
            patch.closed_at = status === 'closed' ? new Date().toISOString() : null;
        }

        if (req.body && req.body.priority !== undefined) {
            const priority = str(req.body.priority).toLowerCase();
            if (!PRIORITIES.includes(priority)) {
                return res.status(400).json({ success: false, error: 'Prioritas tidak valid.' });
            }
            patch.priority = priority;
        }

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ success: false, error: 'Tidak ada perubahan yang dikirim.' });
        }

        const { data: updated, error: updateError } = await supabase
            .from('tickets')
            .update(patch)
            .eq('id', ticket.id)
            .select('*')
            .single();

        if (updateError) throw updateError;

        ticketStreamService.publish(ticket.id, 'status', {
            ticket_id: ticket.id,
            status: updated.status,
            priority: updated.priority,
            ticket: publicTicket(updated),
        });

        return res.json({ success: true, data: publicTicket(updated) });
    } catch (err) {
        console.error('[AdminTicketController] update error:', err.message);
        return res.status(500).json({ success: false, error: 'Gagal mengubah tiket.' });
    }
}

/**
 * GET /api/admin/tickets/stream
 * SSE feed inbox admin: menerima semua event tiket (created/message/status).
 */
function stream(req, res) {
    ticketStreamService.subscribe(req, res, { admin: true });
}

module.exports = { list, stats, detail, reply, update, stream };
