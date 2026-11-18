const supabase = require('../supabase');
const balanceService = require('./balanceService');
const pushService = require('./pushService');
const vendorRegistry = require('./vendors/vendorRegistry');
const { logger } = require('../utils/logger');
const { isRefundEligible, refundOrder } = require('../utils/refundPolicy');

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
    if (!isRefundEligible(order)) {
        return { refunded: false, reason: 'not_eligible' };
    }

    return refundOrder(order, reason);
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
 * Berlaku untuk order saldo maupun QRIS: keduanya sama-sama dikreditkan ke
 * saldo akun, jadi pembatalannya juga memakai jalur yang sama. Nominal selalu
 * diambil dari ledger refund, bukan dari `order.price`, karena refund QRIS
 * memakai `pg_total` (nominal yang benar-benar dibayar).
 */
async function reverseAutoRefund(order) {
    if (!order || !order.user_id) {
        return { reversed: false, reason: 'no_user' };
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

    const amount = Math.floor(Number(refunds[0].amount)) || Math.floor(Number(order.price)) || 0;
    if (amount <= 0) {
        return { reversed: false, reason: 'invalid_amount' };
    }

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

/**
 * Setelah refund dikreditkan, pastikan order tidak keburu ditandai COMPLETED
 * oleh callback sukses vendor yang datang bersamaan. Kalau sudah COMPLETED,
 * tarik kembali saldo yang barusan dikembalikan supaya pembeli tidak mendapat
 * produk gratis.
 *
 * @returns {Promise<{completed: boolean, reversal?: object}>}
 */
async function reverseRefundIfCompleted(order) {
    if (!order?.id || !order?.user_id) return { completed: false };

    const { data: latest, error } = await supabase
        .from('orders')
        .select('status, account_details')
        .eq('id', order.id)
        .maybeSingle();

    if (error || !latest) return { completed: false };
    if (String(latest.status || '').toUpperCase() !== 'COMPLETED') {
        return { completed: false };
    }

    const reversal = await reverseAutoRefund({
        ...order,
        account_details: latest.account_details || order.account_details,
    });

    const accountDetails = {
        ...(latest.account_details || order.account_details || {}),
        refund_reversed: reversal.reversed === true,
    };
    if (reversal.reversed) {
        accountDetails.refund_reversed_at = new Date().toISOString();
    } else if (reversal.error) {
        accountDetails.balance_reconcile_pending = reversal.error;
    }

    await supabase
        .from('orders')
        .update({ account_details: accountDetails })
        .eq('id', order.id);

    return { completed: true, reversal };
}

/**
 * Tentukan status akhir setelah order dinyatakan gagal di vendor.
 *
 * - guest / order tanpa saldo tujuan -> FAILED (tidak ada yang direfund)
 * - refund sukses                    -> REFUNDED
 * - refund gagal                     -> REFUND_PENDING (cron mencoba ulang)
 *
 * Pemanggil sudah menulis status FAILED lebih dulu. `message` adalah pesan
 * kegagalan asli yang disimpan ke error_message.
 */
async function settleFailedOrder(order, message, reason) {
    if (!isRefundEligible(order)) {
        return { status: 'FAILED' };
    }

    // Jangan pernah merefund order yang ternyata sudah sukses (callback
    // vendor bisa datang bersamaan dengan cron rekonsiliasi).
    const { data: current } = await supabase
        .from('orders')
        .select('status')
        .eq('id', order.id)
        .maybeSingle();

    if (String(current?.status || '').toUpperCase() === 'COMPLETED') {
        logger.warn('order_refund_skipped_already_completed', { orderId: order.id });
        return { status: 'COMPLETED' };
    }

    const refund = await refundBalanceOrder(order, reason);

    if (!refund.refunded) {
        await supabase
            .from('orders')
            .update({
                status: 'REFUND_PENDING',
                error_message: `${message} | refund pending`,
            })
            .eq('id', order.id)
            .neq('status', 'COMPLETED');

        logger.warn('order_failed_refund_pending', {
            orderId: order.id,
            error: refund.error || refund.reason,
        });

        return { status: 'REFUND_PENDING', refund };
    }

    const race = await reverseRefundIfCompleted(order);
    if (race.completed) {
        logger.warn('order_refund_reversed_after_late_success', {
            orderId: order.id,
            reversed: race.reversal?.reversed === true,
        });
        return { status: 'COMPLETED', refund, reversal: race.reversal };
    }

    const { error: refundedError } = await supabase
        .from('orders')
        .update({
            status: 'REFUNDED',
            error_message: message,
        })
        .eq('id', order.id)
        .neq('status', 'COMPLETED');

    if (refundedError) {
        // Saldo sudah dikreditkan; jangan tinggalkan order FAILED tanpa jalur
        // retry. Cron akan melihat baris refund yang sudah ada dan langsung
        // menyelesaikan statusnya.
        logger.error('order_refund_status_update_failed', {
            orderId: order.id,
            code: refundedError.code,
            message: refundedError.message,
        });

        await supabase
            .from('orders')
            .update({ status: 'REFUND_PENDING' })
            .eq('id', order.id)
            .neq('status', 'COMPLETED');

        return { status: 'REFUND_PENDING', refund };
    }

    logger.info('order_refunded_after_vendor_failure', {
        orderId: order.id,
        amount: refund.amount,
        paymentType: order.payment_type,
    });

    return { status: 'REFUNDED', refund };
}

async function markCompleted(order, statusResult) {
    const sn = statusResult.sn || order.vendor_invoice || null;
    const wasFailed = ['FAILED', 'REFUND_PENDING', 'REFUNDED'].includes(String(order.status || '').toUpperCase());

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

    // Push notification ke aplikasi. Tidak boleh menggagalkan alur order —
    // pushService menelan error sendiri dan dibatasi waktunya.
    await pushService.notifyOrderCompleted({
        ...order,
        status: 'COMPLETED',
        account_details: accountDetails,
        vendor_invoice: sn,
    });

    return { ...order, status: 'COMPLETED', account_details: accountDetails, vendor_invoice: sn };
}

async function markFailed(order, statusResult) {
    const message = statusResult.data?.raw || statusResult.message || 'Transaksi gagal di vendor';

    const { data: failedRows, error } = await supabase
        .from('orders')
        .update({
            status: 'FAILED',
            vendor_status: 'failed',
            error_message: message,
        })
        .eq('id', order.id)
        .in('status', ['PROCESSING', 'PROCESSING_LOCK', 'FAILED', 'REFUND_PENDING'])
        .select('id');

    if (error) throw error;

    if (!failedRows || failedRows.length === 0) {
        // Order sudah difinalkan jalur lain (mis. callback sukses vendor).
        const { data: latest } = await supabase
            .from('orders')
            .select('*')
            .eq('id', order.id)
            .maybeSingle();

        logger.warn('order_failed_transition_skipped', {
            orderId: order.id,
            status: latest?.status || order.status,
        });

        return latest || order;
    }

    const settled = await settleFailedOrder(
        order,
        message,
        `Refund otomatis: transaksi vendor gagal untuk ${order.id}`
    );

    if (settled.status === 'COMPLETED') {
        return { ...order, status: 'COMPLETED' };
    }

    if (settled.status === 'REFUNDED' || settled.status === 'REFUND_PENDING') {
        await pushService.notifyOrderFailed({
            ...order,
            status: settled.status,
            error_message: message,
        });

        return { ...order, status: settled.status, error_message: message };
    }

    logger.warn('order_failed_via_status_refresh', {
        orderId: order.id,
        refunded: false,
    });

    await pushService.notifyOrderFailed({ ...order, status: 'FAILED', error_message: message });

    return { ...order, status: 'FAILED', error_message: message };
}

/**
 * Refresh one order from the vendor. Used by the mobile status screen and by
 * the reconciliation cron.
 *
 * Handles balance orders and paid gateway orders that already reached the
 * vendor (PROCESSING / PROCESSING_LOCK). Unpaid gateway orders stay on the
 * payment gateway polling path.
 */
async function refreshIfStale(order, { force = false } = {}) {
    if (!order || isFinalStatus(order.status)) return order;

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
    settleFailedOrder,
    markCompleted,
    markFailed,
    reverseAutoRefund,
    reverseRefundIfCompleted,
    isFinalStatus,
    __test: {
        shouldThrottle,
        REFRESH_THROTTLE_MS,
    },
};
