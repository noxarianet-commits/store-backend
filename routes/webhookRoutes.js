const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const {
    fincloudWebhookGate,
    fincloudIgnoredReffGate,
} = require('../middleware/fincloudWebhook');

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
 *
 * Gate order matters:
 * 1. fincloudWebhookGate runs before body parsing. If FinCloud is disabled,
 *    no body is parsed and no Supabase query is made.
 * 2. Raw body is preserved for signature verification when enabled.
 * 3. Ignored legacy reference IDs are acknowledged without DB access.
 */
router.post(
    '/payment-gateway',
    fincloudWebhookGate,
    rawBodyMiddleware,
    express.urlencoded({ extended: true }),
    fincloudIgnoredReffGate,
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
 * POST /api/webhooks/sekalipay-gateway
 * Callback dari Sekalipay Payment Gateway (QRIS).
 */
router.post(
    '/sekalipay-gateway',
    rawBodyMiddleware,
    webhookController.handleSekalipayGatewayWebhook
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

/**
 * GET & POST /api/webhooks/okeconnect
 * Callback dari OkeConnect H2H saat order selesai/gagal.
 * Format OkeConnect: GET /api/webhooks/okeconnect?refid=xxx&message=xxx
 */
router.get(
    '/okeconnect',
    webhookController.handleOkeconnectWebhook
);

router.post(
    '/okeconnect',
    express.urlencoded({ extended: true }),
    webhookController.handleOkeconnectWebhook
);

module.exports = router;


