const supabase = require('../supabase');
const paymentGatewayService = require('./paymentGatewayService');
const sayabayarGatewayService = require('./sayabayarGatewayService');
const dyqrisGatewayService = require('./dyqrisGatewayService');
const sekalipayService = require('./sekalipayService');
const orderFulfillmentService = require('./orderFulfillmentService');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');
const vendorRegistry = require('./vendors/vendorRegistry');
const emailService = require('./emailService');

/**
 * Service untuk mem-polling status pembayaran dari FinCloud, Saya Bayar, dan Dyqris
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
                .select('id, status, payment_method, pg_invoice, pg_provider, dyqris_ref_id, sayabayar_ref_id, timestamp')
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
        
        if (pgProvider === 'sayabayar') {
            return this._processSayabayarOrder(order);
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
     * Proses polling untuk order Saya Bayar.
     * Cek status via API Saya Bayar GET /v1/invoices/:id.
     */
    async _processSayabayarOrder(order) {
        const refId = order.sayabayar_ref_id || (order.pg_invoice && !order.pg_invoice.startsWith('http') ? order.pg_invoice : null);
        const orderId = order.id;

        if (!refId || refId.startsWith('NX-')) {
            console.warn(`[Polling/PG-Sayabayar] Order ${orderId} tidak memiliki sayabayar_ref_id valid, skip polling API.`);
            return;
        }

        try {
            const checkResult = await sayabayarGatewayService.getInvoiceDetails(refId);

            if (!checkResult.success || !checkResult.data) {
                return;
            }

            if (checkResult.data.status !== 'paid') {
                return;
            }

            console.log(`[Polling/PG-Sayabayar] Order ${orderId} ternyata sudah PAID (ref=${refId}). Memproses...`);

            const { data: currentOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            if (currentOrder && currentOrder.status !== 'PENDING') {
                console.log(`[Polling/PG-Sayabayar] Order ${orderId} sudah diproses. Skip.`);
                return;
            }

            await supabase
                .from('orders')
                .update({ pg_paid_at: new Date().toISOString() })
                .eq('id', orderId);

            const fulfillmentResult = await orderFulfillmentService.fulfillOrder(currentOrder);

            if (!fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.error(`[Polling/PG-Sayabayar] Fulfillment order gagal untuk ${orderId}:`, fulfillmentResult.message);
            } else if (fulfillmentResult.success && !fulfillmentResult.skipped) {
                console.log(`[Polling/PG-Sayabayar] Order ${orderId} berhasil diproses via polling.`);
            }
        } catch (err) {
            console.error(`[Polling/PG-Sayabayar] Error memproses order ${orderId}:`, err);
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
        try {
            console.log('[Polling/H2H-FinCloud] Memulai pengecekan status order PROCESSING...');

            // Ambil order PROCESSING dari vendor Fincloud yang dibuat dalam 24 jam terakhir
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);

            const { data: orders, error } = await supabase
                .from('orders')
                .select('id, status, vendor, vendor_ref_id, account_details, timestamp')
                .eq('status', 'PROCESSING')
                .eq('vendor', 'fincloud')
                .gte('timestamp', yesterday.toISOString());

            if (error) {
                console.error('[Polling/H2H-FinCloud] Gagal mengambil processing orders:', error.message);
                return;
            }

            if (!orders || orders.length === 0) {
                console.log('[Polling/H2H-FinCloud] Tidak ada processing orders untuk diperiksa.');
                return;
            }

            console.log(`[Polling/H2H-FinCloud] Ditemukan ${orders.length} order PROCESSING.`);

            const adapter = vendorRegistry.get('fincloud');

            for (const order of orders) {
                const refId = order.vendor_ref_id || order.id;
                console.log(`[Polling/H2H-FinCloud] Memeriksa status order ${order.id} (refId: ${refId})...`);

                const checkResult = await adapter.checkOrderStatus(refId);

                if (!checkResult.success || !checkResult.data) {
                    console.warn(`[Polling/H2H-FinCloud] Gagal cek status untuk order ${order.id}:`, checkResult.message);
                    continue;
                }

                // Fincloud usually returns the actual status in checkResult.data.data.status
                let apiStatus = checkResult.data?.data?.status;
                if (!apiStatus && typeof checkResult.data?.status === 'string') {
                    apiStatus = checkResult.data.status;
                }
                
                const rrn = checkResult.data?.data?.sn || checkResult.data?.data?.rrn || checkResult.data?.sn || checkResult.data?.rrn;

                if (apiStatus === 'success') {
                    const accountDetails = {
                        ...order.account_details,
                        type: 'auto',
                        rrn: rrn || null,
                        licenses: rrn ? [rrn] : [],
                        completed_at: new Date().toISOString()
                    };

                    const { error: updateError } = await supabase
                        .from('orders')
                        .update({
                            status: 'COMPLETED',
                            account_details: accountDetails,
                            vendor_status: 'success'
                        })
                        .eq('id', order.id);

                    if (updateError) {
                        console.error(`[Polling/H2H-FinCloud] Gagal update status sukses untuk order ${order.id}:`, updateError.message);
                    } else {
                        console.log(`[Polling/H2H-FinCloud] Order ${order.id} berhasil diupdate ke COMPLETED.`);
                        emailService.sendOrderCompletedEmail({
                            ...order,
                            account_details: accountDetails
                        }).catch(err => console.error(`[Polling/H2H-FinCloud] Gagal kirim email sukses untuk order ${order.id}:`, err.message));
                    }
                } else if (apiStatus === 'failed' || apiStatus === 'cancel' || apiStatus === 'cancelled' || apiStatus === 'refund') {
                    const { error: updateError } = await supabase
                        .from('orders')
                        .update({
                            status: 'FAILED',
                            error_message: rrn || 'Order dibatalkan oleh Fincloud (via Polling)',
                            vendor_status: 'failed'
                        })
                        .eq('id', order.id);

                    if (updateError) {
                        console.error(`[Polling/H2H-FinCloud] Gagal update status gagal untuk order ${order.id}:`, updateError.message);
                    } else {
                        console.log(`[Polling/H2H-FinCloud] Order ${order.id} berhasil diupdate ke FAILED.`);
                        emailService.sendOrderFailedEmail(order)
                            .catch(err => console.error(`[Polling/H2H-FinCloud] Gagal kirim email gagal untuk order ${order.id}:`, err.message));
                    }
                } else {
                    console.log(`[Polling/H2H-FinCloud] Order ${order.id} masih pending/processing di Fincloud (status: ${apiStatus}).`);
                }
            }

        } catch (err) {
            console.error('[Polling/H2H-FinCloud] Error dalam pollProcessingOrders:', err);
        }
    }
}

module.exports = new PaymentPollingService();
