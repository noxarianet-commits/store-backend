const billService = require('../services/billService');
const { logger } = require('../utils/logger');

async function inquire(req, res) {
    try {
        const { product_id, variant_id, customer_number } = req.body || {};

        const result = await billService.inquire({
            user: req.user,
            productId: product_id,
            variantId: variant_id,
            customerNumber: customer_number,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        logger.error('mobile_bill_inquiry_controller_failed', { userId: req.user?.id, error: err });
        return res.status(500).json({
            success: false,
            code: 'BILL_INQUIRY_FAILED',
            error: 'Gagal mengecek tagihan.',
        });
    }
}

module.exports = { inquire };
