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
        // type: 'admin' wajib — verifyAdmin.js menolak token tanpa claim ini
        const token = jwt.sign(
            { id: admin.id, username: admin.username, type: 'admin' },
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

/**
 * GET /api/admin/users
 * List users with pagination and search.
 */
async function getUsers(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const offset = (page - 1) * limit;

        let query = supabase
            .from('user_profiles')
            .select('id, email, phone, display_name, balance, balance_limit, is_active, created_at', { count: 'exact' });

        if (search) {
            query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%,phone.ilike.%${search}%`);
        }

        const { data, count, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            success: true,
            data,
            pagination: {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * PATCH /api/admin/users/:id/balance
 * Adjust balance manually (admin credit/debit).
 */
async function adjustBalance(req, res) {
    try {
        const { id } = req.params;
        const { amount, type, description } = req.body;

        if (!amount || amount <= 0 || !['credit', 'debit'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Input tidak valid.' });
        }

        const balanceService = require('../services/balanceService');
        const refId = `ADMIN-${Date.now()}`;
        
        if (type === 'credit') {
            await balanceService.creditBalance(id, amount, 'topup', refId, description || 'Penyesuaian saldo oleh Admin');
        } else {
            await balanceService.debitBalance(id, amount, refId, description || 'Penyesuaian saldo oleh Admin');
        }

        res.json({ success: true, message: 'Saldo berhasil disesuaikan.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * PATCH /api/admin/users/:id/limit
 * Change balance limit.
 */
async function updateLimit(req, res) {
    try {
        const { id } = req.params;
        const { limit } = req.body;

        if (typeof limit !== 'number' || limit < 0) {
            return res.status(400).json({ success: false, error: 'Limit tidak valid.' });
        }

        const { error } = await supabase
            .from('user_profiles')
            .update({ balance_limit: limit })
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: 'Limit berhasil diupdate.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * PATCH /api/admin/users/:id/status
 * Toggle is_active.
 */
async function toggleStatus(req, res) {
    try {
        const { id } = req.params;
        const { is_active } = req.body;

        if (typeof is_active !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Status tidak valid.' });
        }

        const { error } = await supabase
            .from('user_profiles')
            .update({ is_active })
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: 'Status berhasil diupdate.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/admin/balance-transactions
 * List balance transactions with pagination, filters (type, status), and multi-field search.
 */
async function getBalanceTransactions(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { type, status, search } = req.query;

        let query = supabase
            .from('balance_transactions')
            .select('*, user_profiles(id, email, phone, display_name)', { count: 'exact' });

        if (type && type !== 'ALL') {
            query = query.eq('type', type);
        }

        if (status && status !== 'ALL') {
            query = query.eq('status', status);
        }

        if (search && search.trim()) {
            const searchTerm = search.trim();
            // Search in user profiles first to get matched user IDs
            const { data: matchedUsers } = await supabase
                .from('user_profiles')
                .select('id')
                .or(`email.ilike.%${searchTerm}%,display_name.ilike.%${searchTerm}%,phone.ilike.%${searchTerm}%`);

            const orClauses = [
                `reference_id.ilike.%${searchTerm}%`,
                `description.ilike.%${searchTerm}%`,
                `pg_invoice.ilike.%${searchTerm}%`
            ];

            if (matchedUsers && matchedUsers.length > 0) {
                const userIds = matchedUsers.map(u => u.id).join(',');
                orClauses.push(`user_id.in.(${userIds})`);
            }

            query = query.or(orClauses.join(','));
        }

        const { data, count, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            success: true,
            data,
            pagination: {
                total: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit) || 1
            }
        });
    } catch (err) {
        console.error('getBalanceTransactions Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/admin/balance-transactions/stats
 * Aggregate metrics for balance transactions (completed topup, purchase, refund, pending count).
 */
async function getBalanceTransactionStats(req, res) {
    try {
        const [txRes, usersRes] = await Promise.all([
            supabase.from('balance_transactions').select('type, amount, status'),
            supabase.from('user_profiles').select('balance')
        ]);

        if (txRes.error) throw txRes.error;
        if (usersRes.error) throw usersRes.error;

        const txData = txRes.data || [];
        const usersData = usersRes.data || [];

        // Akumulasi saldo user
        let totalUserBalance = 0;
        let usersWithBalance = 0;
        usersData.forEach(u => {
            totalUserBalance += (u.balance || 0);
            if (u.balance > 0) usersWithBalance++;
        });

        let totalTopup = 0;
        let countTopup = 0;
        let totalPurchase = 0;
        let countPurchase = 0;
        let totalRefund = 0;
        let countRefund = 0;
        let pendingCount = 0;

        txData.forEach(tx => {
            if (tx.status === 'completed') {
                if (tx.type === 'topup') {
                    totalTopup += tx.amount || 0;
                    countTopup++;
                } else if (tx.type === 'purchase') {
                    totalPurchase += tx.amount || 0;
                    countPurchase++;
                } else if (tx.type === 'refund') {
                    totalRefund += tx.amount || 0;
                    countRefund++;
                }
            }
            if (tx.status === 'pending') {
                pendingCount++;
            }
        });

        res.json({
            success: true,
            stats: {
                totalUserBalance,
                totalUsers: usersData.length,
                usersWithBalance,
                totalTopup,
                countTopup,
                totalPurchase,
                countPurchase,
                totalRefund,
                countRefund,
                pendingCount,
                totalCount: txData.length
            }
        });
    } catch (err) {
        console.error('getBalanceTransactionStats Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = {
    login,
    changePassword,
    getUsers,
    adjustBalance,
    updateLimit,
    toggleStatus,
    getBalanceTransactions,
    getBalanceTransactionStats
};

