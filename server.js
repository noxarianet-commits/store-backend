const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
require('dotenv').config();

const syncService = require('./services/syncService');

// Routes
const sekalipayRoutes = require('./routes/sekalipayRoutes');
const sekalipayAdminRoutes = require('./routes/sekalipayAdminRoutes');
const productRoutes = require('./routes/productRoutes');
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
    windowMs: 10 * 60 * 1000, max: 300,
    message: { error: 'Terlalu banyak request, silakan coba lagi nanti.' },
    standardHeaders: true, legacyHeaders: false,
});

// CORS
const allowedOrigins = [
    'http://localhost:5173',
    'https://noxarianet.vercel.app',
    'https://www.noxarianet.web.id',
    'https://test.noxarianet.web.id'
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app') || origin.startsWith('http://localhost:')) {
            callback(null, true);
        } else {
            callback(new Error('Akses ditolak oleh CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
}));

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(globalLimiter);

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES — Harus di-mount SEBELUM express.json()
// agar raw body bisa dibaca untuk verifikasi signature
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/webhooks', webhookRoutes);

// Global JSON body parser (hanya untuk non-webhook routes)
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Public
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/home', homeRoutes);
app.use('/api/sekalipay', sekalipayRoutes);
app.use('/api/products', productRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/testimonials', testimonialRoutes);
app.use('/api/payments', paymentRoutes);

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Protected (Admin)
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/admin/sekalipay', verifyAdmin, sekalipayAdminRoutes);
app.use('/api/orders', verifyAdmin, orderRoutes);

// Admin auth: login limiter and verifyAdmin are defined in adminRoutes.js
app.use('/api/admin', adminRoutes);

// ══════════════════════════════════════════════════════════════════════════
// SEKALIPAY CRON JOBS
// ══════════════════════════════════════════════════════════════════════════

cron.schedule('0 */3 * * *', async () => {
    console.log('[CRON] Starting Sekalipay delta sync...');
    try {
        const result = await syncService.deltaSync();
        console.log(`[CRON] Delta sync completed: ${result.productCount || 0} products updated.`);
    } catch (err) {
        console.error('[CRON] Delta sync failed:', err.message);
    }
});

cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Starting Sekalipay full sync...');
    try {
        const result = await syncService.fullSync();
        console.log(`[CRON] Full sync completed: ${result.productCount || 0} products synced.`);
    } catch (err) {
        console.error('[CRON] Full sync failed:', err.message);
    }
});

// ══════════════════════════════════════════════════════════════════════════
// PAYMENT POLLING CRON JOBS (Fallback for Webhooks)
// ══════════════════════════════════════════════════════════════════════════

const paymentPollingService = require('./services/paymentPollingService');

cron.schedule('* * * * *', async () => {
    // Run every minute
    await paymentPollingService.pollPendingOrders();
});

console.log('[CRON] Sekalipay sync scheduled: delta every 3h, full daily at 03:00');
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
