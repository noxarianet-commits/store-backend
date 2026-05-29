const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET tidak ditemukan di environment variables!');
    process.exit(1);
}

// Sekalipay integration
const sekalipayRoutes = require('./routes/sekalipayRoutes');
const syncService = require('./services/syncService');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Setup Rate Limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Terlalu banyak request, silakan coba lagi nanti.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Terlalu banyak percobaan login, coba lagi dalam 15 menit.' },
});

const orderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: { error: 'Terlalu banyak pesanan dibuat. Harap tunggu 1 jam sebelum memesan lagi.' },
});

// Setup CORS yang lebih ketat
const allowedOrigins = [
    'http://localhost:5173',
    'https://noxarianet.vercel.app',
    'https://www.noxarianet.web.id',
    'https://store.jualbelimusang.my.id'
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

// PENTING: cors HARUS dipanggil sebelum rate limiter agar response rate limit memiliki header CORS
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

// Setup Trust Proxy agar rate limiter mengambil IP pengguna dengan benar di belakang Cloudflare/Vercel
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(globalLimiter); // Terapkan pembatasan dasar ke semua endpoint
app.use(express.json());

// Security Middleware for Admin Routes
// Memverifikasi JWT Bearer token yang diterbitkan saat login
const verifyAdmin = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
        if (!authHeader) return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });

        // Support kedua format: "Bearer <token>" atau raw token (backward compat)
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Sesi telah berakhir. Silakan login kembali.' });
        }
        res.status(403).json({ error: 'Token tidak valid.' });
    }
};

// Export app for Vercel
module.exports = app;

// Only listen if not on Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

// Multer storage for temporary processing before upload to Supabase
const upload = multer({ storage: multer.memoryStorage() });

// ══════════════════════════════════════════════════════════════════════════
// SEKALIPAY ROUTES
// ══════════════════════════════════════════════════════════════════════════

// Public Sekalipay routes (no auth needed)
app.use('/api/sekalipay', sekalipayRoutes);

// Admin Sekalipay routes (auth required) — mounted on same router with /admin prefix
app.use('/api/admin/sekalipay', verifyAdmin, sekalipayRoutes);

// ══════════════════════════════════════════════════════════════════════════
// SEKALIPAY CRON JOBS — Stock & Product Sync
// ══════════════════════════════════════════════════════════════════════════

// Delta sync every 3 hours (updates only changed items)
cron.schedule('0 */3 * * *', async () => {
    console.log('[CRON] Starting Sekalipay delta sync...');
    try {
        const result = await syncService.deltaSync();
        console.log(`[CRON] Delta sync completed: ${result.productCount || 0} products updated.`);
    } catch (err) {
        console.error('[CRON] Delta sync failed:', err.message);
    }
});

// Full sync daily at 3 AM (refreshes all products)
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
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════

