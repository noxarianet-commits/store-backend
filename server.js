const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
require('dotenv').config();

const { logger } = require('./utils/logger');
const { requestContext } = require('./middleware/requestContext');

// Initialize Unified Product Sync Service
const productSyncService = require('./services/productSyncService');

// Initialize Vendor Registry
const vendorRegistry = require('./services/vendors/vendorRegistry');
const SekalipayAdapter = require('./services/vendors/SekalipayAdapter');
const OkeconnectAdapter = require('./services/vendors/OkeconnectAdapter');
vendorRegistry.register('sekalipay', new SekalipayAdapter());
vendorRegistry.register('okeconnect', new OkeconnectAdapter());


// Routes — Unified
const productRoutes = require('./routes/productRoutes');
const adminProductRoutes = require('./routes/adminProductRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const orderRoutes = require('./routes/orderRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const testimonialRoutes = require('./routes/testimonialRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const homeRoutes = require('./routes/homeRoutes');
const authRoutes = require('./routes/authRoutes');
const balanceRoutes = require('./routes/balanceRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const adminTicketRoutes = require('./routes/adminTicketRoutes');

const verifyAdmin = require('./middleware/verifyAdmin');
const verifyUser = require('./middleware/verifyUser');

// ══════════════════════════════════════════════════════════════════════════
// APP SETUP
// ══════════════════════════════════════════════════════════════════════════

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Rate Limiters
const globalLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 600,
    // SSE stream tiket berumur panjang dan otomatis reconnect — jangan
    // sampai koneksi itu menghabiskan kuota request halaman lain.
    // Path pelanggan mengandung nomor tiket (mis. /api/tickets/TK-.../stream),
    // jadi cocokkan suffix '/stream', bukan '/tickets/stream'.
    skip: (req) => req.path.includes('/payments/status') || req.path.endsWith('/stream'),
    message: { error: 'Terlalu banyak request, silakan coba lagi nanti.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// CORS — Allow all origins
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-order-token', 'x-ticket-token', 'x-signature', 'x-event', 'x-webhook-signature', 'x-callback-secret', '*'],
    optionsSuccessStatus: 200
}));


// Middleware
app.use(requestContext);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(globalLimiter);



// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES — Mounted before express.json() for raw body verification
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/webhooks', webhookRoutes);

// Global JSON body parser (for non-webhook routes)
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Public
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/home', homeRoutes);
app.use('/api/products', productRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/testimonials', testimonialRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/balance', verifyUser, balanceRoutes);
app.use('/api/tickets', ticketRoutes);

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Protected (Admin)
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/tickets', adminTicketRoutes);
app.use('/api/orders', verifyAdmin, orderRoutes);
app.use('/api/admin', adminRoutes);

// ══════════════════════════════════════════════════════════════════════════
// CRON JOBS — single-leader guard
// ══════════════════════════════════════════════════════════════════════════

// PM2 cluster mode sets NODE_APP_INSTANCE. Only instance 0 is the cron leader.
// Vercel/serverless must not run in-process cron at all: use Vercel Cron or an
// external scheduler instead.
const pm2Instance = process.env.NODE_APP_INSTANCE;
const isCronLeader = pm2Instance === undefined || pm2Instance === '0';
const cronEnabled =
    process.env.CRON_ENABLED !== 'false' &&
    !process.env.VERCEL &&
    isCronLeader;

if (cronEnabled) {
    const paymentPollingService = require('./services/paymentPollingService');
    const otpService = require('./services/otpService');

    let paymentPollRunning = false;
    let productSyncRunning = false;

    const requestedPaymentSchedule = process.env.PAYMENT_POLL_CRON || '*/2 * * * *';
    const paymentSchedule = cron.validate(requestedPaymentSchedule)
        ? requestedPaymentSchedule
        : '*/2 * * * *';
    if (paymentSchedule !== requestedPaymentSchedule) {
        logger.warn('invalid_payment_poll_cron_fallback', { requested: requestedPaymentSchedule, using: paymentSchedule });
    }

    // Webhooks are the primary payment path. This is the fallback sweep.
    // Keep expiry in the same serialized run so an order cannot be cancelled
    // between "gateway says paid" and fulfillment in a separate cron tick.
    cron.schedule(paymentSchedule, async () => {
        if (paymentPollRunning) {
            logger.warn('payment_cron_skipped_overlap', { schedule: paymentSchedule });
            return;
        }

        paymentPollRunning = true;
        try {
            await paymentPollingService.pollPendingOrders();
            await paymentPollingService.pollPendingTopups();
            await paymentPollingService.cancelExpiredOrders();
            await paymentPollingService.cancelExpiredTopups();
            // pollProcessingOrders() is intentionally not called: it is a no-op.
        } catch (err) {
            logger.error('payment_cron_failed', { error: err });
        } finally {
            paymentPollRunning = false;
        }
    });

    // Sekalipay delta sync every 1 hour
    cron.schedule('0 * * * *', async () => {
        if (productSyncRunning) {
            logger.warn('product_sync_skipped_overlap', { job: 'sekalipay_delta' });
            return;
        }
        productSyncRunning = true;
        try {
            const result = await productSyncService.syncVendor('sekalipay', { type: 'delta' });
            logger.info('product_sync_completed', { job: 'sekalipay_delta', ...result });
        } catch (err) {
            logger.error('product_sync_failed', { job: 'sekalipay_delta', error: err });
        } finally {
            productSyncRunning = false;
        }
    });

    // Sekalipay full sync daily at 03:00
    cron.schedule('0 3 * * *', async () => {
        if (productSyncRunning) {
            logger.warn('product_sync_skipped_overlap', { job: 'sekalipay_full' });
            return;
        }
        productSyncRunning = true;
        try {
            const result = await productSyncService.syncVendor('sekalipay', { type: 'full' });
            logger.info('product_sync_completed', { job: 'sekalipay_full', ...result });
        } catch (err) {
            logger.error('product_sync_failed', { job: 'sekalipay_full', error: err });
        } finally {
            productSyncRunning = false;
        }
    });

    // Okeconnect full sync daily at 04:00
    cron.schedule('0 4 * * *', async () => {
        if (productSyncRunning) {
            logger.warn('product_sync_skipped_overlap', { job: 'okeconnect_full' });
            return;
        }
        productSyncRunning = true;
        try {
            const result = await productSyncService.syncVendor('okeconnect', { type: 'full' });
            logger.info('product_sync_completed', { job: 'okeconnect_full', ...result });
        } catch (err) {
            logger.error('product_sync_failed', { job: 'okeconnect_full', error: err });
        } finally {
            productSyncRunning = false;
        }
    });

    // Background balance refresh for OkeConnect
    cron.schedule('*/5 * * * *', async () => {
        try {
            const okeAdapter = vendorRegistry.get('okeconnect');
            if (okeAdapter) {
                await okeAdapter.getBalance({ force: true });
            }
        } catch (err) {
            logger.warn('okeconnect_balance_refresh_failed', { message: err.message });
        }
    });

    cron.schedule('15 5 * * *', async () => {
        try {
            await otpService.purgeExpired();
        } catch (err) {
            logger.error('otp_purge_failed', { error: err });
        }
    });

    logger.info('cron_scheduled', {
        paymentSchedule,
        productSync: 'sekalipay delta 1h/full 03:00, okeconnect full 04:00',
        otpCleanup: 'daily 05:15',
        pm2Instance: pm2Instance ?? null,
    });
} else {
    logger.info('cron_disabled', {
        reason: process.env.VERCEL ? 'serverless' : (isCronLeader ? 'CRON_ENABLED=false' : 'pm2_non_leader'),
        pm2Instance: pm2Instance ?? null,
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 404 + ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════

app.use('/api', (req, res) => {
    res.status(404).json({
        error: 'Endpoint tidak ditemukan',
        request_id: req.id,
    });
});

// Never let Express' default HTML error page leak a stack trace or absolute
// filesystem paths to clients.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err?.type === 'entity.parse.failed') {
        logger.warn('request_json_parse_failed', { path: req.path });
        return res.status(400).json({
            error: 'Format request tidak valid',
            request_id: req.id,
        });
    }

    logger.error('unhandled_request_error', {
        method: req.method,
        path: req.path,
        error: err,
    });

    return res.status(500).json({
        error: 'Terjadi kesalahan server',
        request_id: req.id,
    });
});


// ══════════════════════════════════════════════════════════════════════════
// START / EXPORT
// ══════════════════════════════════════════════════════════════════════════

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        logger.info('server_started', { port: PORT });
    });
}
