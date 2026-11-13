const supabase = require('../supabase');
const vendorRegistry = require('./vendors/vendorRegistry');
const orderFulfillmentService = require('./orderFulfillmentService');
const { isAvailableForChannel } = require('../utils/channel');
const { generateOrderId, generateOrderAccessToken } = require('../utils/orderIds');
const { logger } = require('../utils/logger');

const QUOTE_TTL_MINUTES = 10;
const QUOTE_REUSE_SECONDS = 60;

function fail(status, code, error) {
    return { status, body: { success: false, code, error } };
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

async function getShopStatus() {
    const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'shop_status')
        .maybeSingle();

    if (error || !data) return { isOpen: true, message: null };
    return {
        isOpen: data.value?.isOpen !== false,
        message: data.value?.message || 'Toko sedang tutup. Silakan coba lagi nanti.',
    };
}

async function findProductWithVariant(productId, variantId) {
    const { data: product, error } = await supabase
        .from('products')
        .select('*, product_variants(*)')
        .eq('id', productId)
        .maybeSingle();

    if (error) throw error;
    if (!product) return { error: 'PRODUCT_NOT_FOUND' };

    const variants = product.product_variants || [];
    const variant = variants.find(v =>
        String(v.vendor_variant_id) === String(variantId) ||
        String(v.id) === String(variantId)
    );

    if (!variant) return { error: 'VARIANT_NOT_FOUND' };

    return { product, variant };
}

function serializeQuote(inquiry, product, variant) {
    return {
        inquiry_id: inquiry.id,
        expires_at: inquiry.expires_at,
        product: {
            id: product.id,
            name: product.name,
            category: product.category,
            product_type: product.product_type,
        },
        variant: {
            // Public id for bill variants is the internal row id; vendor
            // payment codes stay server-side.
            id: String(variant.id),
            db_id: variant.id,
            name: variant.name,
        },
        customer: {
            number: inquiry.customer_number,
            name: inquiry.customer_name || null,
        },
        bill: {
            period: inquiry.bill_period || null,
            amount: inquiry.bill_amount,
            admin_fee: inquiry.admin_fee,
            total: inquiry.total_amount,
        },
        payment_methods: ['balance'],
    };
}

/**
 * POST /api/mobile/bills/inquiry
 */
