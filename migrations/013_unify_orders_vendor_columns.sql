-- ══════════════════════════════════════════════════════════════
-- Migration 013: Unify Orders Vendor Columns
--
-- Fase 1C dari Blueprint Perombakan Multi-Vendor
--
-- Apa yang dilakukan:
--   1. Tambah kolom generic: vendor_order_id, vendor_variant_id
--   2. Pastikan vendor_invoice ada
--   3. Backfill dari kolom vendor-specific lama
--   4. Tambah indexes
--
-- PENTING: Kolom lama (sekalipay_ref_id, fincloud_sku, dll)
-- TIDAK dihapus di migration ini. Penghapusan ada di Fase 5 (cleanup)
-- setelah semua kode sudah menggunakan kolom generic baru.
--
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 1: Tambah kolom generic (additive)                   │
-- └─────────────────────────────────────────────────────────────┘

-- vendor_order_id: menggantikan sekalipay_ref_id / vendor_ref_id
-- vendor_variant_id: menggantikan sekalipay_variant_id / fincloud_sku
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS vendor_order_id TEXT,
    ADD COLUMN IF NOT EXISTS vendor_variant_id TEXT;

-- vendor_invoice: mungkin sudah ada (dipakai di orderFulfillmentService.js),
-- tapi tidak pernah ada di migration files → tambah untuk safety
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS vendor_invoice TEXT;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 2: Backfill dari kolom lama                          │
-- │                                                            │
-- │  Mengisi kolom generic baru dari data yang sudah ada       │
-- │  di kolom vendor-specific lama.                            │
-- └─────────────────────────────────────────────────────────────┘

-- Backfill vendor_order_id
UPDATE orders SET
    vendor_order_id = COALESCE(vendor_ref_id, sekalipay_ref_id)
WHERE vendor_order_id IS NULL;

-- Backfill vendor_variant_id
UPDATE orders SET
    vendor_variant_id = COALESCE(
        fincloud_sku,
        sekalipay_variant_id::TEXT
    )
WHERE vendor_variant_id IS NULL;

-- Backfill vendor_invoice dari sekalipay_invoice
UPDATE orders SET
    vendor_invoice = sekalipay_invoice
WHERE vendor_invoice IS NULL AND sekalipay_invoice IS NOT NULL;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 3: Indexes                                           │
-- └─────────────────────────────────────────────────────────────┘

CREATE INDEX IF NOT EXISTS idx_orders_vendor_order_id ON orders(vendor_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_variant_id ON orders(vendor_variant_id);


-- ══════════════════════════════════════════════════════════════
-- DONE! Verifikasi:
--   -- Cek backfill berhasil (tidak ada NULL di order yang punya ref lama)
--   SELECT id, vendor, vendor_order_id, vendor_variant_id, vendor_invoice,
--          sekalipay_ref_id, sekalipay_variant_id, fincloud_sku
--   FROM orders
--   WHERE vendor_order_id IS NULL
--     AND (sekalipay_ref_id IS NOT NULL OR vendor_ref_id IS NOT NULL)
--   LIMIT 10;
--   -- Harus return 0 rows
--
-- CATATAN: Kolom lama (sekalipay_ref_id, sekalipay_invoice,
-- sekalipay_variant_id, fincloud_sku, vendor_ref_id) TETAP ADA.
-- Kolom ini akan dihapus di Migration 014 (Fase 5) setelah semua
-- kode backend sudah sepenuhnya menggunakan kolom generic baru.
-- ══════════════════════════════════════════════════════════════
