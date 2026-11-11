const supabase = require('../supabase');
const paymentGatewayService = require('./paymentGatewayService');
const sekalipayGatewayService = require('./sekalipayGatewayService');
const dyqrisGatewayService = require('./dyqrisGatewayService');
const vendorRegistry = require('./vendors/vendorRegistry');
const cacheService = require('./cacheService');
const balanceService = require('./balanceService');
const orderFulfillmentService = require('./orderFulfillmentService');
const { getActivePaymentGateway } = require('./paymentSettings');
const { findProductByAnyId, findProductByExternalId, findVariantByPublicId } = require('../utils/productLookup');
const { normalizePhoneNumber, normalizeNotePhoneNumber } = require('../utils/phoneUtils');
const { isAvailableForChannel } = require('../utils/channel');
const { generateOrderId, generateOrderAccessToken, generateUniqueCode } = require('../utils/orderIds');
const { logger } = require('../utils/logger');

/**
 * Mobile prepaid order service.
 *
 * Differences from the web checkout:
 *   - a valid app user is mandatory;
 *   - buyer contact data comes from user_profiles, never from the request;
 *   - amount is always calculated server-side;
 *   - channel is forced to "android";
 *   - Idempotency-Key is honoured.
 */

function fail(status, code, error) {
    return { status, body: { success: false, code, error } };
}

function extractTarget(input = {}) {
    const fields = input.fields && typeof input.fields === 'object' ? input.fields : {};

    const targetRaw =
        fields.customer_id ??
        fields.user_id ??
        fields.target ??
        fields.note ??
        input.customer_id ??
        input.user_id ??
        input.note ??
        '';

    const zoneRaw =
        fields.zone_id ??
        fields.server_id ??
        input.zone_id ??
        input.server_id ??
        '';

    const qtyRaw = fields.provider_qty ?? input.provider_qty;

    return {
        target: String(targetRaw ?? '').trim(),
        zone: String(zoneRaw ?? '').trim(),
        providerQty: qtyRaw === undefined || qtyRaw === null || qtyRaw === ''
            ? null
            : parseInt(qtyRaw, 10),
    };
}

async function getProfile(userId) {
    const { data, error } = await supabase
        .from('user_profiles')
        .select('id, email, phone, display_name, balance, is_active')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;
    return data;
}

async function findExistingOrder(userId, idempotencyKey) {
    if (!idempotencyKey) return null;

    const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    return data || null;
}

function orderToResponse(order) {
    if (!order) return null;

    const base = {
        order_id: order.id,
        access_token: order.order_access_token,
        amount: order.price,
        status: order.status,
        payment_type: order.payment_type,
        pg_provider: order.pg_provider,
        product: order.product,
        variant: order.variant,
        created_at: order.timestamp,
    };

    if (order.payment_type === 'balance') {
        return base;
    }

    return {
        ...base,
        invoice: order.pg_invoice,
        unique_code: order.unique_code,
        fee: order.pg_fee,
        total: order.pg_total,
        payment_code: 'QRIS',
        payment_link: order.pg_payment_link,
        qr_link: order.pg_qr_link,
    };
}

