const supabase = require('../supabase');
const paymentGatewayService = require('./paymentGatewayService');
const sekalipayService = require('./sekalipayService');

/**
 * Service untuk mem-polling status pembayaran dari FinCloud
 * sebagai solusi jika webhook dari FinCloud gagal atau tidak masuk.
 */
class PaymentPollingService {
    async pollPendingOrders() {
        try {
            console.log('[Polling/PG-FinCloud] Memulai pengecekan status pending orders...');
            
            // Cari order PENDING yang menggunakan QRIS dan punya id_depo (pg_invoice)
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
                console.error('[Polling/PG-FinCloud] Gagal mengambil pending orders:', error.message);
                return;
            }

            if (!orders || orders.length === 0) {
                console.log('[Polling/PG-FinCloud] Tidak ada pending orders untuk diproses.');
                return;
            }

            console.log(`[Polling/PG-FinCloud] Ditemukan ${orders.length} order PENDING.`);

            // Proses setiap order
            for (const order of orders) {
                await this.processOrder(order);
            }

            console.log('[Polling/PG-FinCloud] Pengecekan selesai.');
        } catch (err) {
            console.error('[Polling/PG-FinCloud] Error dalam proses polling:', err);
        }
    }

    async processOrder(order) {
        const idDepo = order.pg_invoice;
        const reffId = order.id;

        try {
            // Cek status ke FinCloud API
            const checkResult = await paymentGatewayService.checkInvoiceStatus(idDepo);
            
            if (!checkResult.success || !checkResult.data) {
                // Jika FinCloud API mengembalikan status sukses (false) / error
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
                .select('status')
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

            // ── Buat transaksi ke Sekalipay Reseller API ─────────────────
            const variantId = order.sekalipay_variant_id;
            if (!variantId) {
                console.error(`[Polling/PG-FinCloud] Order ${reffId} tidak punya sekalipay_variant_id.`);
                await supabase
                    .from('orders')
                    .update({ status: 'FAILED', error_message: 'variant_id tidak ditemukan di order' })
                    .eq('id', reffId);
                return;
            }

            const carts = [
                {
                    item_id: variantId,
                    quantity: 1,
                    note: order.account_details?.sekalipay_note || '-',
                },
            ];

            const sekalipayResult = await sekalipayService.createTransaction(reffId, carts);

            if (!sekalipayResult.success) {
                const errMsg = sekalipayResult.message || 'UNKNOWN_SEKALIPAY_ERROR';
                console.error(`[Polling/PG-FinCloud] Sekalipay order gagal untuk ${reffId}:`, errMsg);

                await supabase
                    .from('orders')
                    .update({
                        status: 'FAILED',
                        error_message: errMsg,
                    })
                    .eq('id', reffId);

                return;
            }

            const sekalipayData = sekalipayResult.data;
            console.log(`[Polling/PG-FinCloud] Sekalipay order dibuat: invoice=${sekalipayData.invoice}, ref_id=${sekalipayData.ref_id}`);

            // ── Update order ke PROCESSING ───────────────────────────────
            await supabase
                .from('orders')
                .update({
                    status: 'PROCESSING',
                    sekalipay_invoice: sekalipayData.invoice || null,
                })
                .eq('id', reffId);

            console.log(`[Polling/PG-FinCloud] Order ${reffId} berhasil diproses.`);
        } catch (err) {
            console.error(`[Polling/PG-FinCloud] Error memproses order ${reffId}:`, err);
        }
    }
}

module.exports = new PaymentPollingService();
