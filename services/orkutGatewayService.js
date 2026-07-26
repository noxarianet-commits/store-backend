const supabase = require('../supabase');

/**
 * OrkutGatewayService — Client untuk OrderKuota (ORKUT) Payment Gateway API.
 *
 * Base URL: Configurable via settings table (orkut_config) or ORKUT_BASE_URL env var
 * Auth: merchant code + api_hash (query params)
 *
 * Endpoints yang dipakai:
 *   GET /create_payment  — Buat QRIS Dinamis
 *   GET /transactions    — Cek status pembayaran
 *   GET /health          — Health check
 */
class OrkutGatewayService {
    /**
     * Ambil konfigurasi ORKUT (URL, Merchant Code, API Hash)
     * dari database settings table ('orkut_config') dengan fallback ke .env
     */
    async getConfig() {
        let baseURL = (process.env.ORKUT_BASE_URL || 'http://panelku.fincloud.my.id:10002').replace(/\/+$/, '');
        let merchantCode = (process.env.ORKUT_MERCHANT_CODE || '').trim();
        let apiHash = (process.env.ORKUT_API_HASH || '').trim();

        try {
            const { data } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'orkut_config')
                .single();

            if (data && data.value && typeof data.value === 'object') {
                if (data.value.base_url) baseURL = data.value.base_url.trim().replace(/\/+$/, '');
                if (data.value.merchant_code) merchantCode = data.value.merchant_code.trim();
                if (data.value.api_hash) apiHash = data.value.api_hash.trim();
            }
        } catch (err) {
            // fallback to env
        }

        return { baseURL, merchantCode, apiHash };
    }

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
                `[OrkutGatewayService] ${context} — HTTP ${status}:`,
                data
            );
            return {
                success: false,
                status,
                message: data?.msg || data?.message || 'UNKNOWN_ERROR',
            };
        }
        console.error(
            `[OrkutGatewayService] ${context} — Network error:`,
            error.message
        );
        return {
            success: false,
            status: 0,
            message: 'NETWORK_ERROR',
        };
    }

    /**
     * GET /health
     */
    async healthCheck() {
        try {
            const { baseURL } = await this.getConfig();
            const res = await fetch(`${baseURL}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(10000),
            });

            if (!res.ok) {
                return { success: false, message: `HTTP ${res.status}` };
            }

            return { success: true };
        } catch (error) {
            return this._handleError(error, 'healthCheck');
        }
    }

    /**
     * GET /create_payment?merchant={code}&hash={hash}&amount={nominal}&trx_id={id}
     * Buat QRIS Dinamis baru.
     */
    async createPayment({ trxId, amount }) {
        try {
            const { baseURL, merchantCode, apiHash } = await this.getConfig();

            const params = new URLSearchParams();
            if (merchantCode) params.append('merchant', merchantCode);
            if (apiHash) params.append('hash', apiHash);
            params.append('amount', String(amount));
            params.append('trx_id', trxId);

            const url = `${baseURL}/create_payment?${params.toString()}`;
            console.log(`[OrkutGatewayService] Requesting QRIS from ${baseURL}: trx_id=${trxId}, amount=${amount}`);

            const res = await fetch(url, {
                method: 'GET',
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.success) {
                console.error(
                    `[OrkutGatewayService] createPayment failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.message || json.msg || 'Gagal membuat QRIS ORKUT',
                };
            }

            // ORKUT returns: { success: true, results: { qr_link, qr_string, total_bayar, ref, merchant_name } }
            return { success: true, data: json.results };
        } catch (error) {
            return this._handleError(error, 'createPayment');
        }
    }

    /**
     * GET /transactions?merchant={code}&hash={hash}&ref={ref_id}
     * Cek status pembayaran QRIS via ref_id.
     */
    async checkPaymentStatus(refId) {
        try {
            const { baseURL, merchantCode, apiHash } = await this.getConfig();

            const params = new URLSearchParams();
            if (merchantCode) params.append('merchant', merchantCode);
            if (apiHash) params.append('hash', apiHash);
            params.append('ref', refId);

            const url = `${baseURL}/transactions?${params.toString()}`;

            const res = await fetch(url, {
                method: 'GET',
                signal: AbortSignal.timeout(30000),
            });

            const json = await res.json();

            if (!res.ok || !json.success) {
                if (json.status === 'NOT_FOUND') {
                    return { success: true, paymentStatus: 'NOT_FOUND', data: null };
                }
                console.error(
                    `[OrkutGatewayService] checkPaymentStatus failed:`,
                    json
                );
                return {
                    success: false,
                    status: res.status,
                    message: json.message || json.msg || 'Gagal cek status ORKUT',
                };
            }

            return {
                success: true,
                paymentStatus: json.status, // 'PAID' | 'PENDING'
                data: json.data || null,
            };
        } catch (error) {
            return this._handleError(error, `checkPaymentStatus(${refId})`);
        }
    }
}

module.exports = new OrkutGatewayService();
