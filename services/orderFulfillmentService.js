const supabase = require('../supabase');
const vendorRegistry = require('./vendors/vendorRegistry');
const { normalizeNotePhoneNumber } = require('../utils/phoneUtils');

/**
 * Service to handle order fulfillment centrally.
 * Implements atomic locking to prevent race conditions from multiple triggers
 * (webhook, cron polling, on-demand status check) causing duplicate transactions.
 */
class OrderFulfillmentService {
    /**
     * Build vendor-appropriate order payload from standard order record.
     */
    _buildOrderPayload(vendorName, order, variantId) {
        const rawNote = order.account_details?.target || order.account_details?.sekalipay_note || order.account_details?.note || '-';
        let note = normalizeNotePhoneNumber(rawNote);
        let zoneId = order.account_details?.zone_id || order.account_details?.zoneId || null;

        // Extract zone_id if formatted as USER_ID(ZONE_ID)
        if (typeof note === 'string') {
            const match = note.match(/^([^\(\)]+)\(([^\(\)]+)\)$/);
            if (match) {
                note = match[1].trim();
                if (!zoneId) zoneId = match[2].trim();
            }
        }

        if (vendorName === 'sekalipay') {
            const cartItem = {
                item_id: parseInt(variantId) || variantId,
                quantity: 1,
                note,
            };
            if (zoneId) cartItem.zone_id = String(zoneId);

            return {
                carts: [cartItem],
                accountDetails: order.account_details,
            };
        }

        if (vendorName === 'okeconnect') {
            return {
                variantId,
                sku: variantId,
                product: variantId,
                dest: note,
                target: note,
                zoneId,
                qty: order.account_details?.provider_qty,
                accountDetails: order.account_details,
            };
        }

        // Generic fallback for future vendors
        return {
            variantId,
            sku: variantId,
            product: variantId,
            dest: note,
            target: note,
            zoneId,
            accountDetails: order.account_details,
        };

    }

    /**
     * Claims the order atomically and processes fulfillment to vendor.
     * @param {Object} order The order object from database
     * @returns {Promise<{success: boolean, skipped?: boolean, message?: string}>}
     */
    async fulfillOrder(order) {
        const orderId = order.id;
        const variantId = order.vendor_variant_id || (order.sekalipay_variant_id ? String(order.sekalipay_variant_id) : null);
        let vendorName = order.vendor || order.account_details?.vendor;

        // Auto-detect vendor if missing or misattributed
        if (!vendorName || (vendorName === 'sekalipay' && variantId && isNaN(variantId))) {
            try {
                const { data: vRow } = await supabase
                    .from('product_variants')
                    .select('product_id, products(vendor)')
                    .eq('vendor_variant_id', variantId)
                    .maybeSingle();

                if (vRow?.products?.vendor) {
                    vendorName = vRow.products.vendor;
                    console.log(`[OrderFulfillment] Auto-corrected vendor for order ${orderId} to '${vendorName}'.`);
                }
            } catch (e) {
                console.warn('[OrderFulfillment] Vendor auto-lookup warning:', e.message);
            }
        }

        if (!vendorName) vendorName = 'sekalipay';
        console.log(`[OrderFulfillment] Claiming order ${orderId} for vendor '${vendorName}' (variant: ${variantId})...`);

        try {
            // 1. Atomic Claim: UPDATE ... WHERE id = ? AND status = 'PENDING'
            const { data: updatedOrders, error: updateError } = await supabase
                .from('orders')
                .update({ status: 'PROCESSING_LOCK', vendor: vendorName })
                .eq('id', orderId)
                .eq('status', 'PENDING')
                .select('id');

            if (updateError) {
                console.error(`[OrderFulfillment] Error during claim for order ${orderId}:`, updateError.message);
                return { success: false, message: 'Database error during claim' };
            }

            // 2. Skip if already claimed by another worker
            if (!updatedOrders || updatedOrders.length === 0) {
                console.log(`[OrderFulfillment] Skip — order ${orderId} already claimed (status != PENDING).`);
                return { success: true, skipped: true };
            }

            console.log(`[OrderFulfillment] Claim success for order ${orderId}. Processing to ${vendorName}...`);

            // 3. Resolve Vendor Adapter
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

            if (!variantId) {
                const errMsg = 'variant_id / sku tidak ditemukan di order';
                await supabase.from('orders').update({ status: 'FAILED', error_message: errMsg }).eq('id', orderId);
                return { success: false, message: errMsg };
            }


            // 4. Delegate to vendor adapter
            const orderPayload = this._buildOrderPayload(vendorName, order, variantId);
            const vendorResult = await vendorAdapter.createOrder(orderId, orderPayload);

            if (!vendorResult.success) {
                const errMsg = vendorResult.message || `Pesanan gagal di vendor ${vendorName}`;
                console.error(`[OrderFulfillment] Order ${orderId} failed on ${vendorName}:`, errMsg);

                await supabase
                    .from('orders')
                    .update({
                        status: 'FAILED',
                        error_message: errMsg,
                    })
                    .eq('id', orderId);

                return { success: false, message: errMsg };
            }

            const vendorOrderId = vendorResult.vendorOrderId || vendorResult.data?.ref_id || orderId;
            const vendorInvoice = vendorResult.invoice || vendorResult.data?.invoice || null;

            console.log(`[OrderFulfillment] Order ${orderId} processed on ${vendorName}. (Vendor Ref: ${vendorOrderId})`);

            const sn = vendorResult.sn || null;
            const updatedAccountDetails = {
                ...order.account_details,
                ...(sn ? { sn, serial_number: sn, licenses: [sn] } : {}),
            };

            // 5. Update order to PROCESSING
            await supabase
                .from('orders')
                .update({
                    status: 'PROCESSING',
                    vendor_status: 'pending',
                    vendor_order_id: vendorOrderId,
                    vendor_invoice: vendorInvoice || sn,
                    account_details: updatedAccountDetails,
                })
                .eq('id', orderId);

            return { success: true };


        } catch (err) {
            console.error(`[OrderFulfillment] Exception processing order ${orderId}:`, err);
            await supabase
                .from('orders')
                .update({ status: 'FAILED', error_message: err.message })
                .eq('id', orderId);

            return { success: false, message: err.message };
        }
    }
}

module.exports = new OrderFulfillmentService();
