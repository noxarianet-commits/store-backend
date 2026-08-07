const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../supabase');

class DyqrisGatewayService {
    async getConfig() {
        let baseURL = (process.env.DYQRIS_BASE_URL || '').replace(/\/+$/, '');
        let apiKey = (process.env.DYQRIS_API_KEY || '').trim();
        let webhookSecret = (process.env.DYQRIS_WEBHOOK_SECRET || process.env.MERCHANT_WEBHOOK_SECRET || '').trim();
        let expiryMinutes = 15;

        try {
            const { data } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'dyqris_config')
                .maybeSingle();

            if (data && data.value) {
                let conf = data.value;
                if (typeof conf === 'string') {
                    try { conf = JSON.parse(conf); } catch (e) {}
                }
                if (conf && typeof conf === 'object') {
                    if (conf.base_url) baseURL = conf.base_url.replace(/\/+$/, '');
                    if (conf.api_key) apiKey = conf.api_key.trim();
                    if (conf.webhook_secret) webhookSecret = conf.webhook_secret.trim();
                    if (conf.expiry_minutes) expiryMinutes = parseInt(conf.expiry_minutes, 10) || 15;
                }
            }
        } catch (err) {
            console.error('[DyqrisGatewayService] Error reading config from DB:', err.message);
        }

        return { baseURL, apiKey, webhookSecret, expiryMinutes };
    }

    /**
     * POST /v1/transactions — buat tagihan Dyqris baru
     */
    async createTransaction({ refId, amount, expiryMinutes, metadata }) {
        const { baseURL, apiKey, expiryMinutes: defaultExpiry } = await this.getConfig();

        if (!baseURL || !apiKey) {
            return {
                success: false,
                status: 400,
                message: 'API Key atau Base URL Dyqris belum dikonfigurasi di Admin Settings / .env'
            };
        }

        const payload = {
            ref_id: refId,
            amount: parseInt(amount, 10),
            expiry_minutes: expiryMinutes || defaultExpiry || 15,
            metadata: metadata || {}
        };

        try {
            console.log('[DyqrisGatewayService] Creating transaction payload:', JSON.stringify(payload, null, 2));
            const response = await axios.post(`${baseURL}/v1/transactions`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                timeout: 15000
            });

            // Respon 201 Created atau 200 OK (duplikat ref_id)
            if (response.data && (response.status === 201 || response.status === 200)) {
                return {
                    success: true,
                    data: response.data
                };
            }

            const errorMsg = response.data?.message || response.data?.error || 'Gagal membuat transaksi Dyqris';
            return {
                success: false,
                status: response.status || 500,
                message: errorMsg
            };
        } catch (err) {
            const errData = err.response?.data;
            console.error('[DyqrisGatewayService] createTransaction error:', JSON.stringify(errData, null, 2) || err.message);

            const errorMsg = errData?.message || errData?.error || err.message || 'Error koneksi ke API Dyqris';
            return {
                success: false,
                status: err.response?.status || 500,
                message: errorMsg
            };
        }
    }

    /**
     * GET /v1/transactions/:id — cek status transaksi (polling)
     */
    async getTransactionDetails(id) {
        const { baseURL, apiKey } = await this.getConfig();

        if (!baseURL || !apiKey) {
            return { success: false, message: 'API Key atau Base URL Dyqris belum dikonfigurasi' };
        }

        try {
            const response = await axios.get(`${baseURL}/v1/transactions/${id}`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                },
                timeout: 10000
            });

            if (response.data && (response.data.id || response.data.status)) {
                return {
                    success: true,
                    data: response.data
                };
            }

            return { success: false, message: 'Transaksi Dyqris tidak ditemukan' };
        } catch (err) {
            console.error('[DyqrisGatewayService] getTransactionDetails error:', err.response?.data || err.message);
            return { success: false, message: err.message };
        }
    }

    /**
     * Verifikasi signature webhook HMAC-SHA256
     * Signature format: sha256=<hex> atau <hex>
     */
    verifyWebhookSignature(rawBody, signatureHeader, secret) {
        if (!signatureHeader || !secret) {
            console.error('[DyqrisGatewayService] Missing signatureHeader or secret for verification');
            return false;
        }

        try {
            const expectedHex = crypto
                .createHmac('sha256', secret)
                .update(rawBody)
                .digest('hex');

            const cleanSignature = signatureHeader.replace(/^sha256=/, '').trim();

            const expectedBuf = Buffer.from(expectedHex, 'utf8');
            const receivedBuf = Buffer.from(cleanSignature, 'utf8');

            if (expectedBuf.length !== receivedBuf.length) return false;

            return crypto.timingSafeEqual(expectedBuf, receivedBuf);
        } catch (err) {
            console.error('[DyqrisGatewayService] Signature verification error:', err.message);
            return false;
        }
    }
}

module.exports = new DyqrisGatewayService();
