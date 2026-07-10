const VendorAdapter = require('./VendorAdapter');
const sekalipayService = require('../sekalipayService');
const crypto = require('crypto');

class SekalipayAdapter extends VendorAdapter {
    constructor() {
        super('sekalipay');
    }

    async fetchProducts(params = {}) {
        if (params.delta && params.updatedSince) {
            return await sekalipayService.fetchItemsDelta(params.updatedSince, params.category || 1);
        }
        return await sekalipayService.fetchAllItems(params.category || 1);
    }

    async createOrder(refId, orderData) {
        // orderData expected to have { carts: [{ item_id, quantity, note }] }
        if (!orderData.carts) {
            throw new Error('Sekalipay requires carts array in orderData');
        }
        return await sekalipayService.createTransaction(refId, orderData.carts);
    }

    async checkOrderStatus(refId) {
        return await sekalipayService.getTransactionDetail(refId);
    }

    async validateAccount(params) {
        const { itemId, customerId, zoneId } = params;
        return await sekalipayService.validateAccount(itemId, customerId, zoneId);
    }

    async getBalance() {
        return await sekalipayService.checkBalance();
    }

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
}

module.exports = SekalipayAdapter;
