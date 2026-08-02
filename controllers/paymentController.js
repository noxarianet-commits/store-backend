const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const orkutGatewayService = require('../services/orkutGatewayService');
const paymentPollingService = require('../services/paymentPollingService');
const sekalipayService = require('../services/sekalipayService');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function generateOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `NX-${ts}-${rand}`;
}

/**
 * Generate kode unik (1–999) yang belum dipakai oleh transaksi PENDING.
 * Kode unik ditambahkan ke nominal agar setiap pembayaran punya
 * total yang berbeda — penting untuk ORKUT balance-delta detection.
 */
async function generateUniqueCode() {
    // Ambil kode unik yang sudah dipakai oleh order PENDING
    const { data: pendingOrders } = await supabase
        .from('orders')
        .select('unique_code')
        .eq('status', 'PENDING')
        .gt('unique_code', 0);

    const usedCodes = new Set((pendingOrders || []).map(o => o.unique_code));

    // Cari kode unik yang belum dipakai (1–100)
    let code;
    let attempts = 0;
    do {
        code = Math.floor(Math.random() * 100) + 1; // 1–100
        attempts++;
    } while (usedCodes.has(code) && attempts < 200);

    // Fallback jika semua terpakai
    if (usedCodes.has(code)) {
        code = Math.floor(Math.random() * 100) + 1;
    }

    return code;
}

/**
 * Baca setting payment_gateway dari Supabase.
 * Returns 'fincloud' (default) atau 'orkut'.
 */
async function getActivePaymentGateway() {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'payment_gateway')
            .single();

        if (error || !data || !data.value) return 'fincloud';
        let val = data.value;
        if (typeof val === 'object' && val !== null) {
            val = val.provider || val.value || val.gateway || 'fincloud';
        }
        return String(val).toLowerCase().trim() === 'orkut' ? 'orkut' : 'fincloud';
    } catch {
        return 'fincloud';
    }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/create
// Buat order baru + invoice QRIS via gateway aktif (FinCloud / ORKUT).
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
// Note: payment_gateway dipilih otomatis dari setting admin.
// ══════════════════════════════════════════════════════════════════════════

