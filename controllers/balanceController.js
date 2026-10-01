const balanceService = require('../services/balanceService');
const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const sekalipayGatewayService = require('../services/sekalipayGatewayService');
const dyqrisGatewayService = require('../services/dyqrisGatewayService');

const { getActivePaymentGateway } = require('./paymentController');

async function getBalance(req, res) {
    try {
        const data = await balanceService.getBalance(req.user.id);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

async function createTopup(req, res) {
    try {
        const { amount } = req.body;
        if (!amount || amount < 1000) {
            return res.status(400).json({ success: false, error: 'Minimal top-up adalah Rp 10.000' });
        }

        const balanceData = await balanceService.getBalance(req.user.id);
        if (balanceData.balance + amount > balanceData.balance_limit) {
            return res.status(400).json({ success: false, error: `Top-up ditolak. Melebihi limit saldo (Rp ${balanceData.balance_limit.toLocaleString('id-ID')}).` });
        }

        const pgProvider = await getActivePaymentGateway();
        const topupId = `TOPUP-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Date.now().toString().slice(-6)}`;
        
        let pgInvoice, qrLink, total, pgExpiredAt;

        // PG Create Invoice — must match exact method names from each gateway service
        if (pgProvider === 'dyqris') {
            const pgRes = await dyqrisGatewayService.createTransaction({
                refId: topupId,
                amount: amount,
                expiryMinutes: 30, // 30 menit
                metadata: { product_name: 'Top-up Saldo NoxariaNet' }
            });
            if (!pgRes.success) throw new Error(pgRes.message || 'Dyqris createTransaction failed');
            pgInvoice = pgRes.data.id;
            qrLink = pgRes.data.qr_image_url || (pgRes.data.qr_string ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(pgRes.data.qr_string)}` : null);
            total = pgRes.data.actual_amount || amount;
            pgExpiredAt = pgRes.data.expired_at ? new Date(pgRes.data.expired_at) : new Date(Date.now() + 30 * 60 * 1000);
        } else if (pgProvider === 'sekalipay') {
            const pgRes = await sekalipayGatewayService.createPayment({
                merchant_ref_id: topupId,
                amount: amount,
                customer_name: req.user.display_name || 'User',
                customer_email: req.user.email || 'user@noxarianet.web.id',
                metadata: { source: 'topup', order_id: topupId }
            });
            if (!pgRes.success) throw new Error(pgRes.message || 'Sekalipay createPayment failed');
            pgInvoice = pgRes.data.invoice || pgRes.data.merchant_ref_id;
            qrLink = pgRes.data.qr_link || pgRes.data.payment_link || null;
            total = pgRes.data.total || amount;
            pgExpiredAt = pgRes.data.expired_at ? new Date(pgRes.data.expired_at) : new Date(Date.now() + 30 * 60 * 1000);
        } else {
            // fincloud (default)
            const pgRes = await paymentGatewayService.createInvoice({
                reffId: topupId,
                nominal: amount,
            });
            if (!pgRes.success) throw new Error(pgRes.message || 'Fincloud createInvoice failed');
            pgInvoice = String(pgRes.data.reff_id || pgRes.data.external_id || pgRes.data.id_depo || topupId);
            qrLink = pgRes.data.qris_url || pgRes.data.qr_url || (pgRes.data.qris_string ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(pgRes.data.qris_string)}` : null);
            total = pgRes.data.total_bayar || pgRes.data.nominal_total || amount;
            pgExpiredAt = new Date(Date.now() + 30 * 60 * 1000);
        }

        // Batalkan topup pending sebelumnya milik user ini agar tidak menumpuk
        await supabase
            .from('balance_transactions')
            .update({ status: 'cancelled' })
            .eq('user_id', req.user.id)
            .eq('type', 'topup')
            .eq('status', 'pending');

        const { data: tx, error } = await supabase.from('balance_transactions').insert([{
            user_id: req.user.id,
            type: 'topup',
            amount,
            balance_before: balanceData.balance,
            balance_after: balanceData.balance,
            status: 'pending',
            reference_id: topupId,
            description: `Top-up Saldo`,
            pg_provider: pgProvider,
            pg_invoice: pgInvoice,
            pg_qr_link: qrLink,
            pg_total: total,
            pg_expired_at: pgExpiredAt
        }]).select('id').single();

        if (error) throw error;

        res.json({
            success: true,
            topup_id: topupId,
            qr_link: qrLink,
            total,
            pg_provider: pgProvider,
            status: 'pending',
            amount
        });
    } catch (err) {
        console.error('Create Topup Error:', err);
        res.status(500).json({ success: false, error: 'Gagal membuat top-up' });
    }
}

async function getTopupStatus(req, res) {
    try {
        const { id } = req.params; // referensi id (TOPUP-xxx) atau UUID
        
        let query = supabase
            .from('balance_transactions')
            .select('*')
            .eq('user_id', req.user.id);

        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            query = query.or(`id.eq.${id},reference_id.eq.${id}`);
        } else {
            query = query.eq('reference_id', id);
        }

        const { data: txList, error } = await query.order('created_at', { ascending: false });

        if (error || !txList || txList.length === 0) {
            return res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
        }

        // Cari transaksi (utamakan yang completed, lalu yang punya info PG)
        let tx = txList.find(t => t.status === 'completed') || txList.find(t => t.pg_provider || t.pg_invoice) || txList[0];

        // Jika sudah completed, langsung kembalikan status completed
        if (tx.status === 'completed') {
            return res.json({ success: true, status: 'completed', data: tx });
        }

        // Kalau masih pending, cek status PG dan batas kedaluwarsa 30 menit
        if (tx.status === 'pending' && (tx.pg_invoice || tx.reference_id)) {
            let isPaid = false;
            let isExpired = false;

            const now = new Date();
            const createdAt = new Date(tx.created_at);
            const isTimeout = (now - createdAt >= 30 * 60 * 1000) || (tx.pg_expired_at && now >= new Date(tx.pg_expired_at));
            
            try {
                if (tx.pg_provider === 'dyqris') {
                    const statusRes = await dyqrisGatewayService.getTransactionDetails(tx.pg_invoice || tx.reference_id);
                    const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                    if (s === 'PAID') isPaid = true;
                    else if (s === 'EXPIRED' || s === 'CANCELLED') isExpired = true;
                } else if (tx.pg_provider === 'sekalipay') {
                    const statusRes = await sekalipayGatewayService.checkPaymentStatus(tx.reference_id || tx.pg_invoice);
                    const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                    if (s === 'PAID' || s === 'SUCCESS' || s === 'COMPLETED') isPaid = true;
                    else if (s === 'EXPIRED' || s === 'CANCELLED' || s === 'FAILED') isExpired = true;
                } else {
                    // fincloud
                    const statusRes = await paymentGatewayService.checkInvoiceStatus(tx.pg_invoice || tx.reference_id);
                    const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                    if (s === 'PAID' || s === 'SUCCESS') isPaid = true;
                    else if (s === 'EXPIRED' || s === 'CANCELLED') isExpired = true;
                }
            } catch (pgError) {
                console.error(`Error polling status for topup ${tx.reference_id}:`, pgError.message);
            }

            if (isPaid) {
                try {
                    await balanceService.creditTopup(tx);
                    tx.status = 'completed';
                } catch (creditErr) {
                    console.error('Error crediting balance for topup:', creditErr);
                }
            } else if (isExpired || isTimeout) {
                await supabase.from('balance_transactions').update({ status: 'cancelled' }).eq('id', tx.id);
                tx.status = 'cancelled';
            }
        }

        res.json({ success: true, status: tx.status, data: tx });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

async function getHistory(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const type = req.query.type || null;
        
        const data = await balanceService.getHistory(req.user.id, page, limit, type);
        res.json({ success: true, ...data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

async function getPendingTopup(req, res) {
    try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const nowIso = new Date().toISOString();

        const { data: tx, error } = await supabase
            .from('balance_transactions')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('type', 'topup')
            .eq('status', 'pending')
            .not('pg_qr_link', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        if (tx) {
            // Cek apakah sudah expired (> 30 menit atau pg_expired_at terlewat)
            const isExpired = (new Date(tx.created_at) < new Date(thirtyMinutesAgo)) || 
                              (tx.pg_expired_at && new Date(tx.pg_expired_at) < new Date(nowIso));

            if (isExpired) {
                await supabase
                    .from('balance_transactions')
                    .update({ status: 'cancelled' })
                    .eq('id', tx.id);
                return res.json({ success: true, data: null });
            }
        }

        res.json({ success: true, data: tx || null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

async function cancelPendingTopup(req, res) {
    try {
        const { id } = req.body;
        let query = supabase
            .from('balance_transactions')
            .update({ status: 'cancelled' })
            .eq('user_id', req.user.id)
            .eq('type', 'topup')
            .eq('status', 'pending');

        if (id) {
            query = query.or(`id.eq.${id},reference_id.eq.${id}`);
        }

        const { error } = await query;
        if (error) throw error;

        res.json({ success: true, message: 'Top-up berhasil dibatalkan' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { getBalance, createTopup, getTopupStatus, getHistory, getPendingTopup, cancelPendingTopup };
