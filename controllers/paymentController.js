const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');

// ══════════════════════════════════════════════════════════════════════════
// HELPER
// ══════════════════════════════════════════════════════════════════════════

function generateOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `NX-${ts}-${rand}`;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/payments/methods
// Ambil daftar metode pembayaran aktif dari Sekalipay PG.
// ══════════════════════════════════════════════════════════════════════════

async function getPaymentMethods(req, res) {
    try {
        const result = await paymentGatewayService.getPaymentMethods();
        if (!result.success) {
            return res
                .status(result.status || 500)
                .json({ error: result.message });
        }
        return res.json({ data: result.data });
    } catch (err) {
        console.error('[paymentController] getPaymentMethods error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/create
// Buat order baru + payment di PG.
//
// Body:
//   product_id       (string)  — ID produk di DB kita
//   variant_id       (integer) — ID variant Sekalipay
//   variant_name     (string)
//   product_name     (string)
//   amount           (integer) — Harga jual (sell_price)
//   payment_code     (string)  — Kode metode bayar (QRIS, BCAVA, dll)
//   customer_name    (string)
//   wa_number        (string)
//   email            (string)
// ══════════════════════════════════════════════════════════════════════════

async function createPayment(req, res) {
    try {
        const {
            product_id,
            variant_id,
            variant_name,
            product_name,
            amount,
            payment_code,
            customer_name,
            wa_number,
            email,
        } = req.body;

        // ── Validasi input ──────────────────────────────────────
        if (!variant_id || !amount || !payment_code || !wa_number || !email) {
            return res.status(400).json({
                error: 'variant_id, amount, payment_code, wa_number, dan email wajib diisi',
            });
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount harus berupa angka positif' });
        }

        // ── Generate order ID ───────────────────────────────────
        const orderId = generateOrderId();

        // ── Build callback & return URL ─────────────────────────
        const backendUrl = (
            process.env.BACKEND_URL ||
            `http://localhost:${process.env.PORT || 3000}`
        ).replace(/\/+$/, '');
        const frontendUrl = (
            process.env.FRONTEND_URL || 'http://localhost:5173'
        ).replace(/\/+$/, '');

        const callbackUrl = `${backendUrl}/api/webhooks/payment-gateway`;
        const returnUrl = `${frontendUrl}/checkout/success?order_id=${orderId}`;

        // ── Buat payment di PG ──────────────────────────────────
        const pgResult = await paymentGatewayService.createPayment({
            merchant_ref_id: orderId,
            amount,
            payment_code,
            customer_name: customer_name || wa_number,
            customer_email: email,
            customer_phone: wa_number,
            callback_url: callbackUrl,
            return_url: returnUrl,
            metadata: {
                source: 'noxarianet_store',
                product_id: product_id || null,
                variant_id,
            },
        });

        if (!pgResult.success) {
            console.error('[paymentController] PG createPayment failed:', pgResult);
            return res.status(pgResult.status || 502).json({
                error: `Gagal membuat pembayaran: ${pgResult.message}`,
            });
        }

        const pgData = pgResult.data;

        // ── Simpan order ke Supabase ────────────────────────────
        const { error: dbError } = await supabase.from('orders').insert([
            {
                id: orderId,
                product: product_name || 'Unknown',
                variant: variant_name || '-',
                price: amount,
                wa_number,
                email,
                customer_name: customer_name || wa_number,
                payment_method: payment_code,
                status: 'PENDING',

                // Data PG
                pg_invoice: pgData.invoice || null,
                pg_payment_link: pgData.payment_link || null,
                pg_qr_link: pgData.qr_link || null,
                pg_virtual_account: pgData.virtual_account || null,
                pg_payment_code: payment_code,
                pg_fee: pgData.fee || 0,
                pg_total: pgData.total || amount,
                pg_expired_at: pgData.expired_at || null,

                // Sekalipay Reseller
                sekalipay_ref_id: orderId, // ref_id = order id
                sekalipay_variant_id: variant_id,

                timestamp: new Date().toISOString(),
            },
        ]);

        if (dbError) {
            console.error('[paymentController] DB insert error:', dbError);
            return res
                .status(500)
                .json({ error: `Gagal menyimpan order: ${dbError.message}` });
        }

        console.log(`[paymentController] Order ${orderId} created, PG invoice: ${pgData.invoice}`);

        // ── Response ke frontend ────────────────────────────────
        return res.status(201).json({
            success: true,
            data: {
                order_id: orderId,
                invoice: pgData.invoice,
                amount,
                fee: pgData.fee || 0,
                total: pgData.total || amount,
                payment_code,
                payment_link: pgData.payment_link || null,
                qr_link: pgData.qr_link || null,
                virtual_account: pgData.virtual_account || null,
                expired_at: pgData.expired_at || null,
                status: 'PENDING',
            },
        });
    } catch (err) {
        console.error('[paymentController] createPayment crash:', err);
        return res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/payments/status/:orderId
// Polling status order dari Supabase (dipakai frontend untuk real-time update).
// ══════════════════════════════════════════════════════════════════════════

async function getPaymentStatus(req, res) {
    try {
        const { orderId } = req.params;

        const { data, error } = await supabase
            .from('orders')
            .select(
                'id, status, pg_invoice, pg_paid_at, pg_qr_link, pg_virtual_account, account_details, error_message, pg_expired_at'
            )
            .eq('id', orderId)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        return res.json({ data });
    } catch (err) {
        console.error('[paymentController] getPaymentStatus error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

module.exports = { getPaymentMethods, createPayment, getPaymentStatus };
