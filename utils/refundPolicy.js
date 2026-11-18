const balanceService = require('../services/balanceService');
const { logger } = require('./logger');

/**
 * Kebijakan refund otomatis ke saldo akun.
 *
 * Hanya order milik pengguna yang login (`user_id`) yang boleh direfund.
 * Guest checkout tidak punya saldo tujuan, jadi order-nya tetap FAILED.
 *
 * Nominal:
 * - order saldo   : `price` (saldo yang dipotong saat order dibuat)
 * - order gateway : `pg_total` (nominal yang benar-benar dibayar pembeli,
 *   termasuk fee gateway dan kode unik), fallback `price` untuk order lama
 *   yang belum punya pg_total.
 */

function paymentTypeOf(order) {
    return String(order?.payment_type || '').toLowerCase();
}

function isRefundEligible(order) {
    if (!order || !order.user_id) return false;
    const type = paymentTypeOf(order);
    return type === 'balance' || type === 'gateway';
}

function refundAmount(order) {
    if (!order) return 0;

    const price = Math.floor(Number(order.price) || 0);
    if (paymentTypeOf(order) === 'balance') return price;

    const pgTotal = Math.floor(Number(order.pg_total) || 0);
    return pgTotal > 0 ? pgTotal : price;
}

/**
 * Kredit saldo untuk order yang gagal. Tidak pernah throw: kegagalan refund
 * dikembalikan sebagai `{ refunded: false, error }` supaya pemanggil bisa
 * menandai order REFUND_PENDING dan membiarkan cron mencoba ulang.
 */
async function refundOrder(order, reason) {
    if (!isRefundEligible(order)) {
        return { refunded: false, reason: 'not_eligible' };
    }

    const amount = refundAmount(order);
    if (amount <= 0) {
        return { refunded: false, reason: 'invalid_amount' };
    }

    try {
        await balanceService.refundBalance(
            order.user_id,
            amount,
            order.id,
            reason || `Refund otomatis untuk order ${order.id}`
        );
        return { refunded: true, amount };
    } catch (err) {
        logger.error('order_auto_refund_failed', {
            orderId: order.id,
            userId: order.user_id,
            paymentType: order.payment_type,
            amount,
            message: err.message,
        });
        return { refunded: false, amount, error: err.message };
    }
}

module.exports = {
    isRefundEligible,
    refundAmount,
    refundOrder,
};
