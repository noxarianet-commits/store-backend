const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

/**
 * Middleware khusus untuk webhook routes:
 * Menyimpan raw body sebagai req.rawBody agar bisa dipakai
 * untuk verifikasi HMAC-SHA256 / SHA256 signature.
 */
const rawBodyMiddleware = express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
});

/**
 * POST /api/webhooks/payment-gateway
 * Callback dari Sekalipay PG ketika pembayaran user berhasil.
 * Dipanggil secara otomatis oleh Sekalipay setelah payment confirmed.
 *
 * Verifikasi: HMAC-SHA256(body, secretKey)
 */
router.post(
    '/payment-gateway',
    rawBodyMiddleware,
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

module.exports = router;
