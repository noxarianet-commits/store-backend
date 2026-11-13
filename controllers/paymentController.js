const supabase = require('../supabase');
const crypto = require('crypto');
const paymentGatewayService = require('../services/paymentGatewayService');
const sekalipayGatewayService = require('../services/sekalipayGatewayService');
const dyqrisGatewayService = require('../services/dyqrisGatewayService');
const paymentPollingService = require('../services/paymentPollingService');
const vendorRegistry = require('../services/vendors/vendorRegistry');
const cacheService = require('../services/cacheService');
const balanceService = require('../services/balanceService');
const orderFulfillmentService = require('../services/orderFulfillmentService');
const { findProductByAnyId, findProductByExternalId, findVariantByPublicId } = require('../utils/productLookup');
const { withReadRetry, isTransientError } = require('../utils/dbRetry');
const { logger } = require('../utils/logger');
const { normalizePhoneNumber, normalizeNotePhoneNumber } = require('../utils/phoneUtils');
const { isMandatoryValidationEnabled } = require('../utils/settingFlags');
const { getActivePaymentGateway } = require('../services/paymentSettings');
const orderStatusService = require('../services/orderStatusService');
const { isAvailableForChannel } = require('../utils/channel');
const { sanitizeAccountDetails } = require('../utils/orderPresenter');

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function generateOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `NX-${ts}-${rand}`;
}

/**
 * Normalize the order target that is stored in account_details.
 *
 * Meter / customer numbers (PLN token) are digits only and must never be
 * phone-normalized, because a meter ID may start with 62 or 8.
 */
function buildAccountTarget(note, matchedVariant) {
    if (!note) return null;
    const isMeterTarget = matchedVariant?.provider_meta?.target_type === 'meter';
    return isMeterTarget ? String(note).replace(/\D/g, '') : normalizeNotePhoneNumber(note);
}

/**
 * Token akses order. Order ID bisa ditebak, jadi ID bukan bukti kepemilikan.
 * Token ini yang membuktikan request benar-benar berasal dari pembeli.
 */
function generateOrderAccessToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Perbandingan string yang aman terhadap timing attack.
 * Returns true hanya bila keduanya identik.
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (err) {
        return false;
    }
}

/**
 * Caller (pembeli) sah untuk order ini bila salah satu terpenuhi:
 *   - req.user.id cocok dengan order.user_id, atau
 *   - header X-Order-Token cocok dengan order.order_access_token
 *
 * Mengembalikan null bila tidak sah. Penolakan sengaja disamarkan jadi 404
 * supaya penyerang tidak bisa membedakan "order tidak ada" dari "bukan milikmu".
 */
function authorizeOrderAccess(req, order) {
    if (req.user && order.user_id && req.user.id === order.user_id) return order;

    const provided = req.headers['x-order-token'];
    if (order.order_access_token && safeEqual(provided, order.order_access_token)) return order;

    return null;
}

/**
 * Generate unique payment code (1–100) not used by any active PENDING order.
 */
