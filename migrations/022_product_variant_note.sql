-- ══════════════════════════════════════════════════════════════
-- Migration 022: Catatan publik per varian produk
--
-- Catatan ini ditampilkan di halaman produk (di bawah pemilih paket)
-- dan diatur dari dashboard admin pada tab Sekalipay / OkeConnect.
--
-- Jalankan di Supabase SQL Editor.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS note TEXT;

COMMENT ON COLUMN product_variants.note IS
    'Catatan publik per varian. Teks multi-baris, format sederhana (bold/italic/code/list).';
