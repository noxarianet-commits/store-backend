const supabase = require('../supabase');
const paymentGatewayService = require('../services/paymentGatewayService');
const sayabayarGatewayService = require('../services/sayabayarGatewayService');
const dyqrisGatewayService = require('../services/dyqrisGatewayService');
const paymentPollingService = require('../services/paymentPollingService');
const vendorRegistry = require('../services/vendors/vendorRegistry');
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
 * Generate unique payment code (1–100) not used by any active PENDING order.
 */
async function generateUniqueCode() {
    const { data: pendingOrders } = await supabase
        .from('orders')
        .select('unique_code')
        .eq('status', 'PENDING')
        .gt('unique_code', 0);

    const usedCodes = new Set((pendingOrders || []).map(o => o.unique_code));

    let code;
    let attempts = 0;
    do {
        code = Math.floor(Math.random() * 100) + 1;
        attempts++;
    } while (usedCodes.has(code) && attempts < 200);

    if (usedCodes.has(code)) {
        code = Math.floor(Math.random() * 100) + 1;
    }

    return code;
}

/**
 * Read active payment gateway setting from Supabase.
 * Returns 'fincloud' (default) | 'sayabayar' | 'dyqris'.
 */
async function getActivePaymentGateway() {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'payment_gateway')
            .maybeSingle();

        if (error || !data || !data.value) return 'fincloud';
        let val = data.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (e) {}
        }
        if (typeof val === 'object' && val !== null) {
            val = val.provider || val.value || val.gateway || 'fincloud';
        }
        const strVal = String(val).toLowerCase().trim();
        if (strVal === 'sayabayar') return 'sayabayar';
        if (strVal === 'dyqris') return 'dyqris';
        return 'fincloud';
    } catch {
        return 'fincloud';
    }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/create
// ══════════════════════════════════════════════════════════════════════════

