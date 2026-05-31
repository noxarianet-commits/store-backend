const crypto = require('crypto');
const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const sekalipayService = require('../services/sekalipayService');

// ══════════════════════════════════════════════════════════════════════════
// HELPER — Sekalipay Reseller Webhook Signature Verification
// Format: SHA256(ref_id + ":" + invoice + ":" + status + ":" + webhook_secret)
// ══════════════════════════════════════════════════════════════════════════

function buildSekalipaySignature(refId, invoice, status, secret) {
    return crypto
        .createHash('sha256')
        .update(`${refId}:${invoice}:${status}:${secret}`)
        .digest('hex');
}

function timingSafeCompare(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 1 — POST /api/webhooks/payment-gateway
// Dipanggil Sekalipay PG saat pembayaran user berhasil dikonfirmasi.
//
// Alur:
//   1. Verifikasi HMAC-SHA256 signature dari raw body
//   2. Cari order di Supabase via merchant_ref_id
//   3. Jika status "paid", buat transaksi ke Sekalipay Reseller
//   4. Update order: status=PROCESSING atau FAILED (jika Sekalipay error)
// ══════════════════════════════════════════════════════════════════════════

async function handlePaymentGatewayWebhook(req, res) {
    const payload = req.body || {};
    
    // Kadang payload ada di .data, kadang di luar (langsung di body)
    const data = payload.data ? payload.data : payload;
    const merchantRefId = data.merchant_ref_id || '';
    const event = req.headers['x-event'] || data.event || '';

    console.log(`[Webhook/PG] Received event for ${merchantRefId}`);

    if (!merchantRefId) {
        return res.status(400).json({ error: 'merchant_ref_id missing' });
    }

    // ── STRATEGI BARU: Webhook sbg Trigger, Verifikasi via API ────────────
    // Daripada berurusan dengan signature webhook yang sering mismatch 
    // (karena format JSON dari server PG), kita gunakan webhook ini HANYA
    // sebagai "ping". Kita akan memanggil API Sekalipay langsung untuk
    // mengecek status asli order ini. Ini 100% aman dan anti-spoofing.
    
    const checkResult = await paymentGatewayService.checkPaymentStatus(merchantRefId);
    
    if (!checkResult.success || !checkResult.data) {
        console.error(`[Webhook/PG] Gagal mengecek status ke API Sekalipay untuk ${merchantRefId}`);
        return res.status(500).json({ error: 'Failed to verify payment status via API' });
    }

    const pgData = checkResult.data;
    const pgStatus = pgData.status || ''; // Biasanya 'paid'
    const pgInvoice = pgData.invoice || '';

    console.log(`[Webhook/PG] API Verification -> merchant_ref_id=${merchantRefId}, status=${pgStatus}`);

    // ── Hanya proses jika status "paid" ──────────────────────────────────
    if (pgStatus !== 'paid' && pgStatus !== 'completed') {
        console.log(`[Webhook/PG] Status bukan "paid" (${pgStatus}), dilewati.`);
        return res.sendStatus(200);
    }

    // ── Ambil order dari Supabase ─────────────────────────────────────────
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', merchantRefId)
        .single();

    if (fetchError || !order) {
        console.error(`[Webhook/PG] Order ${merchantRefId} tidak ditemukan:`, fetchError?.message);
        return res.status(404).json({ error: 'Order not found' });
    }

    // ── Idempotency check — jangan proses dua kali ────────────────────────
    if (order.status !== 'PENDING') {
        console.log(`[Webhook/PG] Order ${merchantRefId} sudah diproses (status: ${order.status}), skip.`);
        return res.sendStatus(200);
    }

    // ── Update pg_paid_at & tandai sedang diproses ────────────────────────
    await supabase
        .from('orders')
        .update({ pg_paid_at: pgData.paid_at || new Date().toISOString() })
        .eq('id', merchantRefId);

    // ── Buat transaksi ke Sekalipay Reseller API ──────────────────────────
    const variantId = order.sekalipay_variant_id;
    if (!variantId) {
        console.error(`[Webhook/PG] Order ${merchantRefId} tidak punya sekalipay_variant_id.`);
        await supabase
            .from('orders')
            .update({ status: 'FAILED', error_message: 'variant_id tidak ditemukan di order' })
            .eq('id', merchantRefId);
        return res.sendStatus(200);
    }

    const carts = [
        {
            item_id: variantId,
            quantity: 1,
            note: '-', // produk auto, tidak butuh note
        },
    ];

    const sekalipayResult = await sekalipayService.createTransaction(merchantRefId, carts);

    if (!sekalipayResult.success) {
        // Sekalipay gagal — simpan error agar bot bisa notif admin
        const errMsg = sekalipayResult.message || 'UNKNOWN_SEKALIPAY_ERROR';
        console.error(`[Webhook/PG] Sekalipay order gagal untuk ${merchantRefId}:`, errMsg);

        await supabase
            .from('orders')
            .update({
                status: 'FAILED',
                error_message: errMsg,
                pg_invoice: pgInvoice || order.pg_invoice,
            })
            .eq('id', merchantRefId);

        return res.sendStatus(200); // Tetap 200 agar PG tidak retry
    }

    const sekalipayData = sekalipayResult.data;
    console.log(`[Webhook/PG] Sekalipay order dibuat: invoice=${sekalipayData.invoice}, ref_id=${sekalipayData.ref_id}`);

    // ── Update order ke PROCESSING ────────────────────────────────────────
    await supabase
        .from('orders')
        .update({
            status: 'PROCESSING',
            pg_invoice: pgInvoice || order.pg_invoice,
            sekalipay_invoice: sekalipayData.invoice || null,
        })
        .eq('id', merchantRefId);

    return res.sendStatus(200);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 2 — POST /api/webhooks/sekalipay
// Dipanggil Sekalipay Reseller saat order selesai/gagal.
//
// Events yang diproses:
//   order.completed — ambil licenses, update status=COMPLETED, simpan account_details
//   order.canceled  — update status=FAILED
//   webhook.test    — balas 200 saja
// ══════════════════════════════════════════════════════════════════════════

async function handleSekalipayWebhook(req, res) {
    const rawBody = req.rawBody;
    const receivedSig = req.headers['x-signature'] || '';
    const event = req.headers['x-event'] || req.body?.event || '';

    console.log(`[Webhook/Sekalipay] Received event: ${event}`);

    const payload = req.body;
    const data = payload?.data || {};
    const refId = data.ref_id || '';
    const invoice = data.invoice || '';
    const dataStatus =
        event === 'webhook.test'
            ? 'test'
            : event === 'order.item.sent'
            ? (data.item?.status || '')
            : (data.status || '');

    // ── Verifikasi signature ──────────────────────────────────────────────
    const webhookSecret = process.env.SEKALIPAY_WEBHOOK_SECRET || '';
    const expectedSig = buildSekalipaySignature(refId, invoice, dataStatus, webhookSecret);

    if (!timingSafeCompare(receivedSig, expectedSig)) {
        console.warn('[Webhook/Sekalipay] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── webhook.test — hanya verifikasi konfigurasi ───────────────────────
    if (event === 'webhook.test') {
        console.log('[Webhook/Sekalipay] Test webhook OK.');
        return res.sendStatus(200);
    }

    // ── Ambil order dari Supabase via sekalipay_ref_id ────────────────────
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('id, status')
        .eq('sekalipay_ref_id', refId)
        .single();

    if (fetchError || !order) {
        console.error(`[Webhook/Sekalipay] Order ref_id=${refId} tidak ditemukan.`);
        // Tetap 200 agar tidak di-retry terus
        return res.sendStatus(200);
    }

    // ── order.completed ───────────────────────────────────────────────────
    if (event === 'order.completed') {
        if (order.status === 'COMPLETED') {
            console.log(`[Webhook/Sekalipay] Order ${refId} sudah COMPLETED, skip.`);
            return res.sendStatus(200);
        }

        // Ekstrak licenses dari items (produk auto)
        const items = data.items || [];
        const allLicenses = [];

        items.forEach((item) => {
            if (Array.isArray(item.licenses)) {
                allLicenses.push(...item.licenses);
            }
        });

        const accountDetails = {
            type: 'auto',
            licenses: allLicenses,
            raw_items: items,
            completed_at: payload.timestamp || new Date().toISOString(),
        };

        const { error: updateError } = await supabase
            .from('orders')
            .update({
                status: 'COMPLETED',
                account_details: accountDetails,
                sekalipay_invoice: invoice,
            })
            .eq('id', order.id);

        if (updateError) {
            console.error(`[Webhook/Sekalipay] Gagal update order ${order.id}:`, updateError.message);
        } else {
            console.log(`[Webhook/Sekalipay] Order ${order.id} COMPLETED. Licenses: ${allLicenses.length}`);
        }

        return res.sendStatus(200);
    }

    // ── order.canceled ────────────────────────────────────────────────────
    if (event === 'order.canceled') {
        await supabase
            .from('orders')
            .update({
                status: 'FAILED',
                error_message: 'Order dibatalkan oleh Sekalipay',
                sekalipay_invoice: invoice,
            })
            .eq('id', order.id);

        console.log(`[Webhook/Sekalipay] Order ${order.id} CANCELLED.`);
        return res.sendStatus(200);
    }

    // ── Event lain — abaikan ──────────────────────────────────────────────
    console.log(`[Webhook/Sekalipay] Event ${event} tidak diproses.`);
    return res.sendStatus(200);
}

module.exports = { handlePaymentGatewayWebhook, handleSekalipayWebhook };
