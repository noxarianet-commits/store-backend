-- ══════════════════════════════════════════════════════════════════════════
-- Migration 016: Hapus Vendor Fincloud PPOB dan Produk Terkait
-- 
-- Apa yang dilakukan:
--   1. Menghapus varian produk di product_variants yang berelasi dengan vendor fincloud
--   2. Menghapus semua produk dari vendor fincloud di tabel products
--   3. Menghapus setting & sync history Fincloud PPOB dari tabel settings
--   4. Menghapus tabel legacy fincloud_products jika masih ada
--
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 1: Hapus Varian Produk Vendor Fincloud               │
-- └─────────────────────────────────────────────────────────────┘
DELETE FROM product_variants
WHERE product_id IN (
    SELECT id FROM products WHERE vendor = 'fincloud'
);

-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 2: Hapus Produk Vendor Fincloud                      │
-- └─────────────────────────────────────────────────────────────┘
DELETE FROM products
WHERE vendor = 'fincloud';

-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 3: Hapus Pengaturan & Sync Metadata Fincloud PPOB     │
-- └─────────────────────────────────────────────────────────────┘
DELETE FROM settings
WHERE key IN ('fincloud_last_sync', 'fincloud_sync', 'fincloud_ppob_config');

-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 4: Hapus Tabel Legacy jika Masih Ada                 │
-- └─────────────────────────────────────────────────────────────┘
DROP TABLE IF EXISTS fincloud_products CASCADE;

-- ══════════════════════════════════════════════════════════════════════════
-- VERIFIKASI:
--   SELECT count(*) AS remaining_fincloud_products 
--   FROM products WHERE vendor = 'fincloud'; 
--   -- Harus mengembalikan 0
--
--   SELECT count(*) AS remaining_fincloud_variants 
--   FROM product_variants pv 
--   JOIN products p ON p.id = pv.product_id 
--   WHERE p.vendor = 'fincloud'; 
--   -- Harus mengembalikan 0
-- ══════════════════════════════════════════════════════════════════════════
