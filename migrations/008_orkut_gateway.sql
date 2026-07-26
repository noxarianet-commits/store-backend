-- ══════════════════════════════════════════════════════════════
-- Migration 008: ORKUT Payment Gateway Support + Unique Code
-- Menambahkan kolom untuk mendukung:
--   - Multiple payment gateway providers (FinCloud / ORKUT)
--   - Kode unik per transaksi (1–999) untuk deteksi pembayaran
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. Kode unik transaksi (ditambahkan ke nominal agar berbeda)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS unique_code INTEGER DEFAULT 0;

-- 2. Payment gateway provider yang digunakan (fincloud / orkut)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_provider TEXT DEFAULT 'fincloud';

-- 3. ORKUT-specific: ref ID dari ORKUT Gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS orkut_ref_id TEXT;

-- Index
CREATE INDEX IF NOT EXISTS idx_orders_pg_provider ON orders(pg_provider);
CREATE INDEX IF NOT EXISTS idx_orders_orkut_ref_id ON orders(orkut_ref_id);

-- ══════════════════════════════════════════════════════════════
-- DONE!
-- ══════════════════════════════════════════════════════════════