async function resolveProductAndVariant(input) {
    const { product_id, variant_id, sku, variant_name } = input;
    const targetVariantId = String(variant_id || sku || '');

    if (!targetVariantId && !product_id) {
        return { error: fail(400, 'VARIANT_REQUIRED', 'variant_id / sku wajib diisi') };
    }

    let dbProduct = null;

    if (product_id) {
        const { data, error } = await findProductByAnyId(
            supabase,
            product_id,
            '*, product_variants(*)'
        );
        if (error) {
            logger.error('mobile_order_product_lookup_failed', { productId: product_id, code: error.code });
            return { error: fail(500, 'PRODUCT_LOOKUP_FAILED', 'Gagal memuat produk') };
        }
        dbProduct = data;
    }

    if (!dbProduct && targetVariantId) {
        const { data: vRow, error } = await findVariantByPublicId(
            supabase,
            targetVariantId,
            'id, product_id, vendor_variant_id'
        );
        if (error) {
            logger.error('mobile_order_variant_lookup_failed', { variantId: targetVariantId, code: error.code });
            return { error: fail(500, 'VARIANT_LOOKUP_FAILED', 'Gagal memuat varian produk') };
        }

        if (vRow?.product_id) {
            const { data, error: productError } = await findProductByAnyId(
                supabase,
                vRow.product_id,
                '*, product_variants(*)'
            );
            if (productError) {
                logger.error('mobile_order_variant_product_lookup_failed', { productId: vRow.product_id, code: productError.code });
                return { error: fail(500, 'PRODUCT_LOOKUP_FAILED', 'Gagal memuat produk') };
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
            logger.error('mobile_order_sku_lookup_failed', { sku, code: error.code });
            return { error: fail(500, 'PRODUCT_LOOKUP_FAILED', 'Gagal memuat produk') };
        }
        dbProduct = data;
    }

    if (!dbProduct || dbProduct.is_active === false) {
        return { error: fail(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan atau sedang tidak aktif') };
    }

    if (!isAvailableForChannel(dbProduct, 'app')) {
        return { error: fail(404, 'PRODUCT_NOT_AVAILABLE', 'Produk tidak tersedia di aplikasi') };
    }

    if (dbProduct.product_type === 'postpaid') {
        return { error: fail(400, 'USE_BILL_FLOW', 'Produk tagihan harus dibuat melalui alur inquiry tagihan') };
    }

    const actualVendor = dbProduct.vendor || input.vendor || 'sekalipay';
    const adapter = vendorRegistry.get(actualVendor);
    if (!adapter) {
        return { error: fail(400, 'VENDOR_UNSUPPORTED', `Vendor '${actualVendor}' tidak didukung`) };
    }

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
        return { error: fail(404, 'VARIANT_NOT_FOUND', 'Varian produk tidak ditemukan atau sedang tidak aktif') };
    }

    return { dbProduct, matchedVariant, actualVendor, adapter, targetVariantId };
}

function computeAmount(matchedVariant, providerQty) {
    const sellPrice = matchedVariant.sell_price || matchedVariant.price || 0;

    if (matchedVariant.provider_meta && matchedVariant.provider_meta.open_denom) {
        if (!providerQty || !Number.isFinite(providerQty) || providerQty <= 0) {
            return { error: fail(400, 'PROVIDER_QTY_REQUIRED', 'Nominal (provider_qty) wajib diisi untuk produk ini') };
        }
        if (matchedVariant.provider_meta.min_qty && providerQty < matchedVariant.provider_meta.min_qty) {
            return { error: fail(400, 'PROVIDER_QTY_MIN', `Nominal minimal adalah ${matchedVariant.provider_meta.min_qty}`) };
        }
        if (matchedVariant.provider_meta.max_qty && providerQty > matchedVariant.provider_meta.max_qty) {
            return { error: fail(400, 'PROVIDER_QTY_MAX', `Nominal maksimal adalah ${matchedVariant.provider_meta.max_qty}`) };
        }
        return { amount: Math.ceil(providerQty + sellPrice) };
    }

    return { amount: Math.ceil(sellPrice) };
}

async function checkVendorAvailability({ adapter, actualVendor, matchedVariant, targetVariantId, providerQty, amount }) {
    const requiredVendorCost = matchedVariant.provider_meta?.open_denom
        ? (providerQty || 0)
        : (matchedVariant.base_price || matchedVariant.sell_price || amount);

    if (actualVendor === 'okeconnect') {
        const balanceRes = await adapter.getBalance();
        if (balanceRes.success && typeof balanceRes.balance === 'number' && balanceRes.balance < requiredVendorCost) {
            logger.warn('mobile_okeconnect_balance_insufficient', {
                balance: balanceRes.balance,
                required: requiredVendorCost,
            });
            return {
                error: fail(
                    503,
                    'VENDOR_BALANCE_LOW',
                    'Saldo server sedang dalam pengisian. Silakan coba beberapa saat lagi.'
                ),
            };
        }
        return { requiredVendorCost };
    }

    const stockCheck = await adapter.checkStock(matchedVariant.vendor_variant_id || targetVariantId);
    if (!stockCheck.success || stockCheck.available === false) {
        return {
            error: fail(
                400,
                'VENDOR_STOCK_EMPTY',
                stockCheck.message || 'Stok varian ini sedang habis. Silakan coba lagi nanti.'
            ),
        };
    }

    return { requiredVendorCost };
}

async function validateAccount({ adapter, actualVendor, dbProduct, matchedVariant, targetVariantId, target, zone, fallbackName }) {
    let resolvedCustomerName = fallbackName;
    let resolvedTarget = target;

    if (actualVendor === 'okeconnect') {
        const isEwallet = dbProduct?.category?.toLowerCase().includes('wallet') ||
            /dana|ovo|gopay|gojek|shopee|linkaja|isaku|maxim/i.test(dbProduct?.name || '');
        // Meter / customer numbers (PLN token) are not phone numbers.
        const isMeterTarget = matchedVariant?.provider_meta?.target_type === 'meter';

        if (isEwallet) {
            if (/[a-zA-Z]/.test(resolvedTarget)) {
                return { error: fail(400, 'INVALID_TARGET', 'Nomor tujuan e-wallet tidak boleh mengandung huruf.') };
            }
            const normalized = normalizePhoneNumber(resolvedTarget);
            if (!normalized || !/^08[0-9]{8,13}$/.test(normalized)) {
                return { error: fail(400, 'INVALID_TARGET', 'Format nomor e-wallet tidak valid. Harus diawali 08 dengan 10-14 digit angka.') };
            }
            resolvedTarget = normalized;
        } else if (isMeterTarget) {
            const digits = String(resolvedTarget || '').replace(/\D/g, '');
            if (!digits || digits.length < 6 || digits.length > 20) {
                return { error: fail(400, 'INVALID_TARGET', 'No. Meter / ID Pelanggan PLN harus berupa 6-20 digit angka.') };
            }
            resolvedTarget = digits;
        } else if (!zone && /^[0-9\s\-\+\(\)]+$/.test(resolvedTarget)) {
            const normalized = normalizePhoneNumber(resolvedTarget);
            if (normalized && normalized.startsWith('08')) {
                resolvedTarget = normalized;
            }
        }

        if (matchedVariant.validation?.available) {
            if (!resolvedTarget) {
                return { error: fail(400, 'TARGET_REQUIRED', 'User ID / Nomor Tujuan wajib diisi dan divalidasi terlebih dahulu') };
            }

            const valRes = await adapter.validateAccount({
                variantId: matchedVariant.vendor_variant_id || targetVariantId,
                customerId: resolvedTarget,
                zoneId: zone,
                productName: dbProduct.name,
                brand: dbProduct.brand,
                category: dbProduct.category,
            });

            if (!valRes.success || valRes.valid === false) {
                if (valRes.message !== 'VALIDATION_NOT_AVAILABLE') {
                    return {
                        error: fail(
                            400,
                            'TARGET_INVALID',
                            valRes.message || 'ID Akun tujuan tidak valid atau tidak ditemukan.'
                        ),
                    };
                }
            }

            if (valRes.data?.account_name || valRes.data?.display_name) {
                resolvedCustomerName = valRes.data.account_name || valRes.data.display_name;
            }
        }
    } else if (actualVendor === 'sekalipay' && matchedVariant.validation?.available) {
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
                            return {
                                error: fail(
                                    400,
                                    'VARIANT_INACTIVE',
                                    'Varian produk ini sedang tidak aktif di penyedia. Silakan pilih varian lain.'
                                ),
                            };
                        }
                    }
                }
            }
        } catch (valErr) {
            logger.warn('mobile_sekalipay_validation_check_failed_open', { message: valErr.message });
        }
    }

    return { resolvedCustomerName, resolvedTarget };
}

