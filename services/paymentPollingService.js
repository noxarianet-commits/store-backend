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
     * Cek status via FinCloud API (id_depo).
     */
    async _processFincloudOrder(order) {
        const idDepo = order.pg_invoice;
        const reffId = order.id;

        try {
            // Cek status ke FinCloud API
            const checkResult = await paymentGatewayService.checkInvoiceStatus(idDepo);
            
            if (!checkResult.success || !checkResult.data) {
                return;
            }

            const apiStatus = checkResult.data.status;

            if (apiStatus !== 'success') {
                // Belum dibayar, abaikan
                return;
            }

            console.log(`[Polling/PG-FinCloud] Order ${reffId} ternyata sudah sukses dibayar (id_depo=${idDepo}). Memproses...`);

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

            // ── Buat transaksi ke Vendor (Sekalipay / Fincloud) via Fulfillment Service ──────────
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

    async pollProcessingOrders() {
        // Reserved for active vendors if background status polling is needed.
        // Sekalipay and OkeConnect handle fulfillment completions via webhooks.
    }
}

module.exports = new PaymentPollingService();
