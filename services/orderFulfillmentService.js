const supabase = require('../supabase');
const sekalipayService = require('./sekalipayService');

/**
 * Service to handle order fulfillment centrally.
 * Implements atomic locking to prevent race conditions from multiple triggers
 * (e.g., webhook, cron polling, on-demand status check) causing duplicate
 * transactions to Sekalipay.
 */
class OrderFulfillmentService {
    /**
     * Claims the order atomically and processes the Sekalipay transaction.
     * @param {Object} order The order object from database
     * @returns {Promise<{success: boolean, skipped?: boolean, message?: string}>}
     */
    async fulfillOrder(order) {
        const orderId = order.id;
        console.log(`[OrderFulfillment] Attempting to claim order ${orderId}...`);

        try {
            // 1. Atomic Claim: UPDATE ... WHERE id = ? AND status = 'PENDING'
            // We use 'PROCESSING_LOCK' as a temporary state to claim ownership.
            const { data: updatedOrders, error: updateError } = await supabase
                .from('orders')
                .update({ status: 'PROCESSING_LOCK' })
                .eq('id', orderId)
                .eq('status', 'PENDING')
                .select('id'); // Return the id to confirm update

            if (updateError) {
                console.error(`[OrderFulfillment] Error during claim for order ${orderId}:`, updateError.message);
                return { success: false, message: 'Database error during claim' };
            }

            // 2. Check if claim was successful (if 0 rows returned, someone else claimed it)
            if (!updatedOrders || updatedOrders.length === 0) {
                console.log(`[OrderFulfillment] Skip — order ${orderId} sudah diklaim proses lain (status bukan PENDING).`);
                return { success: true, skipped: true };
            }

            console.log(`[OrderFulfillment] Klaim berhasil untuk order ${orderId}. Memproses Sekalipay...`);

            // 3. Process Sekalipay Transaction
            const variantId = order.sekalipay_variant_id;
            if (!variantId) {
                console.error(`[OrderFulfillment] Order ${orderId} tidak punya sekalipay_variant_id.`);
                await supabase
                    .from('orders')
                    .update({ status: 'FAILED', error_message: 'variant_id tidak ditemukan di order' })
                    .eq('id', orderId);
                return { success: false, message: 'Missing variant_id' };
            }

            const carts = [
                {
                    item_id: variantId,
                    quantity: 1,
                    note: '-',
                },
            ];

            const sekalipayResult = await sekalipayService.createTransaction(orderId, carts);

            // 4. Handle Sekalipay Result & Update Status
            if (!sekalipayResult.success) {
                const errMsg = sekalipayResult.message || 'UNKNOWN_SEKALIPAY_ERROR';
                console.error(`[OrderFulfillment] Sekalipay order gagal untuk ${orderId}:`, errMsg);

                await supabase
                    .from('orders')
                    .update({
                        status: 'FAILED',
                        error_message: errMsg,
                    })
                    .eq('id', orderId);

                return { success: false, message: errMsg };
            }

            const sekalipayData = sekalipayResult.data;
            console.log(`[OrderFulfillment] Sekalipay order dibuat: invoice=${sekalipayData.invoice}, ref_id=${sekalipayData.ref_id}`);

            // Update order to PROCESSING (waiting for Sekalipay webhook for completion)
            await supabase
                .from('orders')
                .update({
                    status: 'PROCESSING',
                    sekalipay_invoice: sekalipayData.invoice || null,
                })
                .eq('id', orderId);

            console.log(`[OrderFulfillment] Order ${orderId} berhasil diproses ke Sekalipay.`);
            return { success: true };

        } catch (err) {
            console.error(`[OrderFulfillment] Exception saat memproses order ${orderId}:`, err);
            
            // Revert lock if something catastrophic happens before Sekalipay is hit?
            // Safer to leave it as PROCESSING_LOCK or FAILED to avoid infinite retry loops on error.
            await supabase
                .from('orders')
                .update({ status: 'FAILED', error_message: err.message })
                .eq('id', orderId);
                
            return { success: false, message: err.message };
        }
    }
}

module.exports = new OrderFulfillmentService();
