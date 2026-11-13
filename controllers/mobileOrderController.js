const supabase = require('../supabase');
const mobileOrderService = require('../services/mobileOrderService');
const billService = require('../services/billService');
const orderStatusService = require('../services/orderStatusService');
const paymentGatewayService = require('../services/paymentGatewayService');
const balanceService = require('../services/balanceService');
const { logger } = require('../utils/logger');
const { sanitizeAccountDetails } = require('../utils/orderPresenter');

function toSafeOrder(order) {
    if (!order) return null;

    return {
        id: order.id,
        product: order.product,
        variant: order.variant,
        price: order.price,
        status: order.status,
        payment_method: order.payment_method,
        payment_type: order.payment_type,
        pg_provider: order.pg_provider,
        pg_invoice: order.pg_invoice,
        pg_paid_at: order.pg_paid_at,
        pg_expired_at: order.pg_expired_at,
        error_message: order.error_message,
        account_details: sanitizeAccountDetails(order.account_details),
        timestamp: order.timestamp,
        channel: order.channel,
        order_type: order.order_type,
    };
}

async function create(req, res) {
    try {
        const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key || null;
        const type = String(req.body?.type || 'prepaid').toLowerCase();

        const result = type === 'bill'
            ? await billService.createOrder({
                user: req.user,
                inquiryId: req.body?.inquiry_id,
                idempotencyKey,
            })
            : await mobileOrderService.createPrepaidOrder({
                user: req.user,
                input: req.body || {},
                idempotencyKey,
            });

        return res.status(result.status).json(result.body);
    } catch (err) {
        logger.error('mobile_order_create_controller_failed', { userId: req.user?.id, error: err });
        return res.status(500).json({
            success: false,
            code: 'ORDER_CREATE_FAILED',
            error: 'Gagal membuat order.',
        });
    }
}

async function list(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;
        const status = String(req.query.status || '').trim().toUpperCase();

        let query = supabase
            .from('orders')
            .select(
                'id, product, variant, price, status, payment_method, payment_type, pg_provider, ' +
                'pg_paid_at, pg_expired_at, error_message, account_details, timestamp, channel, order_type',
                { count: 'exact' }
            )
            .eq('user_id', req.user.id);

        if (status && status !== 'ALL') {
            query = query.eq('status', status);
        }

        const { data, error, count } = await query
            .order('timestamp', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: (data || []).map(toSafeOrder),
            meta: {
                total: count || 0,
                page,
                limit,
                total_pages: Math.ceil((count || 0) / limit) || 1,
            },
        });
    } catch (err) {
        logger.error('mobile_orders_list_failed', { userId: req.user?.id, error: err });
        res.status(500).json({ success: false, code: 'ORDERS_LIST_FAILED', error: 'Gagal memuat riwayat pesanan.' });
    }
}

async function getById(req, res) {
    try {
        const { id } = req.params;

        let { data: order, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error) throw error;
        if (!order) {
            return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'Pesanan tidak ditemukan.' });
        }

        if (!orderStatusService.isFinalStatus(order.status) && order.payment_type === 'balance') {
            const refreshed = await orderStatusService.refreshIfStale(order, {
                force: req.query.force === 'true',
            });
            if (refreshed) order = { ...order, ...refreshed };
        }

        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: toSafeOrder(order) });
    } catch (err) {
        logger.error('mobile_order_detail_failed', { userId: req.user?.id, orderId: req.params.id, error: err });
        res.status(500).json({ success: false, code: 'ORDER_DETAIL_FAILED', error: 'Gagal memuat pesanan.' });
    }
}

async function cancel(req, res) {
    try {
        const { id } = req.params;

        const { data: order, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error) throw error;
        if (!order) {
            return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'Pesanan tidak ditemukan.' });
        }
        if (order.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                code: 'ORDER_NOT_CANCELLABLE',
                error: `Pesanan tidak bisa dibatalkan (status: ${order.status}).`,
            });
        }

        if (order.payment_type === 'balance') {
            // Claim before refunding so fulfillment cannot claim the order in
            // the gap between the refund and the status update.
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
                return res.status(409).json({
                    success: false,
                    code: 'ORDER_NOT_CANCELLABLE',
                    error: 'Pesanan sudah diproses dan tidak bisa dibatalkan.',
                });
            }

            try {
                await balanceService.refundBalance(
                    order.user_id,
                    order.price,
                    order.id,
                    'Refund otomatis: pesanan dibatalkan oleh pengguna'
                );
            } catch (refundErr) {
                logger.error('mobile_order_cancel_refund_failed', {
                    orderId: order.id,
                    message: refundErr.message,
                });
                return res.status(500).json({
                    success: false,
                    code: 'REFUND_FAILED',
                    error: 'Refund gagal diproses. Silakan hubungi CS.',
                });
            }

            await supabase
                .from('orders')
                .update({ status: 'CANCELLED' })
                .eq('id', order.id)
                .eq('status', 'REFUND_PENDING');

            return res.json({ success: true, message: 'Pesanan berhasil dibatalkan dan saldo dikembalikan.' });
        }

        if (order.pg_provider !== 'sekalipay' && order.pg_provider !== 'dyqris') {
            try {
                await paymentGatewayService.cancelInvoice(order.pg_invoice || order.id);
            } catch (cancelErr) {
                logger.warn('mobile_order_cancel_gateway_failed', {
                    orderId: order.id,
                    message: cancelErr.message,
                });
            }
        }

        await supabase
            .from('orders')
            .update({ status: 'CANCELLED', error_message: 'Dibatalkan oleh pengguna' })
            .eq('id', order.id)
            .eq('status', 'PENDING');

        res.json({ success: true, message: 'Pesanan berhasil dibatalkan.' });
    } catch (err) {
        logger.error('mobile_order_cancel_failed', { userId: req.user?.id, orderId: req.params.id, error: err });
        res.status(500).json({ success: false, code: 'ORDER_CANCEL_FAILED', error: 'Gagal membatalkan pesanan.' });
    }
}

module.exports = {
    create,
    list,
    getById,
    cancel,
    toSafeOrder,
};
