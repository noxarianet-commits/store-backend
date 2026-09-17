const crypto = require('crypto');

/**
 * PaymentGatewayService — Client untuk FinCloud Payment Gateway API (Dynamic QRIS).
 *
 * Base URL: https://api.fincloud.my.id/v1
 * Auth: Body/Query param `apikey`
 * Content-Type: application/json
 *
 * Endpoints:
 *   POST /create_invoice  — Buat tagihan Dynamic QRIS baru
 *   POST /cek_status      — Cek status tagihan (mendukung external_id & reff_id)
 *   POST /cancel_invoice   — Batalkan tagihan
 *   POST /profile         — Cek profil dan saldo akun
 */
class PaymentGatewayService {
    constructor() {
        this.baseURL = (
            process.env.FINCLOUD_BASE_URL || 'https://api.fincloud.my.id/v1'
        ).replace(/\/+$/, '');

        this.apiKey = (process.env.FINCLOUD_API_KEY || '').trim();
        this.secretKey = (
            process.env.FINCLOUD_SECRET_KEY ||
            process.env.FINCLOUD_PPOB_WEBHOOK_SECRET ||
            ''
        ).trim();
    }

    // ══════════════════════════════════════════════════════════════
    // SIGNATURE HELPERS
    // ══════════════════════════════════════════════════════════════

    /**
     * Generate MD5 signature dari gabungan string.
     * Digunakan oleh endpoint FinCloud v1 create_invoice: MD5(apiKey + nominal + reffId).
     * @param {...string} parts
     * @returns {string} MD5 hex digest
     */
    generateMD5Signature(...parts) {
        const raw = parts.join('');
        return crypto.createHash('md5').update(raw).digest('hex');
    }

    /**
     * Generate HMAC-SHA256 signature jika SecretKey tersedia.
     * @param {string} data
     * @param {string} [secret]
     * @returns {string} HMAC-SHA256 hex digest
     */
    generateHmacSignature(data, secret = this.secretKey) {
        if (!secret) return '';
        return crypto.createHmac('sha256', secret).update(data).digest('hex');
    }

