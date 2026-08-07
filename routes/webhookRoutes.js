const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

/**
 * Middleware khusus untuk webhook Sekalipay Reseller:
 * Menyimpan raw body sebagai req.rawBody agar bisa dipakai
 * untuk verifikasi SHA256 signature.
 */
const rawBodyMiddleware = express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
});

/**
 * POST /api/webhooks/payment-gateway
 * Callback dari FinCloud ketika pembayaran QRIS user berhasil.
 * FinCloud mengirim data via application/x-www-form-urlencoded.
 *
 * Verifikasi: MD5(apikey + reff_id + status)
 */
router.post(
    '/payment-gateway',
    express.urlencoded({ extended: true }),
    webhookController.handlePaymentGatewayWebhook
);

/**
 * POST /api/webhooks/sekalipay
 * Callback dari Sekalipay Reseller API ketika order selesai / dibatalkan.
 *
 * Verifikasi: SHA256(ref_id + ":" + invoice + ":" + status + ":" + webhook_secret)
 */
router.post(
    '/sekalipay',
    rawBodyMiddleware,
    webhookController.handleSekalipayWebhook
);

/**
 * POST /api/webhooks/fincloud-ppob
 * Callback dari Fincloud PPOB H2H ketika order selesai / dibatalkan.
 */
router.post(
    '/fincloud-ppob',
    express.urlencoded({ extended: true }),
    webhookController.handleFincloudPPOBWebhook
);

/**
 * POST /api/webhooks/sayabayar
 * Callback dari Saya Bayar Gateway (invoice.paid, invoice.expired, dll).
 */
router.post(
    '/sayabayar',
    rawBodyMiddleware,
    webhookController.handleSayabayarWebhook
);

/**
 * POST /api/webhooks/dyqris
 * Callback dari Dyqris Mini QRIS Gateway (transaction.paid).
 */
router.post(
    '/dyqris',
    rawBodyMiddleware,
    webhookController.handleDyqrisWebhook
);

module.exports = router;

