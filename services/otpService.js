/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — OTP Service
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pembuat & verifier OTP email untuk registrasi akun dan lupa password.
 * Satu-satunya tempat yang menyentuh tabel `email_otps`, supaya seluruh aturan
 * (TTL, batas percobaan, cooldown resend, hashing) tidak tersebar di controller.
 *
 * Env variables:
 *   OTP_PEPPER — Rahasia tambahan untuk hash OTP. WAJIB ada di produksi.
 *                Kalau kosong, jatuh ke JWT_SECRET.
 */

const crypto = require('crypto');
const supabase = require('../supabase');

const CODE_LENGTH = 6;
const DEFAULT_TTL_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const PURPOSE = {
    REGISTER: 'register',
    RESET_PASSWORD: 'reset_password',
};

// Pepper terpisah dari kode, sehingga hash yang bocor (backup, dump SQL, log
// query) tidak bisa di-brute-force di luar proses. Tanpa pepper, penyerang
// cukup mencoba 1.000.000 kombinasi SHA-256 di CPU biasa dalam hitungan detik.
const OTP_PEPPER = process.env.OTP_PEPPER || process.env.JWT_SECRET;

if (!OTP_PEPPER) {
    console.error('[OtpService] PERINGATAN: OTP_PEPPER dan JWT_SECRET kosong — hash OTP tidak aman.');
}

/**
 * Kode OTP numerik sepanjang CODE_LENGTH, dibangkitkan dengan CSPRNG.
 * crypto.randomInt (bukan Math.random) karena menebak kode = bypass autentikasi.
 * @returns {string} Contoh: "402817"
 */
function generateCode() {
    const min = 10 ** (CODE_LENGTH - 1);
    const max = 10 ** CODE_LENGTH;
    return String(crypto.randomInt(min, max)).padStart(CODE_LENGTH, '0');
}

/**
 * Hash OTP dengan pepper. `email` dan `purpose` ikut di-hash supaya hash dari
 * satu tujuan tidak bisa dipakai ulang di tujuan lain (mis. kode reset
 * password dicoba pada endpoint registrasi).
 *
 * @param {string} code
 * @param {string} email
 * @param {string} purpose
 * @returns {string} hex SHA-256
 */
function hashCode(code, email, purpose) {
    return crypto
        .createHash('sha256')
        .update(`${OTP_PEPPER}|${email}|${purpose}|${code}`)
        .digest('hex');
}

/**
 * Perbandingan hash yang aman terhadap timing attack.
 * Pola sama dengan paymentController.js:35 (safeEqual).
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (err) {
        return false;
    }
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// ══════════════════════════════════════════════════════════════════════════
// GENERATE
// ══════════════════════════════════════════════════════════════════════════

/**
 * Buat OTP baru dan nonaktifkan OTP lama untuk (email, purpose) yang sama.
 *
 * Mengganti, bukan menumpuk: kalau ada OTP lama yang masih hidup, resend akan
 * membatalkannya. Tanpa ini, kode lama tetap berlaku sampai kedaluwarsa dan
 * user bisa saja memakai kode lama, bukan yang baru saja dikirim.
 *
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.purpose - 'register' | 'reset_password'
 * @param {number} [options.ttlMinutes=10]
 * @param {number} [options.maxAttempts=5]
 * @returns {Promise<{ok: boolean, code?: string, otpId?: string, expiresAt?: Date, error?: string}>}
 */
