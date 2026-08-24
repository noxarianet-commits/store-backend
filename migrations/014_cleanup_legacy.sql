-- ============================================================================
-- Migration 014: Cleanup Legacy Columns, Indexes, and Tables
-- Description: Menghapus tabel fincloud_products, kolom-kolom vendor-spesifik
--              lama di orders dan products (termasuk JSONB variants), serta
--              membersihkan index usang.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HAPUS TABEL FINCLOUD_PRODUCTS (Data sudah dipindah ke products di Migrasi 012)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS fincloud_products CASCADE;

-- ----------------------------------------------------------------------------
-- 2. HAPUS KOLOM LAMA DI TABEL PRODUCTS
-- ----------------------------------------------------------------------------
-- Hapus index lama terlebih dahulu jika ada
DROP INDEX IF EXISTS idx_products_sekalipay_product_id;
DROP INDEX IF EXISTS idx_products_sekalipay_item_id;

-- Hapus kolom lama di products
ALTER TABLE products DROP COLUMN IF EXISTS sekalipay_item_id;
ALTER TABLE products DROP COLUMN IF EXISTS sekalipay_product_id;
ALTER TABLE products DROP COLUMN IF EXISTS variants; -- JSONB digantikan oleh product_variants

-- ----------------------------------------------------------------------------
-- 3. HAPUS KOLOM LAMA DI TABEL ORDERS
-- ----------------------------------------------------------------------------
-- Hapus index lama di orders
DROP INDEX IF EXISTS idx_orders_sekalipay_ref_id;
DROP INDEX IF EXISTS idx_orders_dyqris_ref_id;
DROP INDEX IF EXISTS idx_orders_sayabayar_ref_id;
DROP INDEX IF EXISTS idx_orders_vendor_ref_id;

-- Hapus kolom vendor-spesifik lama di orders (digantikan kolom generik)
ALTER TABLE orders DROP COLUMN IF EXISTS sekalipay_ref_id;
ALTER TABLE orders DROP COLUMN IF EXISTS sekalipay_invoice;
ALTER TABLE orders DROP COLUMN IF EXISTS sekalipay_variant_id;
ALTER TABLE orders DROP COLUMN IF EXISTS fincloud_sku;
ALTER TABLE orders DROP COLUMN IF EXISTS dyqris_ref_id;
ALTER TABLE orders DROP COLUMN IF EXISTS sayabayar_ref_id;
ALTER TABLE orders DROP COLUMN IF EXISTS vendor_ref_id;
ALTER TABLE orders DROP COLUMN IF EXISTS testimonial;
ALTER TABLE orders DROP COLUMN IF EXISTS proof_image;

-- ----------------------------------------------------------------------------
-- 4. BUAT INDEX BARU YANG OPTIMAL UNTUK SKEMA UNIFIED
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_vendor_order_id ON orders(vendor_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_variant_id ON orders(vendor_variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_pg_invoice ON orders(pg_invoice);
CREATE INDEX IF NOT EXISTS idx_product_variants_vendor_variant_id ON product_variants(vendor_variant_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_lookup ON product_variants(product_id, is_active, is_hidden);

-- ----------------------------------------------------------------------------
-- 5. BERSIHKAN SETTINGS USANG
-- ----------------------------------------------------------------------------
DELETE FROM settings WHERE key = 'admin_auth';
