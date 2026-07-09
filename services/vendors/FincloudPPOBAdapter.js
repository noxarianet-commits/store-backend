const VendorAdapter = require('./VendorAdapter');
const axios = require('axios');
const crypto = require('crypto');

class FincloudPPOBAdapter extends VendorAdapter {
    constructor() {
        super('fincloud');
        // Pastikan baseURL selalu berujung ke /api
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
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            // Adapt fincloud response format to match VendorAdapter expectation
            // FinCloud usually returns HTTP status 200/400 and JSON body
            return {
                success: res.data.status === true || res.data.status === 'success' || (res.status >= 200 && res.status < 300),
                data: res.data,
                message: res.data.message || res.data.msg || ''
            };
        } catch (error) {
            if (error.response) {
                return {
                    success: false,
                    status: error.response.status,
                    message: error.response.data?.message || error.response.data?.msg || 'UNKNOWN_ERROR',
                    data: error.response.data
                };
            }
            return {
                success: false,
                status: 0,
                message: 'NETWORK_ERROR',
                data: { error: error.message }
            };
        }
    }

    async fetchProducts(params = {}) {
        const payload = {};
        if (params.category) payload.category = params.category;
        if (params.brand) payload.brand = params.brand;
        
        return await this._post('/ppob/products', payload);
    }

    async createOrder(refId, orderData) {
        const { sku, target } = orderData;
        if (!sku || !target) {
            throw new Error('Fincloud requires sku and target in orderData');
        }

        const signature = this._md5(`${this.apiKey}${refId}`);
        return await this._post('/ppob/order', {
            sku,
            target,
            uid: target,
            reff_id: refId,
            signature
        });
    }

    async checkOrderStatus(refId) {
        const signature = this._md5(`${this.apiKey}${refId}`);
        return await this._post('/ppob/status', {
            reff_id: refId,
            signature
        });
    }

    async validateAccount(params) {
        // Fincloud PPOB documentation does not mention account validation endpoints
        throw new Error('validateAccount() not supported by Fincloud PPOB');
    }

    async getBalance() {
        return await this._post('/cek_saldo'); // Note: For PPOB check balance? Or is it same as PG balance?
    }

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
        
        // If we reach here, MD5 matched and HMAC wasn't strictly required
        return true;
    }
}

module.exports = FincloudPPOBAdapter;