async function generateOtp({
    email,
    purpose,
    ttlMinutes = DEFAULT_TTL_MINUTES,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
    const mail = normalizeEmail(email);
    const code = generateCode();

    try {
        // Batalkan OTP lama lebih dulu supaya hanya satu yang berlaku.
        await supabase
            .from('email_otps')
            .update({ verified_at: new Date().toISOString() })
            .eq('email', mail)
            .eq('purpose', purpose)
            .is('verified_at', null);

        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

        const { data, error } = await supabase
            .from('email_otps')
            .insert({
                email: mail,
                code_hash: hashCode(code, mail, purpose),
                purpose,
                attempts: 0,
                max_attempts: maxAttempts,
                expires_at: expiresAt.toISOString(),
            })
            .select('id, expires_at')
            .single();

        if (error) throw error;

        console.log(`[OtpService] OTP dibuat untuk ${purpose} → ${mail} (kedaluwarsa ${expiresAt.toISOString()})`);

        return {
            ok: true,
            code,
            otpId: data.id,
            expiresAt: new Date(data.expires_at),
        };
    } catch (err) {
        console.error('[OtpService] generateOtp Error:', err);
        return { ok: false, error: err.message };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY
// ══════════════════════════════════════════════════════════════════════════

/**
 * Cocokkan kode OTP dengan yang tersimpan.
 *
 * Setiap pemanggilan yang gagal SELALU menambah `attempts` — termasuk saat kode
 * sudah kedaluwarsa atau sudah pernah dipakai. Kalau counter hanya naik pada
 * kode yang salah, penyerang bisa memakai kode kedaluwarsa sebagai pemecah
 * tanpa batas.
 *
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.purpose
 * @param {string} options.code - 6 digit
 * @returns {Promise<{ok: boolean, reason?: 'invalid'|'expired'|'maxed'|'missing', otpId?: string}>}
 */
async function verifyOtp({ email, purpose, code }) {
    const mail = normalizeEmail(email);
    const submitted = String(code || '').trim();

    // 1. OTP untuk (email, purpose) ini belum pernah dibuat / sudah dipakai.
    const { data: otp, error } = await supabase
        .from('email_otps')
        .select('id, code_hash, attempts, max_attempts, expires_at')
        .eq('email', mail)
        .eq('purpose', purpose)
        .is('verified_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('[OtpService] verifyOtp query Error:', error);
        return { ok: false, reason: 'invalid' };
    }
    if (!otp) return { ok: false, reason: 'missing' };

    // 2. Batas percobaan — diperiksa sebelum hashing supaya kode tidak bisa
    //    dicoba berulang tanpa konsekuensi.
    if (otp.attempts >= otp.max_attempts) {
        return { ok: false, reason: 'maxed', otpId: otp.id };
    }

    // 3. Kedaluwarsa.
    if (new Date(otp.expires_at).getTime() <= Date.now()) {
        return { ok: false, reason: 'expired', otpId: otp.id };
    }

    // 4. Cocokkan kode.
    if (!safeEqual(hashCode(submitted, mail, purpose), otp.code_hash)) {
        return await consumeFailedAttempt(otp, purpose, mail);
    }

    // 5. Berhasil → bakar kodenya supaya tidak bisa dipakai ulang.
    const { data: consumed, error: consumeError } = await supabase
        .from('email_otps')
        .update({ verified_at: new Date().toISOString() })
        .eq('id', otp.id)
        .is('verified_at', null)
        .select('id')
        .maybeSingle();

    if (consumeError) {
        console.error('[OtpService] verifyOtp consume Error:', consumeError);
        return { ok: false, reason: 'invalid' };
    }
    if (!consumed) {
        // Di antara select dan update, request lain sudah consume lebih dulu.
        return { ok: false, reason: 'invalid' };
    }

    return { ok: true, otpId: otp.id };
}

/**
 * Naikkan counter percobaan dan laporkan hasilnya.
 *
 * Increment memakai `eq('attempts', otp.attempts)` sehingga bersifat
 * compare-and-swap: kalau nol baris yang terpengaruh, berarti request lain
 * sudah menaikkan counter duluan dan pemeriksaan batas percobaan di atas sudah
 * basi. Tanpa ini, lima request paralel bisa semuanya lolos cek batas.
 *
 * @param {Object} otp - Baris OTP yang sudah dibaca
 * @param {string} purpose
 * @param {string} mail
 * @returns {Promise<{ok: boolean, reason: 'invalid'|'maxed', otpId: string}>}
 */
async function consumeFailedAttempt(otp, purpose, mail) {
    const { data: updated } = await supabase
        .from('email_otps')
        .update({ attempts: otp.attempts + 1 })
        .eq('id', otp.id)
        .eq('attempts', otp.attempts)
        .select('attempts, max_attempts')
        .maybeSingle();

    if (!updated) {
        // Konflik: percobaan paralel sudah menaikkan counter duluan.
        return { ok: false, reason: 'invalid', otpId: otp.id };
    }

    if (updated.attempts >= updated.max_attempts) {
        console.warn(`[OtpService] OTP untuk ${purpose} → ${mail} terkunci setelah ${updated.attempts} percobaan.`);
        return { ok: false, reason: 'maxed', otpId: otp.id };
    }

    console.warn(`[OtpService] OTP salah untuk ${purpose} → ${mail} (percobaan ${updated.attempts}/${updated.max_attempts})`);
    return { ok: false, reason: 'invalid', otpId: otp.id };
}

// ══════════════════════════════════════════════════════════════════════════
// RESEND COOLDOWN
// ══════════════════════════════════════════════════════════════════════════

/**
 * Sisa detik sebelum OTP untuk (email, purpose) boleh dibuat ulang.
 *
 * Rate limit per-IP (express-rate-limit) tidak mencegah penyerang dengan satu
 * email dari banyak IP, dan sebaliknya. Cooldown per email menutup kedua sisi:
 * spraying dari banyak IP tetap tertahan, dan satu IP yang menebak banyak email
 * tetap harus menunggu tiap email.
 *
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.purpose
 * @param {number} [cooldownSeconds=60]
 * @returns {Promise<{allowed: boolean, retryAfterSeconds: number}>}
 */
async function getResendCooldown({ email, purpose, cooldownSeconds = RESEND_COOLDOWN_SECONDS }) {
    const mail = normalizeEmail(email);

    try {
        const { data: latest, error } = await supabase
            .from('email_otps')
            .select('created_at')
            .eq('email', mail)
            .eq('purpose', purpose)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error || !latest) return { allowed: true, retryAfterSeconds: 0 };

        const elapsedSeconds = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
        const remaining = Math.ceil(cooldownSeconds - elapsedSeconds);

        if (remaining > 0) {
            return { allowed: false, retryAfterSeconds: remaining };
        }
        return { allowed: true, retryAfterSeconds: 0 };
    } catch (err) {
        console.error('[OtpService] getResendCooldown Error:', err);
        // Jangan kunci user keluar karena masalah transient — biarkan coba lagi.
        return { allowed: true, retryAfterSeconds: 0 };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// INVALIDATE / CLEANUP
// ══════════════════════════════════════════════════════════════════════════

/**
 * Nonaktifkan semua OTP aktif untuk (email, purpose).
 * Dipanggil setelah password berhasil diganti agar kode lama tidak bisa dipakai lagi.
 *
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.purpose
 * @returns {Promise<void>}
 */
async function invalidateOtps({ email, purpose }) {
    try {
        const { error } = await supabase
            .from('email_otps')
            .update({ verified_at: new Date().toISOString() })
            .eq('email', normalizeEmail(email))
            .eq('purpose', purpose)
            .is('verified_at', null);

        if (error) throw error;
    } catch (err) {
        console.error('[OtpService] invalidateOtps Error:', err);
    }
}

/**
 * Hapus OTP & pending registration yang sudah lama kedaluwarsa.
 * Dipanggil dari cron harian di server.js — tabel ini bukan arsip, tidak perlu
 * tumbuh tanpa batas.
 *
 * @returns {Promise<{otpsDeleted: number, pendingDeleted: number}>}
 */
async function purgeExpired() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let otpsDeleted = 0;
    let pendingDeleted = 0;

    try {
        const otps = await supabase.from('email_otps').delete({ count: 'exact' }).lt('expires_at', cutoff);
        if (otps.error) throw otps.error;
        otpsDeleted = otps.count || 0;

        const pending = await supabase
            .from('pending_registrations')
            .delete({ count: 'exact' })
            .lt('expires_at', cutoff);
        if (pending.error) throw pending.error;
        pendingDeleted = pending.count || 0;

        console.log(`[OtpService] Pembersihan: ${otpsDeleted} OTP, ${pendingDeleted} pending registrasi dihapus.`);
    } catch (err) {
        console.error('[OtpService] purgeExpired Error:', err);
    }

    return { otpsDeleted, pendingDeleted };
}

module.exports = {
    PURPOSE,
    CODE_LENGTH,
    RESEND_COOLDOWN_SECONDS,
    generateOtp,
    verifyOtp,
    invalidateOtps,
    getResendCooldown,
    purgeExpired,
};