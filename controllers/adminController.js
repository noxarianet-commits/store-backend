const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * POST /api/admin/login
 * Authenticate admin with username/password, returns JWT token.
 */
async function login(req, res) {
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
        if (!admin || !admin.is_active) {
            return res.status(401).json({ success: false, error: 'Username atau password salah.' });
        }

        // 3. Verifikasi password menggunakan bcrypt
        const isPasswordValid = await bcrypt.compare(password, admin.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, error: 'Username atau password salah.' });
        }

        // 4. Buat JWT token
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
}

/**
 * PUT /api/admin/password
 * Change admin password. (Protected)
 */
async function changePassword(req, res) {
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
}

module.exports = { login, changePassword };
