const axios = require('axios');
const crypto = require('crypto');

/**
 * PaymentGatewayService — Client untuk Sekalipay Payment Gateway API.
 *
 * Base URL: https://sekalipay.com/api/v1/gateway
 * Auth: X-API-Key header + X-Signature (HMAC-SHA256 dari raw JSON body) untuk POST
 */
class PaymentGatewayService {
    constructor() {
        this.baseURL =
            process.env.SEKALIPAY_GATEWAY_BASE_URL ||
            'https://sekalipay.com/api/v1/gateway';
        this.apiKey = (process.env.SEKALIPAY_GATEWAY_API_KEY || '').trim();
        this.secretKey = (process.env.SEKALIPAY_GATEWAY_SECRET_KEY || '').trim();
        this.merchantCode =
            process.env.SEKALIPAY_MERCHANT_CODE || 'MCH-B8ISMW';

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                Accept: 'application/json',
                'X-API-Key': this.apiKey,
            },
            timeout: 30000,
        });
    }

    // ══════════════════════════════════════════════════════════════
    // SIGNATURE
    // ══════════════════════════════════════════════════════════════

    /**
     * Generate HMAC-SHA256 signature dari raw JSON string body.
     * Wajib untuk semua POST request.
     *
     * @param {string} bodyString - Raw JSON string
     * @returns {string} HMAC-SHA256 hex digest
     */
    generateSignature(bodyString) {
        return crypto
            .createHmac('sha256', this.secretKey)
            .update(bodyString)
            .digest('hex');
    }

    /**
     * Verifikasi HMAC-SHA256 signature dari webhook callback PG.
     * Digunakan di webhookController untuk memastikan request sah.
     *
     * @param {string|Buffer} rawBody - Raw body string dari request
     * @param {string} receivedSignature - Nilai header X-Signature
     * @returns {boolean}
     */
    verifyWebhookSignature(rawBody, receivedSignature) {
        if (!receivedSignature) {
            console.error('[PaymentGatewayService] No X-Signature header received');
            return false;
        }
        const bodyString =
            typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        
        const expected = this.generateSignature(bodyString);
        const bufA = Buffer.from(expected, 'utf8');
        const bufB = Buffer.from(receivedSignature, 'utf8');
        
        if (bufA.length !== bufB.length) {
            console.error(`[PaymentGatewayService] Signature length mismatch. Expected: ${expected} | Received: ${receivedSignature}`);
            return false;
        }
        const isValid = crypto.timingSafeEqual(bufA, bufB);
        if (!isValid) {
            console.error(`[PaymentGatewayService] Signature mismatch!`);
            console.error(`  Expected (with SecretKey): ${expected}`);
            console.error(`  Received:                  ${receivedSignature}`);
            
            // Try with alternative keys for debugging
            const sigApiKey = crypto.createHmac('sha256', this.apiKey).update(bodyString).digest('hex');
            const webhookSecret = (process.env.SEKALIPAY_WEBHOOK_SECRET || '').trim();
            const sigWebhookSecret = webhookSecret ? crypto.createHmac('sha256', webhookSecret).update(bodyString).digest('hex') : 'N/A';
            
            console.error(`  With API Key:              ${sigApiKey}`);
            console.error(`  With Webhook Secret:       ${sigWebhookSecret}`);
            
            console.error(`  Raw body length: ${bodyString.length}`);
            console.error(`  Raw body sample: ${bodyString.substring(0, 100)}...${bodyString.substring(bodyString.length - 20)}`);
        }
        return isValid;
    }

    // ══════════════════════════════════════════════════════════════
    // ERROR HANDLER
    // ══════════════════════════════════════════════════════════════

    _handleError(error, context) {
        if (error.response) {
            const { status, data } = error.response;
            console.error(
                `[PaymentGatewayService] ${context} — HTTP ${status}:`,
                data
            );
            return {
                success: false,
                status,
                message: data?.message || 'UNKNOWN_ERROR',
                errors: data?.errors || null,
            };
        }
        console.error(
            `[PaymentGatewayService] ${context} — Network error:`,
            error.message
        );
        return {
            success: false,
            status: 0,
            message: 'NETWORK_ERROR',
            errors: { network: [error.message] },
        };
    }

    // ══════════════════════════════════════════════════════════════
    // MERCHANT INFO
    // ══════════════════════════════════════════════════════════════

    /**
     * GET /merchant/info
     * Ambil info merchant (saldo, status, sandbox mode).
     *
     * @returns {{ success: boolean, data?: object }}
     */
    async getMerchantInfo() {
        try {
            const res = await this.client.get('/merchant/info');
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'getMerchantInfo');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // PAYMENT METHODS
    // ══════════════════════════════════════════════════════════════

    /**
     * GET /payment-methods
     * Ambil daftar metode pembayaran aktif (QRIS, VA, dll).
     * Tidak butuh signature.
     *
     * @returns {{ success: boolean, data?: Array }}
     */
    async getPaymentMethods() {
        try {
            const res = await this.client.get('/payment-methods');
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'getPaymentMethods');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CREATE PAYMENT
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /payment
     * Buat transaksi pembayaran baru.
     * Otomatis menambahkan X-Signature HMAC-SHA256 dari body.
     *
     * @param {object} paymentData
     * @param {string} paymentData.merchant_ref_id - ID unik dari sistem kita (= order.id)
     * @param {number} paymentData.amount          - Harga produk (tanpa fee)
     * @param {string} paymentData.payment_code    - Kode metode bayar (QRIS, BCAVA, dll)
     * @param {string} paymentData.customer_name
     * @param {string} paymentData.customer_email
     * @param {string} paymentData.customer_phone
     * @param {string} paymentData.callback_url   - URL webhook backend
     * @param {string} paymentData.return_url      - Redirect setelah bayar
     * @param {object} [paymentData.metadata]      - Data tambahan (opsional)
     * @returns {{ success: boolean, data?: object }}
     */
    async createPayment(paymentData) {
        try {
            const bodyString = JSON.stringify(paymentData);
            const signature = this.generateSignature(bodyString);

            const res = await this.client.post('/payment', bodyString, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature': signature,
                },
            });

            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'createPayment');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CHECK PAYMENT STATUS
    // ══════════════════════════════════════════════════════════════

    /**
     * GET /payment/{merchant_ref_id}
     * Cek status pembayaran. Berguna saat webhook belum diterima.
     *
     * @param {string} merchantRefId - merchant_ref_id yang dipakai saat createPayment
     * @returns {{ success: boolean, data?: object }}
     */
    async checkPaymentStatus(merchantRefId) {
        try {
            const res = await this.client.get(`/payment/${merchantRefId}`);
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, `checkPaymentStatus(${merchantRefId})`);
        }
    }
}

module.exports = new PaymentGatewayService();