async function inquire({ user, productId, variantId, customerNumber }) {
    try {
        const shop = await getShopStatus();
        if (!shop.isOpen) {
            return fail(403, 'SHOP_CLOSED', shop.message);
        }

        const profile = await getProfile(user.id);
        if (!profile || profile.is_active === false) {
            return fail(403, 'ACCOUNT_INACTIVE', 'Akun tidak ditemukan atau tidak aktif.');
        }

        if (!productId || !variantId) {
            return fail(400, 'PRODUCT_AND_VARIANT_REQUIRED', 'product_id dan variant_id wajib diisi.');
        }

        const customer = String(customerNumber || '').trim();
        if (!customer) {
            return fail(400, 'CUSTOMER_NUMBER_REQUIRED', 'Nomor pelanggan / ID meter wajib diisi.');
        }

        const resolved = await findProductWithVariant(productId, variantId);
        if (resolved.error === 'PRODUCT_NOT_FOUND') {
            return fail(404, 'PRODUCT_NOT_FOUND', 'Produk tagihan tidak ditemukan.');
        }
        if (resolved.error === 'VARIANT_NOT_FOUND') {
            return fail(404, 'VARIANT_NOT_FOUND', 'Varian tagihan tidak ditemukan.');
        }

        const { product, variant } = resolved;

        if (product.is_active === false || !isAvailableForChannel(product, 'app')) {
            return fail(404, 'PRODUCT_NOT_AVAILABLE', 'Produk tagihan tidak tersedia di aplikasi.');
        }
        if (product.product_type !== 'postpaid') {
            return fail(400, 'NOT_POSTPAID', 'Produk ini bukan produk tagihan.');
        }
        if (variant.is_active === false || variant.is_hidden === true) {
            return fail(400, 'VARIANT_INACTIVE', 'Varian tagihan sedang tidak aktif.');
        }

        const meta = variant.provider_meta || {};
        if (!meta.postpaid || !meta.inquiry_code || !meta.payment_code) {
            return fail(422, 'BILL_NOT_CONFIGURED', 'Konfigurasi tagihan belum lengkap.');
        }

        const vendor = product.vendor || 'okeconnect';
        const adapter = vendorRegistry.get(vendor);
        if (!adapter || typeof adapter.inquireBill !== 'function') {
            return fail(501, 'BILL_VENDOR_UNSUPPORTED', 'Vendor tagihan belum mendukung inquiry.');
        }

        // Reuse a very recent quote to avoid hammering the vendor when the app
        // re-renders the confirmation screen.
        const reuseAfter = new Date(Date.now() - QUOTE_REUSE_SECONDS * 1000).toISOString();
        const { data: recent } = await supabase
            .from('bill_inquiries')
            .select('*')
            .eq('user_id', user.id)
            .eq('variant_id', variant.id)
            .eq('customer_number', customer)
            .eq('status', 'open')
            .gt('expires_at', new Date().toISOString())
            .gte('created_at', reuseAfter)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (recent) {
            return {
                status: 200,
                body: {
                    success: true,
                    data: serializeQuote(recent, product, variant),
                    reused: true,
                },
            };
        }

        const inquiry = await adapter.inquireBill({
            inquiryCode: meta.inquiry_code,
            customerId: customer,
            productName: product.name,
        });

        if (!inquiry.success || !inquiry.data) {
            logger.warn('bill_inquiry_vendor_failed', {
                userId: user.id,
                productId: product.id,
                message: inquiry.message,
            });
            return fail(
                422,
                'BILL_INQUIRY_FAILED',
                inquiry.message || 'Tagihan tidak ditemukan. Periksa kembali nomor pelanggan.'
            );
        }

        const baseBillAmount = Math.max(0, parseInt(inquiry.data.bill_amount, 10) || 0);
        const vendorBillTotal = Math.max(
            0,
            parseInt(inquiry.data.total_amount, 10) || baseBillAmount
        );

        if (vendorBillTotal <= 0) {
            return fail(422, 'BILL_AMOUNT_INVALID', 'Nominal tagihan tidak valid.');
        }

        const adminFee = Math.max(0, parseInt(variant.sell_price || variant.markup || 0, 10) || 0);
        // The vendor's total already includes any biller admin fee shown in
        // the inquiry response. Add only our own service fee on top.
        const totalAmount = vendorBillTotal + adminFee;

        // Make sure the vendor balance can cover the bill before letting the
        // user proceed. OkeConnect's getBalance is cached for 60s; force a
        // fresh read for larger bills.
        const commission = Math.max(0, parseInt(meta.commission || 0, 10) || 0);
        const vendorFee = Math.max(0, parseInt(meta.vendor_fee || 0, 10) || 0);
        const vendorCost = Math.max(0, vendorBillTotal - commission + vendorFee);

        if (typeof adapter.getBalance === 'function') {
            const balanceRes = await adapter.getBalance({ force: vendorCost >= 100000 });
            if (balanceRes.success && typeof balanceRes.balance === 'number' && balanceRes.balance < vendorCost) {
                logger.warn('bill_vendor_balance_low', {
                    vendor,
                    balance: balanceRes.balance,
                    required: vendorCost,
                });
                return fail(
                    503,
                    'VENDOR_BALANCE_LOW',
                    'Saldo server tagihan sedang diisi. Silakan coba beberapa saat lagi.'
                );
            }
        }

        // One open quote per (user, variant, customer number). Only retire a
        // quote older than the reuse window; a concurrent request's fresh
        // quote must not be cancelled. The unique partial index makes the
        // insert below the final arbiter.
        await supabase
            .from('bill_inquiries')
            .update({ status: 'cancelled' })
            .eq('user_id', user.id)
            .eq('variant_id', variant.id)
            .eq('customer_number', customer)
            .eq('status', 'open')
            .lt('created_at', reuseAfter);

        const { data: inserted, error: insertError } = await supabase
            .from('bill_inquiries')
            .insert({
                user_id: user.id,
                product_id: product.id,
                variant_id: variant.id,
                customer_number: customer,
                customer_name: inquiry.data.customer_name || null,
                bill_period: inquiry.data.bill_period || null,
                bill_amount: vendorBillTotal,
                admin_fee: adminFee,
                total_amount: totalAmount,
                vendor,
                inquiry_code: meta.inquiry_code,
                payment_code: meta.payment_code,
                vendor_ref: inquiry.data.vendor_ref || inquiry.data.inquiry_ref || null,
                raw_response: {
                    vendor_ref: inquiry.data.vendor_ref || null,
                    inquiry_ref: inquiry.data.inquiry_ref || null,
                    raw: inquiry.data.raw || null,
                },
                status: 'open',
                expires_at: new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString(),
            })
            .select('*')
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                const { data: existing } = await supabase
                    .from('bill_inquiries')
                    .select('*')
                    .eq('user_id', user.id)
                    .eq('variant_id', variant.id)
                    .eq('customer_number', customer)
                    .eq('status', 'open')
                    .gt('expires_at', new Date().toISOString())
                    .maybeSingle();

                if (existing) {
                    return {
                        status: 200,
                        body: {
                            success: true,
                            data: serializeQuote(existing, product, variant),
                            reused: true,
                        },
                    };
                }
            }

            logger.error('bill_inquiry_insert_failed', { userId: user.id, code: insertError.code });
            return fail(500, 'BILL_INQUIRY_SAVE_FAILED', 'Gagal menyimpan hasil cek tagihan.');
        }

        logger.info('bill_inquiry_created', {
            userId: user.id,
            productId: product.id,
            billAmount: vendorBillTotal,
            adminFee,
        });

        return {
            status: 201,
            body: {
                success: true,
                data: serializeQuote(inserted, product, variant),
            },
        };
    } catch (err) {
        logger.error('bill_inquiry_failed', { userId: user?.id, error: err });
        return fail(500, 'BILL_INQUIRY_FAILED', 'Gagal mengecek tagihan.');
    }
}

