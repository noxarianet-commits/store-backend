const crypto = require('crypto');
const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const sekalipayService = require('../services/sekalipayService');
const emailService = require('../services/emailService');
const orderFulfillmentService = require('../services/orderFulfillmentService');
const vendorRegistry = require('../services/vendors/vendorRegistry');
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
// Dipanggil FinCloud saat pembayaran QRIS user berhasil dikonfirmasi.
//
// FinCloud mengirim callback via POST form-urlencoded dengan parameter:
//   reff_id   — ID referensi invoice (= orderId kita)
//   nominal   — Jumlah nominal yang dibayar
//   status    — Status pembayaran ('success')
//   signature — MD5(apikey + reff_id + status)
//   is_test   — (opsional) true jika simulasi ping test dari dashboard
//
// Alur:
//   1. Validasi signature MD5 dari FinCloud
//   2. Handle ping test (is_test)
//   3. Verify via API: panggil cek_status untuk konfirmasi ulang
//   4. Cari order di Supabase via reff_id (= orderId)
//   5. Jika status "success", buat transaksi ke Sekalipay Reseller
//   6. Update order: status=PROCESSING atau FAILED (jika Sekalipay error)
// ══════════════════════════════════════════════════════════════════════════

async function handlePaymentGatewayWebhook(req, res) {
    const reffId = req.body?.reff_id || '';
    const nominal = req.body?.nominal || '';
    const status = req.body?.status || '';
    const signature = req.body?.signature || '';
    const isTest = req.body?.is_test === 'true' || req.body?.is_test === true;

    console.log(`[Webhook/PG-FinCloud] Received callback for reff_id=${reffId}, status=${status}`);

    // ── Validasi signature ────────────────────────────────────────────────
    const isValidSig = paymentGatewayService.verifyWebhookSignature(
        reffId,
        status,
        signature
    );

    if (!isValidSig) {
        console.warn('[Webhook/PG-FinCloud] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── Handle ping test dari FinCloud dashboard ──────────────────────────
    if (isTest) {
        console.log('[Webhook/PG-FinCloud] Test webhook OK (is_test=true).');
        return res.status(200).send('TEST_OK');
    }

    // ── Hanya proses jika status "success" ────────────────────────────────
    if (status !== 'success') {
        console.log(`[Webhook/PG-FinCloud] Status bukan "success" (${status}), dilewati.`);
        return res.status(200).json({ message: 'Status not success, ignored' });
    }

    if (!reffId) {
        return res.status(400).json({ error: 'reff_id missing' });
    }

    // ── Ambil order dari Supabase (reff_id = orderId) ─────────────────────
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', reffId)
        .single();

    if (fetchError || !order) {
        console.error(`[Webhook/PG-FinCloud] Order ${reffId} tidak ditemukan:`, fetchError?.message);
        return res.status(404).json({ error: 'Order not found' });
    }

    // ── Idempotency check — jangan proses dua kali ────────────────────────
    if (order.status !== 'PENDING') {
        console.log(`[Webhook/PG-FinCloud] Order ${reffId} sudah diproses (status: ${order.status}), skip.`);
        return res.status(200).json({ message: 'Order already processed' });
    }

    // ── Verifikasi via API (opsional, untuk extra security) ───────────────
    const idDepo = order.pg_invoice; // id_depo disimpan di pg_invoice saat create
    if (idDepo) {
        const checkResult = await paymentGatewayService.checkInvoiceStatus(idDepo);
        if (checkResult.success && checkResult.data) {
            const apiStatus = checkResult.data.status;
            if (apiStatus !== 'success') {
                console.warn(`[Webhook/PG-FinCloud] API verification says status=${apiStatus}, bukan success. Skip.`);
                return res.status(200).json({ message: 'API verification failed' });
            }
            console.log(`[Webhook/PG-FinCloud] API verification OK: id_depo=${idDepo}, status=${apiStatus}`);
        } else {
            // API check gagal, tapi signature sudah valid — lanjut proses
            console.warn(`[Webhook/PG-FinCloud] API verification gagal untuk id_depo=${idDepo}, lanjut dengan signature.`);
        }
    }

    // ── Update pg_paid_at & tandai sedang diproses ────────────────────────
    await supabase
        .from('orders')
        .update({ pg_paid_at: new Date().toISOString() })
        .eq('id', reffId);

    // ── Buat transaksi ke Vendor (Sekalipay / Fincloud) via Fulfillment Service ──────────
    // OrderFulfillmentService already has atomic lock and handles both vendors.
    const fulfillmentResult = await orderFulfillmentService.fulfillOrder(order);

    if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
        console.error(`[Webhook/PG-FinCloud] Fulfillment order gagal untuk ${reffId}:`, fulfillmentResult.message);
        // Order status is already updated to FAILED in fulfillOrder
        return res.sendStatus(200); // Tetap 200 agar FinCloud tidak retry
    }

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
            : (data.status || data.item?.status || '');

    // ── Verifikasi signature ──────────────────────────────────────────────
    const webhookSecret = process.env.SEKALIPAY_WEBHOOK_SECRET || '';
    const expectedSig = buildSekalipaySignature(refId, invoice, dataStatus, webhookSecret);

    // console.log(`[Webhook/Sekalipay] Signature debug: ref_id="${refId}", invoice="${invoice}", status="${dataStatus}"`);
    // console.log(`[Webhook/Sekalipay] Signature received="${receivedSig}", expected="${expectedSig}"`);

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
        .select('*')
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

            // Kirim email notifikasi sukses ke pembeli (fire-and-forget)
            emailService.sendOrderCompletedEmail({
                ...order,
                account_details: accountDetails,
                sekalipay_invoice: invoice,
            }).catch(err => console.error(`[Webhook/Sekalipay] Email completed gagal:`, err.message));
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

        // Kirim email notifikasi gagal ke pembeli (fire-and-forget)
        emailService.sendOrderFailedEmail(order)
            .catch(err => console.error(`[Webhook/Sekalipay] Email failed gagal:`, err.message));

        return res.sendStatus(200);
    }

    // ── order.refunded ──────────────────────────────────
    if (event === 'order.refunded') {
        const rawPayloadStr = JSON.stringify(payload);
        await supabase
            .from('orders')
            .update({
                status: 'FAILED',
                error_message: `Nomor tujuan salah atau tidak valid (refund)`,
                sekalipay_invoice: invoice,
            })
            .eq('id', order.id);

        console.log(`[Webhook/Sekalipay] Order ${order.id} REFUNDED/REFOUNDED. Payload: ${rawPayloadStr}`);

        // Kirim email notifikasi gagal ke pembeli (fire-and-forget)
        emailService.sendOrderFailedEmail(order)
            .catch(err => console.error(`[Webhook/Sekalipay] Email refunded gagal:`, err.message));

        return res.sendStatus(200);
    }

    // ── Event lain — abaikan ──────────────────────────────────────────────
    console.log(`[Webhook/Sekalipay] Event ${event} tidak diproses.`);
    return res.sendStatus(200);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 3 — POST /api/webhooks/fincloud-ppob
// Dipanggil Fincloud PPOB H2H saat order sukses atau gagal
// ══════════════════════════════════════════════════════════════════════════

async function handleFincloudPPOBWebhook(req, res) {
    const { reff_id, nominal, status, rrn, signature, signature_hmac } = req.body;
    
    console.log(`[Webhook/Fincloud-PPOB] Received callback for reff_id=${reff_id}, status=${status}`);

    if (!reff_id) {
        return res.status(400).json({ error: 'reff_id missing' });
    }

    let adapter;
    try {
        adapter = vendorRegistry.get('fincloud');
    } catch (err) {
        console.error(`[Webhook/Fincloud-PPOB] Fincloud adapter not found`);
        return res.status(500).json({ error: 'Vendor adapter missing' });
    }

    const webhookSecret = process.env.FINCLOUD_PPOB_WEBHOOK_SECRET;
    
    const isValidSig = adapter.verifyWebhookSignature(req.body, signature, webhookSecret);
    if (!isValidSig) {
        console.warn('[Webhook/Fincloud-PPOB] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── Ambil order dari Supabase (vendor_ref_id = reff_id) ─────────────────────
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('vendor_ref_id', reff_id)
        .eq('vendor', 'fincloud')
        .single();

    if (fetchError || !order) {
        console.error(`[Webhook/Fincloud-PPOB] Order ${reff_id} tidak ditemukan:`, fetchError?.message);
        return res.sendStatus(200); // 200 to prevent retries
    }

    if (order.status === 'COMPLETED' || order.status === 'FAILED') {
        console.log(`[Webhook/Fincloud-PPOB] Order ${reff_id} sudah final (${order.status}), skip.`);
        return res.sendStatus(200);
    }

    if (status === 'success') {
        const accountDetails = {
            ...order.account_details,
            type: 'auto',
            rrn: rrn || null,
            completed_at: new Date().toISOString()
        };

        const { error: updateError } = await supabase
            .from('orders')
            .update({
                status: 'COMPLETED',
                account_details: accountDetails,
                vendor_status: 'success'
            })
            .eq('id', order.id);

        if (updateError) {
            console.error(`[Webhook/Fincloud-PPOB] Gagal update order ${order.id}:`, updateError.message);
        } else {
            console.log(`[Webhook/Fincloud-PPOB] Order ${order.id} COMPLETED.`);
            emailService.sendOrderCompletedEmail({
                ...order,
                account_details: accountDetails
            }).catch(err => console.error(`[Webhook/Fincloud-PPOB] Email completed gagal:`, err.message));
        }
    } else if (status === 'failed') {
        await supabase
            .from('orders')
            .update({
                status: 'FAILED',
                error_message: rrn || 'Order dibatalkan oleh Fincloud',
                vendor_status: 'failed'
            })
            .eq('id', order.id);

        console.log(`[Webhook/Fincloud-PPOB] Order ${order.id} FAILED.`);
        emailService.sendOrderFailedEmail(order)
            .catch(err => console.error(`[Webhook/Fincloud-PPOB] Email failed gagal:`, err.message));
    } else {
        console.log(`[Webhook/Fincloud-PPOB] Unhandled status: ${status}`);
    }

    return res.sendStatus(200);
}

module.exports = { handlePaymentGatewayWebhook, handleSekalipayWebhook, handleFincloudPPOBWebhook };
