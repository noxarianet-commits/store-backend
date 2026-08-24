-- ══════════════════════════════════════════════════════════════
-- Migration 012: Migrate Fincloud Products to Unified Tables
--
-- Fase 1B dari Blueprint Perombakan Multi-Vendor
--
-- Apa yang dilakukan:
--   1. Insert fincloud_products ke tabel products (tanpa harga)
--   2. Buat 1 variant per fincloud product di product_variants
--
-- PRASYARAT: Migration 011 harus sudah dijalankan terlebih dahulu!
--
-- CATATAN: Tabel `products` TIDAK punya kolom base_price/markup/sell_price.
-- Harga hanya ada di level product_variants.
--
-- ON CONFLICT DO NOTHING: aman dijalankan berulang kali.
--
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 1: Insert fincloud products ke tabel products        │
-- │                                                            │
-- │  Hanya kolom product-level yang dimasukkan.                │
-- │  Harga disimpan di product_variants (Step 2).              │
-- └─────────────────────────────────────────────────────────────┘

INSERT INTO products (vendor, external_id, category, name, brand,
                      is_active, metadata, created_at)
SELECT
    'fincloud',
    sku,                    -- external_id = SKU dari Fincloud
    category,
    name,
    brand,
    is_available,           -- is_available → is_active
    product_meta,           -- product_meta → metadata
    created_at
FROM fincloud_products
ON CONFLICT (vendor, external_id) DO NOTHING;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 2: Buat 1 variant per fincloud product               │
-- │                                                            │
-- │  Fincloud punya struktur flat (1 SKU = 1 produk),          │
-- │  jadi setiap fincloud product menjadi 1 variant.           │
-- │  SKU dipakai sebagai vendor_variant_id.                    │
-- └─────────────────────────────────────────────────────────────┘

INSERT INTO product_variants (product_id, vendor_variant_id, name,
                              base_price, markup, sell_price, stock,
                              order_process, is_active, is_hidden, synced_at)
SELECT
    p.id,
    fp.sku,                 -- vendor_variant_id = SKU
    fp.name,
    fp.base_price,
    fp.markup,
    fp.sell_price,
    9999,                   -- fincloud tidak punya stock tracking, pakai 9999
    'auto',
    fp.is_available,
    fp.is_hidden,
    fp.updated_at           -- synced_at = last update dari Fincloud
FROM fincloud_products fp
JOIN products p ON p.vendor = 'fincloud' AND p.external_id = fp.sku
ON CONFLICT (product_id, vendor_variant_id) DO NOTHING;


-- ══════════════════════════════════════════════════════════════
-- DONE! Verifikasi:
--   SELECT count(*) FROM products WHERE vendor = 'fincloud';
--   SELECT count(*) FROM product_variants pv
--     JOIN products p ON p.id = pv.product_id
--     WHERE p.vendor = 'fincloud';
--   -- Kedua angka harus sama (1 variant per fincloud product)
--
--   -- Cross-check: tidak ada fincloud product yang terlewat
--   SELECT count(*) FROM fincloud_products fp
--   WHERE NOT EXISTS (
--     SELECT 1 FROM products p
--     WHERE p.vendor = 'fincloud' AND p.external_id = fp.sku
--   );
--   -- Harus return 0
-- ══════════════════════════════════════════════════════════════
