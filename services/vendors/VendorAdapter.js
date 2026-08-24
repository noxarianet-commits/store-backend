/**
 * Abstract Base Class for Vendor Adapters.
 * All vendor implementations (Sekalipay, Fincloud, etc.) must extend this class.
 */
class VendorAdapter {
    constructor(name) {
        this.name = name;
    }

    /**
     * Vendor identifier name (e.g. 'sekalipay', 'fincloud')
     */
    get vendorName() {
        return this.name;
    }

    /**
     * Fetch products from the vendor API.
     * @param {Object} params - Query parameters (e.g. { type: 'full'|'delta', updatedSince, category })
     * @returns {Promise<{ success: boolean, data?: any, message?: string, serverTime?: string }>}
     */
    async fetchProducts(params = {}) {
        throw new Error(`fetchProducts() not implemented for vendor '${this.name}'`);
    }

    /**
     * Fetch single product detail from vendor if supported.
     * @param {string|number} externalId
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async fetchProductDetail(externalId) {
        throw new Error(`fetchProductDetail() not implemented for vendor '${this.name}'`);
    }

    /**
     * Create an order/transaction with the vendor.
     * @param {string} refId - Unique reference ID from our system (NX-...)
     * @param {Object} orderData - Vendor order payload
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async createOrder(refId, orderData) {
        throw new Error(`createOrder() not implemented for vendor '${this.name}'`);
    }

    /**
     * Check status of an existing order from vendor.
     * @param {string} refId - Reference ID or vendor invoice ID
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async checkOrderStatus(refId) {
        throw new Error(`checkOrderStatus() not implemented for vendor '${this.name}'`);
    }

    /**
     * Cancel an order with vendor if supported.
     * @param {string} refId
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async cancelOrder(refId) {
        return { success: false, message: 'Cancel not supported by vendor' };
    }

    /**
     * Real-time stock check for a variant before creating payment/invoice.
     * Default returns available: true with default stock for vendors without stock APIs.
     * @param {string|number} variantId
     * @returns {Promise<{ success: boolean, available: boolean, stock?: number, data?: any, message?: string }>}
     */
    async checkStock(variantId) {
        return { success: true, available: true, stock: 9999 };
    }

    /**
     * Validate customer account/user ID before checkout (e.g. game ID validation).
     * @param {Object} params - { variantId, customerId, zoneId, ... }
     * @returns {Promise<{ success: boolean, valid: boolean, message?: string, data?: any }>}
     */
    async validateAccount(params) {
        return { success: true, valid: true };
    }

    /**
     * Check if validation service is online/active for a product or category.
     * @param {Object|string} params
     * @returns {Promise<{ success: boolean, available: boolean, data?: any, message?: string }>}
     */
    async checkValidationServices(params) {
        return { success: true, available: true };
    }

    /**
     * Get vendor account balance.
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async getBalance() {
        return { success: false, message: 'getBalance() not implemented' };
    }

    /**
     * Verify incoming webhook signature.
     * @param {Object} payload - Webhook payload/body
     * @param {string} signature - Signature from headers/body
     * @param {string} secret - Webhook secret key
     * @returns {boolean}
     */
    verifyWebhookSignature(payload, signature, secret) {
        throw new Error(`verifyWebhookSignature() not implemented for vendor '${this.name}'`);
    }

    /**
     * Parse raw webhook payload into a normalized structure.
     * @param {Object} body
     * @param {Object} headers
     * @returns {{ event: string, vendorOrderId: string, status?: string, data?: any }}
     */
    parseWebhookEvent(body, headers) {
        throw new Error(`parseWebhookEvent() not implemented for vendor '${this.name}'`);
    }
}

module.exports = VendorAdapter;