async function createPayment(req, res) {
    try {
        // 1. Cek status toko (buka/tutup)
        const { data: statusSetting, error: statusError } = await supabase
            .from('settings')
            .select('*')
            .eq('key', 'shop_status')
            .maybeSingle();

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
            vendor = 'sekalipay',
            product_id,
            variant_id,
            sku,
            variant_name,
            product_name,
            amount,
            customer_name,
            wa_number,
            email,
            note,
            customer_id,
            user_id,
            zone_id,
            provider_qty,
        } = req.body;

        // 2. Validasi input umum
        if (!amount || !wa_number || !email) {
            return res.status(400).json({ error: 'amount, wa_number, dan email wajib diisi' });
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount harus berupa angka positif' });
        }

        const targetVariantId = String(variant_id || sku || '');
        if (!targetVariantId && !product_id) {
            return res.status(400).json({ error: 'variant_id / sku wajib diisi' });
        }


        // 3. Query produk & variant secara unified
        let dbProduct = null;
        if (product_id) {
            // Bisa integer ID atau external_id / SKU
            let query = supabase.from('products').select('*, product_variants(*)');
            if (!isNaN(product_id)) {
                query = query.or(`id.eq.${product_id},external_id.eq.${product_id}`);
            } else {
                query = query.eq('external_id', String(product_id));
            }
            const { data } = await query.maybeSingle();
            dbProduct = data;
        }

        if (!dbProduct && sku) {
            const { data } = await supabase
                .from('products')
                .select('*, product_variants(*)')
                .eq('external_id', String(sku))
                .maybeSingle();
            dbProduct = data;
        }

        if (!dbProduct || dbProduct.is_active === false) {
            return res.status(404).json({ error: 'Produk tidak ditemukan atau sedang tidak aktif' });
        }

        // Tentukan vendor sebenarnya dari produk di database
        const actualVendor = dbProduct.vendor || vendor || 'sekalipay';
        const adapter = vendorRegistry.get(actualVendor);
        if (!adapter) {
            return res.status(400).json({ error: `Vendor '${actualVendor}' tidak didukung di sistem` });
        }

        // Cari variant yang cocok di product_variants (atau fallback ke variants JSONB)
        let matchedVariant = null;
        if (dbProduct.product_variants && dbProduct.product_variants.length > 0) {
            matchedVariant = dbProduct.product_variants.find(v =>
                String(v.vendor_variant_id) === targetVariantId ||
                String(v.id) === targetVariantId ||
                String(v.metadata?.sku) === targetVariantId
            );
        } else if (Array.isArray(dbProduct.variants)) {
            matchedVariant = dbProduct.variants.find(v =>
                String(v.id) === targetVariantId || String(v.sku) === targetVariantId
            );
        }

        if (!matchedVariant || matchedVariant.is_active === false || matchedVariant.is_hidden === true) {
            return res.status(404).json({ error: 'Varian produk tidak ditemukan atau sedang tidak aktif' });
        }

        // 4. Hitung harga server-side
        let expectedAmount = 0;
        const sellPrice = matchedVariant.sell_price || matchedVariant.price || 0;

        if (matchedVariant.provider_meta && matchedVariant.provider_meta.open_denom) {
            if (!provider_qty || typeof provider_qty !== 'number' || provider_qty <= 0) {
                return res.status(400).json({ error: 'Nominal (provider_qty) wajib diisi untuk produk ini' });
            }
            if (matchedVariant.provider_meta.min_qty && provider_qty < matchedVariant.provider_meta.min_qty) {
                return res.status(400).json({ error: `Nominal minimal adalah ${matchedVariant.provider_meta.min_qty}` });
            }
            if (matchedVariant.provider_meta.max_qty && provider_qty > matchedVariant.provider_meta.max_qty) {
                return res.status(400).json({ error: `Nominal maksimal adalah ${matchedVariant.provider_meta.max_qty}` });
            }
            expectedAmount = Math.ceil(provider_qty + sellPrice);
        } else {
            expectedAmount = Math.ceil(sellPrice);
        }

        if (amount !== expectedAmount) {
            console.error(`[paymentController] Price mismatch. Expected: ${expectedAmount}, Got: ${amount}`);
            return res.status(400).json({ error: 'Terjadi ketidaksesuaian harga. Silakan refresh halaman.' });
        }
        if (expectedAmount < 1000) {
            return res.status(400).json({ error: 'Minimal pembayaran Rp 1.000' });
        }

        // 5. Cek stok real-time via adapter (hanya untuk vendor yang mendukung)
        if (actualVendor !== 'okeconnect') {
            const stockCheck = await adapter.checkStock(matchedVariant.vendor_variant_id || targetVariantId);
            if (!stockCheck.success || stockCheck.available === false) {
                return res.status(400).json({
                    error: stockCheck.message || 'Maaf, stok varian ini sedang habis. Silakan coba lagi nanti.'
                });
            }
        }

        // 6. Cek validasi service/akun (hanya untuk Sekalipay)
        if (actualVendor === 'sekalipay' && matchedVariant.validation?.available) {
            try {
                const svcCheck = await adapter.checkValidationServices({
                    product_name: dbProduct.name,
                    search: dbProduct.name,
                });
                if (svcCheck.success && Array.isArray(svcCheck.data)) {
                    const matchedSvc = svcCheck.data.find(s =>
                        s.product_id === parseInt(dbProduct.external_id) ||
                        s.product_name?.toLowerCase() === dbProduct.name?.toLowerCase()
                    );
                    if (matchedSvc?.variants && Array.isArray(matchedSvc.variants)) {
                        const vItem = matchedSvc.variants.find(v => String(v.item_id) === targetVariantId);
                        if (vItem) {
                            const vstatus = String(vItem.status).toLowerCase();
                            if (vstatus !== 'active' && vstatus !== 'on' && vstatus !== 'true') {
                                return res.status(400).json({
                                    error: 'Varian produk ini sedang tidak aktif di penyedia. Silakan pilih varian lain.'
                                });
                            }
                        }
                    }
                }
            } catch (valErr) {
                console.warn('[paymentController] Validation check warning (fail-open):', valErr.message);
            }
        }


        // 7. Generate order ID & unique code
        const orderId = generateOrderId();
        const uniqueCode = await generateUniqueCode();
        const totalWithUniqueCode = amount + uniqueCode;

        // 8. Tentukan Payment Gateway & Buat Invoice
        const pgProvider = await getActivePaymentGateway();
        console.log(`[paymentController] Using PG: ${pgProvider}, unique_code: ${uniqueCode}`);

        let pgData, pgFee, pgTotal, pgInvoice, pgPaymentLink, pgQrLink;

        if (pgProvider === 'dyqris') {
            const dyqrisResult = await dyqrisGatewayService.createTransaction({
                refId: orderId,
                amount: amount,
                expiryMinutes: 15,
                metadata: {
                    customer_name: (customer_name || wa_number || 'Pelanggan').trim(),
                    email: (email || 'customer@noxarianet.web.id').trim(),
                    product_name: product_name || dbProduct.name || 'NoxariaNet Store'
                }
            });
            if (!dyqrisResult.success) {
                return res.status(dyqrisResult.status || 502).json({ error: `Gagal membuat pembayaran Dyqris: ${dyqrisResult.message}` });
            }
            pgData = dyqrisResult.data;
            pgFee = 0;
            pgTotal = pgData.actual_amount || amount;
            pgInvoice = pgData.id;
            pgPaymentLink = pgData.qr_image_url || null;
            pgQrLink = pgData.qr_image_url || (pgData.qr_string ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(pgData.qr_string)}` : null);

        } else if (pgProvider === 'sayabayar') {
            const sayabayarResult = await sayabayarGatewayService.createInvoice({
                customer_name: (customer_name || wa_number || 'Pelanggan').trim(),
                customer_email: (email || 'customer@noxarianet.web.id').trim(),
                amount: amount,
                description: `Order ${orderId} - ${product_name || dbProduct.name}`,
                redirect_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/checkout/success?order_id=${orderId}`
            });
            if (!sayabayarResult.success) {
                return res.status(sayabayarResult.status || 502).json({ error: `Gagal membuat pembayaran Saya Bayar: ${sayabayarResult.message}` });
            }
            pgData = sayabayarResult.data;
            pgFee = 0;
            const sayabayarUniqueCode = pgData.unique_code ?? pgData.payment_channel?.unique_code ?? (pgData.amount_to_pay ? (pgData.amount_to_pay - amount) : 0);
            pgTotal = pgData.amount_to_pay || pgData.payment_channel?.amount_to_pay || (amount + sayabayarUniqueCode);
            pgInvoice = pgData.payment_url || pgData.invoice_number || pgData.id;
            pgPaymentLink = pgData.payment_url || null;
            const qrisString = pgData.payment_channel?.qris_string;
            pgQrLink = qrisString ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qrisString)}` : (pgData.payment_url || null);

        } else {
            const pgResult = await paymentGatewayService.createInvoice({
                reffId: orderId,
                nominal: totalWithUniqueCode,
            });
            if (!pgResult.success) {
                return res.status(pgResult.status || 502).json({ error: `Gagal membuat pembayaran: ${pgResult.message}` });
            }
            pgData = pgResult.data;
            pgFee = (pgData.nominal_total || totalWithUniqueCode) - (pgData.nominal_asli || totalWithUniqueCode);
            pgTotal = pgData.nominal_total || totalWithUniqueCode;
            pgInvoice = String(pgData.id_depo || '');
            pgPaymentLink = pgData.invoice_url || null;
            pgQrLink = pgData.qr_url || null;
        }

        const effectiveUniqueCode = pgProvider === 'dyqris'
            ? (pgData.actual_amount ? (pgData.actual_amount - amount) : 0)
            : pgProvider === 'sayabayar'
                ? (pgData.unique_code ?? pgData.payment_channel?.unique_code ?? (pgData.amount_to_pay ? (pgData.amount_to_pay - amount) : 0))
                : uniqueCode;

        // 9. Simpan order ke Supabase
        const variantIdForOrder = matchedVariant.vendor_variant_id || targetVariantId;
        const { error: dbError } = await supabase.from('orders').insert([
            {
                id: orderId,
                product: product_name || dbProduct.name,
                variant: variant_name || matchedVariant.name || '-',
                price: amount,
                wa_number,
                email,
                customer_name: customer_name || wa_number,
                payment_method: 'QRIS',
                status: 'PENDING',

                // PG fields
                pg_provider: pgProvider,
                pg_invoice: pgInvoice,
                pg_payment_link: pgPaymentLink,
                pg_qr_link: pgQrLink,
                pg_virtual_account: null,
                pg_payment_code: 'QRIS',
                pg_fee: pgFee,
                pg_total: pgTotal,
                pg_expired_at: pgData?.expired_at || null,
                unique_code: effectiveUniqueCode,

                // Generic Vendor Fields
                vendor: actualVendor,
                vendor_order_id: null,
                vendor_variant_id: variantIdForOrder,
                vendor_status: 'none',

                // Account details
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

                    return {
                        vendor: actualVendor,
                        note: note ? normalizeNotePhoneNumber(note) : null,
                        target: note ? normalizeNotePhoneNumber(note) : null,
                        customer_id: finalUserId,
                        user_id: finalUserId,
                        zone_id: finalZoneId,
                        provider_qty: provider_qty ? parseInt(provider_qty) : undefined,
                    };
                })(),


                timestamp: new Date().toISOString(),
            },
        ]);

        if (dbError) {
            console.error('[paymentController] DB insert error:', dbError);
            return res.status(500).json({ error: `Gagal menyimpan order: ${dbError.message}` });
        }

        console.log(`[paymentController] Order ${orderId} created via ${pgProvider}`);

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
// ══════════════════════════════════════════════════════════════════════════

async function getPaymentStatus(req, res) {
    try {
        const { orderId } = req.params;

        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        if (data.status === 'PENDING' && data.pg_invoice) {
            await paymentPollingService.processOrder(data);
            const { data: updatedData } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (updatedData) return res.json({ data: updatedData });
        }

        return res.json({ data });
    } catch (err) {
        console.error('[paymentController] getPaymentStatus error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/cancel
// ══════════════════════════════════════════════════════════════════════════

async function cancelPayment(req, res) {
    try {
        const { order_id } = req.body;
        if (!order_id) return res.status(400).json({ error: 'order_id wajib diisi' });

        const { data: order, error: fetchError } = await supabase
            .from('orders')
            .select('id, status, pg_provider')
            .eq('id', order_id)
            .single();

        if (fetchError || !order) return res.status(404).json({ error: 'Order tidak ditemukan' });
        if (order.status !== 'PENDING') {
            return res.status(400).json({ error: `Order tidak bisa dibatalkan (status: ${order.status})` });
        }

        if (order.pg_provider !== 'sayabayar' && order.pg_provider !== 'dyqris') {
            await paymentGatewayService.cancelInvoice(order_id);
        }

        await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order_id);
        return res.json({ success: true, message: 'Invoice berhasil dibatalkan' });
    } catch (err) {
        console.error('[paymentController] cancelPayment error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { createPayment, getPaymentStatus, cancelPayment };
