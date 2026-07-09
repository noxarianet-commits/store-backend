class VendorAdapter {
    constructor(name) {
        this.name = name;
    }

    /**
     * Fetch products from the vendor API.
     * @param {Object} params - Query parameters
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async fetchProducts(params = {}) {
        throw new Error('fetchProducts() not implemented');
    }

    /**
     * Create an order/transaction.
     * @param {string} refId - Unique reference ID from our system
     * @param {Object} orderData - Vendor-specific order payload
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async createOrder(refId, orderData) {
        throw new Error('createOrder() not implemented');
    }

    /**
     * Check status of an existing order.
     * @param {string} refId - Reference ID or vendor invoice ID
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async checkOrderStatus(refId) {
        throw new Error('checkOrderStatus() not implemented');
    }

    /**
     * Validate customer account/ID.
     * @param {Object} params - Validation parameters
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async validateAccount(params) {
        throw new Error('validateAccount() not implemented');
    }

    /**
     * Get vendor account balance.
     * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
     */
    async getBalance() {
        throw new Error('getBalance() not implemented');
    }

    /**
     * Verify incoming webhook signature.
     * @param {Object} payload - Webhook payload/body
     * @param {string} signature - Signature from headers/body
     * @param {string} secret - Webhook secret key
     * @returns {boolean}
     */
    verifyWebhookSignature(payload, signature, secret) {
        throw new Error('verifyWebhookSignature() not implemented');
    }
}

module.exports = VendorAdapter;
