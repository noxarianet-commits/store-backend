const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const otpService = require('../services/otpService');
const emailService = require('../services/emailService');

const JWT_SECRET = process.env.JWT_SECRET;

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_SALT_ROUNDS = 10;
const PENDING_TTL_MINUTES = 30;

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

/**
 * Cari user berdasarkan email, case-insensitive.
 *
 * Pakai `.limit(1)` dan bukan `.maybeSingle()`: kolom `email` punya batasan
 * UNIQUE yang case-SENSITIVE, jadi "A@x.com" dan "a@x.com" bisa hidup berdampingan.
 * maybeSingle() akan melempar error pada dua baris semacam itu — user yang
 * emailnya terdaftar dengan kapitalisasi aneh akan mendapat 500 saat login.
 * .limit(1) selalu mengembalikan baris pertama bila ada, dan null bila tidak ada.
 *
 * @param {string} email
 * @returns {Promise<{data: Object|null, error: Object|null}>}
 */
async function findUserByEmail(email, columns) {
    const { data, error } = await supabase
        .from('user_profiles')
        .select(columns)
        .ilike('email', normalizeEmail(email))
        .limit(1);

    return { data: data && data.length > 0 ? data[0] : null, error };
}

/**
 * Samarkan sebagian email untuk ditampilkan di respons, mis. "n***@mail.com".
 * Murni kosmetik untuk UI, tidak ada peran keamanan.
 *
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
    const mail = normalizeEmail(email);
    const at = mail.indexOf('@');
    if (at <= 0) return mail;

    const local = mail.slice(0, at);
    const visible = local.slice(0, 1);
    return `${visible}${'*'.repeat(Math.max(3, local.length - 1))}${mail.slice(at)}`;
}

/**
 * Sign token untuk user yang baru selesai verifikasi.
 * Dipakai oleh verifyRegistration; login memakai payload yang sama persis,
 * jadi token dari kedua jalur tidak bisa dibedakan oleh verifyUser.
 */
function signUserToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, display_name: user.display_name, type: 'user' },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

/**
 * Pesan error yang aman untuk ditampilkan ke pengguna, berdasarkan alasan
 * kegagalan OTP. 'missing' disamarkan jadi 'invalid' supaya penyerang tidak
 * bisa memakai endpoint ini untuk memeriksa email mana yang pernah meminta OTP.
 *
 * @param {string} reason - Alasan dari otpService.verifyOtp
 * @returns {{status: number, error: string}}
 */
function mapOtpFailure(reason) {
    switch (reason) {
        case 'expired':
            return { status: 400, error: 'Kode verifikasi sudah kedaluwarsa. Silakan minta kode baru.' };
        case 'maxed':
            return { status: 429, error: 'Terlalu banyak percobaan. Silakan minta kode baru.' };
        case 'missing':
        case 'invalid':
        default:
            return { status: 400, error: 'Kode verifikasi salah.' };
    }
}

/**
 * Periksa cooldown resend untuk (email, purpose).
 *
 * @param {Object} res
 * @param {string} email
 * @param {string} purpose
 * @returns {Promise<Object|null>} Objek response kalau cooldown masih aktif, null kalau boleh.
 */
async function checkCooldown(res, email, purpose) {
    const cooldown = await otpService.getResendCooldown({ email, purpose });

    if (cooldown.allowed) return null;

    return res.status(429).json({
        success: false,
        error: `Terlalu sering meminta kode. Coba lagi dalam ${cooldown.retryAfterSeconds} detik.`,
        retry_after: cooldown.retryAfterSeconds,
    });
}

/**
 * Buat OTP lalu kirim lewat email. Melempar balasan error kalau gagal.
 *
 * Pengiriman di-AWAIT di sini, tidak seperti email notifikasi order yang
 * fire-and-forget. Email OTP adalah satu-satunya jalan melewati verifikasi, jadi
 * kegagalan diam-diam akan membuat user terkunci di layar OTP tanpa tahu kenapa.
 * OTP yang gagal terkirim langsung di-invalidate supaya tidak ada kode yatim
 * yang entah bisa dipakai.
 *
 * @param {Object} res
 * @param {string} email
 * @param {string} purpose
 * @param {string} [displayName]
 * @returns {Promise<Object|null>} Objek response kalau gagal, null kalau sukses.
 */
