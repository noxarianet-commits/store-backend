const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../supabase');

class SayabayarGatewayService {
    async getConfig() {
        let baseURL = (process.env.SAYABAYAR_BASE_URL || 'https://api.sayabayar.com/v1').replace(/\/+$/, '');
        let apiKey = (process.env.SAYABAYAR_API_KEY || '').trim();
        let webhookSecret = (process.env.SAYABAYAR_WEBHOOK_SECRET || '').trim();
        let channelPreference = 'platform';
        let paymentMethod = 'qris';

        try {
            const { data } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'sayabayar_config')
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
                    if (conf.channel_preference) channelPreference = conf.channel_preference;
                    if (conf.payment_method) paymentMethod = conf.payment_method;
                }
            }
        } catch (err) {
            console.error('[SayabayarGatewayService] Error reading config from DB:', err.message);
        }

        return { baseURL, apiKey, webhookSecret, channelPreference, paymentMethod };
    }

    async createInvoice({ customer_name, customer_email, amount, description, payment_method, redirect_url, expired_at }) {
        const { baseURL, apiKey, channelPreference, paymentMethod: defaultMethod } = await this.getConfig();

        if (!apiKey) {
            return {
                success: false,
                status: 400,
                message: 'API Key Saya Bayar belum dikonfigurasi di Admin Settings / .env'
            };
        }

        const payload = {
            customer_name: customer_name || 'Pelanggan NoxariaNet',
            customer_email: customer_email || 'customer@noxarianet.web.id',
            amount: parseInt(amount, 10),
            description: description || 'Pembelian Produk NoxariaNet',
            channel_preference: channelPreference,
            payment_method: payment_method || defaultMethod || 'qris'
        };

        if (redirect_url) payload.redirect_url = redirect_url;
        if (expired_at) payload.expired_at = expired_at;

        try {
            const response = await axios.post(`${baseURL}/invoices`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey
                },
                timeout: 15000
            });

            if (response.data && response.data.success) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            return {
                success: false,
                status: response.status || 500,
                message: response.data?.error?.message || 'Gagal membuat invoice Saya Bayar'
            };
        } catch (err) {
            console.error('[SayabayarGatewayService] createInvoice error:', err.response?.data || err.message);
            return {
                success: false,
                status: err.response?.status || 500,
                message: err.response?.data?.error?.message || err.message || 'Error koneksi ke API Saya Bayar'
            };
        }
    }

    async getInvoiceDetails(id) {
        const { baseURL, apiKey } = await this.getConfig();

        if (!apiKey) {
            return { success: false, message: 'API Key Saya Bayar belum dikonfigurasi' };
        }

        try {
            const response = await axios.get(`${baseURL}/invoices/${id}`, {
                headers: { 'X-API-Key': apiKey },
                timeout: 10000
            });

            if (response.data && response.data.success) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            return { success: false, message: response.data?.error?.message || 'Invoice tidak ditemukan' };
        } catch (err) {
            console.error('[SayabayarGatewayService] getInvoiceDetails error:', err.response?.data || err.message);
            return { success: false, message: err.message };
        }
    }

    verifyWebhookSignature(payloadString, signature, secret) {
        if (!signature || !secret) return false;

        try {
            const expected = crypto
                .createHmac('sha256', secret)
                .update(payloadString)
                .digest('hex');

            return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        } catch (err) {
            console.error('[SayabayarGatewayService] Signature verification error:', err.message);
            return false;
        }
    }

    async getBalance() {
        const { baseURL, apiKey } = await this.getConfig();
        if (!apiKey) return { success: false, message: 'API Key belum dikonfigurasi' };

        try {
            const response = await axios.get(`${baseURL}/balance`, {
                headers: { 'X-API-Key': apiKey },
                timeout: 10000
            });
            return response.data;
        } catch (err) {
            return { success: false, message: err.message };
        }
    }
}

module.exports = new SayabayarGatewayService();
