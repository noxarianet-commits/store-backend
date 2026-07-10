const supabase = require('../supabase');
const vendorRegistry = require('./vendors/vendorRegistry');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');

/**
 * Service to handle order fulfillment centrally.
 * Implements atomic locking to prevent race conditions from multiple triggers
 * (e.g., webhook, cron polling, on-demand status check) causing duplicate
 * transactions to vendors.
 */
class OrderFulfillmentService {
    /**
     * Claims the order atomically and processes the transaction.
     * @param {Object} order The order object from database
     * @returns {Promise<{success: boolean, skipped?: boolean, message?: string}>}
     */
    async fulfillOrder(order) {
        const orderId = order.id;
        const vendorName = order.vendor || 'sekalipay'; // default to sekalipay for backward compatibility
        console.log(`[OrderFulfillment] Attempting to claim order ${orderId} for vendor ${vendorName}...`);

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

            console.log(`[OrderFulfillment] Klaim berhasil untuk order ${orderId}. Memproses ke ${vendorName}...`);

            // 3. Process Transaction via Vendor Adapter
            let vendorAdapter;
            try {
                vendorAdapter = vendorRegistry.get(vendorName);
            } catch (err) {
                console.error(`[OrderFulfillment] ${err.message}`);
                await supabase
                    .from('orders')
                    .update({ status: 'FAILED', error_message: `Vendor ${vendorName} tidak didukung` })
                    .eq('id', orderId);
                return { success: false, message: 'Unsupported vendor' };
            }

            let vendorResult;

            if (vendorName === 'fincloud') {
                const sku = order.fincloud_sku;
                if (!sku) {
                    await supabase
                        .from('orders')
                        .update({ status: 'FAILED', error_message: 'fincloud_sku tidak ditemukan di order' })
                        .eq('id', orderId);
                    return { success: false, message: 'Missing fincloud_sku' };
                }

                // Fincloud PPOB uses target directly
                let target = order.account_details?.target;
                if (!target && order.account_details?.sekalipay_note) {
                    // Fallback to sekalipay_note (which might contain the number)
                    target = normalizeNotePhoneNumber(order.account_details.sekalipay_note);
                }

                if (!target) {
                    await supabase
                        .from('orders')
                        .update({ status: 'FAILED', error_message: 'Target/nomor HP tidak ditemukan' })
                        .eq('id', orderId);
                    return { success: false, message: 'Missing target' };
                }

                vendorResult = await vendorAdapter.createOrder(orderId, { sku, target });

                if (!vendorResult.success) {
                    const errMsg = vendorResult.message || 'UNKNOWN_FINCLOUD_ERROR';
                    console.error(`[OrderFulfillment] Fincloud order gagal untuk ${orderId}:`, errMsg, vendorResult.data);
                    
                    await supabase
                        .from('orders')
                        .update({
                            status: 'FAILED',
                            error_message: errMsg,
                        })
                        .eq('id', orderId);

                    return { success: false, message: errMsg };
                }

                console.log(`[OrderFulfillment] Fincloud order dibuat: reff_id=${orderId}`);

                // Update order to PROCESSING
                await supabase
                    .from('orders')
                    .update({
                        status: 'PROCESSING',
                        vendor_ref_id: orderId, // Fincloud uses our orderId as reff_id
                        vendor_status: 'pending'
                    })
                    .eq('id', orderId);

            } else {
                // Default / Sekalipay
                const variantId = order.sekalipay_variant_id;
                if (!variantId) {
                    console.error(`[OrderFulfillment] Order ${orderId} tidak punya sekalipay_variant_id.`);
                    await supabase
                        .from('orders')
                        .update({ status: 'FAILED', error_message: 'variant_id tidak ditemukan di order' })
                        .eq('id', orderId);
                    return { success: false, message: 'Missing variant_id' };
                }

                const rawNote = order.account_details?.sekalipay_note || '-';
                const note = normalizeNotePhoneNumber(rawNote);

                const carts = [
                    {
                        item_id: variantId,
                        quantity: 1,
                        note,
                    },
                ];

                vendorResult = await vendorAdapter.createOrder(orderId, { carts });

                if (!vendorResult.success) {
                    const errMsg = vendorResult.message || 'UNKNOWN_SEKALIPAY_ERROR';
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

                const sekalipayData = vendorResult.data;
                console.log(`[OrderFulfillment] Sekalipay order dibuat: invoice=${sekalipayData.invoice}, ref_id=${sekalipayData.ref_id}`);

                // Update order to PROCESSING (waiting for Sekalipay webhook for completion)
                // We update both legacy columns and new vendor columns
                await supabase
                    .from('orders')
                    .update({
                        status: 'PROCESSING',
                        sekalipay_invoice: sekalipayData.invoice || null,
                        vendor_ref_id: sekalipayData.ref_id || null,
                        vendor_invoice: sekalipayData.invoice || null,
                        vendor_status: 'pending'
                    })
                    .eq('id', orderId);
            }

            console.log(`[OrderFulfillment] Order ${orderId} berhasil diproses ke ${vendorName}.`);
            return { success: true };

        } catch (err) {
            console.error(`[OrderFulfillment] Exception saat memproses order ${orderId}:`, err);
            
            await supabase
                .from('orders')
                .update({ status: 'FAILED', error_message: err.message })
                .eq('id', orderId);
                
            return { success: false, message: err.message };
        }
    }
}

module.exports = new OrderFulfillmentService();
