const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../supabase');

/**
 * SekalipayGatewayService — Client untuk Sekalipay Payment Gateway API.
 *
 * Base URL: https://sekalipay.com/api/v1/gateway
 * Auth:
 *   - Header `X-API-Key`: Merchant API Key (mk_...)
 *   - Header `X-Signature`: HMAC-SHA256(raw_json_body, secret_key) untuk POST request
 *
 * Endpoints:
 *   GET  /merchant/info       — Cek informasi akun & saldo merchant
 *   GET  /payment-methods     — Ambil daftar metode pembayaran aktif
 *   POST /payment             — Buat transaksi pembayaran baru (QRIS / QRISREALTIME / QRIS_CUSTOM)
 *   GET  /payment/:ref_id     — Cek status pembayaran berdasarkan merchant_ref_id
 *   POST /withdrawal          — Tarik dana / settlement ke rekening terdaftar
 */
class SekalipayGatewayService {
    /**
     * Ambil konfigurasi Sekalipay Gateway dari database settings atau fallback ke .env.
     */
    async getConfig() {
        let baseURL = (
            process.env.SEKALIPAY_GATEWAY_BASE_URL ||
            'https://sekalipay.com/api/v1/gateway'
        ).replace(/\/+$/, '');
        let apiKey = (
            process.env.SEKALIPAY_GATEWAY_API_KEY ||
            process.env.SEKALIPAY_API_KEY ||
            ''
        ).trim();
        let secretKey = (
            process.env.SEKALIPAY_GATEWAY_SECRET_KEY ||
            process.env.SEKALIPAY_WEBHOOK_SECRET ||
            ''
        ).trim();
        let merchantCode = (
            process.env.SEKALIPAY_MERCHANT_CODE ||
            ''
        ).trim();
        let paymentCode = 'QRIS';

        try {
            const { data } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'sekalipay_gateway_config')
                .maybeSingle();

            if (data && data.value) {
                let conf = data.value;
                if (typeof conf === 'string') {
                    try { conf = JSON.parse(conf); } catch (e) {}
                }
                if (conf && typeof conf === 'object') {
                    if (conf.base_url) baseURL = conf.base_url.replace(/\/+$/, '');
                    if (conf.api_key) apiKey = conf.api_key.trim();
                    if (conf.secret_key) secretKey = conf.secret_key.trim();
                    if (conf.merchant_code) merchantCode = conf.merchant_code.trim();
                    if (conf.payment_code) paymentCode = conf.payment_code.trim();
                }
            }
        } catch (err) {
            console.error('[SekalipayGatewayService] Error reading config from DB:', err.message);
        }

