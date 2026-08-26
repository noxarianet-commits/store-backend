const crypto = require('crypto');
const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const sekalipayGatewayService = require('../services/sekalipayGatewayService');
const dyqrisGatewayService = require('../services/dyqrisGatewayService');
const emailService = require('../services/emailService');
const orderFulfillmentService = require('../services/orderFulfillmentService');
const vendorRegistry = require('../services/vendors/vendorRegistry');

// ══════════════════════════════════════════════════════════════════════════
// HELPER — Sekalipay Reseller Webhook Signature Verification
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
// ══════════════════════════════════════════════════════════════════════════

async function handlePaymentGatewayWebhook(req, res) {
    const reffId = req.body?.reff_id || '';
    const status = req.body?.status || '';
    const signature = req.body?.signature || '';
    const isTest = req.body?.is_test === 'true' || req.body?.is_test === true;

    console.log(`[Webhook/PG-FinCloud] Received callback for reff_id=${reffId}, status=${status}`);

    // 1. Validasi signature
    const isValidSig = paymentGatewayService.verifyWebhookSignature(
        reffId,
        status,
        signature
    );

    if (!isValidSig) {
        console.warn('[Webhook/PG-FinCloud] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    if (isTest) {
        return res.status(200).send('TEST_OK');
    }

    if (status !== 'success') {
        return res.status(200).json({ message: 'Status not success, ignored' });
    }

    if (!reffId) {
        return res.status(400).json({ error: 'reff_id missing' });
    }

    // 2. Ambil order dari Supabase (reff_id = orderId)
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', reffId)
        .single();

    if (fetchError || !order) {
        console.error(`[Webhook/PG-FinCloud] Order ${reffId} tidak ditemukan:`, fetchError?.message);
        return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'PENDING') {
        return res.status(200).json({ message: 'Order already processed' });
    }

    // 3. Update pg_paid_at & proses fulfillment
    await supabase
        .from('orders')
        .update({ pg_paid_at: new Date().toISOString() })
        .eq('id', reffId);

    const fulfillmentResult = await orderFulfillmentService.fulfillOrder(order);
    if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
        console.error(`[Webhook/PG-FinCloud] Fulfillment order gagal untuk ${reffId}:`, fulfillmentResult.message);
    }

    return res.sendStatus(200);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 2 — POST /api/webhooks/sekalipay
// Dipanggil Sekalipay Reseller saat order selesai/gagal.
// ══════════════════════════════════════════════════════════════════════════

async function handleSekalipayWebhook(req, res) {
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

    // 1. Verifikasi signature
    const webhookSecret = process.env.SEKALIPAY_WEBHOOK_SECRET || '';
    const expectedSig = buildSekalipaySignature(refId, invoice, dataStatus, webhookSecret);

    if (!timingSafeCompare(receivedSig, expectedSig)) {
        console.warn('[Webhook/Sekalipay] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    if (event === 'webhook.test') {
        return res.sendStatus(200);
    }

    // 2. Ambil order dari Supabase
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .or(`vendor_order_id.eq.${refId},id.eq.${refId}`)
        .maybeSingle();

    if (fetchError || !order) {
        console.error(`[Webhook/Sekalipay] Order ref_id=${refId} tidak ditemukan.`);
        return res.sendStatus(200);
    }

    // 3. order.completed
    if (event === 'order.completed') {
        if (order.status === 'COMPLETED') {
            return res.sendStatus(200);
        }

        const items = data.items || [];
        const allLicenses = [];

        items.forEach((item) => {
            if (Array.isArray(item.licenses)) {
                allLicenses.push(...item.licenses);
            }
        });

        const accountDetails = {
            ...order.account_details,
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
                vendor_status: 'success',
                vendor_invoice: invoice,
            })
            .eq('id', order.id);

        if (updateError) {
            console.error(`[Webhook/Sekalipay] Gagal update order ${order.id}:`, updateError.message);
        } else {
            console.log(`[Webhook/Sekalipay] Order ${order.id} COMPLETED. Licenses: ${allLicenses.length}`);
            emailService.sendOrderCompletedEmail({
                ...order,
                account_details: accountDetails,
                vendor_invoice: invoice,
            }).catch(err => console.error(`[Webhook/Sekalipay] Email completed gagal:`, err.message));
        }

        return res.sendStatus(200);
    }

    // 4. order.canceled / refunded
    if (event === 'order.canceled' || event === 'order.refunded') {
        const errorMsg = event === 'order.refunded'
            ? 'Nomor tujuan salah atau tidak valid (refund)'
            : 'Order dibatalkan oleh Sekalipay';

        await supabase
            .from('orders')
            .update({
                status: 'FAILED',
                error_message: errorMsg,
                vendor_status: 'failed',
                vendor_invoice: invoice,
            })
            .eq('id', order.id);

        console.log(`[Webhook/Sekalipay] Order ${order.id} ${event}.`);
        emailService.sendOrderFailedEmail(order)
            .catch(err => console.error(`[Webhook/Sekalipay] Email failed gagal:`, err.message));

        return res.sendStatus(200);
    }

    return res.sendStatus(200);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 3 — POST /api/webhooks/fincloud-ppob
// Dipanggil Fincloud PPOB H2H saat order sukses atau gagal
// ══════════════════════════════════════════════════════════════════════════

async function handleFincloudPPOBWebhook(req, res) {
    const { reff_id, status, rrn, sn, signature } = req.body;
    
    console.log(`[Webhook/Fincloud-PPOB] Received callback for reff_id=${reff_id}, status=${status}`);

    if (!reff_id) {
        return res.status(400).json({ error: 'reff_id missing' });
    }

    let adapter;
    try {
        adapter = vendorRegistry.get('fincloud');
    } catch (err) {
        return res.status(500).json({ error: 'Vendor adapter missing' });
    }

    const webhookSecret = process.env.FINCLOUD_PPOB_WEBHOOK_SECRET;
    const isValidSig = adapter.verifyWebhookSignature(req.body, signature, webhookSecret);
    if (!isValidSig) {
        console.warn('[Webhook/Fincloud-PPOB] Invalid signature — request ditolak.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // Ambil order dari Supabase
    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('*')
        .or(`vendor_order_id.eq.${reff_id},id.eq.${reff_id}`)
        .eq('vendor', 'fincloud')
        .maybeSingle();

    if (fetchError || !order) {
        console.error(`[Webhook/Fincloud-PPOB] Order ${reff_id} tidak ditemukan:`, fetchError?.message);
        return res.sendStatus(200);
    }

    if (order.status === 'COMPLETED' || order.status === 'FAILED') {
        return res.sendStatus(200);
    }

    if (status === 'success') {
        const actualRrn = rrn || sn || null;
        const accountDetails = {
            ...order.account_details,
            type: 'auto',
            rrn: actualRrn,
            licenses: actualRrn ? [actualRrn] : [],
            completed_at: new Date().toISOString()
        };

        const { error: updateError } = await supabase
            .from('orders')
            .update({
                status: 'COMPLETED',
                account_details: accountDetails,
                vendor_status: 'success',
                vendor_invoice: actualRrn,
            })
            .eq('id', order.id);

        if (!updateError) {
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
    }

    return res.sendStatus(200);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 4 — POST /api/webhooks/sekalipay-gateway
// Callback dari Sekalipay Payment Gateway (QRIS).
// ══════════════════════════════════════════════════════════════════════════

async function handleSekalipayGatewayWebhook(req, res) {
    try {
        const signature = req.headers['x-signature'] || req.headers['x-webhook-signature'] || '';
        const payloadString = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        
        const { secretKey } = await sekalipayGatewayService.getConfig();
        if (secretKey) {
            const isValid = sekalipayGatewayService.verifyWebhookSignature(payloadString, signature, secretKey);
            if (!isValid) {
                console.warn('[Webhook/SekalipayGateway] Invalid signature - request ditolak.');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const data = body.data || body;
        const event = body.event || body.type || '';

        const merchantRefId = data.merchant_ref_id || data.ref_id || data.order_id || body.merchant_ref_id;
        const invoice = data.invoice || body.invoice;
        const status = String(data.status || body.status || '').toLowerCase();

        console.log(`[Webhook/SekalipayGateway] Received callback for ref=${merchantRefId}, invoice=${invoice}, status=${status}, event=${event}`);

        if (!merchantRefId && !invoice) {
            return res.status(400).json({ error: 'merchant_ref_id or invoice missing' });
        }

        // Cari order di Supabase
        let query = supabase.from('orders').select('*');
        if (merchantRefId && invoice) {
            query = query.or(`id.eq.${merchantRefId},pg_invoice.eq.${invoice}`);
        } else if (merchantRefId) {
            query = query.eq('id', merchantRefId);
        } else {
            query = query.eq('pg_invoice', invoice);
        }

        const { data: order, error: fetchError } = await query.maybeSingle();

        if (fetchError || !order) {
            console.error(`[Webhook/SekalipayGateway] Order ref=${merchantRefId} invoice=${invoice} tidak ditemukan.`);
            return res.status(200).json({ received: true });
        }

        if (order.status !== 'PENDING') {
            return res.status(200).json({ received: true, message: 'Order already processed' });
        }

        // Cek status keberhasilan bayar
        const isPaid = status === 'paid' || status === 'success' || status === 'completed' || event === 'payment.paid' || event === 'invoice.paid';

        if (isPaid) {
            const paidAt = data.paid_at || new Date().toISOString();
            await supabase
                .from('orders')
                .update({ pg_paid_at: paidAt })
                .eq('id', order.id);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(order);
            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.error(`[Webhook/SekalipayGateway] Fulfillment order gagal untuk ${order.id}:`, fulfillmentResult.message);
            }
        } else if (status === 'expired' || status === 'cancelled' || status === 'failed') {
            await supabase
                .from('orders')
                .update({ status: 'CANCELLED', error_message: `Pembayaran ${status} di Sekalipay Gateway` })
                .eq('id', order.id);
        }

        return res.status(200).json({ received: true, status: 'OK' });
    } catch (err) {
        console.error('[Webhook/SekalipayGateway] Internal error:', err);
        return res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 5 — POST /api/webhooks/dyqris
// Callback dari Dyqris Mini QRIS Gateway (transaction.paid).
// ══════════════════════════════════════════════════════════════════════════

async function handleDyqrisWebhook(req, res) {
    try {
        const signature = req.headers['x-signature'];
        const payloadString = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        
        const { webhookSecret } = await dyqrisGatewayService.getConfig();
        if (webhookSecret) {
            const isValid = dyqrisGatewayService.verifyWebhookSignature(payloadString, signature, webhookSecret);
            if (!isValid) {
                console.warn('[Webhook/Dyqris] Invalid signature - request ditolak.');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { event, id, ref_id, status } = body || {};

        console.log(`[Webhook/Dyqris] Received event ${event || status} for id=${id}, ref_id=${ref_id}`);

        if (!id && !ref_id) {
            return res.status(400).json({ error: 'Payload transaction ID missing' });
        }

        let query = supabase.from('orders').select('*');
        if (id && ref_id) {
            query = query.or(`pg_invoice.eq.${id},id.eq.${ref_id}`);
        } else if (id) {
            query = query.or(`pg_invoice.eq.${id},id.eq.${id}`);
        } else {
            query = query.eq('id', ref_id);
        }

        const { data: order, error: fetchError } = await query.maybeSingle();

        if (fetchError || !order) {
            console.error(`[Webhook/Dyqris] Order id=${id} ref_id=${ref_id} tidak ditemukan.`);
            return res.status(200).json({ received: true });
        }

        if (order.status !== 'PENDING') {
            return res.status(200).json({ received: true });
        }

        if (event === 'transaction.paid' || status === 'paid') {
            await supabase
                .from('orders')
                .update({ pg_paid_at: body.paid_at || new Date().toISOString() })
                .eq('id', order.id);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(order);
            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.error(`[Webhook/Dyqris] Fulfillment order gagal untuk ${order.id}:`, fulfillmentResult.message);
            }
        } else if (status === 'expired' || status === 'cancelled') {
            await supabase
                .from('orders')
                .update({ status: 'CANCELLED', error_message: `Transaksi Dyqris ${status}` })
                .eq('id', order.id);
        }

        return res.status(200).json({ received: true });
    } catch (err) {
        console.error('[Webhook/Dyqris] Internal error:', err);
        return res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 6 — GET / POST /api/webhooks/okeconnect
// Callback dari OkeConnect saat transaksi Sukses/Gagal.
// ══════════════════════════════════════════════════════════════════════════

async function handleOkeconnectWebhook(req, res) {
    try {
        const queryParams = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
        const refId = queryParams.refid || queryParams.refID || '';
        const message = queryParams.message || '';

        console.log(`[Webhook/OkeConnect] Received callback for refId=${refId}, message=${message}`);

        if (!refId && !message) {
            return res.status(400).json({ error: 'Parameter refid atau message missing' });
        }

        let adapter;
        try {
            adapter = vendorRegistry.get('okeconnect');
        } catch (err) {
            return res.status(500).json({ error: 'Vendor adapter okeconnect missing' });
        }

        const isValid = adapter.verifyWebhookSignature(req, null, process.env.OKECONNECT_CALLBACK_SECRET);
        if (!isValid) {
            console.warn('[Webhook/OkeConnect] Invalid secret token — request ditolak.');
            return res.status(401).json({ error: 'Invalid secret token' });
        }

        const event = adapter.parseWebhookEvent(req.body, req.headers, queryParams);

        // Check if this is an account inquiry callback (refId starts with INQ)
        if (refId.startsWith('INQ') && typeof adapter.handleInquiryCallback === 'function') {
            adapter.handleInquiryCallback(refId, event);
            console.log(`[Webhook/OkeConnect] Dispatched inquiry callback for ${refId} (status: ${event.status}).`);
            return res.status(200).json({ refid: refId, message: message || 'OK', status: 'inquiry_processed' });
        }

        // Cari order di Supabase
        const { data: order, error: fetchError } = await supabase
            .from('orders')
            .select('*')
            .or(`vendor_order_id.eq.${refId},id.eq.${refId}`)
            .eq('vendor', 'okeconnect')
            .maybeSingle();

        if (fetchError || !order) {
            console.warn(`[Webhook/OkeConnect] Order refId=${refId} tidak ditemukan di database.`);
            return res.status(200).json({ refid: refId, message, status: 'order_not_found' });
        }


        if (order.status === 'COMPLETED' || order.status === 'FAILED') {
            return res.status(200).json({ refid: refId, message, status: 'already_processed' });
        }

        if (event.status === 'success') {
            const sn = event.sn || order.vendor_invoice || null;
            const accountDetails = {
                ...order.account_details,
                type: 'auto',
                sn: sn,
                serial_number: sn,
                licenses: sn ? [sn] : [],
                raw_callback_message: message,
                completed_at: new Date().toISOString(),
            };


            const { error: updateError } = await supabase
                .from('orders')
                .update({
                    status: 'COMPLETED',
                    account_details: accountDetails,
                    vendor_status: 'success',
                    vendor_invoice: sn,
                })
                .eq('id', order.id);

            if (!updateError) {
                console.log(`[Webhook/OkeConnect] Order ${order.id} COMPLETED (SN: ${sn}).`);
                emailService.sendOrderCompletedEmail({
                    ...order,
                    account_details: accountDetails,
                    vendor_invoice: sn,
                }).catch(err => console.error(`[Webhook/OkeConnect] Email completed gagal:`, err.message));
            }
        } else if (event.status === 'failed') {
            await supabase
                .from('orders')
                .update({
                    status: 'FAILED',
                    error_message: message || 'Transaksi gagal di OkeConnect',
                    vendor_status: 'failed',
                })
                .eq('id', order.id);

            console.log(`[Webhook/OkeConnect] Order ${order.id} FAILED.`);
            emailService.sendOrderFailedEmail(order)
                .catch(err => console.error(`[Webhook/OkeConnect] Email failed gagal:`, err.message));
        }

        return res.status(200).json({ refid: refId, message: message || 'OK' });
    } catch (err) {
        console.error('[Webhook/OkeConnect] Internal error:', err);
        return res.status(500).json({ error: err.message });
    }
}

module.exports = {
    handlePaymentGatewayWebhook,
    handleSekalipayWebhook,
    handleFincloudPPOBWebhook,
    handleSekalipayGatewayWebhook,
    handleDyqrisWebhook,
    handleOkeconnectWebhook,
};

