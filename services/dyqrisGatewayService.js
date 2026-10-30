const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../supabase');
const { logger } = require('../utils/logger');

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
            logger.error('dyqris_config_read_failed', { message: err.message });
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
            logger.debug('dyqris_transaction_creating', {
                refId,
                amount: payload.amount,
                expiryMinutes: payload.expiry_minutes,
            });
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
            logger.error('dyqris_create_transaction_failed', {
                refId,
                status: err.response?.status,
                message: errData?.message || errData?.error || err.message,
            });

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
            logger.error('dyqris_get_transaction_failed', {
                transactionId: id,
                status: err.response?.status,
                message: err.response?.data?.message || err.message,
            });
            return { success: false, message: err.message };
        }
    }

    /**
     * Verifikasi signature webhook HMAC-SHA256
     * Signature format: sha256=<hex> atau <hex>
     */
    verifyWebhookSignature(rawBody, signatureHeader, secret) {
        if (!signatureHeader || !secret) {
            logger.warn('dyqris_webhook_signature_config_missing');
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
            logger.error('dyqris_webhook_signature_failed', { message: err.message });
            return false;
        }
    }
}

module.exports = new DyqrisGatewayService();
