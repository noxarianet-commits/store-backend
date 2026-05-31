-- ══════════════════════════════════════════════════════════════
-- Migration 005: Automated Payment Flow
-- Menambahkan kolom-kolom untuk mendukung:
--   - Sekalipay Payment Gateway (PG) sebagai payment provider
--   - Sekalipay Reseller API untuk pembuatan order otomatis
--   - Error tracking agar bot WA bisa notifikasi admin
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. Tambah kolom status lifecycle
--    PENDING       → Order dibuat, menunggu pembayaran
--    PROCESSING    → Pembayaran dikonfirmasi PG, order Sekalipay sedang diproses
--    COMPLETED     → Sekalipay selesai, account_details tersedia
--    FAILED        → Gagal di sisi Sekalipay (saldo habis, dll)
--    CANCELLED     → Order dibatalkan / expired
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';

-- 2. Kolom Payment Gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_invoice TEXT;           -- Invoice dari PG (contoh: INV/20231224/KWL/12345)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_payment_link TEXT;      -- Link halaman pembayaran PG
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_qr_link TEXT;           -- QR code image URL (QRIS)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_virtual_account TEXT;   -- Nomor VA (jika metode VA)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_payment_code TEXT;      -- Metode bayar (QRIS, BCAVA, dll)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_fee INTEGER DEFAULT 0;  -- Biaya layanan PG
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_total INTEGER DEFAULT 0;-- Total termasuk fee
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_expired_at TIMESTAMPTZ; -- Waktu kadaluarsa pembayaran
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_paid_at TIMESTAMPTZ;    -- Waktu bayar terverifikasi PG

-- 3. Kolom Sekalipay Reseller
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sekalipay_ref_id TEXT;     -- ref_id yang dikirim ke Sekalipay (= order id)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sekalipay_invoice TEXT;    -- Invoice yang dikembalikan Sekalipay
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sekalipay_variant_id INTEGER; -- Variant ID Sekalipay

-- 4. Hasil order (detail akun dari Sekalipay)
--    Format: { "licenses": ["key1", "key2"], "type": "auto" }
ALTER TABLE orders ADD COLUMN IF NOT EXISTS account_details JSONB;

-- 5. Error handling — agar bot WA bisa notif admin
--    Diisi saat terjadi kegagalan di sisi Sekalipay (BALANCE_IS_INSUFFICIENT, dll)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 6. Info tambahan dari frontend
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;

-- ══════════════════════════════════════════════════════════════
-- Index untuk query cepat
-- ══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_pg_invoice   ON orders(pg_invoice);
CREATE INDEX IF NOT EXISTS idx_orders_sekalipay_ref_id ON orders(sekalipay_ref_id);

-- ══════════════════════════════════════════════════════════════
-- DONE! Jalankan juga di Supabase Dashboard → Table Editor
-- untuk memastikan kolom baru visible di interface.
-- ══════════════════════════════════════════════════════════════