function mapRpcError(errorCode, message) {
    switch (errorCode) {
        case 'BILL_INQUIRY_NOT_FOUND':
            return fail(404, errorCode, message || 'Tagihan tidak ditemukan.');
        case 'BILL_INQUIRY_ALREADY_USED':
            return fail(409, errorCode, message || 'Tagihan ini sudah diproses.');
        case 'BILL_INQUIRY_EXPIRED':
            return fail(400, errorCode, message || 'Tagihan sudah kedaluwarsa. Silakan cek ulang.');
        case 'BILL_AMOUNT_MISMATCH':
            return fail(409, errorCode, message || 'Nominal tagihan berubah. Silakan cek ulang.');
        case 'INSUFFICIENT_BALANCE':
            return fail(400, errorCode, message || 'Saldo tidak mencukupi.');
        case 'USER_NOT_FOUND':
            return fail(403, errorCode, message || 'Akun tidak ditemukan atau tidak aktif.');
        default:
            return fail(400, errorCode || 'BILL_ORDER_FAILED', message || 'Gagal membuat order tagihan.');
    }
}

/**
 * POST /api/mobile/orders with type=bill
 */
async function createOrder({ user, inquiryId, idempotencyKey }) {
    try {
        const shop = await getShopStatus();
        if (!shop.isOpen) {
            return fail(403, 'SHOP_CLOSED', shop.message);
        }

        if (!inquiryId) {
            return fail(400, 'INQUIRY_ID_REQUIRED', 'inquiry_id wajib diisi.');
        }

        const { data: inquiry, error: inquiryError } = await supabase
            .from('bill_inquiries')
            .select('*')
            .eq('id', inquiryId)
            .eq('user_id', user.id)
            .maybeSingle();

        if (inquiryError) throw inquiryError;
        if (!inquiry) {
            return fail(404, 'BILL_INQUIRY_NOT_FOUND', 'Tagihan tidak ditemukan.');
        }
        if (inquiry.status !== 'open') {
            return fail(409, 'BILL_INQUIRY_ALREADY_USED', 'Tagihan ini sudah diproses.');
        }
        if (new Date(inquiry.expires_at).getTime() <= Date.now()) {
            await supabase
                .from('bill_inquiries')
                .update({ status: 'expired' })
                .eq('id', inquiry.id)
                .eq('status', 'open');
            return fail(400, 'BILL_INQUIRY_EXPIRED', 'Tagihan sudah kedaluwarsa. Silakan cek ulang.');
        }

        const resolved = await findProductWithVariant(inquiry.product_id, inquiry.variant_id);
        if (resolved.error) {
            return fail(404, 'PRODUCT_NOT_FOUND', 'Produk tagihan tidak ditemukan.');
        }

        const { product, variant } = resolved;
        if (product.is_active === false || !isAvailableForChannel(product, 'app')) {
            return fail(404, 'PRODUCT_NOT_AVAILABLE', 'Produk tagihan tidak tersedia di aplikasi.');
        }
        if (product.product_type !== 'postpaid') {
            return fail(400, 'NOT_POSTPAID', 'Produk ini bukan produk tagihan.');
        }
        if (variant.is_active === false || variant.is_hidden === true) {
            return fail(400, 'VARIANT_INACTIVE', 'Varian tagihan sedang tidak aktif.');
        }

        const profile = await getProfile(user.id);
        if (!profile || profile.is_active === false) {
            return fail(403, 'ACCOUNT_INACTIVE', 'Akun tidak ditemukan atau tidak aktif.');
        }
        if (!profile.email || !profile.phone) {
            return fail(400, 'PROFILE_INCOMPLETE', 'Lengkapi email dan nomor telepon di profil terlebih dahulu.');
        }

        // Re-check the vendor balance immediately before debiting the user.
        // The quote could be a few minutes old.
        const vendorAdapter = vendorRegistry.get(inquiry.vendor);
        if (vendorAdapter && typeof vendorAdapter.getBalance === 'function') {
            const meta = variant.provider_meta || {};
            const commission = Math.max(0, parseInt(meta.commission || 0, 10) || 0);
            const vendorFee = Math.max(0, parseInt(meta.vendor_fee || 0, 10) || 0);
            const vendorCost = Math.max(0, inquiry.bill_amount - commission + vendorFee);

            const balanceRes = await vendorAdapter.getBalance({ force: vendorCost >= 100000 });
            if (balanceRes.success && typeof balanceRes.balance === 'number' && balanceRes.balance < vendorCost) {
                logger.warn('bill_order_vendor_balance_low', {
                    orderInquiryId: inquiry.id,
                    balance: balanceRes.balance,
                    required: vendorCost,
                });
                return fail(
                    503,
                    'VENDOR_BALANCE_LOW',
                    'Saldo server tagihan sedang diisi. Silakan coba beberapa saat lagi.'
                );
            }
        }

        const orderId = generateOrderId();
        const accessToken = generateOrderAccessToken();

        const accountDetails = {
            type: 'postpaid',
            postpaid: true,
            vendor: inquiry.vendor,
            target: inquiry.customer_number,
            customer_number: inquiry.customer_number,
            note: inquiry.customer_number,
            customer_name: inquiry.customer_name || profile.display_name,
            bill_period: inquiry.bill_period,
            bill_amount: inquiry.bill_amount,
            admin_fee: inquiry.admin_fee,
            total_amount: inquiry.total_amount,
            inquiry_id: inquiry.id,
            inquiry_code: inquiry.inquiry_code,
            payment_code: inquiry.payment_code,
            vendor_ref: inquiry.vendor_ref,
            use_inquiry_ref: process.env.OKECONNECT_BILL_USE_INQUIRY_REF === 'true',
        };

        const orderPayload = {
            id: orderId,
            product: product.name,
            variant: variant.name || '-',
            price: inquiry.total_amount,
            wa_number: profile.phone,
            email: profile.email,
            customer_name: inquiry.customer_name || profile.display_name || profile.phone,
            order_access_token: accessToken,
            vendor: inquiry.vendor,
            vendor_variant_id: inquiry.payment_code,
            account_details: accountDetails,
            timestamp: new Date().toISOString(),
            channel: 'android',
            description: `Pembayaran ${product.name}`,
        };

        const { data: rpcResult, error: rpcError } = await supabase.rpc('create_bill_order', {
            p_user_id: user.id,
            p_inquiry_id: inquiry.id,
            p_order: orderPayload,
            p_idempotency_key: idempotencyKey || null,
        });

        if (rpcError) {
            logger.error('bill_order_rpc_failed', { userId: user.id, code: rpcError.code, message: rpcError.message });
            return fail(500, 'BILL_ORDER_FAILED', 'Gagal membuat order tagihan.');
        }

        if (!rpcResult?.success) {
            return mapRpcError(rpcResult?.error, rpcResult?.message);
        }

        const { data: order } = await supabase
            .from('orders')
            .select('*')
            .eq('id', rpcResult.order_id)
            .single();

        if (!order) {
            return fail(500, 'BILL_ORDER_NOT_FOUND', 'Order tagihan tidak ditemukan setelah dibuat.');
        }

        if (rpcResult.idempotent) {
            return {
                status: 200,
                body: {
                    success: true,
                    idempotent: true,
                    data: {
                        order_id: order.id,
                        access_token: order.order_access_token,
                        amount: order.price,
                        status: order.status,
                        payment_type: order.payment_type,
                        pg_provider: order.pg_provider,
                    },
                },
            };
        }

        orderFulfillmentService.fulfillOrder(order).catch(err => {
            logger.error('bill_order_fulfillment_failed', { orderId: order.id, error: err });
        });

        logger.info('bill_order_created', {
            orderId: order.id,
            userId: user.id,
            productId: product.id,
            total: inquiry.total_amount,
        });

        return {
            status: 201,
            body: {
                success: true,
                data: {
                    order_id: order.id,
                    access_token: order.order_access_token,
                    amount: order.price,
                    status: 'PROCESSING',
                    payment_type: 'balance',
                    pg_provider: 'balance',
                },
            },
        };
    } catch (err) {
        logger.error('bill_order_create_failed', { userId: user?.id, error: err });
        return fail(500, 'BILL_ORDER_FAILED', 'Gagal membuat order tagihan.');
    }
}

/**
 * Mark expired quotes. Called by cron.
 */
async function expireStale() {
    const { error, count } = await supabase
        .from('bill_inquiries')
        .update({ status: 'expired' })
        .eq('status', 'open')
        .lt('expires_at', new Date().toISOString());

    if (error) {
        logger.error('bill_inquiry_expiry_failed', { code: error.code });
        return { success: false };
    }

    return { success: true, count: count || 0 };
}

module.exports = {
    inquire,
    createOrder,
    expireStale,
    __test: {
        serializeQuote,
        mapRpcError,
        QUOTE_TTL_MINUTES,
    },
};
