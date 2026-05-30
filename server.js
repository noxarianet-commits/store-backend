const express = require('express');
const cors = require('cors');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
require('dotenv').config();

const syncService = require('./services/syncService');
const orderController = require('./controllers/orderController');

// Routes
const sekalipayRoutes = require('./routes/sekalipayRoutes');
const sekalipayAdminRoutes = require('./routes/sekalipayAdminRoutes');
const productRoutes = require('./routes/productRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const orderRoutes = require('./routes/orderRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const testimonialRoutes = require('./routes/testimonialRoutes');

const verifyAdmin = require('./middleware/verifyAdmin');

// ══════════════════════════════════════════════════════════════════════════
// APP SETUP
// ══════════════════════════════════════════════════════════════════════════

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Rate Limiters
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 100,
    message: { error: 'Terlalu banyak request, silakan coba lagi nanti.' },
    standardHeaders: true, legacyHeaders: false,
});

const orderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 50,
    message: { error: 'Terlalu banyak pesanan dibuat. Harap tunggu 1 jam sebelum memesan lagi.' },
});

// CORS
const allowedOrigins = [
    'http://localhost:5173',
    'https://noxarianet.vercel.app',
    'https://www.noxarianet.web.id',
    'https://store.jualbelimusang.my.id'
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
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
}));

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(globalLimiter);
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Public
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/sekalipay', sekalipayRoutes);
app.use('/api/products', productRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/testimonials', testimonialRoutes);

// Public order creation (with file upload and rate limiter)
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/order', orderLimiter, upload.single('proof_image'), orderController.create);

// ══════════════════════════════════════════════════════════════════════════
// ROUTES — Protected (Admin)
// ══════════════════════════════════════════════════════════════════════════

app.use('/api/admin/sekalipay', verifyAdmin, sekalipayAdminRoutes);
app.use('/api/orders', verifyAdmin, orderRoutes);
app.use('/api/banners', verifyAdmin, bannerRoutes);

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

console.log('[CRON] Sekalipay sync scheduled: delta every 3h, full daily at 03:00');

// ══════════════════════════════════════════════════════════════════════════
// START / EXPORT
// ══════════════════════════════════════════════════════════════════════════

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
