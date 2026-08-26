const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
require('dotenv').config();

// Initialize Unified Product Sync Service
const productSyncService = require('./services/productSyncService');

// Initialize Vendor Registry
const vendorRegistry = require('./services/vendors/vendorRegistry');
const SekalipayAdapter = require('./services/vendors/SekalipayAdapter');
const FincloudPPOBAdapter = require('./services/vendors/FincloudPPOBAdapter');
const OkeconnectAdapter = require('./services/vendors/OkeconnectAdapter');
vendorRegistry.register('sekalipay', new SekalipayAdapter());
vendorRegistry.register('fincloud', new FincloudPPOBAdapter());
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

const verifyAdmin = require('./middleware/verifyAdmin');

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
    skip: (req) => req.path.includes('/payments/status'),
    message: { error: 'Terlalu banyak request, silakan coba lagi nanti.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// CORS — Allow all origins
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-signature', 'x-event', 'x-webhook-signature', 'x-callback-secret', '*'],
    optionsSuccessStatus: 200
}));


// Middleware
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

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Protected (Admin)
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/admin/products', adminProductRoutes);
app.use('/api/orders', verifyAdmin, orderRoutes);
app.use('/api/admin', adminRoutes);

// ══════════════════════════════════════════════════════════════════════════
// CRON JOBS — Unified Product Sync
// ══════════════════════════════════════════════════════════════════════════

// Sekalipay delta sync every 1 hour
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Starting Sekalipay delta sync...');
    try {
        const result = await productSyncService.syncVendor('sekalipay', { type: 'delta' });
        console.log(`[CRON] Sekalipay delta sync completed:`, result);
    } catch (err) {
        console.error('[CRON] Sekalipay delta sync failed:', err.message);
    }
});

// Sekalipay full sync daily at 03:00
cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Starting Sekalipay full sync...');
    try {
        const result = await productSyncService.syncVendor('sekalipay', { type: 'full' });
        console.log(`[CRON] Sekalipay full sync completed:`, result);
    } catch (err) {
        console.error('[CRON] Sekalipay full sync failed:', err.message);
    }
});

// Fincloud full sync daily at 03:30
cron.schedule('30 3 * * *', async () => {
    console.log('[CRON] Starting Fincloud full sync...');
    try {
        const result = await productSyncService.syncVendor('fincloud', { type: 'full' });
        console.log(`[CRON] Fincloud full sync completed:`, result);
    } catch (err) {
        console.error('[CRON] Fincloud full sync failed:', err.message);
    }
});

// Okeconnect full sync daily at 04:00
cron.schedule('0 4 * * *', async () => {
    console.log('[CRON] Starting Okeconnect full sync...');
    try {
        const result = await productSyncService.syncVendor('okeconnect', { type: 'full' });
        console.log(`[CRON] Okeconnect full sync completed:`, result);
    } catch (err) {
        console.error('[CRON] Okeconnect full sync failed:', err.message);
    }
});

// ══════════════════════════════════════════════════════════════════════════
// PAYMENT POLLING CRON JOBS (Fallback for Webhooks)
// ══════════════════════════════════════════════════════════════════════════

const paymentPollingService = require('./services/paymentPollingService');

cron.schedule('* * * * *', async () => {
    // Run every minute
    await paymentPollingService.pollPendingOrders();
    await paymentPollingService.cancelExpiredOrders();
    await paymentPollingService.pollProcessingOrders();
});

console.log('[CRON] Unified Product Sync scheduled: Sekalipay (delta 1h, full 03:00), Fincloud (full 03:30), Okeconnect (full 04:00)');
console.log('[CRON] Payment polling scheduled: every 1 minute');


// ══════════════════════════════════════════════════════════════════════════
// START / EXPORT
// ══════════════════════════════════════════════════════════════════════════

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