async function generateUniqueCode() {
    const { data: pendingOrders } = await supabase
        .from('orders')
        .select('unique_code')
        .eq('status', 'PENDING')
        .gt('unique_code', 0)
        .limit(500);

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
            payment_type = 'gateway',
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
            const { data, error } = await findProductByAnyId(
                supabase,
                product_id,
                '*, product_variants(*)'
            );

            if (error) {
                logger.error('order_product_lookup_failed', {
                    productId: product_id,
                    code: error.code,
                });
                return res.status(500).json({ error: 'Gagal memuat produk' });
            }

            dbProduct = data;
        }

        // Fallback: cari produk via targetVariantId di tabel product_variants
        if (!dbProduct && targetVariantId) {
            const { data: vRow, error: variantError } = await findVariantByPublicId(
                supabase,
                targetVariantId,
                'id, product_id, vendor_variant_id'
            );

            if (variantError) {
                logger.error('order_variant_lookup_failed', {
                    variantId: targetVariantId,
                    code: variantError.code,
                });
                return res.status(500).json({ error: 'Gagal memuat varian produk' });
            }

            if (vRow?.product_id) {
                const { data, error } = await findProductByAnyId(
                    supabase,
                    vRow.product_id,
                    '*, product_variants(*)'
                );
                if (error) {
                    logger.error('order_variant_product_lookup_failed', {
                        productId: vRow.product_id,
                        code: error.code,
                    });
                    return res.status(500).json({ error: 'Gagal memuat produk' });
                }
                dbProduct = data;
            }
        }

        if (!dbProduct && sku) {
            const { data, error } = await findProductByExternalId(
                supabase,
                sku,
                '*, product_variants(*)'
            );
            if (error) {
                logger.error('order_sku_product_lookup_failed', { sku, code: error.code });
                return res.status(500).json({ error: 'Gagal memuat produk' });
            }
            dbProduct = data;
        }

        if (!dbProduct || dbProduct.is_active === false) {
            return res.status(404).json({ error: 'Produk tidak ditemukan atau sedang tidak aktif' });
        }

        // App-only products must never be purchasable through the web route,
        // even if someone knows the product ID and bypasses the catalog.
        if (!isAvailableForChannel(dbProduct, 'web')) {
            return res.status(404).json({ error: 'Produk tidak ditemukan atau sedang tidak aktif' });
        }

        // Bill products require the inquiry -> quote -> order flow. Never let
        // them fall through the generic prepaid checkout, even if an admin
        // accidentally enables the web channel.
        if (dbProduct.product_type === 'postpaid') {
            return res.status(400).json({ error: 'Produk tagihan hanya dapat dibeli melalui aplikasi.' });
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
                String(v.metadata?.sku) === targetVariantId ||
                (sku && (String(v.metadata?.sku) === String(sku) || String(v.vendor_variant_id) === String(sku))) ||
                (variant_name && v.name === variant_name)
            );
        } else if (Array.isArray(dbProduct.variants)) {
            matchedVariant = dbProduct.variants.find(v =>
                String(v.id) === targetVariantId ||
                String(v.sku) === targetVariantId ||
                String(v.vendor_variant_id) === targetVariantId ||
                (variant_name && v.name === variant_name)
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
            logger.warn('order_price_mismatch', { expectedAmount, receivedAmount: amount });
            return res.status(400).json({ error: 'Terjadi ketidaksesuaian harga. Silakan refresh halaman.' });
        }
        if (expectedAmount < 1000) {
            return res.status(400).json({ error: 'Minimal pembayaran Rp 1.000' });
        }

        // 5. Cek stok & saldo vendor
        const requiredVendorCost = matchedVariant.provider_meta?.open_denom
            ? (provider_qty || 0)
            : (matchedVariant.base_price || matchedVariant.sell_price || amount);

        if (actualVendor === 'okeconnect') {
            const balanceRes = await adapter.getBalance();
            if (balanceRes.success && typeof balanceRes.balance === 'number') {
                if (balanceRes.balance < requiredVendorCost) {
                    logger.warn('okeconnect_balance_insufficient', { balance: balanceRes.balance, required: requiredVendorCost });
                    return res.status(400).json({
                        error: 'Mohon maaf, saldo server sedang dalam pengisian. Silakan coba beberapa saat lagi atau pilih server lain.'
                    });
                }
            }
        } else {
            const stockCheck = await adapter.checkStock(matchedVariant.vendor_variant_id || targetVariantId);
            if (!stockCheck.success || stockCheck.available === false) {
                return res.status(400).json({
                    error: stockCheck.message || 'Maaf, stok varian ini sedang habis. Silakan coba lagi nanti.'
                });
            }
        }

        // 6. Validasi Akun Wajib (Khusus OkeConnect / Varian dengan validasi)
        // Dilewati total saat settings `mandatory_validation` nonaktif (endpoint
        // validasi provider sedang gangguan) — transaksi tetap berjalan.
        const mandatoryValidation = await isMandatoryValidationEnabled();
        const isValidationNeeded = Boolean(matchedVariant.validation?.available);
        if (isValidationNeeded && !mandatoryValidation) {
            logger.info('account_validation_bypassed', {
                vendor: actualVendor,
                variantId: matchedVariant.vendor_variant_id || targetVariantId,
                product: dbProduct?.name,
            });
        }

        let resolvedCustomerName = (customer_name || wa_number || 'Pelanggan').trim();

        if (actualVendor === 'okeconnect') {
            let targetId = customer_id || user_id || (typeof note === 'string' && !note.startsWith('{') ? note : '');
            const isEwallet = dbProduct?.category?.toLowerCase().includes('wallet') ||
                /dana|ovo|gopay|gojek|shopee|linkaja|isaku|maxim/i.test(dbProduct?.name || '');

            if (isEwallet) {
                if (/[a-zA-Z]/.test(targetId)) {
                    return res.status(400).json({ error: 'Nomor tujuan e-wallet tidak boleh mengandung huruf. Masukkan nomor HP yang valid (contoh: 08123456789)' });
                }
                const normalized = normalizePhoneNumber(targetId);
                if (!normalized || !/^08[0-9]{8,13}$/.test(normalized)) {
                    return res.status(400).json({ error: 'Format nomor e-wallet tidak valid. Harus diawali 08 dengan 10-14 digit angka.' });
                }
                targetId = normalized;
            } else if (!zone_id && /^[0-9\s\-\+\(\)]+$/.test(targetId)) {
                const normalized = normalizePhoneNumber(targetId);
                if (normalized && normalized.startsWith('08')) {
                    targetId = normalized;
                }
            }

            if (isValidationNeeded) {
                if (!targetId) {
                    return res.status(400).json({
                        error: mandatoryValidation
                            ? 'User ID / Nomor Tujuan wajib diisi dan divalidasi terlebih dahulu'
                            : 'User ID / Nomor Tujuan wajib diisi',
                    });
                }

                if (mandatoryValidation) {
                    const valRes = await adapter.validateAccount({
                        variantId: matchedVariant.vendor_variant_id || targetVariantId,
                        customerId: targetId,
                        zoneId: zone_id,
                        productName: dbProduct.name,
                        brand: dbProduct.brand,
                        category: dbProduct.category,
                    });

                    if (!valRes.success || valRes.valid === false) {
                        if (valRes.message !== 'VALIDATION_NOT_AVAILABLE') {
                            return res.status(400).json({
                                error: valRes.message || 'ID Akun tujuan tidak valid atau tidak ditemukan. Mohon cek kembali ID Anda.'
                            });
                        }
                    }

                    if (valRes.data?.account_name || valRes.data?.display_name) {
                        resolvedCustomerName = valRes.data.account_name || valRes.data.display_name;
                    }
                }
            }
        } else if (actualVendor === 'sekalipay' && matchedVariant.validation?.available && mandatoryValidation) {
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
                logger.warn('sekalipay_validation_check_failed_open', { message: valErr.message });
            }
        }


        // 7. Generate order ID & unique code
        const orderId = generateOrderId();
        const orderAccessToken = generateOrderAccessToken();
        
        const variantIdForOrder = matchedVariant.vendor_variant_id || targetVariantId;
        
        // --- BALANCE PAYMENT FLOW ---
        if (payment_type === 'balance') {
            if (!req.user || !req.user.id) {
                return res.status(401).json({ error: 'Harap login untuk menggunakan saldo' });
            }
            
            try {
                await balanceService.debitBalance(req.user.id, amount, orderId, `Pembelian ${product_name || dbProduct.name}`);
            } catch (balErr) {
                return res.status(400).json({ error: balErr.message || 'Saldo tidak mencukupi atau terjadi kesalahan' });
            }
            
            // Simpan order
            const { error: dbError } = await supabase.from('orders').insert([
                {
                    id: orderId,
                    product: product_name || dbProduct.name,
                    variant: variant_name || matchedVariant.name || '-',
                    price: amount,
                    wa_number,
                    email,
                    customer_name: resolvedCustomerName,
                    payment_method: 'BALANCE',
                    payment_type: 'balance',
                    user_id: req.user.id,
                    order_access_token: orderAccessToken,
                    status: 'PENDING',
                    channel: 'web',
                    order_type: 'prepaid',
                    pg_provider: 'balance',
                    vendor: actualVendor,
                    vendor_variant_id: variantIdForOrder,
                    vendor_status: 'none',
                    pg_paid_at: new Date().toISOString(),
                    account_details: (() => {
                        const rawZoneId = zone_id || (req.body.fieldData && req.body.fieldData.zone_id);
                        const rawUserId = customer_id || user_id || (req.body.fieldData && req.body.fieldData.customer_id);
                        const isMeterTarget = matchedVariant?.provider_meta?.target_type === 'meter';
                        const accountTarget = buildAccountTarget(note, matchedVariant);
                        let finalZoneId = rawZoneId ? String(rawZoneId).trim() : null;
                        let finalUserId = rawUserId ? String(rawUserId).trim() : null;
                        if (isMeterTarget && finalUserId) {
                            finalUserId = finalUserId.replace(/\D/g, '');
                        }
                        if (!finalZoneId && note && typeof note === 'string') {
                            const match = note.match(/^([^\(\)]+)\(([^\(\)]+)\)$/);
                            if (match) {
                                finalUserId = finalUserId || match[1].trim();
                                finalZoneId = match[2].trim();
                            }
                        }
                        return {
                            vendor: actualVendor,
                            note: accountTarget,
                            target: accountTarget,
                            customer_id: finalUserId,
                            user_id: finalUserId,
                            zone_id: finalZoneId,
                            provider_qty: provider_qty ? parseInt(provider_qty) : undefined,
                            ...(isMeterTarget ? { target_type: 'meter' } : {}),
                        };
                    })(),
                    timestamp: new Date().toISOString(),
                }
            ]);
            
            if (dbError) {
                logger.error('balance_order_insert_failed', { orderId, code: dbError.code });
                // Refund balance
                await balanceService.refundBalance(req.user.id, amount, orderId, 'Refund otomatis karena gagal simpan order');
                return res.status(500).json({ error: 'Gagal menyimpan order' });
            }
            
            // Ambil data terbaru untuk fulfillment
            const { data: latestOrder } = await supabase.from('orders').select('*').eq('id', orderId).single();
            
            // Jalankan fulfillment di background tanpa await
            orderFulfillmentService.fulfillOrder(latestOrder).catch(err => {
                logger.error('balance_order_fulfillment_failed', { orderId, error: err });
            });
            
            return res.status(201).json({
                success: true,
                data: {
                    order_id: orderId,
                    access_token: orderAccessToken,
                    amount,
                    status: 'PROCESSING',
                    pg_provider: 'balance'
                }
            });
        }
        
        // --- GATEWAY PAYMENT FLOW ---
        const uniqueCode = await generateUniqueCode();
        const totalWithUniqueCode = amount + uniqueCode;

        // 8. Tentukan Payment Gateway & Buat Invoice
        const pgProvider = await getActivePaymentGateway();
        logger.info('payment_gateway_selected', { orderId, pgProvider, uniqueCode });

        let pgData, pgFee, pgTotal, pgInvoice, pgPaymentLink, pgQrLink;

        if (pgProvider === 'dyqris') {
            const dyqrisResult = await dyqrisGatewayService.createTransaction({
                refId: orderId,
                amount: amount,
                expiryMinutes: 15,
                metadata: {
                    customer_name: resolvedCustomerName,
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

        } else if (pgProvider === 'sekalipay') {
            const sekalipayResult = await sekalipayGatewayService.createPayment({
                merchant_ref_id: orderId,
                amount: amount,
                customer_name: resolvedCustomerName,
                customer_email: (email || 'customer@noxarianet.web.id').trim(),
                customer_phone: wa_number || '08123456789',
                access_token: orderAccessToken,
                metadata: {
                    source: 'website',
                    order_id: orderId,
                    product_name: product_name || dbProduct.name || 'NoxariaNet Store'
                }
            });
            if (!sekalipayResult.success) {
                return res.status(sekalipayResult.status || 502).json({ error: `Gagal membuat pembayaran Sekalipay: ${sekalipayResult.message}` });
            }
            pgData = sekalipayResult.data;
            pgFee = pgData.fee || 0;
            pgTotal = pgData.total || (amount + pgFee);
            pgInvoice = pgData.invoice || pgData.merchant_ref_id;
            pgPaymentLink = pgData.payment_link || pgData.checkout_url || null;
            pgQrLink = pgData.qr_link || pgData.payment_link || null;

        } else if (pgProvider === 'fincloud') {
            const pgResult = await paymentGatewayService.createInvoice({
                reffId: orderId,
                nominal: amount,
            });
            if (!pgResult.success) {
                return res.status(pgResult.status || 502).json({ error: `Gagal membuat pembayaran: ${pgResult.message}` });
            }
            pgData = pgResult.data;
            const nominalAsli = pgData.nominal || pgData.nominal_asli || amount;
            const totalBayar = pgData.total_bayar || pgData.nominal_total || (nominalAsli + (pgData.kode_unik || 0));
            pgFee = pgData.fee || 0;
            pgTotal = totalBayar;
            pgInvoice = String(pgData.reff_id || pgData.external_id || pgData.id_depo || orderId);
            pgPaymentLink = pgData.checkout_url || pgData.invoice_url || null;
            pgQrLink = pgData.qris_url || pgData.qr_url || (pgData.qris_string ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(pgData.qris_string)}` : null);
        } else {
            return res.status(500).json({ error: 'Payment gateway tidak dikenali' });
        }

        const effectiveUniqueCode = pgProvider === 'dyqris'
            ? (pgData.actual_amount ? (pgData.actual_amount - amount) : 0)
            : pgProvider === 'sekalipay'
                ? 0
                : pgProvider === 'fincloud'
                    ? (pgData.kode_unik !== undefined ? pgData.kode_unik : ((pgTotal || amount) - amount))
                    : uniqueCode;

        // Optimistically deduct vendor balance in cache
        if (actualVendor === 'okeconnect') {
            cacheService.deductCachedBalance('okeconnect', requiredVendorCost);
        }

        // 9. Simpan order ke Supabase
        const { error: dbError } = await supabase.from('orders').insert([
            {
                id: orderId,
                product: product_name || dbProduct.name,
                variant: variant_name || matchedVariant.name || '-',
                price: amount,
                wa_number,
                email,
                customer_name: resolvedCustomerName,
                payment_method: 'QRIS',
                payment_type: 'gateway',
                user_id: req.user ? req.user.id : null,
                order_access_token: orderAccessToken,
                status: 'PENDING',
                channel: 'web',
                order_type: 'prepaid',

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
                    const isMeterTarget = matchedVariant?.provider_meta?.target_type === 'meter';
                    const accountTarget = buildAccountTarget(note, matchedVariant);

                    let finalZoneId = rawZoneId ? String(rawZoneId).trim() : null;
                    let finalUserId = rawUserId ? String(rawUserId).trim() : null;

                    if (isMeterTarget && finalUserId) {
                        finalUserId = finalUserId.replace(/\D/g, '');
                    }

                    if (!finalZoneId && note && typeof note === 'string') {
                        const match = note.match(/^([^\(\)]+)\(([^\(\)]+)\)$/);
                        if (match) {
                            finalUserId = finalUserId || match[1].trim();
                            finalZoneId = match[2].trim();
                        }
                    }

                    return {
                        vendor: actualVendor,
                        note: accountTarget,
                        target: accountTarget,
                        customer_id: finalUserId,
                        user_id: finalUserId,
                        zone_id: finalZoneId,
                        provider_qty: provider_qty ? parseInt(provider_qty) : undefined,
                        ...(isMeterTarget ? { target_type: 'meter' } : {}),
                    };
                })(),


                timestamp: new Date().toISOString(),
            },
        ]);

        if (dbError) {
            logger.error('gateway_order_insert_failed', { orderId, code: dbError.code });
            return res.status(500).json({ error: 'Gagal menyimpan order' });
        }

        logger.info('order_created', { orderId, pgProvider, vendor: actualVendor });

        return res.status(201).json({
            success: true,
            data: {
                order_id: orderId,
                access_token: orderAccessToken,
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
        logger.error('payment_create_failed', { error: err });
        return res.status(500).json({ error: 'Gagal membuat pembayaran' });
    }
}

// In-memory map to throttle upstream Payment Gateway checks (orderId -> timestamp)
const lastVendorCheckMap = new Map();

// Periodic cleanup of stale throttle entries (every 10 minutes). Do not keep a
// serverless process alive just for this timer.
const throttleCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of lastVendorCheckMap.entries()) {
        if (now - timestamp > 3600000) { // older than 1 hour
            lastVendorCheckMap.delete(key);
        }
    }
}, 600000);
if (throttleCleanupTimer.unref) throttleCleanupTimer.unref();

// Columns needed by the storefront status page and by authorizeOrderAccess().
// Everything else (email, wa_number, proof_image, payment links, ...) is not
// required on every poll and only increases egress.
const ORDER_STATUS_FIELDS = [
    'id',
    'status',
    'product',
    'variant',
    'price',
    'payment_method',
    'payment_type',
    'pg_provider',
    'pg_invoice',
    'pg_paid_at',
    'pg_expired_at',
    'error_message',
    'account_details',
    'user_id',
    'order_access_token',
].join(',');

/**
 * Remove credentials and (for the slim view) customer PII before sending an
 * order row to the browser.
 */
function toSafeOrderResponse(order, { slim }) {
    const out = { ...order };
    delete out.order_access_token;
    out.account_details = sanitizeAccountDetails(out.account_details);

    if (slim) {
        delete out.user_id;
        delete out.email;
        delete out.wa_number;
        delete out.customer_name;
    }

    return out;
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/payments/status/:orderId
// ══════════════════════════════════════════════════════════════════════════

async function getPaymentStatus(req, res) {
    try {
        const { orderId } = req.params;
        const force = req.query.force === 'true';
        const slim = req.query.view === 'slim';
        const columns = slim ? ORDER_STATUS_FIELDS : '*';

        res.set('Cache-Control', 'no-store');

        let { data, error } = await withReadRetry(async () => {
            const result = await supabase
                .from('orders')
                .select(columns)
                .eq('id', orderId)
                .maybeSingle();

            // Supabase resolves with { error }, it does not throw. Re-throw
            // only transient errors so withReadRetry can retry them.
            if (result.error && isTransientError(result.error)) throw result.error;
            return result;
        });

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: 'Order tidak ditemukan' });
            }
            logger.error('order_status_read_failed', { orderId, code: error.code });
            return res.status(500).json({ error: 'Gagal memeriksa status pesanan' });
        }
        if (!data) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        // Akses harus dibuktikan: pemilik order (req.user.id) atau X-Order-Token.
        // Order ID bisa ditebak, jadi id saja tidak cukup.
        if (!authorizeOrderAccess(req, data)) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        // Jika order masih PENDING, throttle pengecekan ke API vendor Payment Gateway
        // Regular poll: minimal interval 60 detik (1 menit++)
        // Manual refresh (?force=true): minimal interval 15 detik
        if (data.status === 'PENDING' && data.pg_invoice) {
            const now = Date.now();
            const lastCheck = lastVendorCheckMap.get(orderId) || 0;
            const minInterval = force ? 15000 : 60000;

            if (now - lastCheck >= minInterval) {
                lastVendorCheckMap.set(orderId, now);
                try {
                    await paymentPollingService.processOrder(data);
                    const { data: updatedData } = await supabase
                        .from('orders')
                        .select(columns)
                        .eq('id', orderId)
                        .maybeSingle();

                    if (updatedData) {
                        return res.json({ data: toSafeOrderResponse(updatedData, { slim }) });
                    }
                } catch (vendorErr) {
                    logger.warn('order_vendor_status_check_failed', {
                        orderId,
                        code: vendorErr.code,
                        message: vendorErr.message,
                    });
                }
            }
        }

        // Balance orders (including postpaid bills) have no PG invoice to
        // poll. Ask the vendor for the latest status, throttled by
        // orderStatusService. This makes app polling work without FCM.
        if (!slim && data.payment_type === 'balance' &&
            ['PENDING', 'PROCESSING', 'PROCESSING_LOCK'].includes(data.status)) {
            const refreshed = await orderStatusService.refreshIfStale(data, { force });
            if (refreshed) data = refreshed;
        }

        return res.json({ data: toSafeOrderResponse(data, { slim }) });
    } catch (err) {
        logger.error('order_status_failed', { orderId: req.params.orderId, error: err });
        res.status(500).json({ error: 'Gagal memeriksa status pesanan' });
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
            .select('id, status, payment_type, price, pg_provider, user_id, order_access_token')
            .eq('id', order_id)
            .single();

        if (fetchError || !order) return res.status(404).json({ error: 'Order tidak ditemukan' });

        // Cegah orang membatalkan invoice milik orang lain hanya dengan.order_id
        if (!authorizeOrderAccess(req, order)) {
            return res.status(404).json({ error: 'Order tidak ditemukan' });
        }

        if (order.status !== 'PENDING') {
            return res.status(400).json({ error: `Order tidak bisa dibatalkan (status: ${order.status})` });
        }

        // Balance orders were paid at creation time. Claim before refunding so
        // fulfillment cannot consume the order in between.
        if (order.payment_type === 'balance' && order.user_id) {
            const { data: claimed, error: claimError } = await supabase
                .from('orders')
                .update({
                    status: 'REFUND_PENDING',
                    error_message: 'Dibatalkan oleh pengguna; refund diproses',
                })
                .eq('id', order.id)
                .eq('status', 'PENDING')
                .select('id');

            if (claimError) throw claimError;
            if (!claimed || claimed.length === 0) {
                return res.status(409).json({ error: 'Order sudah diproses dan tidak bisa dibatalkan' });
            }

            try {
                await balanceService.refundBalance(
                    order.user_id,
                    order.price,
                    order.id,
                    'Refund otomatis: pesanan dibatalkan oleh pengguna'
                );
            } catch (refundErr) {
                logger.error('payment_cancel_refund_failed', {
                    orderId: order.id,
                    message: refundErr.message,
                });
                return res.status(500).json({ error: 'Refund gagal diproses. Silakan hubungi CS.' });
            }

            await supabase
                .from('orders')
                .update({ status: 'CANCELLED' })
                .eq('id', order.id)
                .eq('status', 'REFUND_PENDING');

            return res.json({ success: true, message: 'Invoice berhasil dibatalkan dan saldo dikembalikan' });
        }

        if (order.pg_provider !== 'sekalipay' && order.pg_provider !== 'dyqris') {
            await paymentGatewayService.cancelInvoice(order_id);
        }

        await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order_id);
        return res.json({ success: true, message: 'Invoice berhasil dibatalkan' });
    } catch (err) {
        logger.error('payment_cancel_failed', { orderId: req.body?.order_id, error: err });
        res.status(500).json({ error: 'Gagal membatalkan pembayaran' });
    }
}

module.exports = { createPayment, getPaymentStatus, cancelPayment, getActivePaymentGateway };