async function createPayment(req, res) {
    try {
        // ── Cek status toko (buka/tutup) ────────────────────────
        const { data: statusSetting, error: statusError } = await supabase
            .from('settings')
            .select('*')
            .eq('key', 'shop_status')
            .single();

        let shopOpen = true;
        if (!statusError && statusSetting) {
            shopOpen = statusSetting.value?.isOpen !== false;
        }

        if (!shopOpen) {
            return res.status(403).json({
                error: statusSetting?.value?.message || 'Toko sedang tutup. Silakan coba lagi nanti.'
            });
        }

        const {
            vendor = 'sekalipay', // Default to sekalipay for backward compatibility
            product_id, // For sekalipay: product.id, For fincloud: sku
            variant_id, // For sekalipay
            sku,        // For fincloud
            variant_name,
            product_name,
            amount,
            customer_name,
            wa_number,
            email,
            note,           // string | json string (for sekalipay), string (target for fincloud)
            customer_id,
            user_id,
            zone_id,
            provider_qty,   // number (for open denom)
        } = req.body;

        // ── Validasi input umum ──────────────────────────────────────
        if (!amount || !wa_number || !email) {
            return res.status(400).json({
                error: 'amount, wa_number, dan email wajib diisi',
            });
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount harus berupa angka positif' });
        }
        
        let expectedAmount = 0;
        let dbVariantId = null;
        let dbSku = null;

        if (vendor === 'fincloud') {
            if (!product_id && !sku) {
                return res.status(400).json({ error: 'sku wajib diisi untuk fincloud' });
            }
            
            dbSku = sku || product_id;

            const { data: dbProduct, error: fetchError } = await supabase
                .from('fincloud_products')
                .select('*')
                .eq('sku', dbSku)
                .single();
                
            if (fetchError || !dbProduct) {
                return res.status(404).json({ error: 'Produk Fincloud tidak ditemukan di sistem' });
            }

            if (!dbProduct.is_available) {
                return res.status(400).json({ error: 'Maaf, produk Fincloud ini sedang tidak tersedia.' });
            }
            
            expectedAmount = Math.ceil(dbProduct.sell_price || 0);
            
            // Note: Fincloud PPOB documentation doesn't specify a real-time stock check endpoint,
            // so we skip real-time stock check for Fincloud PPOB.

        } else {
            // Default: sekalipay
            if (!variant_id) {
                return res.status(400).json({ error: 'variant_id wajib diisi untuk sekalipay' });
            }
            
            dbVariantId = variant_id;
            
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
            const variant = (dbProduct.variants || []).find(v => v.id === dbVariantId);
            if (!variant) {
                return res.status(404).json({ error: 'Variant tidak ditemukan' });
            }

            // Verifikasi Harga Secara Aman (Backend-side calculation)
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
            
            // ── Cek stok real-time dari Sekalipay sebelum buat QRIS ──
            if (dbProduct.sekalipay_product_id) {
                const stockCheck = await sekalipayService.fetchItemDetail(dbVariantId);
                
                // JIKA API MERESPON ERROR ATAU PRODUK TIDAK VALID, BLOCK CHECKOUT
                if (!stockCheck.success || !stockCheck.data) {
                    console.warn(`[paymentController] Validasi gagal untuk variant ${dbVariantId}:`, stockCheck.message || 'Unknown Error');
                    return res.status(400).json({ error: 'Produk saat ini sedang tidak tersedia atau tidak valid di sistem penyedia. Silakan coba beberapa saat lagi.' });
                }

                const liveStock = stockCheck.data.stock;
                if (liveStock !== undefined && liveStock <= 0) {
                    console.warn(`[paymentController] Stok habis untuk variant ${dbVariantId} (live stock: ${liveStock})`);
                    // Update stok di DB lokal agar frontend segera update
                    const updatedVariants = (dbProduct.variants || []).map(v =>
                        v.id === dbVariantId ? { ...v, stock: 0 } : v
                    );
                    await supabase
                        .from('products')
                        .update({ variants: updatedVariants })
                        .eq('id', product_id);
                    return res.status(400).json({ error: 'Maaf, stok untuk varian ini sedang habis. Silakan pilih varian lain atau coba lagi nanti.' });
                }
            }

            // ── Cek ketersediaan variant di layanan validasi (H2H/topup: ewallet/game) ──
            // Pastikan data[].variants[].status = active/on/true sebelum create payment
            if (variant.validation?.available && dbProduct.sekalipay_product_id) {
                try {
                    const svcCheck = await sekalipayService.checkValidationServices(dbProduct.name);
                    if (svcCheck.success && Array.isArray(svcCheck.data)) {
                        // Cari produk yang cocok berdasarkan nama atau sekalipay_product_id
                        const matchedSvc = svcCheck.data.find(s =>
                            s.product_id === dbProduct.sekalipay_product_id
                            || s.product_name?.toLowerCase() === dbProduct.name?.toLowerCase()
                        );

                        // Cek status variant spesifik di response (harus active/on/true)
                        if (matchedSvc?.variants && Array.isArray(matchedSvc.variants)) {
                            const matchedVariant = matchedSvc.variants.find(v => v.item_id === dbVariantId);
                            if (matchedVariant) {
                                const vstatus = String(matchedVariant.status).toLowerCase();
                                const isVariantActive = vstatus === 'active' || vstatus === 'on' || vstatus === 'true';
                                if (!isVariantActive) {
                                    console.warn(`[paymentController] Variant ${dbVariantId} status "${matchedVariant.status}" is not active in validation services`);
                                    return res.status(400).json({
                                        error: 'Varian produk ini sedang tidak aktif di penyedia layanan. Silakan pilih varian lain atau coba lagi nanti.'
                                    });
                                }
                                console.log(`[paymentController] Validation service check passed for "${dbProduct.name}" variant ${dbVariantId} (status: ${matchedVariant.status})`);
                            }
                        }
                    } else {
                        // API gagal tapi bukan network error — tetap lanjut (fail-open)
                        console.warn('[paymentController] checkValidationServices returned no data, proceeding with checkout (fail-open)');
                    }
                } catch (valErr) {
                    // Network error atau unexpected crash — tetap lanjut (fail-open)
                    console.warn('[paymentController] checkValidationServices error, proceeding with checkout (fail-open):', valErr.message);
                }
            }
        }

        // Jika harga dari frontend berbeda dengan perhitungan backend, tolak request
        if (amount !== expectedAmount) {
            console.error(`[paymentController] Price mismatch. Expected: ${expectedAmount}, Got: ${amount}`);
            return res.status(400).json({ error: 'Terjadi ketidaksesuaian harga. Silakan refresh halaman.' });
        }

        if (expectedAmount < 1000) {
            return res.status(400).json({ error: 'Minimal pembayaran Rp 1.000' });
        }

        // ── Generate order ID & kode unik ───────────────────────
        const orderId = generateOrderId();
        const uniqueCode = await generateUniqueCode();
        const totalWithUniqueCode = amount + uniqueCode;

        // ── Tentukan payment gateway dari setting admin ─────────
        const pgProvider = await getActivePaymentGateway();
        console.log(`[paymentController] Using payment gateway: ${pgProvider}, unique_code: ${uniqueCode}`);

        let pgData, pgFee, pgTotal, pgInvoice, pgPaymentLink, pgQrLink;

        if (pgProvider === 'orkut') {
            // ── Buat QRIS via ORKUT Gateway ─────────────────────
            const orkutResult = await orkutGatewayService.createPayment({
                trxId: orderId,
                amount: totalWithUniqueCode,
            });

            if (!orkutResult.success) {
                console.error('[paymentController] ORKUT createPayment failed:', orkutResult);
                return res.status(orkutResult.status || 502).json({
                    error: `Gagal membuat pembayaran ORKUT: ${orkutResult.message}`,
                });
            }

            pgData = orkutResult.data;
            pgFee = 0; // ORKUT tidak mengenakan fee tambahan
            pgTotal = totalWithUniqueCode;
            pgInvoice = pgData.ref || orderId;
            pgPaymentLink = null;
            
            // Gunakan HTTPS QR Generator jika qr_string ada, untuk mencegah Mixed Content Block (HTTP di HTTPS)
            if (pgData.qr_string) {
                pgQrLink = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(pgData.qr_string)}`;
            } else {
                pgQrLink = pgData.qr_link || null;
            }

        } else {
            // ── Buat invoice QRIS via FinCloud (default) ────────
            const pgResult = await paymentGatewayService.createInvoice({
                reffId: orderId,
                nominal: totalWithUniqueCode,
            });

            if (!pgResult.success) {
                console.error('[paymentController] FinCloud createInvoice failed:', pgResult);
                return res.status(pgResult.status || 502).json({
                    error: `Gagal membuat pembayaran: ${pgResult.message}`,
                });
            }

            pgData = pgResult.data;
            pgFee = (pgData.nominal_total || totalWithUniqueCode) - (pgData.nominal_asli || totalWithUniqueCode);
            pgTotal = pgData.nominal_total || totalWithUniqueCode;
            pgInvoice = String(pgData.id_depo || '');
            pgPaymentLink = pgData.invoice_url || null;
            pgQrLink = pgData.qr_url || null;
        }

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

                // Data PG
                pg_provider: pgProvider,
                pg_invoice: pgInvoice,
                pg_payment_link: pgPaymentLink,
                pg_qr_link: pgQrLink,
                pg_virtual_account: null,
                pg_payment_code: 'QRIS',
                pg_fee: pgFee,
                pg_total: pgTotal,
                pg_expired_at: null,

                // Kode unik
                unique_code: uniqueCode,

                // ORKUT-specific
                orkut_ref_id: pgProvider === 'orkut' ? (pgData.ref || orderId) : null,

                // Vendor Information
                vendor,
                fincloud_sku: dbSku,
                sekalipay_ref_id: orderId,
                sekalipay_variant_id: dbVariantId,

                // Simpan note/target/zone_id ke account_details
                account_details: (() => {
                    const rawZoneId = zone_id || (req.body.fieldData && req.body.fieldData.zone_id);
                    const rawUserId = customer_id || user_id || (req.body.fieldData && req.body.fieldData.customer_id);

                    let finalZoneId = rawZoneId ? String(rawZoneId).trim() : null;
                    let finalUserId = rawUserId ? String(rawUserId).trim() : null;

                    if (!finalZoneId && note && typeof note === 'string') {
                        const match = note.match(/^([^\(\)]+)\(([^\(\)]+)\)$/);
                        if (match) {
                            finalUserId = finalUserId || match[1].trim();
                            finalZoneId = match[2].trim();
                        }
                    }

                    return note ? { 
                        sekalipay_note: vendor === 'sekalipay' ? normalizeNotePhoneNumber(note) : null,
                        target: vendor === 'fincloud' ? normalizeNotePhoneNumber(note) : null,
                        customer_id: finalUserId,
                        user_id: finalUserId,
                        zone_id: finalZoneId,
                    } : null;
                })(),

                timestamp: new Date().toISOString(),
            },
        ]);

        if (dbError) {
            console.error('[paymentController] DB insert error:', dbError);
            return res
                .status(500)
                .json({ error: `Gagal menyimpan order: ${dbError.message}` });
        }

        console.log(`[paymentController] Order ${orderId} created via ${pgProvider}, unique_code: ${uniqueCode}`);

        // ── Response ke frontend ────────────────────────────────
        return res.status(201).json({
            success: true,
            data: {
                order_id: orderId,
                invoice: pgInvoice,
                amount,
                unique_code: uniqueCode,
                fee: pgFee,
                total: pgTotal,
                payment_code: 'QRIS',
                payment_link: pgPaymentLink,
                qr_link: pgQrLink,
                virtual_account: null,
                expired_at: null,
                status: 'PENDING',
                pg_provider: pgProvider,
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
                'id, status, pg_invoice, pg_paid_at, pg_qr_link, pg_virtual_account, account_details, error_message, pg_expired_at, sekalipay_variant_id, unique_code, pg_provider'
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
                    'id, status, pg_invoice, pg_paid_at, pg_qr_link, pg_virtual_account, account_details, error_message, pg_expired_at, unique_code, pg_provider'
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
// Batalkan invoice (status → expired/cancelled).
// Routing ke gateway yang sesuai berdasarkan pg_provider order.
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
            .select('id, status, pg_provider')
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

        // Cancel berdasarkan gateway provider
        if (order.pg_provider === 'orkut') {
            // ORKUT tidak punya endpoint cancel — langsung update di DB saja
            console.log(`[paymentController] ORKUT order ${order_id} cancelled (no API cancel needed)`);
        } else {
            // Cancel di FinCloud
            const cancelResult = await paymentGatewayService.cancelInvoice(order_id);

            if (!cancelResult.success) {
                console.error('[paymentController] FinCloud cancelInvoice failed:', cancelResult);
                return res.status(502).json({
                    error: `Gagal membatalkan: ${cancelResult.message}`,
                });
            }
        }

        // Update status di Supabase
        await supabase
            .from('orders')
            .update({ status: 'CANCELLED' })
            .eq('id', order_id);

        console.log(`[paymentController] Order ${order_id} cancelled via ${order.pg_provider}`);

        return res.json({ success: true, message: 'Invoice berhasil dibatalkan' });
    } catch (err) {
        console.error('[paymentController] cancelPayment error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

module.exports = { createPayment, getPaymentStatus, cancelPayment };