async function dispatchOtp(res, email, purpose, displayName) {
    const otp = await otpService.generateOtp({ email, purpose, ttlMinutes: PENDING_TTL_MINUTES });

    if (!otp.ok) {
        return res.status(500).json({ success: false, error: 'Gagal membuat kode verifikasi. Silakan coba lagi.' });
    }

    const mail = await emailService.sendOtpEmail({
        to: email,
        code: otp.code,
        purpose,
        displayName,
        expiresMinutes: PENDING_TTL_MINUTES,
    });

    if (!mail.success) {
        console.error(`[Auth] Gagal mengirim OTP ke ${email}:`, mail.error);
        await otpService.invalidateOtps({ email, purpose });
        return res.status(500).json({
            success: false,
            error: 'Gagal mengirim email verifikasi. Silakan coba lagi beberapa saat lagi.',
        });
    }

    return null;
}

/**
 * Cek cooldown lalu kirim OTP. Dipakai oleh endpoint resend.
 *
 * @param {Object} res
 * @param {string} email
 * @param {string} purpose
 * @param {string} [displayName]
 * @returns {Promise<Object|null>}
 */
async function dispatchOtpWithCooldown(res, email, purpose, displayName) {
    const cooldownFailure = await checkCooldown(res, email, purpose);
    if (cooldownFailure) return cooldownFailure;

    return dispatchOtp(res, email, purpose, displayName);
}

/**
 * POST /api/auth/register
 *
 * LANGKAH 1 dari 2. TIDAK lagi membuat akun dan tidak mengembalikan token.
 * Data registrasi ditahan di `pending_registrations`, lalu email berisi OTP dikirim
 * ke alamat tersebut. Akun baru hanya dibuat oleh /register/verify setelah
 * kepemilikan email terbukti.
 *
 * Kenapa tidak langsung membuat akun seperti sebelumnya: tanpa verifikasi email,
 * siapa pun bisa mendaftar memakai alamat orang lain lalu order dan saldonya
 * ikut menempel ke akun tersebut.
 */
