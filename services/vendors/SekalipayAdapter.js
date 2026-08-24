const VendorAdapter = require('./VendorAdapter');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Sekalipay Reseller API Adapter.
 * Integrates directly with Sekalipay Reseller API v1 endpoints.
 */
class SekalipayAdapter extends VendorAdapter {
    constructor() {
        super('sekalipay');
        this.baseURL = process.env.SEKALIPAY_BASE_URL || 'https://sekalipay.com/api';
        this.apiKey = process.env.SEKALIPAY_API_KEY || '';

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Accept': 'application/json',
                'X-APIKEY': this.apiKey,
                'User-Agent': 'PostmanRuntime/7.32.3',
            },
            timeout: 30000,
        });
    }

    /**
     * Normalize API errors into a consistent structure.
     */
    _handleError(error, context) {
        if (error.response) {
            const { status, data } = error.response;
            console.error(`[SekalipayAdapter] ${context} — HTTP ${status}:`, data);
            return {
                success: false,
                status,
                message: data?.message || 'UNKNOWN_ERROR',
                errors: data?.errors || null,
                data: data,
            };
        }
        console.error(`[SekalipayAdapter] ${context} — Network error:`, error.message);
        return {
            success: false,
            status: 0,
            message: 'NETWORK_ERROR',
            errors: { network: [error.message] },
        };
    }

    /**
     * Fetch products from Sekalipay API.
     * Can fetch all items or delta changes across categories [1, 3, 4].
     * @param {Object} params - { type: 'full'|'delta', updatedSince?: string, category?: number }
     */
    async fetchProducts(params = {}) {
        const categories = params.category ? [params.category] : [1, 3, 4];
        let items = [];
        let serverTime = null;

        for (const cat of categories) {
            let res;
            if (params.type === 'delta' && params.updatedSince) {
                res = await this.fetchItemsDelta(params.updatedSince, cat);
            } else {
                res = await this.fetchAllItems(cat);
            }

            if (!res.success) {
                console.error(`[SekalipayAdapter] Failed fetching items for category ${cat}:`, res.message);
                continue;
            }

            if (res.data) {
                items.push({
                    categoryId: cat,
                    items: res.data,
                });
            }
            if (res.serverTime) {
                serverTime = res.serverTime;
            }
        }

        return {
            success: true,
            data: items,
            serverTime: serverTime || new Date().toISOString(),
        };
    }

    /**
     * Fetch all items for a given category (full sync).
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
            return this._handleError(error, `fetchAllItems(${category})`);
        }
    }

    /**
     * Fetch items updated since a specific timestamp (delta sync).
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
            return this._handleError(error, `fetchItemsDelta(${category})`);
        }
    }

    /**
     * Fetch single item / variant detail.
     */
    async fetchProductDetail(variantId) {
        try {
            const res = await this.client.get(`/v1/item/${variantId}`);
            return { success: true, data: res.data.data };
        } catch (error) {
            return this._handleError(error, `fetchProductDetail(${variantId})`);
        }
    }

    /**
     * Real-time stock check for Sekalipay variant.
     */
    async checkStock(variantId) {
        const detailRes = await this.fetchProductDetail(variantId);
        if (!detailRes.success || !detailRes.data) {
            return {
                success: false,
                available: false,
                stock: 0,
                message: detailRes.message || 'Gagal mengecek stok varian',
            };
        }

        const liveStock = detailRes.data.stock !== undefined ? detailRes.data.stock : 9999;
        return {
            success: true,
            available: liveStock > 0,
            stock: liveStock,
            data: detailRes.data,
        };
    }

    /**
     * Validate customer account before purchase.
     */
    async validateAccount(params = {}) {
        try {
            const itemId = params.variantId || params.variant_id || params.item_id || params.itemId;
            const customerId = params.customerId || params.customer_id || params.user_id || params.target;
            const zoneId = params.zoneId || params.zone_id || null;

            if (!itemId || !customerId) {
                return { success: false, valid: false, message: 'item_id dan customer_id wajib diisi' };
            }

            const body = { item_id: parseInt(itemId), customer_id: String(customerId) };
            if (zoneId) body.zone_id = String(zoneId);

            const res = await this.client.post('/v1/item/validate', body, {
                headers: { 'Content-Type': 'application/json' },
            });

            return {
                success: true,
                valid: true,
                data: res.data.data,
            };
        } catch (error) {
            const err = this._handleError(error, 'validateAccount');
            return {
                success: false,
                valid: false,
                status: err.status,
                message: err.message,
                errors: err.errors,
            };
        }
    }

    /**
     * Check active validation services before checkout.
     */
    async checkValidationServices(params = {}) {
        try {
            const search = typeof params === 'string'
                ? params
                : (params?.search || params?.product_name || params?.productName || '');

            const res = await this.client.get('/v1/validation/services', {
                params: { search: search || undefined },
            });

            return {
                success: true,
                available: true,
                data: res.data.data,
                meta: res.data.meta,
            };
        } catch (error) {
            return this._handleError(error, 'checkValidationServices');
        }
    }

    /**
     * Create order / transaction on Sekalipay.
     * @param {string} refId - NX order ID
     * @param {Object} orderData - { carts: [{ item_id, quantity, note, zone_id }] }
     */
    async createOrder(refId, orderData) {
        try {
            if (!orderData || !Array.isArray(orderData.carts)) {
                throw new Error('Sekalipay requires carts array in orderData');
            }

            const res = await this.client.post('/v1/trx', {
                ref_id: refId,
                carts: orderData.carts,
            }, {
                headers: { 'Content-Type': 'application/json' },
            });

            return {
                success: true,
                data: res.data.data,
                invoice: res.data.data?.invoice,
                vendorOrderId: res.data.data?.ref_id || refId,
            };
        } catch (error) {
            return this._handleError(error, 'createOrder');
        }
    }

    /**
     * Get transaction detail.
     */
    async checkOrderStatus(refId) {
        try {
            const res = await this.client.get(`/v1/trx/${refId}`);
            return {
                success: true,
                data: res.data.data,
                status: res.data.data?.status,
            };
        } catch (error) {
            return this._handleError(error, `checkOrderStatus(${refId})`);
        }
    }

    /**
     * Get reseller account balance.
     */
    async getBalance() {
        try {
            const res = await this.client.get('/v1/balance');
            return {
                success: true,
                data: res.data.data,
                balance: res.data.data?.balance,
            };
        } catch (error) {
            return this._handleError(error, 'getBalance');
        }
    }

    /**
     * Verify incoming webhook signature from Sekalipay.
     */
    verifyWebhookSignature(payload, signature, secret) {
        if (!payload || !payload.data) return false;

        const event = payload.event || '';
        const data = payload.data;
        const ref_id = data.ref_id || '';
        const invoice = data.invoice || '';
        const status = (event === 'webhook.test') ? 'test' : (data.status || (data.item && data.item.status) || '');

        const expected = crypto.createHash('sha256')
            .update(`${ref_id}:${invoice}:${status}:${secret}`)
            .digest('hex');

        try {
            const bufSig = Buffer.from(signature || '', 'utf8');
            const bufExpected = Buffer.from(expected, 'utf8');
            if (bufSig.length !== bufExpected.length) return false;
            return crypto.timingSafeEqual(bufSig, bufExpected);
        } catch (e) {
            return false;
        }
    }

    /**
     * Parse webhook body to standard event structure.
     */
    parseWebhookEvent(body) {
        return {
            event: body.event,
            vendorOrderId: body.data?.ref_id || body.data?.invoice,
            invoice: body.data?.invoice,
            status: body.data?.status || (body.data?.item && body.data?.item.status),
            data: body.data,
        };
    }
}

module.exports = SekalipayAdapter;
