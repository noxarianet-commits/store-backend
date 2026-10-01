const supabase = require('../supabase');
const paymentGatewayService = require('./paymentGatewayService');
const sekalipayGatewayService = require('./sekalipayGatewayService');
const dyqrisGatewayService = require('./dyqrisGatewayService');
const orderFulfillmentService = require('./orderFulfillmentService');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');
const vendorRegistry = require('./vendors/vendorRegistry');
const emailService = require('./emailService');

/**
 * Service untuk mem-polling status pembayaran dari Sekalipay Gateway, FinCloud, dan Dyqris
 * sebagai solusi jika webhook dari payment gateway gagal atau tidak masuk.
 */
class PaymentPollingService {
    async pollPendingOrders() {
        try {
            console.log('[Polling/PG] Memulai pengecekan status pending orders...');
            
            // Cari order PENDING yang menggunakan QRIS dan punya pg_invoice
            // Batasi misalnya order yang dibuat maksimal 24 jam terakhir agar tidak berat
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);

            const { data: orders, error } = await supabase
                .from('orders')
                .select('*')
                .eq('status', 'PENDING')
                .eq('payment_method', 'QRIS')
                .not('pg_invoice', 'is', null)
                .gte('timestamp', yesterday.toISOString());


            if (error) {
                console.error('[Polling/PG] Gagal mengambil pending orders:', error.message);
                return;
            }

            if (!orders || orders.length === 0) {
                console.log('[Polling/PG] Tidak ada pending orders untuk diproses.');
                return;
            }

            console.log(`[Polling/PG] Ditemukan ${orders.length} order PENDING.`);

            // Proses setiap order berdasarkan pg_provider
            for (const order of orders) {
                await this.processOrder(order);
            }

            console.log('[Polling/PG] Pengecekan selesai.');
        } catch (err) {
            console.error('[Polling/PG] Error dalam proses polling:', err);
        }
    }

    async pollPendingTopups() {
        try {
            console.log('[Polling/PG] Memulai pengecekan status pending topups...');
            
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);

            const { data: topups, error } = await supabase
                .from('balance_transactions')
                .select('*')
                .eq('status', 'pending')
                .not('pg_invoice', 'is', null)
                .gte('created_at', yesterday.toISOString());

            if (error) {
                console.error('[Polling/PG] Gagal mengambil pending topups:', error.message);
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
                    } else {
                        // fincloud
                        const statusRes = await paymentGatewayService.checkInvoiceStatus(tx.pg_invoice || tx.reference_id);
                        const s = statusRes.success && statusRes.data ? (statusRes.data.status || '').toUpperCase() : '';
                        if (s === 'PAID' || s === 'SUCCESS') isPaid = true;
                        else if (s === 'EXPIRED' || s === 'CANCELLED') isExpired = true;
                    }
                } catch (pgError) {
                    console.error(`Error polling status for topup ${tx.reference_id}:`, pgError.message);
                }

                if (isPaid) {
                    try {
                        const creditRes = await balanceService.creditTopup(tx);
                        if (creditRes?.alreadyProcessed) {
                            // Sering terjadi: webhook sudah lebih duluan. Ini normal,
                            // creditTopup yang idempoten jadi tidak ada kredit ganda.
                            console.log(`[Polling/PG] Topup ${tx.reference_id} sudah dikreditkan sebelumnya, dilewati.`);
                        } else {
                            console.log(`[Polling/PG] Topup ${tx.reference_id} berhasil dikreditkan via polling.`);
                        }
                    } catch (creditErr) {
                        console.error('Error crediting balance for topup:', creditErr);
                    }
                } else if (isExpired || isTimeout) {
                    await supabase.from('balance_transactions').update({ status: 'cancelled' }).eq('id', tx.id);
                }
            }
        } catch (err) {
            console.error('[Polling/PG] Error dalam proses polling topups:', err);
        }
    }

    async processOrder(order) {
        const pgProvider = order.pg_provider || 'fincloud';
        
        if (pgProvider === 'sekalipay') {
            return this._processSekalipayOrder(order);
        } else if (pgProvider === 'dyqris') {
            return this._processDyqrisOrder(order);
        } else {
            return this._processFincloudOrder(order);
        }
    }

    /**
     * Proses polling untuk order Dyqris.
     * Cek status via Dyqris API GET /v1/transactions/:id.
     */
    async _processDyqrisOrder(order) {
        const refId = order.dyqris_ref_id || order.pg_invoice;
        const orderId = order.id;

        if (!refId) {
            console.warn(`[Polling/PG-Dyqris] Order ${orderId} tidak memiliki dyqris_ref_id valid, skip polling API.`);
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

            console.log(`[Polling/PG-Dyqris] Order ${orderId} ternyata sudah PAID (ref=${refId}). Memproses...`);

            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (currentOrder && currentOrder.status !== 'PENDING') {
                console.log(`[Polling/PG-Dyqris] Order ${orderId} sudah diproses. Skip.`);
                return;
            }

            await supabase
                .from('orders')
                .update({ pg_paid_at: checkResult.data.paid_at || new Date().toISOString() })
                .eq('id', orderId);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.error(`[Polling/PG-Dyqris] Fulfillment order gagal untuk ${orderId}:`, fulfillmentResult.message);
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.log(`[Polling/PG-Dyqris] Order ${orderId} berhasil diproses via polling.`);
            }
        } catch (err) {
            console.error(`[Polling/PG-Dyqris] Error memproses order ${orderId}:`, err);
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
            console.warn(`[Polling/PG-Sekalipay] Order ${orderId} tidak memiliki ref_id valid, skip polling API.`);
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

            console.log(`[Polling/PG-Sekalipay] Order ${orderId} ternyata sudah PAID (ref=${refId}). Memproses...`);

            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (currentOrder && currentOrder.status !== 'PENDING') {
                console.log(`[Polling/PG-Sekalipay] Order ${orderId} sudah diproses. Skip.`);
                return;
            }

            await supabase
                .from('orders')
                .update({ pg_paid_at: checkResult.data.paid_at || new Date().toISOString() })
                .eq('id', orderId);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.error(`[Polling/PG-Sekalipay] Fulfillment order gagal untuk ${orderId}:`, fulfillmentResult.message);
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.log(`[Polling/PG-Sekalipay] Order ${orderId} berhasil diproses via polling.`);
            }
        } catch (err) {
            console.error(`[Polling/PG-Sekalipay] Error memproses order ${orderId}:`, err);
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
                console.log(`[Polling/PG-FinCloud] Order ${reffId} berstatus ${apiStatus}. Menandai CANCELLED.`);
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

            console.log(`[Polling/PG-FinCloud] Order ${reffId} ternyata sudah sukses dibayar (status=${apiStatus}). Memproses...`);

            // Pastikan belum diproses secara bersamaan oleh webhook
            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', reffId)
                .single();

            if (currentOrder && currentOrder.status !== 'PENDING') {
                console.log(`[Polling/PG-FinCloud] Order ${reffId} sudah diproses oleh webhook. Skip.`);
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
                console.error(`[Polling/PG-FinCloud] Fulfillment order gagal untuk ${reffId}:`, fulfillmentResult.message);
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.log(`[Polling/PG-FinCloud] Order ${reffId} berhasil diproses via polling.`);
            }
        } catch (err) {
            console.error(`[Polling/PG-FinCloud] Error memproses order ${reffId}:`, err);
        }
    }

    async cancelExpiredOrders() {
        try {
            // Waktu 30 menit yang lalu
            const expiredTime = new Date();
            expiredTime.setMinutes(expiredTime.getMinutes() - 30);

            const { data: orders, error } = await supabase
                .from('orders')
                .update({ status: 'CANCELLED', error_message: 'Expired: Unpaid for more than 30 minutes' })
                .eq('status', 'PENDING')
                .lt('timestamp', expiredTime.toISOString())
                .select('id');

            if (error) {
                console.error('[Polling/PG] Gagal update status order expired:', error.message);
                return;
            }

            if (orders && orders.length > 0) {
                console.log(`[Polling/PG] Berhasil membatalkan ${orders.length} order kedaluwarsa (> 30 menit).`);
            }
        } catch (err) {
            console.error('[Polling/PG] Error dalam membatalkan order kedaluwarsa:', err);
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
                console.error('[Polling/PG] Gagal update status topup expired:', error.message);
                return;
            }

            if (topups && topups.length > 0) {
                console.log(`[Polling/PG] Berhasil membatalkan ${topups.length} transaksi top-up kedaluwarsa (> 30 menit).`);
            }
        } catch (err) {
            console.error('[Polling/PG] Error dalam membatalkan top-up kedaluwarsa:', err);
        }
    }

    async pollProcessingOrders() {
        // Reserved for active vendors if background status polling is needed.
        // Sekalipay and OkeConnect handle fulfillment completions via webhooks.
    }
}

module.exports = new PaymentPollingService();
