const crypto = require('crypto');

/**
 * PaymentGatewayService — Client untuk FinCloud Payment Gateway API (QRIS).
 *
 * Base URL: https://fincloud.my.id
 * Auth: Body param `apikey` + IP Whitelist
 * Content-Type: application/x-www-form-urlencoded (untuk create invoice)
 * Signature: MD5(apikey + ...params)
 *
 * Endpoints:
 *   POST /api/create_invoice  — Buat tagihan QRIS baru
 *   POST /api/cek_status      — Cek status tagihan
 *   POST /api/cancel_invoice   — Batalkan tagihan
 *   POST /api/cek_saldo        — Cek saldo wallet
 */
class PaymentGatewayService {
    constructor() {
        this.baseURL = (
            process.env.FINCLOUD_BASE_URL || 'https://fincloud.my.id'
        ).replace(/\/+$/, '');

        this.apiKey = (process.env.FINCLOUD_API_KEY || '').trim();
    }

    // ══════════════════════════════════════════════════════════════
    // SIGNATURE — MD5 hash dari gabungan string
    // ══════════════════════════════════════════════════════════════

    /**
     * Generate MD5 signature dari gabungan parameter.
     * @param {...string} parts - Bagian-bagian yang digabung lalu di-hash.
     * @returns {string} MD5 hex digest
     */
    generateSignature(...parts) {
        const raw = parts.join('');
        return crypto.createHash('md5').update(raw).digest('hex');
    }

    /**
     * Verifikasi webhook signature dari FinCloud callback.
     * Format: MD5(apikey + reff_id + status)
     *
     * @param {string} reffId - reff_id dari callback
     * @param {string} status - status dari callback (biasanya 'success')
     * @param {string} receivedSignature - Nilai signature yang diterima
     * @returns {boolean}
     */
    verifyWebhookSignature(reffId, status, receivedSignature) {
        if (!receivedSignature) {
            console.error('[PaymentGatewayService] No signature received in webhook');
            return false;
        }

        const expected = this.generateSignature(this.apiKey, reffId, status);

        if (expected !== receivedSignature) {
            console.error('[PaymentGatewayService] Webhook signature mismatch!');
            console.error(`  Expected: ${expected}`);
            console.error(`  Received: ${receivedSignature}`);
            return false;
        }

        return true;
    }

    // ══════════════════════════════════════════════════════════════
    // ERROR HANDLER
    // ══════════════════════════════════════════════════════════════

    _handleError(error, context) {
        if (error.response) {
            const status = error.response.status;
            let data;
            try {
                data = typeof error.response.data === 'string'
                    ? JSON.parse(error.response.data)
                    : error.response.data;
            } catch {
                data = { msg: error.response.data };
            }
            console.error(
                `[PaymentGatewayService] ${context} — HTTP ${status}:`,
                data
            );
            return {
                success: false,
                status,
                message: data?.msg || data?.message || 'UNKNOWN_ERROR',
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
        };
    }

    // ══════════════════════════════════════════════════════════════
    // CREATE INVOICE (Buat Tagihan QRIS)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /api/create_invoice
     * Buat tagihan QRIS dinamis baru.
     *
     * @param {object} params
     * @param {string} params.reffId  - ID pesanan unik dari sistem kita (= orderId)
     * @param {number} params.nominal - Nominal tagihan (min 1000, tanpa pemisah ribuan)
     * @returns {Promise<{ success: boolean, data?: object, message?: string }>}
     */
    async createInvoice({ reffId, nominal }) {
        try {
            const signature = this.generateSignature(
                this.apiKey,
                String(nominal),
                reffId
            );

            const body = new URLSearchParams({
                apikey: this.apiKey,
                nominal: String(nominal),
                reff_id: reffId,
                signature,
            });

            const res = await fetch(`${this.baseURL}/api/create_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error(
                    `[PaymentGatewayService] createInvoice failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal membuat invoice',
                };
            }

            return { success: true, data: json.data };
        } catch (error) {
            return this._handleError(error, 'createInvoice');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CHECK INVOICE STATUS (Cek Status Tagihan)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /api/cek_status
     * Cek status tagihan QRIS via id_depo.
     *
     * @param {number|string} idDepo - id_depo dari response create_invoice
     * @returns {Promise<{ success: boolean, data?: object }>}
     */
    async checkInvoiceStatus(idDepo) {
        try {
            const signature = this.generateSignature(
                this.apiKey,
                String(idDepo)
            );

            const body = new URLSearchParams({
                apikey: this.apiKey,
                id_depo: String(idDepo),
                signature,
            });

            const res = await fetch(`${this.baseURL}/api/cek_status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error(
                    `[PaymentGatewayService] checkInvoiceStatus failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal cek status',
                };
            }

            return { success: true, data: json.data };
        } catch (error) {
            return this._handleError(error, `checkInvoiceStatus(${idDepo})`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CANCEL INVOICE (Batalkan Tagihan)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /api/cancel_invoice
     * Batalkan tagihan agar statusnya berubah menjadi expired.
     *
     * @param {string} reffId - reff_id tagihan yang ingin dibatalkan
     * @returns {Promise<{ success: boolean, message?: string }>}
     */
    async cancelInvoice(reffId) {
        try {
            const signature = this.generateSignature(this.apiKey, reffId);

            const body = new URLSearchParams({
                apikey: this.apiKey,
                reff_id: reffId,
                signature,
            });

            const res = await fetch(`${this.baseURL}/api/cancel_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error(
                    `[PaymentGatewayService] cancelInvoice failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal membatalkan invoice',
                };
            }

            return { success: true, message: json.msg };
        } catch (error) {
            return this._handleError(error, `cancelInvoice(${reffId})`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CHECK BALANCE (Cek Saldo Wallet)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /api/cek_saldo
     * Ambil saldo QRIS aktif di akun FinCloud.
     *
     * @returns {Promise<{ success: boolean, data?: object }>}
     */
    async checkBalance() {
        try {
            const body = new URLSearchParams({
                apikey: this.apiKey,
            });

            const res = await fetch(`${this.baseURL}/api/cek_saldo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error(
                    `[PaymentGatewayService] checkBalance failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal cek saldo',
                };
            }

            return { success: true, data: json.data };
        } catch (error) {
            return this._handleError(error, 'checkBalance');
        }
    }
}

module.exports = new PaymentGatewayService();
