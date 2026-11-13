const supabase = require('../supabase');
const balanceService = require('./balanceService');
const vendorRegistry = require('./vendors/vendorRegistry');
const { logger } = require('../utils/logger');

const REFRESH_THROTTLE_MS = 30 * 1000;
const staleChecks = new Map();

// Do not keep a serverless process alive just for this cleanup.
const staleCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [orderId, timestamp] of staleChecks.entries()) {
        if (timestamp < cutoff) staleChecks.delete(orderId);
    }
}, 10 * 60 * 1000);
if (staleCleanupTimer.unref) staleCleanupTimer.unref();

function isFinalStatus(status) {
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(String(status || '').toUpperCase());
}

async function refundBalanceOrder(order, reason) {
    if (!order || order.payment_type !== 'balance' || !order.user_id) {
        return { refunded: false, reason: 'not_balance_order' };
    }

    try {
        await balanceService.refundBalance(
            order.user_id,
            order.price,
            order.id,
            reason || `Refund otomatis untuk order ${order.id}`
        );
        return { refunded: true };
    } catch (err) {
        logger.error('order_auto_refund_failed', {
            orderId: order.id,
            userId: order.user_id,
            message: err.message,
        });
        return { refunded: false, error: err.message };
    }
}

function shouldThrottle(orderId, force) {
    if (force) return false;

    const now = Date.now();
    const last = staleChecks.get(orderId) || 0;
    if (now - last < REFRESH_THROTTLE_MS) return true;

    staleChecks.set(orderId, now);
    return false;
}

/**
 * Batalkan refund otomatis ketika order ternyata sukses di vendor.
 *
 * Skenario: order sempat ditandai FAILED (mis. karena check status memakai
 * refID yang salah), saldo otomatis dikembalikan, lalu vendor mengirim
 * callback sukses. Tanpa pembatalan refund, pembeli mendapat produk gratis.
 *
 * Hanya order balance yang punya refund; order gateway tidak pernah di-debit
 * dari saldo.
 */
async function reverseAutoRefund(order) {
    if (!order || order.payment_type !== 'balance' || !order.user_id) {
        return { reversed: false, reason: 'not_balance_order' };
    }

    const { data: refunds, error } = await supabase
        .from('balance_transactions')
        .select('id, amount')
        .eq('user_id', order.user_id)
        .eq('reference_id', order.id)
        .eq('type', 'refund')
        .eq('status', 'completed')
        .limit(1);

    if (error) {
        return { reversed: false, error: error.message };
    }

    if (!refunds || !refunds.length) {
        return { reversed: false, reason: 'no_refund' };
    }

    const amount = order.price || refunds[0].amount;

    try {
        await balanceService.debitBalance(
            order.user_id,
            amount,
            order.id,
            `Penyesuaian saldo: transaksi vendor sukses untuk ${order.id}`
        );
        return { reversed: true, amount };
    } catch (err) {
        return { reversed: false, error: err.message };
    }
}

async function markCompleted(order, statusResult) {
    const sn = statusResult.sn || order.vendor_invoice || null;
    const wasFailed = ['FAILED', 'REFUND_PENDING'].includes(String(order.status || '').toUpperCase());

    // Kalau order sempat gagal dan saldonya sudah dikembalikan, kembalikan
    // lagi penyeimbangannya sebelum order ditandai COMPLETED.
    const refundState = wasFailed ? await reverseAutoRefund(order) : null;

    const accountDetails = {
        ...(order.account_details || {}),
        sn,
        serial_number: sn,
        licenses: sn ? [sn] : (order.account_details?.licenses || []),
        vendor_status_raw: statusResult.data?.raw || order.account_details?.vendor_status_raw || null,
        completed_at: new Date().toISOString(),
    };

    if (refundState) {
        accountDetails.refund_reversed = refundState.reversed === true;
        if (refundState.reversed) {
            accountDetails.refund_reversed_at = new Date().toISOString();
        } else if (refundState.error) {
            // Saldo tidak bisa dikembalikan (mis. sudah dipakai pembeli).
            // Tandai supaya bisa ditangani manual oleh admin.
            accountDetails.balance_reconcile_pending = refundState.error;
        }
    }

    const { error } = await supabase
        .from('orders')
        .update({
            status: 'COMPLETED',
            vendor_status: 'success',
            vendor_invoice: sn,
            error_message: null,
            account_details: accountDetails,
        })
        .eq('id', order.id);

    if (error) throw error;

    if (refundState?.reversed) {
        logger.info('order_refund_reversed_after_vendor_success', {
            orderId: order.id,
            amount: refundState.amount,
        });
    } else if (refundState?.error) {
        logger.warn('order_refund_reversal_failed', {
            orderId: order.id,
            message: refundState.error,
        });
    }

    logger.info('order_completed_via_status_refresh', { orderId: order.id });
    return { ...order, status: 'COMPLETED', account_details: accountDetails, vendor_invoice: sn };
}

