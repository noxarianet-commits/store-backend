const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * POST /api/auth/register
 */
async function register(req, res) {
    try {
        const { email, phone, display_name, password } = req.body;

        if (!email || !phone || !display_name || !password) {
            return res.status(400).json({ success: false, error: 'Semua field wajib diisi.' });
        }

        if (password.length < 8) {
             return res.status(400).json({ success: false, error: 'Password minimal 8 karakter.' });
        }

        // Cek email unik
        const { data: existingUser } = await supabase
            .from('user_profiles')
            .select('id')
            .eq('email', email)
            .maybeSingle();

        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const { data: newUser, error } = await supabase
            .from('user_profiles')
            .insert([{ email, phone, display_name, password_hash }])
            .select('id, email, display_name, phone, balance, is_active')
            .single();

        if (error) throw error;

        const token = jwt.sign(
            { id: newUser.id, email: newUser.email, display_name: newUser.display_name, type: 'user' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user: newUser });
    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/login
 */
async function login(req, res) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email dan password wajib diisi.' });
        }

        const { data: user, error } = await supabase
            .from('user_profiles')
            .select('id, email, phone, display_name, password_hash, balance, is_active')
            .eq('email', email)
            .maybeSingle();

        if (error || !user) {
            return res.status(401).json({ success: false, error: 'Email atau password salah.' });
        }

        if (!user.is_active) {
            return res.status(401).json({ success: false, error: 'Akun dinonaktifkan.' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Email atau password salah.' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, display_name: user.display_name, type: 'user' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        delete user.password_hash;
        res.json({ success: true, token, user });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * GET /api/auth/profile
 */
async function getProfile(req, res) {
    try {
        const { data: user, error } = await supabase
            .from('user_profiles')
            .select('id, email, phone, display_name, balance, balance_limit, is_active, created_at')
            .eq('id', req.user.id)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });
        }

        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * PUT /api/auth/profile
 */
async function updateProfile(req, res) {
    try {
        const { display_name, phone } = req.body;
        
        const updates = {};
        if (display_name !== undefined) updates.display_name = display_name;
        if (phone !== undefined) updates.phone = phone;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, error: 'Tidak ada data yang diupdate.' });
        }

        const { data: user, error } = await supabase
            .from('user_profiles')
            .update(updates)
            .eq('id', req.user.id)
            .select('id, email, phone, display_name, balance, is_active')
            .single();

        if (error) throw error;

        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * PUT /api/auth/password
 */
async function changePassword(req, res) {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ success: false, error: 'Password saat ini dan baru wajib diisi.' });
        }
        if (new_password.length < 8) {
             return res.status(400).json({ success: false, error: 'Password minimal 8 karakter.' });
        }

        const { data: user, error } = await supabase
            .from('user_profiles')
            .select('password_hash')
            .eq('id', req.user.id)
            .single();

        if (error || !user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });

        const isValid = await bcrypt.compare(current_password, user.password_hash);
        if (!isValid) return res.status(401).json({ success: false, error: 'Password saat ini salah.' });

        const newHash = await bcrypt.hash(new_password, 10);
        
        const { error: updateError } = await supabase
            .from('user_profiles')
            .update({ password_hash: newHash })
            .eq('id', req.user.id);

        if (updateError) throw updateError;

        res.json({ success: true, message: 'Password berhasil diubah.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/auth/orders
 * Fetch authenticated user's order history with pagination
 */
async function getUserOrders(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const userId = req.user.id;
        const userEmail = req.user.email;
        const userPhone = req.user.phone;

        let orConditions = [`user_id.eq.${userId}`];
        if (userEmail) orConditions.push(`email.eq.${userEmail}`);
        if (userPhone) orConditions.push(`wa_number.eq.${userPhone}`);

        const { count, error: countError } = await supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .or(orConditions.join(','));

        if (countError) throw countError;

        const { data, error } = await supabase
            .from('orders')
            .select('id, product, variant, price, status, timestamp, payment_method, payment_type')
            .or(orConditions.join(','))
            .order('timestamp', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            success: true,
            data: data || [],
            pagination: {
                total: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit) || 1
            }
        });
    } catch (err) {
        console.error('getUserOrders Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { register, login, getProfile, updateProfile, changePassword, getUserOrders };

