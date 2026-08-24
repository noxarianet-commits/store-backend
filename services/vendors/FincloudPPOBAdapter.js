const VendorAdapter = require('./VendorAdapter');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Fincloud PPOB Adapter.
 * Handles integration with Fincloud PPOB API for digital goods & bill payments.
 */
class FincloudPPOBAdapter extends VendorAdapter {
    constructor() {
        super('fincloud');
        let base = process.env.FINCLOUD_BASE_URL || 'https://fincloud.my.id/api';
        if (!base.endsWith('/api')) {
            base = `${base.replace(/\/$/, '')}/api`;
        }
        this.baseURL = base;
        this.apiKey = process.env.FINCLOUD_PPOB_API_KEY || process.env.FINCLOUD_API_KEY || '';
    }

    /**
     * Helper to generate MD5 hash
     */
    _md5(string) {
        return crypto.createHash('md5').update(string).digest('hex');
    }

    /**
     * Send URL-encoded POST request
     */
    async _post(endpoint, data = {}) {
        const payload = new URLSearchParams({
            apikey: this.apiKey,
            ...data
        });

        try {
            const res = await axios.post(`${this.baseURL}${endpoint}`, payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000,
            });

            return {
                success: res.data.status === true || res.data.status === 'success' || (res.status >= 200 && res.status < 300),
                data: res.data,
                message: res.data.message || res.data.msg || '',
            };
        } catch (error) {
            if (error.response) {
                return {
                    success: false,
                    status: error.response.status,
                    message: error.response.data?.message || error.response.data?.msg || 'UNKNOWN_ERROR',
                    data: error.response.data,
                };
            }
            return {
                success: false,
                status: 0,
                message: 'NETWORK_ERROR',
                data: { error: error.message },
            };
        }
    }

    /**
     * Fetch products list from Fincloud PPOB.
     */
    async fetchProducts(params = {}) {
        const payload = {};
        if (params.category) payload.category = params.category;
        if (params.brand) payload.brand = params.brand;

        return await this._post('/ppob/products', payload);
    }

    /**
     * Fincloud PPOB does not have a separate product detail endpoint.
     */
    async fetchProductDetail(externalId) {
        return { success: true, data: null };
    }

    /**
     * Fincloud does not provide real-time stock endpoints, returns default available.
     */
    async checkStock(variantId) {
        return { success: true, available: true, stock: 9999 };
    }

    /**
     * Fincloud PPOB uses target without separate pre-validation endpoint.
     */
    async validateAccount(params = {}) {
        return { success: true, valid: true };
    }

    /**
     * Default available for validation services.
     */
    async checkValidationServices(params = {}) {
        return { success: true, available: true };
    }

    /**
     * Create PPOB order on Fincloud.
     * @param {string} refId - NX order ID (used as reff_id in Fincloud)
     * @param {Object} orderData - { sku, target }
     */
    async createOrder(refId, orderData) {
        const { sku, target } = orderData;
        if (!sku || !target) {
            throw new Error('Fincloud requires sku and target in orderData');
        }

        const signature = this._md5(`${this.apiKey}${refId}`);
        const res = await this._post('/ppob/order', {
            sku,
            target,
            uid: target,
            reff_id: refId,
            signature,
        });

        return {
            ...res,
            vendorOrderId: refId,
            invoice: res.data?.invoice || res.data?.sn || null,
        };
    }

    /**
     * Check status of order on Fincloud.
     */
    async checkOrderStatus(refId) {
        const signature = this._md5(`${this.apiKey}${refId}`);
        const res = await this._post('/ppob/status', {
            reff_id: refId,
            signature,
        });

        return {
            ...res,
            status: res.data?.status || res.data?.data?.status,
        };
    }

    /**
     * Get account balance from Fincloud.
     */
    async getBalance() {
        const res = await this._post('/cek_saldo');
        return {
            ...res,
            balance: res.data?.saldo || res.data?.balance || res.data?.data?.saldo,
        };
    }

    /**
     * Verify incoming webhook signature from Fincloud PPOB.
     */
    verifyWebhookSignature(payload, signature, secret) {
        if (!payload) return false;

        const { reff_id, nominal, status, rrn, signature_hmac } = payload;

        // Check MD5 signature first (basic validation)
        const expectedMd5 = this._md5(`${this.apiKey}${reff_id || ''}${status || ''}`);
        if (signature !== expectedMd5) return false;

        // If secret is provided and HMAC is present, verify high security signature
        if (secret && signature_hmac) {
            const dataString = `${reff_id || ''}.${nominal || ''}.${status || ''}.${rrn || ''}`;
            const expectedHmac = crypto.createHmac('sha256', secret)
                .update(dataString)
                .digest('hex');

            try {
                const bufSig = Buffer.from(signature_hmac, 'utf8');
                const bufExpected = Buffer.from(expectedHmac, 'utf8');
                if (bufSig.length !== bufExpected.length) return false;
                return crypto.timingSafeEqual(bufSig, bufExpected);
            } catch (e) {
                return false;
            }
        }

        return true;
    }

    /**
     * Parse webhook payload to standard event format.
     */
    parseWebhookEvent(body) {
        return {
            event: body.status === 'success' || body.status === 'sukses' ? 'order.completed' : 'order.status_update',
            vendorOrderId: body.reff_id,
            status: body.status,
            data: body,
        };
    }
}

module.exports = FincloudPPOBAdapter;
