-- 020_auth_email_otp.sql
--
-- Verifikasi OTP via email untuk registrasi akun & lupa password.
--
-- SEBELUMNYA `POST /api/auth/register` langsung membuat baris `user_profiles` dan
-- langsung mengembalikan JWT. Artinya siapa pun bisa mendaftar dengan email orang
-- lain (merekam pesanan + saldo orang itu ke akunnya), dan tidak ada bukti
-- kepemilikan email sama sekali. Lupa password juga tidak mungkin ditangani
-- karena email tidak pernah diverifikasi.
--
-- Alur baru (customers only, admin tetap username+password):
--
--   Registrasi (2 langkah)
--     1. POST /api/auth/register          → simpan pending_registrations, kirim OTP,
--                                          JAWAB 200 TANPA TOKEN
--     2. POST /api/auth/register/verify   → cek OTP, baru insert user_profiles
--                                          dengan email_verified = true, lalu token
--
--   Lupa password (2 langkah)
--     1. POST /api/auth/forgot-password         → OTP
--     2. POST /api/auth/forgot-password/verify  → ganti password_hash
--
-- Karena akun baru hanya dibuat SETELAH OTP benar, data registrasi (nama,
-- nomor, hash password) harus ditahan di server di antara dua langkah tersebut.
-- Itulah gunanya tabel `pending_registrations` di bawah — bukan sekadar cache.
--
-- OTP TIDAK disimpan polos: hanya SHA-256(email + purpose + code + pepper).
-- Tanpa pepper, hash yang bocor dari backup bisa di-brute-force di offline
-- dalam hitungan detik (ruang 10^6 = 1.000.000). Pepper diambil dari
-- OTP_PEPPER, fallback ke JWT_SECRET — lihat services/otpService.js.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Tandai email sebagai terverifikasi
-- ══════════════════════════════════════════════════════════════════════════

-- DEFAULT true + backfill ke bawah: seluruh user yang sudah ada sebelum fitur
-- ini TIDAK wajib verifikasi ulang. Mereka sudah login dengan password dan
-- sudah punya saldo/pesanan, memaksa OTP sekali lagi hanya membingungkan.
-- Default `true` juga berarti user baru otomatis true karena satu-satunya jalur
-- pendaftaran yang sah sudah melewati OTP.
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true;

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

UPDATE user_profiles
   SET email_verified = true,
       email_verified_at = COALESCE(created_at, NOW())
 WHERE email_verified IS NULL;

COMMENT ON COLUMN user_profiles.email_verified IS
    'true bila kepemilikan email sudah dibuktikan lewat OTP. User lama di-backfill menjadi true saat migration ini dijalankan. Jalur pendaftaran tunggal (POST /api/auth/register → /register/verify) selalu menghasilkan true, jadi nilai false hanya mungkin terjadi bila ada akun lama yang nilainya sengaja diturunkan.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. Tabel OTP
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_otps (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email       TEXT NOT NULL,
    -- SHA-256 hex, bukan kode polos. Lihat catatan pepper di atas.
    code_hash   TEXT NOT NULL,
    purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'reset_password')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at  TIMESTAMPTZ NOT NULL,
    -- NULL = masih aktif. Diisi saat OTP dipakai atau digantikan oleh resend.
    verified_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Lookup utama: "OTP terbaru untuk (email, purpose) yang belum dipakai".
CREATE INDEX IF NOT EXISTS idx_email_otps_lookup
    ON email_otps (email, purpose, created_at DESC);

-- Berpoke-dalam expired untuk cron harian di server.js.
CREATE INDEX IF NOT EXISTS idx_email_otps_expires
    ON email_otps (expires_at);

COMMENT ON TABLE email_otps IS
    'OTP verifikasi email untuk registrasi dan reset password. Kode disimpan sebagai SHA-256 ber-pepper, tidak pernah polos. Baris tidak dihapus segera setelah dipakai (verified_at diisi) supaya percobaan ulang kode lama tidak mungkin berhasil.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. Tabel pending registrations
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pending_registrations (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    phone         TEXT NOT NULL,
    -- bcrypt hash. Plaintext password tidak pernah menyentuh database ini.
    password_hash TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    -- Diisi saat OTP registrasi berhasil dicocokkan. Menandai registrasi ini
    -- sudah ditukar menjadi akun sehingga tidak bisa dipakai ulang.
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Partial UNIQUE: satu alamat email hanya boleh punya satu registrasi yang
-- masih menunggu verifikasi. Register ulang menghapus baris lama (replace),
-- bukan menumpuk — tanpa index ini, dua request bersamaan bisa menyisakan dua
-- baris pending untuk email yang sama dan `maybeSingle()` akan meledak.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_active_email
    ON pending_registrations (email)
    WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires
    ON pending_registrations (expires_at);

COMMENT ON TABLE pending_registrations IS
    'Data registrasi yang menahan Credentials (nama, no. HP, bcrypt hash) selama user membuktikan kepemilikan email. Dihapus otomatis oleh cron pembersihan harian di server.js setelah expires_at terlewati.';