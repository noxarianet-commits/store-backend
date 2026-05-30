/* eslint-disable no-unused-vars */
const axios = require('axios');
const crypto = require('crypto');

/**
 * PaymentGatewayService — Stub for Sekalipay Payment Gateway API.
 * 
 * Base URL: https://sekalipay.com/api/v1/gateway
 * Auth: X-API-Key header + X-Signature (HMAC-SHA256 of request body)
 * 
 * TODO: Implement when ready to accept customer payments.
 * See Payment_Gateway_MCH-B8ISMW.json for full endpoint details.
 */
class PaymentGatewayService {
    constructor() {
        this.baseURL = process.env.SEKALIPAY_GATEWAY_BASE_URL || 'https://sekalipay.com/api/v1/gateway';
        this.apiKey = process.env.SEKALIPAY_GATEWAY_API_KEY || '';
        this.secretKey = process.env.SEKALIPAY_GATEWAY_SECRET_KEY || '';
        this.merchantCode = process.env.SEKALIPAY_MERCHANT_CODE || 'MCH-B8ISMW';

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Accept': 'application/json',
                'X-API-Key': this.apiKey,
            },
            timeout: 30000,
        });
    }

    /**
     * Generate HMAC-SHA256 signature from request body JSON string.
     * Required for POST endpoints (Create Payment, Withdrawal).
     * 
     * @param {string} bodyString - Raw JSON string of request body
     * @returns {string} HMAC-SHA256 hex digest
     */
    generateSignature(bodyString) {
        return crypto
            .createHmac('sha256', this.secretKey)
            .update(bodyString)
            .digest('hex');
    }

    /**
     * Get merchant account info (balance, status, etc.).
     * Auth: X-API-Key only (no signature needed).
     * 
     * @returns {Promise<object>}
     */
    async getMerchantInfo() {
        // TODO: Implement
        // GET /merchant/info
        throw new Error('PaymentGatewayService.getMerchantInfo() not yet implemented');
    }

    /**
     * Get available payment methods (QRIS, VA, etc.).
     * No signature required.
     * 
     * @returns {Promise<object>}
     */
    async getPaymentMethods() {
        // TODO: Implement
        // GET /payment-methods
        throw new Error('PaymentGatewayService.getPaymentMethods() not yet implemented');
    }

    /**
     * Create a new payment.
     * Requires X-Signature header (HMAC-SHA256 of body).
     * 
     * @param {object} paymentData
     * @param {string} paymentData.merchant_ref_id - Unique reference ID
     * @param {number} paymentData.amount - Amount in IDR
     * @param {string} paymentData.payment_code - e.g. "QRIS", "BCAVA"
     * @param {string} paymentData.customer_name
     * @param {string} paymentData.customer_email
     * @param {string} paymentData.customer_phone
     * @param {string} paymentData.callback_url - Webhook URL for payment status
     * @param {string} paymentData.return_url - Redirect URL after payment
     * @param {object} [paymentData.metadata] - Optional metadata
     * @returns {Promise<object>}
     */
    async createPayment(paymentData) {
        // TODO: Implement
        // POST /payment
        // Headers: Content-Type: application/json, X-Signature: <hmac>
        //
        // const bodyString = JSON.stringify(paymentData);
        // const signature = this.generateSignature(bodyString);
        // const res = await this.client.post('/payment', bodyString, {
        //     headers: {
        //         'Content-Type': 'application/json',
        //         'X-Signature': signature,
        //     },
        // });
        // return res.data;
        throw new Error('PaymentGatewayService.createPayment() not yet implemented');
    }

    /**
     * Check payment status by merchant_ref_id.
     * No signature required.
     * 
     * @param {string} merchantRefId
     * @returns {Promise<object>}
     */
    async checkPaymentStatus(merchantRefId) {
        // TODO: Implement
        // GET /payment/{merchant_ref_id}
        throw new Error('PaymentGatewayService.checkPaymentStatus() not yet implemented');
    }

    /**
     * Request a withdrawal.
     * Requires X-Signature header.
     * 
     * @param {number} amount - Withdrawal amount in IDR
     * @returns {Promise<object>}
     */
    async requestWithdrawal(amount) {
        // TODO: Implement
        // POST /withdrawal
        throw new Error('PaymentGatewayService.requestWithdrawal() not yet implemented');
    }
}

module.exports = new PaymentGatewayService();