async function markFailed(order, statusResult) {
    const message = statusResult.data?.raw || statusResult.message || 'Transaksi gagal di vendor';

    const { error } = await supabase
        .from('orders')
        .update({
            status: 'FAILED',
            vendor_status: 'failed',
            error_message: message,
        })
        .eq('id', order.id);

    if (error) throw error;

    const refund = await refundBalanceOrder(
        order,
        `Refund otomatis: transaksi vendor gagal untuk ${order.id}`
    );

    if (!refund.refunded && order.payment_type === 'balance' && order.user_id) {
        await supabase
            .from('orders')
            .update({
                status: 'REFUND_PENDING',
                error_message: `${message} | refund pending`,
            })
            .eq('id', order.id);

        logger.warn('order_failed_refund_pending', { orderId: order.id });
        return { ...order, status: 'REFUND_PENDING', error_message: message };
    }

    logger.warn('order_failed_via_status_refresh', {
        orderId: order.id,
        refunded: refund.refunded,
    });

    return { ...order, status: 'FAILED', error_message: message };
}

/**
 * Refresh one order from the vendor. Used by the mobile status screen and by
 * the reconciliation cron.
 *
 * Only balance orders are handled here. Gateway PENDING orders keep using the
 * existing payment gateway polling path.
 */
async function refreshIfStale(order, { force = false } = {}) {
    if (!order || isFinalStatus(order.status)) return order;
    if (order.payment_type !== 'balance') return order;

    const status = String(order.status || '').toUpperCase();

    // Only orders that have actually been sent to the vendor may be queried.
    // PENDING means createOrder() has not run yet; REFUND_PENDING/CANCELLED
    // must never be sent to the vendor.
    if (!['PROCESSING', 'PROCESSING_LOCK'].includes(status)) return order;

    // A PROCESSING_LOCK younger than 10 minutes may still be inside
    // createOrder(). Do not query the vendor while that request is in flight.
    if (status === 'PROCESSING_LOCK') {
        const ageMs = Date.now() - new Date(order.timestamp || 0).getTime();
        if (Number.isFinite(ageMs) && ageMs < 10 * 60 * 1000) return order;
    }

    if (shouldThrottle(order.id, force)) return order;

    const vendorName = order.vendor || order.account_details?.vendor;
    if (!vendorName) return order;

    let adapter;
    try {
        adapter = vendorRegistry.get(vendorName);
    } catch {
        return order;
    }

    if (!adapter || typeof adapter.checkOrderStatus !== 'function') return order;

    try {
        const target = order.account_details?.target ||
            order.account_details?.customer_number ||
            order.account_details?.note;

        const statusResult = await adapter.checkOrderStatus(
            order.vendor_order_id || order.id,
            {
                product: order.vendor_variant_id,
                dest: target,
                // Order lama bisa menyimpan ID transaksi vendor (bukan refID),
                // jadi adapter boleh mencoba lagi dengan id order kita.
                fallbackRefId: order.id,
            }
        );

        if (!statusResult.success) {
            logger.warn('order_status_refresh_failed', {
                orderId: order.id,
                message: statusResult.message,
            });
            return order;
        }

        if (statusResult.status === 'success') {
            return await markCompleted(order, statusResult);
        }

        if (statusResult.status === 'failed') {
            return await markFailed(order, statusResult);
        }

        return order;
    } catch (err) {
        logger.warn('order_status_refresh_exception', { orderId: order.id, message: err.message });
        return order;
    }
}

/**
 * Reconciliation sweep for orders that were claimed by fulfillment but never
 * received a callback. This is the safety net for the app's polling UX.
 */
async function reconcileProcessingOrders() {
    const olderThan = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['PROCESSING', 'PROCESSING_LOCK'])
        .lt('timestamp', olderThan)
        .order('timestamp', { ascending: true })
        .limit(50);

    if (error) {
        logger.error('order_reconciliation_query_failed', { code: error.code });
        return { success: false, checked: 0 };
    }

    let checked = 0;
    for (const order of orders || []) {
        checked++;
        await refreshIfStale(order, { force: true });
    }

    if (checked > 0) {
        logger.info('order_reconciliation_completed', { checked });
    }

    return { success: true, checked };
}

module.exports = {
    refreshIfStale,
    reconcileProcessingOrders,
    refundBalanceOrder,
    markCompleted,
    reverseAutoRefund,
    isFinalStatus,
    __test: {
        shouldThrottle,
        REFRESH_THROTTLE_MS,
    },
};