async function register(req, res) {
    const email = normalizeEmail(req.body.email);
    const { phone, display_name, password } = req.body;

    if (!email || !phone || !display_name || !password) {
        return res.status(400).json({ success: false, error: 'Semua field wajib diisi.' });
    }

    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ success: false, error: 'Format email tidak valid.' });
    }

    if (String(password).length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({
            success: false,
            error: `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`,
        });
    }

    try {
        // Cek apakah email ini sudah punya akun.
        const { data: existingUser, error: lookupError } = await findUserByEmail(email, 'id');

        if (lookupError) throw lookupError;

        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });
        }

        // Cooldown diperiksa SEBELUM menyentuh pending_registrations. Kalau tidak,
        // daftar ulang di dalam jendela cooldown akan menimpa pending yang lama,
        // lalu baris baru ikut terhapus saat balasan 429 dikirim — user kehilangan
        // satu-satunya jalan menyelesaikan registrasi, sementara OTP lamanya sudah
        // dibatalkan. Di posisi ini, pending lama & OTP-nya tetap utuh.
        const cooldownFailure = await checkCooldown(res, email, otpService.PURPOSE.REGISTER);
        if (cooldownFailure) return cooldownFailure;

        // Hash sekarang, simpan di pending. Menghemat satu bcrypt round-trip di
        // langkah verifikasi, dan plaintext password tidak pernah sampai ke DB.
        const password_hash = await bcrypt.hash(String(password), PASSWORD_SALT_ROUNDS);

        // Registrasi ulang untuk email yang sama menggantikan yang lama, bukan
        // menumpuk: tanpa ini satu email bisa punya banyak baris pending dan
        // maybeSingle() di /register/verify akan gagal.
        await supabase
            .from('pending_registrations')
            .delete()
            .eq('email', email)
            .is('consumed_at', null);

        const { error: insertError } = await supabase.from('pending_registrations').insert({
            email,
            display_name: String(display_name).trim(),
            phone: String(phone).trim(),
            password_hash,
            expires_at: new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString(),
        });

        if (insertError) throw insertError;

        const failure = await dispatchOtp(res, email, otpService.PURPOSE.REGISTER, display_name);

        if (failure) {
            // Jangan tinggalkan pending data kalau email gagal terkirim —
            // user tidak akan pernah bisa menyelesaikan registrasinya.
            await supabase
                .from('pending_registrations')
                .delete()
                .eq('email', email)
                .is('consumed_at', null);

            return failure;
        }

        res.json({
            success: true,
            requires_verification: true,
            email,
            masked_email: maskEmail(email),
            expires_in: PENDING_TTL_MINUTES * 60,
            resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/register/verify
 *
 * LANGKAH 2 dari 2. Cocokkan OTP, baru baris `user_profiles` dibuat dan token
 * dikembalikan. Satu kode hanya bisa dipakai sekali.
 */
async function verifyRegistration(req, res) {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();

    if (!email || !code) {
        return res.status(400).json({ success: false, error: 'Email dan kode verifikasi wajib diisi.' });
    }

    try {
        const pending = await supabase
            .from('pending_registrations')
            .select('id, display_name, phone, password_hash, expires_at')
            .eq('email', email)
            .is('consumed_at', null)
            .maybeSingle();

        if (pending.error) throw pending.error;

        if (!pending.data) {
            return res.status(400).json({
                success: false,
                error: 'Tidak ada pendaftaran yang menunggu verifikasi. Silakan daftar ulang.',
            });
        }

        const otpResult = await otpService.verifyOtp({
            email,
            purpose: otpService.PURPOSE.REGISTER,
            code,
        });

        if (!otpResult.ok) {
            const mapped = mapOtpFailure(otpResult.reason);
            return res.status(mapped.status).json({ success: false, error: mapped.error });
        }

        // Data pending ikut kedaluwarsa, bukan hanya OTP-nya.
        if (new Date(pending.data.expires_at).getTime() <= Date.now()) {
            await supabase.from('pending_registrations').delete().eq('id', pending.data.id);
            return res.status(400).json({
                success: false,
                error: 'Pendaftaran sudah kedaluwarsa. Silakan daftar ulang.',
            });
        }

        // Email bisa saja terisi di antara /register dan /register/verify
        // (mis. request paralel lolos cek earlier, atau akun lama dihapus admin).
        const { data: existingUser } = await findUserByEmail(email, 'id');

        if (existingUser) {
            await supabase.from('pending_registrations').delete().eq('id', pending.data.id);
            return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });
        }

        const { data: newUser, error: insertError } = await supabase
            .from('user_profiles')
            .insert({
                email,
                phone: pending.data.phone,
                display_name: pending.data.display_name,
                password_hash: pending.data.password_hash,
                email_verified: true,
                email_verified_at: new Date().toISOString(),
            })
            .select('id, email, display_name, phone, balance, is_active, email_verified')
            .single();

        if (insertError) {
            // 23505 = unique_violation: registrasi paralel dengan email yang sama
            // berhasil duluan. Balas sebagai "sudah terdaftar", bukan 500 generik
            // yang membuat user menekan tombol daftar berulang kali.
            if (insertError.code === '23505') {
                return res.status(400).json({ success: false, error: 'Email sudah terdaftar.' });
            }
            throw insertError;
        }

        // Tandai pending sebagai sudah ditukar supaya /register/verify kedua
        // tidak bisa dipakai membuat akun lain dari data yang sama.
        await supabase
            .from('pending_registrations')
            .update({ consumed_at: new Date().toISOString() })
            .eq('id', pending.data.id);

        await otpService.invalidateOtps({ email, purpose: otpService.PURPOSE.REGISTER });

        console.log(`[Auth] Registrasi terverifikasi: ${email}`);

        res.json({
            success: true,
            token: signUserToken(newUser),
            user: newUser,
        });
    } catch (err) {
        console.error('verifyRegistration Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/register/resend
 * Kirim ulang kode verifikasi untuk registrasi yang masih menggantung.
 */
async function resendRegistrationOtp(req, res) {
    const email = normalizeEmail(req.body.email);

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email wajib diisi.' });
    }

    try {
        const { data: pending } = await supabase
            .from('pending_registrations')
            .select('display_name')
            .eq('email', email)
            .is('consumed_at', null)
            .maybeSingle();

        if (!pending) {
            return res.status(400).json({
                success: false,
                error: 'Tidak ada pendaftaran yang menunggu verifikasi. Silakan daftar ulang.',
            });
        }

        const failure = await dispatchOtpWithCooldown(
            res,
            email,
            otpService.PURPOSE.REGISTER,
            pending.display_name
        );

        if (failure) return failure;

        res.json({
            success: true,
            masked_email: maskEmail(email),
            expires_in: PENDING_TTL_MINUTES * 60,
            resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('resendRegistrationOtp Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/forgot-password
 *
 * Selalu balas sukses, baik email terdaftar maupun tidak. Balas 404 di sini akan
 * berubah jadi alat enumerasi: penyerang bisa memetakan email mana yang punya
 * akun di toko ini.
 */
async function forgotPassword(req, res) {
    const email = normalizeEmail(req.body.email);

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email wajib diisi.' });
    }

    try {
        const { data: user, error: userError } = await findUserByEmail(email, 'id, display_name, is_active');

        if (userError) throw userError;

        if (!user || !user.is_active) {
            // Balas dengan bentuk yang sama persis supaya bentuk respons tidak
            // membocorkan keberadaan akun.
            console.warn(`[Auth] Permintaan reset password untuk email tidak dikenal: ${email}`);
            return res.json({
                success: true,
                message: 'Jika email tersebut terdaftar, kode verifikasi telah dikirim.',
                resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
            });
        }

        const failure = await dispatchOtpWithCooldown(
            res,
            email,
            otpService.PURPOSE.RESET_PASSWORD,
            user.display_name
        );

        if (failure) return failure;

        res.json({
            success: true,
            message: 'Kode verifikasi telah dikirim ke email Anda.',
            resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('forgotPassword Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/forgot-password/verify
 *
 * Ganti password setelah OTP dicocokkan. TIDAK menerbitkan token baru — user
 * wajib login ulang dengan password barunya, supaya tidak ada sesi aktif yang
 * diam-diam terbentuk sebelum pemilik email sempat melihat notifikasi.
 */
async function verifyResetPassword(req, res) {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.new_password || '');

    if (!email || !code || !newPassword) {
        return res.status(400).json({
            success: false,
            error: 'Email, kode verifikasi, dan password baru wajib diisi.',
        });
    }

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({
            success: false,
            error: `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`,
        });
    }

    try {
        const otpResult = await otpService.verifyOtp({
            email,
            purpose: otpService.PURPOSE.RESET_PASSWORD,
            code,
        });

        if (!otpResult.ok) {
            const mapped = mapOtpFailure(otpResult.reason);
            return res.status(mapped.status).json({ success: false, error: mapped.error });
        }

        const newHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);

        const { data: target, error: targetError } = await findUserByEmail(email, 'id');

        if (targetError) throw targetError;

        if (!target) {
            return res.status(400).json({
                success: false,
                error: 'Akun tidak ditemukan. Silakan daftar ulang.',
            });
        }

        // Update per-id, bukan per-email: yang diubah harus baris yang tokennya
        // sedang dipakai. Menyamakan lewat filter email berisiko menimpa akun lain
        // kalau ternyata ada duplikat kapitalisasi di database.
        const { error: updateError } = await supabase
            .from('user_profiles')
            .update({ password_hash: newHash })
            .eq('id', target.id);

        if (updateError) throw updateError;

        await otpService.invalidateOtps({ email, purpose: otpService.PURPOSE.RESET_PASSWORD });

        console.log(`[Auth] Password direset: ${email}`);

        res.json({
            success: true,
            message: 'Password berhasil diubah. Silakan masuk dengan password baru Anda.',
        });
    } catch (err) {
        console.error('verifyResetPassword Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/forgot-password/resend
 * Kirim ulang kode reset password.
 *
 * Balas sukses tanpa memeriksa keberadaan email, sama seperti /forgot-password.
 * Kalau emailnya memang tidak dikenal, tidak ada yang dikirim — jadi cooldown
 * hanya bisa dipakai oleh pemilik email sungguhan.
 */
async function resendResetOtp(req, res) {
    const email = normalizeEmail(req.body.email);

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email wajib diisi.' });
    }

    try {
        const { data: user, error: userError } = await findUserByEmail(email, 'display_name, is_active');

        if (userError) throw userError;

        if (!user || !user.is_active) {
            return res.json({
                success: true,
                message: 'Jika email tersebut terdaftar, kode verifikasi telah dikirim.',
                resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
            });
        }

        const failure = await dispatchOtpWithCooldown(
            res,
            email,
            otpService.PURPOSE.RESET_PASSWORD,
            user.display_name
        );

        if (failure) return failure;

        res.json({
            success: true,
            message: 'Kode verifikasi telah dikirim ulang.',
            resend_available_in: otpService.RESEND_COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('resendResetOtp Error:', err);
        res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
    }
}

/**
 * POST /api/auth/login
 */
async function login(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const { password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email dan password wajib diisi.' });
        }

        const { data: user, error } = await findUserByEmail(
            email,
            'id, email, phone, display_name, password_hash, balance, is_active, email_verified'
        );

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

        delete user.password_hash;

        res.json({ success: true, token: signUserToken(user), user });
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
            .select('id, email, phone, display_name, balance, balance_limit, is_active, email_verified, created_at')
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
        if (new_password.length < PASSWORD_MIN_LENGTH) {
             return res.status(400).json({
                 success: false,
                 error: `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`,
             });
        }

        const { data: user, error } = await supabase
            .from('user_profiles')
            .select('password_hash')
            .eq('id', req.user.id)
            .single();

        if (error || !user) return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });

        const isValid = await bcrypt.compare(current_password, user.password_hash);
        if (!isValid) return res.status(401).json({ success: false, error: 'Password saat ini salah.' });

        const newHash = await bcrypt.hash(new_password, PASSWORD_SALT_ROUNDS);
        
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

module.exports = {
    register,
    verifyRegistration,
    resendRegistrationOtp,
    forgotPassword,
    verifyResetPassword,
    resendResetOtp,
    login,
    getProfile,
    updateProfile,
    changePassword,
    getUserOrders,
};