    /**
     * Verifikasi webhook signature dari FinCloud callback.
     * Mendukung format HMAC-SHA256 dan MD5 fallback.
     *
     * @param {object} params
     * @param {string} params.reffId - reff_id dari callback
     * @param {string} [params.status] - status / event dari callback
     * @param {string} [params.receivedSignature] - Nilai signature yang diterima
     * @param {string} [params.rawBody] - Raw body string
     * @returns {boolean}
     */
    verifyWebhookSignature({ reffId, status = '', receivedSignature = '', rawBody = '' }) {
        if (!receivedSignature) {
            // FinCloud dokumentasi terbaru tidak mencantumkan signature wajib di body callback
            return true;
        }

        const cleanSig = String(receivedSignature).trim().toLowerCase();

        // 1. Cek HMAC-SHA256 jika ada secretKey
        if (this.secretKey) {
            const hmacCandidates = [
                this.generateHmacSignature(rawBody),
                this.generateHmacSignature(reffId),
                this.generateHmacSignature(`${reffId}:${status}`),
            ].map(s => s.toLowerCase());

            if (hmacCandidates.includes(cleanSig)) {
                return true;
            }
        }

        // 2. Cek MD5 legacy format
        const md5Candidates = [
            this.generateMD5Signature(this.apiKey, reffId, status),
            this.generateMD5Signature(this.apiKey, reffId),
            this.generateMD5Signature(reffId, status),
        ].map(s => s.toLowerCase());

        if (md5Candidates.includes(cleanSig)) {
            return true;
        }

        console.error('[PaymentGatewayService] Webhook signature mismatch!');
        console.error(`  Received: ${receivedSignature}`);
        return false;
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
     * POST /create_invoice
     * Buat tagihan QRIS dinamis baru sesuai dokumentasi FinCloud v1.
     *
     * @param {object} params
     * @param {string} params.reffId  - ID pesanan unik dari sistem kita (= orderId / external_id)
     * @param {number} params.nominal - Nominal tagihan (min 1000)
     * @param {number} [params.amount] - Alias untuk nominal
     * @returns {Promise<{ success: boolean, data?: object, message?: string }>}
     */
    async createInvoice({ reffId, nominal, amount }) {
        try {
            const finalNominal = parseInt(nominal || amount, 10);
            const externalId = String(reffId);

            // Signature format untuk FinCloud v1: MD5(apiKey + nominal + reffId)
            const signature = this.generateMD5Signature(
                this.apiKey,
                String(finalNominal),
                externalId
            );

            const payload = {
                apikey: this.apiKey,
                amount: finalNominal,
                nominal: finalNominal,
                external_id: externalId,
                reff_id: externalId,
                signature,
            };

            const res = await fetch(`${this.baseURL}/create_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error('[PaymentGatewayService] createInvoice failed:', json);
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal membuat invoice',
                };
            }

            const d = json.data || {};
            const qrisString = d.qris_string || null;
            const qrisUrl = d.qris_url || (qrisString
                ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrisString)}`
                : null);

            return {
                success: true,
                data: {
                    ...d,
                    reff_id: d.reff_id || externalId,
                    external_id: d.reff_id || externalId,
                    nominal: d.nominal || finalNominal,
                    kode_unik: d.kode_unik !== undefined ? d.kode_unik : 0,
                    total_bayar: d.total_bayar || (finalNominal + (d.kode_unik || 0)),
                    qris_string: qrisString,
                    qris_url: qrisUrl,
                    checkout_url: d.checkout_url || null,
                    expired_at: d.expired_at || null,
                },
                message: json.msg,
            };
        } catch (error) {
            return this._handleError(error, 'createInvoice');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CHECK INVOICE STATUS (Cek Status Tagihan)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /cek_status
     * Cek status tagihan QRIS via external_id / reff_id.
     *
     * @param {string} identifier - external_id / reff_id invoice
     * @returns {Promise<{ success: boolean, data?: object }>}
     */
    async checkInvoiceStatus(identifier) {
        try {
            const externalId = String(identifier);

            const payload = {
                apikey: this.apiKey,
                external_id: externalId,
                reff_id: externalId,
            };

            const res = await fetch(`${this.baseURL}/cek_status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok) {
                console.error('[PaymentGatewayService] checkInvoiceStatus HTTP error:', json);
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal cek status',
                };
            }

            return {
                success: true,
                status: json.status,
                data: json.data || null,
                message: json.msg || '',
            };
        } catch (error) {
            return this._handleError(error, `checkInvoiceStatus(${identifier})`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CANCEL INVOICE (Batalkan Tagihan)
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /cancel_invoice
     * Batalkan tagihan agar statusnya berubah menjadi expired/cancelled.
     *
     * @param {string} identifier - external_id / reff_id yang ingin dibatalkan
     * @returns {Promise<{ success: boolean, message?: string }>}
     */
    async cancelInvoice(identifier) {
        try {
            const externalId = String(identifier);

            const payload = {
                apikey: this.apiKey,
                external_id: externalId,
                reff_id: externalId,
            };

            const res = await fetch(`${this.baseURL}/cancel_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error('[PaymentGatewayService] cancelInvoice failed:', json);
                return {
                    success: false,
                    status: res.status,
                    message: json.msg || 'Gagal membatalkan invoice',
                };
            }

            return {
                success: true,
                message: json.msg || 'Invoice berhasil dibatalkan',
                data: json.data,
            };
        } catch (error) {
            return this._handleError(error, `cancelInvoice(${identifier})`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CHECK BALANCE / PROFILE
    // ══════════════════════════════════════════════════════════════

    /**
     * POST /profile
     * Ambil informasi profil merchant & saldo akun FinCloud.
     * Format: timestamp + MD5(timestamp + apiKey).
     *
     * @returns {Promise<{ success: boolean, data?: object }>}
     */
    async checkBalance() {
        try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const signature = this.generateMD5Signature(timestamp, this.apiKey);

            const res = await fetch(`${this.baseURL}/profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apikey: this.apiKey,
                    timestamp,
                    signature,
                }),
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.status) {
                console.error('[PaymentGatewayService] checkBalance failed:', json);
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