// GET Products
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST Product (Protected)
app.post('/api/products', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .insert([req.body]);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Product (Protected)
app.put('/api/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('products')
            .update(req.body)
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE Product (Protected)
app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('products')
            .delete()
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Services
app.get('/api/services', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST Service (Protected)
app.post('/api/services', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('services')
            .insert([req.body]);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Service (Protected)
app.put('/api/services/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('services')
            .update(req.body)
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE Service (Protected)
app.delete('/api/services/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('services')
            .delete()
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Settings (Public — hanya data non-sensitif)
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*');
        if (error) throw error;

        const settingsMap = {
            shop_status: { isOpen: true, message: 'Selamat datang!' },
            banners: []
            // CATATAN: admin_auth TIDAK lagi ada di settings — sudah dipindah ke tabel admins
        };
        data.forEach(s => {
            // Pastikan kunci sensitif tidak pernah ter-expose ke publik
            if (s.key !== 'admin_auth') {
                settingsMap[s.key] = s.value;
            }
        });
        res.json(settingsMap);
    } catch (err) {
        console.error('GET Settings Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET Testimonials
app.get('/api/testimonials', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('testimonials')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);
        if (error) throw error;
        
        if (!data || data.length === 0) {
            // Fallback ke data/db.json jika Supabase kosong
            try {
                const dbPath = path.join(__dirname, 'data', 'db.json');
                const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                if (dbData.testimonials && dbData.testimonials.length > 0) {
                    return res.json(dbData.testimonials);
                }
            } catch (e) {
                console.error('Error reading fallback testimonials from db.json:', e);
            }
        }
        
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ADMIN LOGIN — Menggunakan bcrypt + JWT
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username dan password wajib diisi.' });
        }

        // 1. Ambil admin dari tabel dedicated (bukan settings)
        const { data: admin, error } = await supabase
            .from('admins')
            .select('id, username, password, is_active')
            .eq('username', username)
            .maybeSingle();

        if (error) {
            console.error('Login DB Error:', error);
            return res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
        }

        // 2. Jika admin tidak ditemukan, kembalikan pesan generik
        //    (hindari memberitahu bahwa username tidak ada)
        if (!admin || !admin.is_active) {
            return res.status(401).json({ success: false, error: 'Username atau password salah.' });
        }

        // 3. Verifikasi password menggunakan bcrypt (konstan time)
        const isPasswordValid = await bcrypt.compare(password, admin.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, error: 'Username atau password salah.' });
        }

        // 4. Buat JWT token — password TIDAK dimasukkan ke dalam payload
        const token = jwt.sign(
            { id: admin.id, username: admin.username },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        console.log(`[AUTH] Login sukses untuk: ${admin.username}`);
        res.json({ success: true, token });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
});

// ADMIN CHANGE PASSWORD (Protected)
app.put('/api/admin/password', verifyAdmin, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        const adminId = req.admin.id;

        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'current_password dan new_password wajib diisi.' });
        }

        if (new_password.length < 8) {
            return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
        }

        // Ambil hash password saat ini
        const { data: admin, error } = await supabase
            .from('admins')
            .select('password')
            .eq('id', adminId)
            .single();

        if (error || !admin) {
            return res.status(404).json({ error: 'Admin tidak ditemukan.' });
        }

        // Verifikasi password lama
        const isValid = await bcrypt.compare(current_password, admin.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Password saat ini tidak cocok.' });
        }

        // Hash password baru & simpan
        const newHash = await bcrypt.hash(new_password, 12);
        const { error: updateError } = await supabase
            .from('admins')
            .update({ password: newHash })
            .eq('id', adminId);

        if (updateError) throw updateError;

        console.log(`[AUTH] Password berhasil diubah untuk admin id: ${adminId}`);
        res.json({ success: true, message: 'Password berhasil diubah.' });
    } catch (err) {
        console.error('Change Password Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Setting (Upsert) (Protected)
app.put('/api/settings/:key', verifyAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        console.log(`Updating setting: ${key}`);

        const { error } = await supabase
            .from('settings')
            .upsert({ key, value }, { onConflict: 'key' });

        if (error) {
            console.error('Supabase Error:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('UPDATE Settings Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST Banner Upload (Protected)
app.post('/api/banners', verifyAdmin, upload.single('banner'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        console.log('Uploading banner:', req.file.originalname);

        const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        const fileName = `banners/${Date.now()}-${safeOriginalName}`;
        const { data, error } = await supabase.storage
            .from('proofs')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (error) {
            console.error('Supabase Storage Error:', error);
            return res.status(500).json({ error: error.message });
        }

        const { data: { publicUrl } } = supabase.storage
            .from('proofs')
            .getPublicUrl(fileName);

        res.json({ url: publicUrl });
    } catch (err) {
        console.error('Banner Upload Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET Orders (Protected)
app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('timestamp', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE Order (Protected)
app.delete('/api/orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Order (Protected)
app.put('/api/orders/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('orders')
            .update(req.body)
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST Order (Public)
app.post('/api/order', orderLimiter, upload.single('proof_image'), async (req, res) => {
    try {
        console.log('Incoming Order Request...');

        let orderData = {};
        if (req.body.orderData) {
            try {
                orderData = JSON.parse(req.body.orderData);
            } catch (e) {
                console.error('JSON Parse Error:', e);
                return res.status(400).json({ error: 'Format data pesanan tidak valid' });
            }
        } else {
            // Fallback jika dikirim langsung tanpa dibungkus orderData
            orderData = req.body;
        }

        if (!orderData.id) {
            return res.status(400).json({ error: 'ID Pesanan tidak ditemukan' });
        }

        let publicUrl = null;
        if (req.file) {
            console.log('Uploading proof image:', req.file.originalname);
            const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
            const fileName = `proofs/${Date.now()}-${safeOriginalName}`;
            const { data: storageData, error: storageError } = await supabase.storage
                .from('proofs')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: false
                });

            if (storageError) {
                console.error('Storage Error (Order Proof):', storageError);
                return res.status(500).json({ error: `Gagal upload bukti: ${storageError.message}` });
            }

            const { data: urlData } = supabase.storage.from('proofs').getPublicUrl(fileName);
            publicUrl = urlData.publicUrl;
            console.log('Proof image uploaded:', publicUrl);
        }

        console.log('Inserting order into DB:', orderData.id);
        const { data, error: dbError } = await supabase
            .from('orders')
            .insert([{
                id: orderData.id,
                product: orderData.product || 'Unknown',
                variant: orderData.variant || '-',
                price: parseInt(orderData.price) || 0,
                email: orderData.email || '-',
                wa_number: orderData.wa_number || '-',
                payment_method: orderData.payment_method || '-',
                testimonial: orderData.testimonial || '-',
                proof_image: publicUrl,
                timestamp: new Date().toISOString()
            }]);

        if (dbError) {
            console.error('Database Error (Order):', dbError);
            return res.status(500).json({ error: `Gagal simpan ke DB: ${dbError.message}` });
        }

        // Jika ada testimoni, masukkan ke tabel testimonials
        const rawTestimonial = orderData.testimonial || req.body.testimonial;
        const customerWA = orderData.wa_number || req.body.wa_number || 'Customer';

        if (rawTestimonial && rawTestimonial !== '-' && rawTestimonial !== '') {
            console.log('Menyimpan Testimoni Baru dari:', customerWA);
            const { error: testiError } = await supabase.from('testimonials').insert([{
                name: customerWA,
                text: rawTestimonial,
                product: orderData.product || 'Unknown',
                created_at: new Date().toISOString()
            }]);

            if (testiError) {
                console.error('Gagal simpan testimoni:', testiError);
            } else {
                console.log('Testimoni berhasil disimpan!');
            }
        }

        console.log('Order processed successfully!');
        res.json({ success: true, data });
    } catch (err) {
        console.error('Server Catch Error (Order):', err);
        require('fs').appendFileSync('error.log', new Date().toISOString() + ' - ' + err.stack + '\n');
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// NOTE: Server listen sudah ditangani di baris 24-28 (conditional).
// Di Vercel, module.exports = app (baris 21) yang digunakan.
// ══════════════════════════════════════════════════════════════════════════