        return { baseURL, apiKey, secretKey, merchantCode, paymentCode };
    }

    /**
     * Generate HMAC-SHA256 signature dari raw JSON body string.
     * @param {string} rawBody
     * @param {string} secretKey
     * @returns {string} hex digest
     */
    generateSignature(rawBody, secretKey) {
        if (!secretKey) return '';
        const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
        return crypto.createHmac('sha256', secretKey).update(bodyStr).digest('hex');
    }

    /**
     * Verifikasi webhook signature dari Sekalipay Gateway.
     * @param {string|object} rawBody
     * @param {string} receivedSignature
     * @param {string} secretKey
     * @returns {boolean}
     */
    verifyWebhookSignature(rawBody, receivedSignature, secretKey) {
        if (!receivedSignature || !secretKey) return false;

        try {
            const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
            const expected = this.generateSignature(bodyStr, secretKey);

            const bufReceived = Buffer.from(receivedSignature, 'utf8');
            const bufExpected = Buffer.from(expected, 'utf8');

            if (bufReceived.length !== bufExpected.length) return false;
            return crypto.timingSafeEqual(bufReceived, bufExpected);
        } catch (err) {
            console.error('[SekalipayGatewayService] Signature verification error:', err.message);
            return false;
        }
    }

    /**
     * POST /payment
     * Buat transaksi pembayaran QRIS baru di Sekalipay Gateway.
     */
    async createPayment({
        merchant_ref_id,
        amount,
        payment_code,
        customer_name,
        customer_email,
        customer_phone,
        callback_url,
        return_url,
        access_token,
        metadata
    }) {
        const config = await this.getConfig();
        const { baseURL, apiKey, secretKey, paymentCode: defaultPaymentCode } = config;

        if (!apiKey || !secretKey) {
            return {
                success: false,
                status: 400,
                message: 'Kredensial Sekalipay Gateway (API Key & Secret Key) belum dikonfigurasi di Admin Settings / .env'
            };
        }

        const chosenPaymentCode = payment_code || defaultPaymentCode || 'QRIS';

        // Sanitasi nama pelanggan
        let formattedName = (customer_name || 'Pelanggan').trim();
        if (/^\d+$/.test(formattedName)) {
            formattedName = `Pelanggan ${formattedName}`;
        }

        const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

        const payload = {
            merchant_ref_id,
            amount: parseInt(amount, 10),
            payment_code: chosenPaymentCode,
            customer_name: formattedName,
            customer_email: customer_email || 'customer@noxarianet.web.id',
            customer_phone: customer_phone || '08123456789',
            callback_url: callback_url || `${backendUrl}/api/webhooks/sekalipay-gateway`,
            return_url: return_url || `${frontendUrl}/checkout/success?order_id=${merchant_ref_id}${access_token ? `&access_token=${encodeURIComponent(access_token)}` : ''}`,
            metadata: metadata || {
                source: 'website',
                order_id: merchant_ref_id
            }
        };

        const rawBody = JSON.stringify(payload);
        const signature = this.generateSignature(rawBody, secretKey);

        try {
            console.log(`[SekalipayGatewayService] Creating payment (${chosenPaymentCode}) for ref=${merchant_ref_id}, amount=${amount}`);

            const response = await axios.post(`${baseURL}/payment`, rawBody, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey,
                    'X-Signature': signature
                },
                timeout: 20000
            });

            if (response.data && (response.data.status === true || response.data.status === 1 || response.status === 201 || response.status === 200)) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            const errorMsg = response.data?.message || 'Gagal membuat pembayaran di Sekalipay Gateway';
            return {
                success: false,
                status: response.status || 500,
                message: errorMsg
            };
        } catch (err) {
            const errData = err.response?.data;
            console.error('[SekalipayGatewayService] createPayment error:', JSON.stringify(errData, null, 2) || err.message);

            const errorMsg = errData?.message || errData?.error || err.message || 'Error koneksi ke API Sekalipay Gateway';
            return {
                success: false,
                status: err.response?.status || 500,
                message: errorMsg
            };
        }
    }

    /**
     * Helper untuk mencari merchant_ref_id asli jika input berupa nomor invoice Sekalipay (SPY... / INV/...).
     * Sekalipay Gateway API GET /payment/:merchant_ref_id membutuhkan merchant_ref_id kita, bukan nomor invoice Sekalipay.
     * @param {string} identifier 
     * @returns {Promise<string>}
     */
    async resolveMerchantRefId(identifier) {
        if (!identifier || typeof identifier !== 'string') return identifier;
        const trimmed = identifier.trim();

        try {
            // 1. Cek di balance_transactions (topup saldo)
            const { data: tx } = await supabase
                .from('balance_transactions')
                .select('reference_id')
                .eq('pg_invoice', trimmed)
                .maybeSingle();

            if (tx && tx.reference_id) {
                return tx.reference_id;
            }

            // 2. Cek di orders
            const { data: order } = await supabase
                .from('orders')
                .select('id')
                .eq('pg_invoice', trimmed)
                .maybeSingle();

            if (order && order.id) {
                return order.id;
            }
        } catch (dbErr) {
            console.warn('[SekalipayGatewayService] resolveMerchantRefId DB lookup warning:', dbErr.message);
        }

        return trimmed;
    }

    /**
     * GET /payment/:merchant_ref_id
     * Cek status pembayaran transaksi via merchant_ref_id.
     * Menerima merchant_ref_id atau invoice number (SPY... / INV/...) dengan resolusi otomatis.
     */
    async checkPaymentStatus(merchantRefId) {
        if (!merchantRefId) {
            return { success: false, message: 'merchantRefId tidak boleh kosong' };
        }

        const { baseURL, apiKey } = await this.getConfig();

        if (!apiKey) {
            return { success: false, message: 'API Key Sekalipay Gateway belum dikonfigurasi' };
        }

        // Jika identifier memiliki format invoice Sekalipay (diawali SPY atau INV), resolve ke merchant_ref_id asli terlebih dahulu
        let targetRefId = String(merchantRefId).trim();
        if (/^(SPY|INV[\/_])/i.test(targetRefId)) {
            const resolved = await this.resolveMerchantRefId(targetRefId);
            if (resolved && resolved !== targetRefId) {
                console.log(`[SekalipayGatewayService] Resolving invoice ${targetRefId} -> merchant_ref_id: ${resolved}`);
                targetRefId = resolved;
            }
        }

        try {
            const response = await axios.get(`${baseURL}/payment/${encodeURIComponent(targetRefId)}`, {
                headers: {
                    'X-API-Key': apiKey
                },
                timeout: 10000
            });

            if (response.data && (response.data.status === true || response.data.status === 1 || response.status === 200)) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            return {
                success: false,
                message: response.data?.message || 'Transaksi tidak ditemukan di Sekalipay Gateway'
            };
        } catch (err) {
            const errData = err.response?.data;

            // Fallback: Jika gagal dengan PAYMENT_NOT_FOUND atau 404, coba cari di DB jika belum di-resolve
            if (targetRefId === merchantRefId && (errData?.message === 'PAYMENT_NOT_FOUND' || err.response?.status === 404)) {
                const resolved = await this.resolveMerchantRefId(merchantRefId);
                if (resolved && resolved !== merchantRefId) {
                    console.log(`[SekalipayGatewayService] Fallback resolving invoice ${merchantRefId} -> merchant_ref_id: ${resolved}`);
                    try {
                        const retryResponse = await axios.get(`${baseURL}/payment/${encodeURIComponent(resolved)}`, {
                            headers: {
                                'X-API-Key': apiKey
                            },
                            timeout: 10000
                        });

                        if (retryResponse.data && (retryResponse.data.status === true || retryResponse.data.status === 1 || retryResponse.status === 200)) {
                            return {
                                success: true,
                                data: retryResponse.data.data
                            };
                        }
                    } catch (retryErr) {
                        console.error(`[SekalipayGatewayService] Retry checkPaymentStatus(${resolved}) error:`, retryErr.response?.data || retryErr.message);
                    }
                }
            }

            const errorMsg = errData?.message || errData?.error || err.message;
            console.error(`[SekalipayGatewayService] checkPaymentStatus(${merchantRefId}) error:`, errData || err.message);
            return { success: false, message: errorMsg };
        }
    }

    /**
     * GET /payment-methods
     * Ambil daftar metode pembayaran aktif di Sekalipay Gateway.
     */
    async getPaymentMethods() {
        const { baseURL, apiKey } = await this.getConfig();

        if (!apiKey) {
            return { success: false, message: 'API Key Sekalipay Gateway belum dikonfigurasi' };
        }

        try {
            const response = await axios.get(`${baseURL}/payment-methods`, {
                headers: {
                    'X-API-Key': apiKey
                },
                timeout: 10000
            });

            if (response.data && (response.data.status === true || response.data.status === 1)) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            return {
                success: false,
                message: response.data?.message || 'Gagal mengambil payment methods'
            };
        } catch (err) {
            return { success: false, message: err.message };
        }
    }

    /**
     * GET /merchant/info
     * Ambil info merchant, saldo tersedia, saldo tertahan, status, dll.
     */
    async getMerchantInfo() {
        const { baseURL, apiKey } = await this.getConfig();

        if (!apiKey) {
            return { success: false, message: 'API Key Sekalipay Gateway belum dikonfigurasi' };
        }

        try {
            const response = await axios.get(`${baseURL}/merchant/info`, {
                headers: {
                    'X-API-Key': apiKey
                },
                timeout: 10000
            });

            if (response.data && (response.data.status === true || response.data.status === 1 || response.data.rc === 200)) {
                return {
                    success: true,
                    data: response.data.data
                };
            }

            return {
                success: false,
                message: response.data?.message || 'Gagal mengambil info merchant'
            };
        } catch (err) {
            return { success: false, message: err.message };
        }
    }
}

module.exports = new SekalipayGatewayService();
