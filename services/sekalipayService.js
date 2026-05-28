const axios = require('axios');

/**
 * SekalipayService — HTTP client for Sekalipay Reseller API.
 * 
 * Handles authentication, request formatting, and error normalization
 * for all Sekalipay API endpoints.
 */
class SekalipayService {
    constructor() {
        this.baseURL = process.env.SEKALIPAY_BASE_URL || 'https://sekalipay.com/api';
        this.apiKey = process.env.SEKALIPAY_API_KEY || '';

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Accept': 'application/json',
                'X-APIKEY': this.apiKey,
            },
            timeout: 30000,
        });
    }

    /**
     * Normalize API errors into a consistent format.
     */
    _handleError(error, context) {
        if (error.response) {
            const { status, data } = error.response;
            console.error(`[SekalipayService] ${context} — HTTP ${status}:`, data);
            return {
                success: false,
                status,
                message: data?.message || 'UNKNOWN_ERROR',
                errors: data?.errors || null,
            };
        }
        console.error(`[SekalipayService] ${context} — Network error:`, error.message);
        return {
            success: false,
            status: 0,
            message: 'NETWORK_ERROR',
            errors: { network: [error.message] },
        };
    }

    // ══════════════════════════════════════════════════════════════
    // BALANCE
    // ══════════════════════════════════════════════════════════════

    /**
     * Check current reseller balance.
     * @returns {{ success: boolean, data?: { balance: number } }}
     */
    async checkBalance() {
        try {
            const res = await this.client.get('/v1/balance');
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'checkBalance');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // ITEMS (Products & Variants)
    // ══════════════════════════════════════════════════════════════

    /**
     * Fetch all items for a given category (full sync).
     * Uses per_page=all to get everything in one request.
     * 
     * @param {number} category - Category ID to filter by
     * @returns {{ success: boolean, data?: Array, serverTime?: string, meta?: object }}
     */
    async fetchAllItems(category = 1) {
        try {
            const res = await this.client.get('/v1/item', {
                params: {
                    category,
                    per_page: 'all',
                },
            });
            return {
                success: true,
                data: res.data.data,
                serverTime: res.data.server_time,
                meta: res.data.meta,
            };
        } catch (error) {
            return this._handleError(error, 'fetchAllItems');
        }
    }

    /**
     * Fetch items updated since a specific timestamp (delta sync).
     * 
     * @param {string} updatedSince - ISO 8601 timestamp
     * @param {number} category - Category ID to filter by
     * @returns {{ success: boolean, data?: Array, serverTime?: string, meta?: object }}
     */
    async fetchItemsDelta(updatedSince, category = 1) {
        try {
            const res = await this.client.get('/v1/item', {
                params: {
                    category,
                    per_page: 'all',
                    updated_since: updatedSince,
                },
            });
            return {
                success: true,
                data: res.data.data,
                serverTime: res.data.server_time,
                meta: res.data.meta,
            };
        } catch (error) {
            return this._handleError(error, 'fetchItemsDelta');
        }
    }

    /**
     * Fetch detail for a single item/variant.
     * 
     * @param {number} variantId - The variant ID
     * @returns {{ success: boolean, data?: object }}
     */
    async fetchItemDetail(variantId) {
        try {
            const res = await this.client.get(`/v1/item/${variantId}`);
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, `fetchItemDetail(${variantId})`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // VALIDATION (Account/ID Check)
    // ══════════════════════════════════════════════════════════════

    /**
     * Validate a customer account (e.g., game user ID).
     * Only call if variant.validation.available === true.
     * 
     * @param {number} itemId - Variant ID
     * @param {string} customerId - Customer's user ID / phone / account
     * @param {string} [zoneId] - Server/zone ID (if validation.requires_zone_id)
     * @returns {{ success: boolean, data?: object }}
     */
    async validateAccount(itemId, customerId, zoneId = null) {
        try {
            const body = { item_id: itemId, customer_id: customerId };
            if (zoneId) body.zone_id = zoneId;

            const res = await this.client.post('/v1/item/validate', body, {
                headers: { 'Content-Type': 'application/json' },
            });
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'validateAccount');
        }
    }

    // ══════════════════════════════════════════════════════════════
    // TRANSACTIONS (prepared for future use)
    // ══════════════════════════════════════════════════════════════

    /**
     * Create a transaction (purchase).
     * Uses variant.id as item_id in the cart.
     * 
     * @param {string} refId - Unique reference ID from your system
     * @param {Array<{ item_id: number, quantity: number, note: string }>} carts
     * @returns {{ success: boolean, data?: object }}
     */
    async createTransaction(refId, carts) {
        try {
            const res = await this.client.post('/v1/trx', {
                ref_id: refId,
                carts,
            }, {
                headers: { 'Content-Type': 'application/json' },
            });
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'createTransaction');
        }
    }

    /**
     * Get transaction detail by reference ID.
     * 
     * @param {string} refId - Reference ID or invoice
     * @returns {{ success: boolean, data?: object }}
     */
    async getTransactionDetail(refId) {
        try {
            const res = await this.client.get(`/v1/trx/${refId}`);
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, `getTransactionDetail(${refId})`);
        }
    }

    /**
     * List transactions with optional filters.
     * 
     * @param {{ page?: number, perPage?: number, status?: string }} params
     * @returns {{ success: boolean, data?: Array }}
     */
    async listTransactions(params = {}) {
        try {
            const res = await this.client.get('/v1/trx', { params });
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, 'listTransactions');
        }
    }
}

module.exports = new SekalipayService();
