const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
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

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(globalLimiter); // Terapkan pembatasan dasar ke semua endpoint

// Setup CORS yang lebih ketat
const allowedOrigins = [
    'http://localhost:5173',
    'https://noxarianet.vercel.app',
    'https://noxarianet.com'
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
app.use(express.json());

// Security Middleware for Admin Routes
const verifyAdmin = async (req, res, next) => {
    try {
        const token = req.headers['x-admin-token'];
        if (!token) return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });

        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'admin_auth')
            .maybeSingle();

        const auth = data ? data.value : { username: 'ANDIKA K.A', password: 'ANDIKAGANTENG.' };
        
        // Simple token: base64 of username:password
        const expectedToken = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        
        if (token === expectedToken) {
            next();
        } else {
            res.status(403).json({ error: 'Token tidak valid atau kadaluarsa.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Gagal memverifikasi admin.' });
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

// GET Settings
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*');
        if (error) throw error;

        const settingsMap = {
            shop_status: { isOpen: true, message: 'Selamat datang!' },
            banners: [],
            admin_auth: { username: 'ANDIKA K.A', password: 'ANDIKAGANTENG.' } // Default jika belum ada di DB
        };
        data.forEach(s => settingsMap[s.key] = s.value);
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
            // Fallback to db.json if Supabase is empty
            try {
                const dbPath = path.join(__dirname, 'db.json');
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

// ADMIN LOGIN (Secure)
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('Login attempt for username:', username);

        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'admin_auth')
            .maybeSingle(); // Pakai maybeSingle agar tidak error kalau kosong

        // Gunakan data dari DB jika ada, kalau tidak pakai default ini
        const auth = data ? data.value : {
            username: 'ANDIKA K.A',
            password: 'ANDIKAGANTENG.'
        };

        if (username === auth.username && password === auth.password) {
            console.log('Login SUCCESS for:', username);
            const token = Buffer.from(`${username}:${password}`).toString('base64');
            res.json({ success: true, token });
        } else {
            console.log('Login FAILED for:', username);
            res.status(401).json({ success: false, error: 'Username atau Password salah!' });
        }
    } catch (err) {
        console.error('Login Error:', err);
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

