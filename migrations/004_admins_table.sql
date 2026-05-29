-- ══════════════════════════════════════════════════════════════
-- Migration 004: Create Admins Table
-- Tabel dedicated untuk autentikasi admin (terpisah dari settings)
-- Password disimpan dalam bentuk bcrypt hash (TIDAK pernah plaintext)
-- Run this script in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. Buat tabel admins
CREATE TABLE IF NOT EXISTS admins (
    id          BIGSERIAL PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,           -- bcrypt hash, BUKAN plaintext
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Index untuk pencarian cepat berdasarkan username
CREATE INDEX IF NOT EXISTS idx_admins_username ON admins(username);

-- 3. Trigger: otomatis update kolom updated_at setiap kali row diupdate
CREATE OR REPLACE FUNCTION update_admins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admins_updated_at ON admins;
CREATE TRIGGER trg_admins_updated_at
    BEFORE UPDATE ON admins
    FOR EACH ROW
    EXECUTE FUNCTION update_admins_updated_at();

-- 4. Hapus admin_auth dari tabel settings (tidak lagi dibutuhkan)
--    CATATAN: Jalankan baris ini SETELAH Anda menjalankan seeder
--    agar admin default sudah ada sebelum data lama dihapus.
-- DELETE FROM settings WHERE key = 'admin_auth';

-- ══════════════════════════════════════════════════════════════
-- DONE! Tabel admins siap digunakan.
-- Selanjutnya jalankan: node utils/seed-admin.js
-- ══════════════════════════════════════════════════════════════
