const supabase = require('../supabase');
const paymentGatewayService = require('./paymentGatewayService');
const sekalipayGatewayService = require('./sekalipayGatewayService');
const dyqrisGatewayService = require('./dyqrisGatewayService');
const orderFulfillmentService = require('./orderFulfillmentService');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');
const vendorRegistry = require('./vendors/vendorRegistry');
const emailService = require('./emailService');
const { logger } = require('../utils/logger');
const { withReadRetry, isTransientError } = require('../utils/dbRetry');

const pollingLog = logger.child({ job: 'payment-polling' });

/**
 * Service untuk mem-polling status pembayaran dari Sekalipay Gateway, FinCloud, dan Dyqris
 * sebagai solusi jika webhook dari payment gateway gagal atau tidak masuk.
 */
class PaymentPollingService {
    async pollPendingOrders() {
        try {
            // Only routing fields are needed here. The full order is re-read
            // after the gateway confirms payment, right before fulfillment.
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);

            const { data: orders, error } = await withReadRetry(async () => {
                const result = await supabase
                    .from('orders')
                    .select('id, status, payment_method, pg_provider, pg_invoice, timestamp')
                    .eq('status', 'PENDING')
                    .eq('payment_method', 'QRIS')
                    .not('pg_invoice', 'is', null)
                    .gte('timestamp', yesterday.toISOString())
                    .limit(100);

                if (result.error && isTransientError(result.error)) throw result.error;
                return result;
            });

            if (error) {
                pollingLog.error('pending_order_query_failed', { code: error.code });
                return;
            }

            if (!orders || orders.length === 0) {
                return;
            }

            pollingLog.info('pending_orders_found', { count: orders.length });
            if (orders.length === 100) {
                pollingLog.warn('pending_order_batch_limit_reached', { limit: 100 });
            }

            for (const order of orders) {
                await this.processOrder(order);
            }
        } catch (err) {
            pollingLog.error('pending_order_poll_failed', { error: err });
        }
    }

    async pollPendingTopups() {
        try {
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);

            const { data: topups, error } = await withReadRetry(async () => {
                const result = await supabase
                    .from('balance_transactions')
                    .select('*')
                    .eq('status', 'pending')
                    .not('pg_invoice', 'is', null)
                    .gte('created_at', yesterday.toISOString())
                    .limit(100);

                if (result.error && isTransientError(result.error)) throw result.error;
                return result;
            });

            if (error) {
                pollingLog.error('pending_topup_query_failed', { code: error.code });
                return;
            }

            if (!topups || topups.length === 0) {
                return;
            }

            const balanceService = require('./balanceService');

            for (const tx of topups) {
                let isPaid = false;
                let isExpired = false;
                const now = new Date();
                const createdAt = new Date(tx.created_at);
                const isTimeout = (now - createdAt >= 30 * 60 * 1000) || (tx.pg_expired_at && now >= new Date(tx.pg_expired_at));

                try {
                    if (tx.pg_provider === 'dyqris') {
                        const statusRes = await dyqrisGatewayService.getTransactionDetails(tx.pg_invoice || tx.reference_id);
                        const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                        if (s === 'PAID') isPaid = true;
                        else if (s === 'EXPIRED' || s === 'CANCELLED') isExpired = true;
                    } else if (tx.pg_provider === 'sekalipay') {
                        const statusRes = await sekalipayGatewayService.checkPaymentStatus(tx.reference_id || tx.pg_invoice);
                        const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                        if (s === 'PAID' || s === 'SUCCESS' || s === 'COMPLETED') isPaid = true;
                        else if (s === 'EXPIRED' || s === 'CANCELLED' || s === 'FAILED') isExpired = true;
                    } else if (tx.pg_provider === 'fincloud') {
                        const statusRes = await paymentGatewayService.checkInvoiceStatus(tx.pg_invoice || tx.reference_id);
                        const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                        if (s === 'PAID' || s === 'SUCCESS') isPaid = true;
                        else if (s === 'EXPIRED' || s === 'CANCELLED') isExpired = true;
                    } else {
                        // Unknown/missing provider: never assume FinCloud.
                        pollingLog.sampled(
                            'warn',
                            `unknown_topup_provider:${tx.pg_provider || 'null'}`,
                            60000,
                            'unknown_topup_provider_skip',
                            { referenceId: tx.reference_id, pgProvider: tx.pg_provider || null }
                        );
                    }
                } catch (pgError) {
                    pollingLog.error('topup_status_check_failed', {
                        referenceId: tx.reference_id,
                        message: pgError.message,
                    });
                }

                if (isPaid) {
                    try {
                        const creditRes = await balanceService.creditTopup(tx);
                        if (creditRes?.alreadyProcessed) {
                            pollingLog.debug('topup_already_credited', { referenceId: tx.reference_id });
                        } else {
                            pollingLog.info('topup_credited_via_polling', { referenceId: tx.reference_id });
                        }
                    } catch (creditErr) {
                        pollingLog.error('topup_credit_failed', {
                            referenceId: tx.reference_id,
                            error: creditErr,
                        });
                    }
                } else if (isExpired || isTimeout) {
                    await supabase.from('balance_transactions').update({ status: 'cancelled' }).eq('id', tx.id);
                }
            }
        } catch (err) {
            pollingLog.error('pending_topup_poll_failed', { error: err });
        }
    }

    async processOrder(order) {
        const pgProvider = order.pg_provider;

        if (pgProvider === 'sekalipay') {
            return this._processSekalipayOrder(order);
        } else if (pgProvider === 'dyqris') {
            return this._processDyqrisOrder(order);
        } else if (pgProvider === 'fincloud') {
            return this._processFincloudOrder(order);
        }

        // Never default an unknown/missing provider to FinCloud. That would
        // call a legacy gateway for orders that were never FinCloud orders.
        pollingLog.warn('unknown_pg_provider_skip', {
            orderId: order.id,
            pgProvider: pgProvider || null,
        });
    }

    /**
     * Proses polling untuk order Dyqris.
     * Cek status via Dyqris API GET /v1/transactions/:id.
     */
    async _processDyqrisOrder(order) {
        const refId = order.pg_invoice;
        const orderId = order.id;

        if (!refId) {
            pollingLog.warn('dyqris_missing_reference', { orderId });
            return;
        }

        try {
            const checkResult = await dyqrisGatewayService.getTransactionDetails(refId);

            if (!checkResult.success || !checkResult.data) {
                return;
            }

            if (checkResult.data.status !== 'paid') {
                return;
            }

            pollingLog.info('dyqris_order_paid', { orderId, refId });

            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (currentOrder && currentOrder.status !== 'PENDING') {
                pollingLog.debug('dyqris_order_already_processed', { orderId });
                return;
            }

            await supabase
                .from('orders')
                .update({ pg_paid_at: checkResult.data.paid_at || new Date().toISOString() })
                .eq('id', orderId);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.error('dyqris_fulfillment_failed', { orderId, message: fulfillmentResult.message });
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.info('dyqris_order_fulfilled', { orderId });
            }
        } catch (err) {
            pollingLog.error('dyqris_order_process_failed', { orderId, error: err });
        }
    }

    /**
     * Proses polling untuk order Sekalipay Payment Gateway (QRIS).
     * Cek status via Sekalipay Gateway API GET /payment/:ref_id.
     */
    async _processSekalipayOrder(order) {
        const refId = order.id || order.pg_invoice;
        const orderId = order.id;

        if (!refId) {
            pollingLog.warn('sekalipay_missing_reference', { orderId });
            return;
        }

        try {
            const checkResult = await sekalipayGatewayService.checkPaymentStatus(refId);

            if (!checkResult.success || !checkResult.data) {
                return;
            }

            const status = String(checkResult.data.status || '').toLowerCase();
            if (status !== 'paid' && status !== 'success' && status !== 'completed') {
                return;
            }

            pollingLog.info('sekalipay_order_paid', { orderId, refId });

            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (!currentOrder) {
                pollingLog.warn('sekalipay_order_missing_after_paid', { orderId });
                return;
            }

            if (currentOrder.status !== 'PENDING') {
                pollingLog.debug('sekalipay_order_already_processed', { orderId });
                return;
            }

            await supabase
                .from('orders')
                .update({ pg_paid_at: checkResult.data.paid_at || new Date().toISOString() })
                .eq('id', orderId);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.error('sekalipay_fulfillment_failed', { orderId, message: fulfillmentResult.message });
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.info('sekalipay_order_fulfilled', { orderId });
            }
        } catch (err) {
            pollingLog.error('sekalipay_order_process_failed', { orderId, error: err });
        }
    }

    /**
     * Proses polling untuk order FinCloud.
     * Cek status via FinCloud API (/cek_status dengan external_id / reff_id).
     */
    async _processFincloudOrder(order) {
        const reffId = order.id || order.pg_invoice;

        try {
            // Cek status ke FinCloud API
            const checkResult = await paymentGatewayService.checkInvoiceStatus(reffId);
            
            if (!checkResult.success || !checkResult.data) {
                return;
            }

            const apiStatus = String(checkResult.data.status || '').toLowerCase();

            if (apiStatus === 'expired' || apiStatus === 'cancelled') {
                pollingLog.info('fincloud_order_expired', { orderId: reffId, apiStatus });
                await supabase
                    .from('orders')
                    .update({ status: 'CANCELLED', error_message: `Tagihan ${apiStatus} di FinCloud` })
                    .eq('id', reffId)
                    .eq('status', 'PENDING');
                return;
            }

            if (apiStatus !== 'success' && apiStatus !== 'paid') {
                // Belum dibayar, abaikan
                return;
            }

            pollingLog.info('fincloud_order_paid', { orderId: reffId, apiStatus });

            // Pastikan belum diproses secara bersamaan oleh webhook
            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', reffId)
                .single();

            if (!currentOrder) {
                pollingLog.warn('fincloud_order_missing_after_paid', { orderId: reffId });
                return;
            }

            if (currentOrder.status !== 'PENDING') {
                pollingLog.debug('fincloud_order_already_processed', { orderId: reffId });
                return;
            }

            // ── Update pg_paid_at ────────────────────────────────────────
            await supabase
                .from('orders')
                .update({ pg_paid_at: new Date().toISOString() })
                .eq('id', reffId);

            // ── Buat transaksi ke Vendor (Sekalipay / Okeconnect) via Fulfillment Service ──────────
            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.error('fincloud_fulfillment_failed', { orderId: reffId, message: fulfillmentResult.message });
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                pollingLog.info('fincloud_order_fulfilled', { orderId: reffId });
            }
        } catch (err) {
            pollingLog.error('fincloud_order_process_failed', { orderId: reffId, error: err });
        }
    }

    async cancelExpiredOrders() {
        try {
            // Waktu 30 menit yang lalu
            const expiredTime = new Date();
            expiredTime.setMinutes(expiredTime.getMinutes() - 30);

            const { data: orders, error } = await supabase
                .from('orders')
                .select('id, payment_type, user_id, price, status')
                .eq('status', 'PENDING')
                .lt('timestamp', expiredTime.toISOString())
                .order('timestamp', { ascending: true })
                .limit(200);

            if (error) {
                pollingLog.error('expired_order_query_failed', { code: error.code });
                await this.retryPendingRefunds();
                return;
            }

            if (!orders || orders.length === 0) {
                await this.retryPendingRefunds();
                return;
            }

            const balanceService = require('./balanceService');
            let cancelled = 0;
            let refunded = 0;

            for (const order of orders) {
                // Balance orders were already paid at creation time. Claim the
                // order with an intermediate status first so fulfillment can
                // never claim it while we are refunding.
                if (order.payment_type === 'balance' && order.user_id) {
                    const { data: claimed, error: claimError } = await supabase
                        .from('orders')
                        .update({
                            status: 'REFUND_PENDING',
                            error_message: 'Expired: refunding balance before cancellation',
                        })
                        .eq('id', order.id)
                        .eq('status', 'PENDING')
                        .select('id');

                    if (claimError) {
                        pollingLog.error('expired_order_claim_failed', {
                            orderId: order.id,
                            code: claimError.code,
                        });
                        continue;
                    }
                    if (!claimed || claimed.length === 0) continue;

                    try {
                        await balanceService.refundBalance(
                            order.user_id,
                            order.price,
                            order.id,
                            'Refund otomatis: pesanan kedaluwarsa sebelum diproses'
                        );

                        await supabase
                            .from('orders')
                            .update({ status: 'CANCELLED' })
                            .eq('id', order.id)
                            .eq('status', 'REFUND_PENDING');

                        refunded++;
                        cancelled++;
                    } catch (refundErr) {
                        // Leave REFUND_PENDING. retryPendingRefunds() will try
                        // again on the next payment sweep.
                        pollingLog.error('expired_balance_order_refund_failed', {
                            orderId: order.id,
                            message: refundErr.message,
                        });
                    }
                    continue;
                }

                const { data: cancelledRows, error: cancelError } = await supabase
                    .from('orders')
                    .update({
                        status: 'CANCELLED',
                        error_message: 'Expired: Unpaid for more than 30 minutes',
                    })
                    .eq('id', order.id)
                    .eq('status', 'PENDING')
                    .select('id');

                if (cancelError) {
                    pollingLog.error('expired_order_cancel_failed', {
                        orderId: order.id,
                        code: cancelError.code,
                    });
                    continue;
                }

                if (cancelledRows && cancelledRows.length > 0) cancelled++;
            }

            pollingLog.info('expired_orders_cancelled', { count: cancelled, refunded });

            await this.retryPendingRefunds();
        } catch (err) {
            pollingLog.error('expired_order_sweep_failed', { error: err });
        }
    }

    /**
     * Retry balance refunds for orders left in REFUND_PENDING by a failed
     * cancellation refund. refund_balance is idempotent, so this is safe to
     * run on every payment sweep.
     */
    async retryPendingRefunds() {
        try {
            const { data: orders, error } = await supabase
                .from('orders')
                .select('id, payment_type, user_id, price, status')
                .eq('status', 'REFUND_PENDING')
                .limit(200);

            if (error) {
                pollingLog.error('refund_pending_query_failed', { code: error.code });
                return { success: false, retried: 0 };
            }

            if (!orders || orders.length === 0) return { success: true, retried: 0 };

            const balanceService = require('./balanceService');
            let completed = 0;

            for (const order of orders) {
                if (order.payment_type !== 'balance' || !order.user_id) continue;

                try {
                    await balanceService.refundBalance(
                        order.user_id,
                        order.price,
                        order.id,
                        'Refund otomatis: pesanan kedaluwarsa sebelum diproses'
                    );

                    await supabase
                        .from('orders')
                        .update({ status: 'CANCELLED' })
                        .eq('id', order.id)
                        .eq('status', 'REFUND_PENDING');

                    completed++;
                } catch (err) {
                    pollingLog.error('refund_pending_retry_failed', {
                        orderId: order.id,
                        message: err.message,
                    });
                }
            }

            if (completed > 0) {
                pollingLog.info('refund_pending_completed', { count: completed });
            }

            return { success: true, retried: completed };
        } catch (err) {
            pollingLog.error('refund_pending_sweep_failed', { error: err });
            return { success: false, retried: 0 };
        }
    }

    async cancelExpiredTopups() {
        try {
            // Waktu 30 menit yang lalu
            const expiredTime = new Date();
            expiredTime.setMinutes(expiredTime.getMinutes() - 30);
            const now = new Date();

            const { data: topups, error } = await supabase
                .from('balance_transactions')
                .update({ status: 'cancelled' })
                .eq('type', 'topup')
                .eq('status', 'pending')
                .or(`created_at.lt.${expiredTime.toISOString()},pg_expired_at.lt.${now.toISOString()}`)
                .select('id, reference_id');

            if (error) {
                pollingLog.error('expired_topup_update_failed', { code: error.code });
                return;
            }

            if (topups && topups.length > 0) {
                pollingLog.info('expired_topups_cancelled', { count: topups.length });
            }
        } catch (err) {
            pollingLog.error('expired_topup_sweep_failed', { error: err });
        }
    }

    async pollProcessingOrders() {
        // Reserved for active vendors if background status polling is needed.
        // Sekalipay and OkeConnect handle fulfillment completions via webhooks.
    }
}

module.exports = new PaymentPollingService();