function buildNote({ target, zone, providerQty, openDenom, orderProcess }) {
    if (openDenom) {
        return JSON.stringify({ target, provider_qty: providerQty });
    }
    if (orderProcess === 'smm') {
        return JSON.stringify({ target, opt_smm: [], comment_smm: '' });
    }
    return zone ? `${target}(${zone})` : target;
}

function buildAccountDetails({ actualVendor, note, target, zone, providerQty, targetType }) {
    // Meter / customer numbers must reach the vendor exactly as entered (and
    // as digits only), so they skip the phone-number normalization.
    const isMeterTarget = targetType === 'meter';
    const normalizedNote = isMeterTarget
        ? (note ? String(note).replace(/\D/g, '') : null)
        : (note ? normalizeNotePhoneNumber(note) : null);

    return {
        vendor: actualVendor,
        note: normalizedNote || null,
        target: normalizedNote || null,
        customer_id: target || null,
        user_id: target || null,
        zone_id: zone || null,
        provider_qty: providerQty || undefined,
        ...(isMeterTarget ? { target_type: 'meter' } : {}),
    };
}

async function createGatewayOrder({ orderId, orderAccessToken, amount, profile, resolvedCustomerName, dbProduct, matchedVariant, actualVendor, variantIdForOrder, accountDetails, idempotencyKey, input }) {
    const uniqueCode = await generateUniqueCode();
    const pgProvider = await getActivePaymentGateway();
    logger.info('mobile_payment_gateway_selected', { orderId, pgProvider, uniqueCode });

    let pgData, pgFee, pgTotal, pgInvoice, pgPaymentLink, pgQrLink;

    if (pgProvider === 'dyqris') {
        const dyqrisResult = await dyqrisGatewayService.createTransaction({
            refId: orderId,
            amount,
            expiryMinutes: 15,
            metadata: {
                customer_name: resolvedCustomerName,
                email: profile.email,
                product_name: dbProduct.name,
                source: 'android',
            },
        });
        if (!dyqrisResult.success) {
            return fail(dyqrisResult.status || 502, 'PG_CREATE_FAILED', `Gagal membuat pembayaran Dyqris: ${dyqrisResult.message}`);
        }
        pgData = dyqrisResult.data;
        pgFee = 0;
        pgTotal = pgData.actual_amount || amount;
        pgInvoice = pgData.id;
        pgPaymentLink = pgData.qr_image_url || null;
        pgQrLink = pgData.qr_image_url || (pgData.qr_string
            ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(pgData.qr_string)}`
            : null);
    } else if (pgProvider === 'sekalipay') {
        const sekalipayResult = await sekalipayGatewayService.createPayment({
            merchant_ref_id: orderId,
            amount,
            customer_name: resolvedCustomerName,
            customer_email: profile.email,
            customer_phone: profile.phone,
            access_token: orderAccessToken,
            metadata: {
                source: 'android',
                order_id: orderId,
                product_name: dbProduct.name,
            },
        });
        if (!sekalipayResult.success) {
            return fail(sekalipayResult.status || 502, 'PG_CREATE_FAILED', `Gagal membuat pembayaran Sekalipay: ${sekalipayResult.message}`);
        }
        pgData = sekalipayResult.data;
        pgFee = pgData.fee || 0;
        pgTotal = pgData.total || (amount + pgFee);
        pgInvoice = pgData.invoice || pgData.merchant_ref_id;
        pgPaymentLink = pgData.payment_link || pgData.checkout_url || null;
        pgQrLink = pgData.qr_link || pgData.payment_link || null;
    } else if (pgProvider === 'fincloud') {
        const pgResult = await paymentGatewayService.createInvoice({ reffId: orderId, nominal: amount });
        if (!pgResult.success) {
            return fail(pgResult.status || 502, 'PG_CREATE_FAILED', `Gagal membuat pembayaran: ${pgResult.message}`);
        }
        pgData = pgResult.data;
        const nominalAsli = pgData.nominal || pgData.nominal_asli || amount;
        const totalBayar = pgData.total_bayar || pgData.nominal_total || (nominalAsli + (pgData.kode_unik || 0));
        pgFee = pgData.fee || 0;
        pgTotal = totalBayar;
        pgInvoice = String(pgData.reff_id || pgData.external_id || pgData.id_depo || orderId);
        pgPaymentLink = pgData.checkout_url || pgData.invoice_url || null;
        pgQrLink = pgData.qris_url || pgData.qr_url || (pgData.qris_string
            ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(pgData.qris_string)}`
            : null);
    } else {
        return fail(500, 'PG_UNKNOWN', 'Payment gateway tidak dikenali');
    }

    const effectiveUniqueCode = pgProvider === 'dyqris'
        ? (pgData.actual_amount ? (pgData.actual_amount - amount) : 0)
        : pgProvider === 'sekalipay'
            ? 0
            : (pgData.kode_unik !== undefined ? pgData.kode_unik : ((pgTotal || amount) - amount));

    if (actualVendor === 'okeconnect') {
        const requiredVendorCost = matchedVariant.provider_meta?.open_denom
            ? (input.provider_qty || 0)
            : (matchedVariant.base_price || matchedVariant.sell_price || amount);
        cacheService.deductCachedBalance('okeconnect', requiredVendorCost);
    }

    const { error: dbError } = await supabase.from('orders').insert([{
        id: orderId,
        product: dbProduct.name,
        variant: matchedVariant.name || '-',
        price: amount,
        wa_number: profile.phone,
        email: profile.email,
        customer_name: resolvedCustomerName,
        payment_method: 'QRIS',
        payment_type: 'gateway',
        user_id: profile.id,
        order_access_token: orderAccessToken,
        status: 'PENDING',
        channel: 'android',
        order_type: 'prepaid',
        idempotency_key: idempotencyKey || null,
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
        vendor: actualVendor,
        vendor_order_id: null,
        vendor_variant_id: variantIdForOrder,
        vendor_status: 'none',
        account_details: accountDetails,
        timestamp: new Date().toISOString(),
    }]);

    if (dbError) {
        logger.error('mobile_gateway_order_insert_failed', { orderId, code: dbError.code });

        if (dbError.code === '23505' && idempotencyKey) {
            const existing = await findExistingOrder(profile.id, idempotencyKey);
            if (existing) {
                try {
                    if (pgProvider !== 'sekalipay' && pgProvider !== 'dyqris') {
                        await paymentGatewayService.cancelInvoice(pgInvoice);
                    }
                } catch (cancelErr) {
                    logger.warn('mobile_duplicate_invoice_cancel_failed', { orderId, message: cancelErr.message });
                }
                return { status: 200, body: { success: true, idempotent: true, data: orderToResponse(existing) } };
            }
        }

        return fail(500, 'ORDER_INSERT_FAILED', 'Gagal menyimpan order');
    }

    return {
        status: 201,
        body: {
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
                payment_type: 'gateway',
            },
        },
    };
}

