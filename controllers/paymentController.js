const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const paymentPollingService = require('../services/paymentPollingService');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');

// ══════════════════════════════════════════════════════════════════════════
// HELPER
// ══════════════════════════════════════════════════════════════════════════

function generateOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `NX-${ts}-${rand}`;
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/create
// Buat order baru + invoice QRIS di FinCloud.
//
// Body:
//   product_id       (string)  — ID produk di DB kita
//   variant_id       (integer) — ID variant Sekalipay Reseller
//   variant_name     (string)
//   product_name     (string)
//   amount           (integer) — Harga jual (sell_price)
//   customer_name    (string)
//   wa_number        (string)
//   email            (string)
//
// Note: payment_code tidak diperlukan lagi (selalu QRIS via FinCloud).
// ══════════════════════════════════════════════════════════════════════════

async function createPayment(req, res) {
    try {
        const {
            product_id,
            variant_id,
            variant_name,
            product_name,
            amount,
            customer_name,
            wa_number,
            email,
            note,           // string | json string (for sekalipay)
            provider_qty,   // number (for open denom)
        } = req.body;

        // ── Validasi input ──────────────────────────────────────
        if (!variant_id || !amount || !wa_number || !email) {
            return res.status(400).json({
                error: 'variant_id, amount, wa_number, dan email wajib diisi',
            });
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount harus berupa angka positif' });
        }
        // ── Ambil data produk dari DB untuk verifikasi harga ──────
        const { data: dbProduct, error: fetchError } = await supabase
            .from('products')
            .select('*')
            .eq('id', product_id)
            .single();

        if (fetchError || !dbProduct) {
            return res.status(404).json({ error: 'Produk tidak ditemukan di sistem' });
        }

        // Cari variant yang sesuai
        const variant = (dbProduct.variants || []).find(v => v.id === variant_id);
        if (!variant) {
            return res.status(404).json({ error: 'Variant tidak ditemukan' });
        }

        // Verifikasi Harga Secara Aman (Backend-side calculation)
        let expectedAmount = 0;
        if (variant.provider_meta && variant.provider_meta.open_denom) {
            if (!provider_qty || typeof provider_qty !== 'number' || provider_qty <= 0) {
                return res.status(400).json({ error: 'Nominal (provider_qty) wajib diisi untuk produk ini' });
            }
            if (variant.provider_meta.min_qty && provider_qty < variant.provider_meta.min_qty) {
                return res.status(400).json({ error: `Nominal minimal adalah ${variant.provider_meta.min_qty}` });
            }
            if (variant.provider_meta.max_qty && provider_qty > variant.provider_meta.max_qty) {
                return res.status(400).json({ error: `Nominal maksimal adalah ${variant.provider_meta.max_qty}` });
            }
            expectedAmount = Math.ceil(provider_qty + (variant.sell_price || 0));
        } else {
            expectedAmount = Math.ceil(variant.sell_price || 0);
        }

        // Jika harga dari frontend berbeda dengan perhitungan backend, tolak request
        if (amount !== expectedAmount) {
            console.error(`[paymentController] Price mismatch. Expected: ${expectedAmount}, Got: ${amount}`);
            return res.status(400).json({ error: 'Terjadi ketidaksesuaian harga. Silakan refresh halaman.' });
        }

        if (expectedAmount < 1000) {
            return res.status(400).json({ error: 'Minimal pembayaran Rp 1.000' });
        }

        // ── Generate order ID ───────────────────────────────────
        const orderId = generateOrderId();

        // ── Buat invoice QRIS di FinCloud ───────────────────────
        const pgResult = await paymentGatewayService.createInvoice({
            reffId: orderId,
            nominal: amount,
        });

        if (!pgResult.success) {
            console.error('[paymentController] FinCloud createInvoice failed:', pgResult);
            return res.status(pgResult.status || 502).json({
                error: `Gagal membuat pembayaran: ${pgResult.message}`,
            });
        }

        const pgData = pgResult.data;

        // ── Map response FinCloud → kolom Supabase ──────────────
        const pgFee = (pgData.nominal_total || amount) - (pgData.nominal_asli || amount);
        const pgTotal = pgData.nominal_total || amount;

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
                payment_method: 'QRIS',
                status: 'PENDING',

                // Data PG (FinCloud)
                pg_invoice: String(pgData.id_depo || ''),
                pg_payment_link: pgData.invoice_url || null,
                pg_qr_link: pgData.qr_url || null,
                pg_virtual_account: null,
                pg_payment_code: 'QRIS',
                pg_fee: pgFee,
                pg_total: pgTotal,
                pg_expired_at: null, // FinCloud tidak return expired_at

                // Sekalipay Reseller (untuk auto-order setelah bayar)
                sekalipay_ref_id: orderId,
                sekalipay_variant_id: variant_id,

                // Simpan note ke account_details
                account_details: note ? { sekalipay_note: normalizeNotePhoneNumber(note) } : null,

                timestamp: new Date().toISOString(),
            },
        ]);

        if (dbError) {
            console.error('[paymentController] DB insert error:', dbError);
            return res
                .status(500)
                .json({ error: `Gagal menyimpan order: ${dbError.message}` });
        }

        console.log(`[paymentController] Order ${orderId} created, FinCloud id_depo: ${pgData.id_depo}`);

        // ── Response ke frontend ────────────────────────────────
        // Mapping field names agar frontend tetap kompatibel
        return res.status(201).json({
            success: true,
            data: {
                order_id: orderId,
                invoice: String(pgData.id_depo || ''),
                amount,
                fee: pgFee,
                total: pgTotal,
                payment_code: 'QRIS',
                payment_link: pgData.invoice_url || null,
                qr_link: pgData.qr_url || null,
                virtual_account: null,
                expired_at: null,
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
                'id, status, pg_invoice, pg_paid_at, pg_qr_link, pg_virtual_account, account_details, error_message, pg_expired_at, sekalipay_variant_id'
            )
            .eq('id', orderId)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        // TRIGGER POLLING ON DEMAND JIKA MASIH PENDING
        if (data.status === 'PENDING' && data.pg_invoice) {
            console.log(`[paymentController] User requested status for ${orderId}, triggering manual poll...`);
            await paymentPollingService.processOrder(data);
            
            // Re-fetch data terbaru jika ada perubahan dari proses polling
            const { data: updatedData } = await supabase
                .from('orders')
                .select(
                    'id, status, pg_invoice, pg_paid_at, pg_qr_link, pg_virtual_account, account_details, error_message, pg_expired_at'
                )
                .eq('id', orderId)
                .single();
                
            if (updatedData) {
                return res.json({ data: updatedData });
            }
        }

        // Hapus sekalipay_variant_id dari response untuk keamanan (optional)
        delete data.sekalipay_variant_id;
        return res.json({ data });
    } catch (err) {
        console.error('[paymentController] getPaymentStatus error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/cancel
// Batalkan invoice FinCloud (status → expired).
// ══════════════════════════════════════════════════════════════════════════

async function cancelPayment(req, res) {
    try {
        const { order_id } = req.body;

        if (!order_id) {
            return res.status(400).json({ error: 'order_id wajib diisi' });
        }

        // Cek order di Supabase
        const { data: order, error: fetchError } = await supabase
            .from('orders')
            .select('id, status')
            .eq('id', order_id)
            .single();

        if (fetchError || !order) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        if (order.status !== 'PENDING') {
            return res.status(400).json({
                error: `Order tidak bisa dibatalkan (status: ${order.status})`,
            });
        }

        // Cancel di FinCloud
        const cancelResult = await paymentGatewayService.cancelInvoice(order_id);

        if (!cancelResult.success) {
            console.error('[paymentController] FinCloud cancelInvoice failed:', cancelResult);
            return res.status(502).json({
                error: `Gagal membatalkan: ${cancelResult.message}`,
            });
        }

        // Update status di Supabase
        await supabase
            .from('orders')
            .update({ status: 'CANCELLED' })
            .eq('id', order_id);

        console.log(`[paymentController] Order ${order_id} cancelled via FinCloud`);

        return res.json({ success: true, message: 'Invoice berhasil dibatalkan' });
    } catch (err) {
        console.error('[paymentController] cancelPayment error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

module.exports = { createPayment, getPaymentStatus, cancelPayment };