async function createPrepaidOrder({ user, input = {}, idempotencyKey }) {
    try {
        // 1. Shop status
        const { data: statusSetting, error: statusError } = await supabase
            .from('settings')
            .select('*')
            .eq('key', 'shop_status')
            .maybeSingle();

        const shopOpen = statusError || !statusSetting
            ? true
            : statusSetting.value?.isOpen !== false;

        if (!shopOpen) {
            return fail(403, 'SHOP_CLOSED', statusSetting?.value?.message || 'Toko sedang tutup. Silakan coba lagi nanti.');
        }

        // 2. Profile is the source of truth for buyer contact data.
        const profile = await getProfile(user.id);
        if (!profile || profile.is_active === false) {
            return fail(403, 'ACCOUNT_INACTIVE', 'Akun tidak ditemukan atau tidak aktif.');
        }
        if (!profile.email || !profile.phone) {
            return fail(400, 'PROFILE_INCOMPLETE', 'Lengkapi email dan nomor telepon di profil terlebih dahulu.');
        }

        // 3. Idempotent replay
        if (idempotencyKey) {
            const existing = await findExistingOrder(user.id, idempotencyKey);
            if (existing) {
                return {
                    status: 200,
                    body: { success: true, idempotent: true, data: orderToResponse(existing) },
                };
            }
        }

        // 4. Resolve product + variant
        const resolved = await resolveProductAndVariant(input);
        if (resolved.error) return resolved.error;

        const { dbProduct, matchedVariant, actualVendor, adapter, targetVariantId } = resolved;
        const targetInfo = extractTarget(input);

        if (!targetInfo.target) {
            return fail(400, 'TARGET_REQUIRED', 'Target / User ID wajib diisi.');
        }

        // 5. Server-side amount
        const amountResult = computeAmount(matchedVariant, targetInfo.providerQty);
        if (amountResult.error) return amountResult.error;
        const amount = amountResult.amount;

        if (amount < 1000) {
            return fail(400, 'AMOUNT_TOO_LOW', 'Minimal pembayaran Rp 1.000');
        }

        // 6. Vendor availability
        const availability = await checkVendorAvailability({
            adapter,
            actualVendor,
            matchedVariant,
            targetVariantId,
            providerQty: targetInfo.providerQty,
            amount,
        });
        if (availability.error) return availability.error;

        // 7. Account validation
        const validated = await validateAccount({
            adapter,
            actualVendor,
            dbProduct,
            matchedVariant,
            targetVariantId,
            target: targetInfo.target,
            zone: targetInfo.zone,
            fallbackName: profile.display_name || profile.phone,
        });
        if (validated.error) return validated.error;

        const openDenom = Boolean(matchedVariant.provider_meta?.open_denom);
        const targetType = matchedVariant.provider_meta?.target_type || null;
        const note = buildNote({
            target: validated.resolvedTarget,
            zone: targetInfo.zone,
            providerQty: targetInfo.providerQty,
            openDenom,
            orderProcess: matchedVariant.order_process,
        });

        const accountDetails = buildAccountDetails({
            actualVendor,
            note,
            target: validated.resolvedTarget,
            zone: targetInfo.zone,
            providerQty: targetInfo.providerQty,
            targetType,
        });

        const orderId = generateOrderId();
        const orderAccessToken = generateOrderAccessToken();
        const variantIdForOrder = matchedVariant.vendor_variant_id || targetVariantId;
        const paymentType = input.payment_type === 'gateway' ? 'gateway' : 'balance';

        // 8. Balance flow
        if (paymentType === 'balance') {
            try {
                await balanceService.debitBalance(
                    profile.id,
                    amount,
                    orderId,
                    `Pembelian ${dbProduct.name}`
                );
            } catch (balErr) {
                return fail(400, 'INSUFFICIENT_BALANCE', balErr.message || 'Saldo tidak mencukupi atau terjadi kesalahan');
            }

            const { error: dbError } = await supabase.from('orders').insert([{
                id: orderId,
                product: dbProduct.name,
                variant: matchedVariant.name || '-',
                price: amount,
                wa_number: profile.phone,
                email: profile.email,
                customer_name: validated.resolvedCustomerName,
                payment_method: 'BALANCE',
                payment_type: 'balance',
                user_id: profile.id,
                order_access_token: orderAccessToken,
                status: 'PENDING',
                channel: 'android',
                order_type: 'prepaid',
                idempotency_key: idempotencyKey || null,
                pg_provider: 'balance',
                vendor: actualVendor,
                vendor_variant_id: variantIdForOrder,
                vendor_status: 'none',
                pg_paid_at: new Date().toISOString(),
                account_details: accountDetails,
                timestamp: new Date().toISOString(),
            }]);

            if (dbError) {
                logger.error('mobile_balance_order_insert_failed', { orderId, code: dbError.code });

                try {
                    await balanceService.refundBalance(
                        profile.id,
                        amount,
                        orderId,
                        'Refund otomatis karena gagal simpan order'
                    );
                } catch (refundErr) {
                    logger.error('mobile_balance_order_insert_refund_failed', {
                        orderId,
                        message: refundErr.message,
                    });
                }

                if (dbError.code === '23505' && idempotencyKey) {
                    const existing = await findExistingOrder(profile.id, idempotencyKey);
                    if (existing) {
                        return {
                            status: 200,
                            body: { success: true, idempotent: true, data: orderToResponse(existing) },
                        };
                    }
                }

                return fail(500, 'ORDER_INSERT_FAILED', 'Gagal menyimpan order');
            }

            const { data: latestOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            orderFulfillmentService.fulfillOrder(latestOrder).catch(err => {
                logger.error('mobile_balance_order_fulfillment_failed', { orderId, error: err });
            });

            return {
                status: 201,
                body: {
                    success: true,
                    data: {
                        order_id: orderId,
                        access_token: orderAccessToken,
                        amount,
                        status: 'PROCESSING',
                        pg_provider: 'balance',
                        payment_type: 'balance',
                    },
                },
            };
        }

        // 9. Gateway flow
        return await createGatewayOrder({
            orderId,
            orderAccessToken,
            amount,
            profile,
            resolvedCustomerName: validated.resolvedCustomerName,
            dbProduct,
            matchedVariant,
            actualVendor,
            variantIdForOrder,
            accountDetails,
            idempotencyKey,
            input: {
                ...input,
                provider_qty: targetInfo.providerQty,
            },
        });
    } catch (err) {
        logger.error('mobile_order_create_failed', { error: err });
        return fail(500, 'ORDER_CREATE_FAILED', 'Gagal membuat pembayaran');
    }
}

module.exports = {
    createPrepaidOrder,
    orderToResponse,
    findExistingOrder,
    __test: {
        extractTarget,
        computeAmount,
        buildNote,
        buildAccountDetails,
        validateAccount,
    },
};
