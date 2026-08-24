-- ══════════════════════════════════════════════════════════════
-- Migration 011: Unified Products + Product Variants Table
-- 
-- Fase 1A dari Blueprint Perombakan Multi-Vendor
-- 
-- Apa yang dilakukan:
--   1. Tambah kolom vendor, external_id, brand, metadata ke products
--   2. Backfill external_id dari sekalipay_product_id
--   3. Buat tabel product_variants (ekstraksi dari JSONB variants)
--   4. Migrasi data variants JSONB existing ke product_variants
--
-- PENTING: Migration ini ADDITIVE — tidak menghapus kolom/tabel apapun.
-- Semua fitur existing tetap berjalan normal setelah migration ini.
--
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 1: Tambah kolom unified ke products                  │
-- └─────────────────────────────────────────────────────────────┘

-- 1a. Kolom vendor & external_id (pengganti sekalipay_product_id)
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT 'sekalipay',
    ADD COLUMN IF NOT EXISTS external_id TEXT;

-- 1b. Backfill: external_id = sekalipay_product_id untuk data existing
UPDATE products SET external_id = sekalipay_product_id::TEXT
WHERE vendor = 'sekalipay' AND external_id IS NULL;

-- 1c. Unique constraint baru (vendor + external_id)
--     Ini adalah conflict target utama untuk sync upsert di masa depan
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_vendor_external
    ON products(vendor, external_id);

-- 1d. Kolom brand & metadata (untuk fincloud, opsional untuk vendor lain)
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS brand TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- 1e. Pastikan is_featured ada
--     Kolom ini sudah aktif dipakai di homeController.js dan sekalipayAdminRoutes.js,
--     tapi tidak pernah ada di migration files (kemungkinan ditambahkan via SQL Editor).
--     ADD COLUMN IF NOT EXISTS memastikan ini aman di kedua kasus.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 2: Buat tabel product_variants                       │
-- │                                                            │
-- │  Menggantikan kolom JSONB `variants` di products.          │
-- │  Relasi: products (1) → product_variants (N)              │
-- │  Kolom lama `variants` TIDAK dihapus (fase 5).            │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS product_variants (
    id                BIGSERIAL PRIMARY KEY,
    product_id        BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    vendor_variant_id TEXT NOT NULL,       -- variant ID dari vendor (Sekalipay: item_id, Fincloud: SKU)
    name              TEXT NOT NULL,
    base_price        INTEGER NOT NULL DEFAULT 0,
    markup            INTEGER NOT NULL DEFAULT 1000,
    sell_price        INTEGER,             -- base_price + markup (computed saat sync)
    stock             INTEGER DEFAULT 0,
    order_process     TEXT DEFAULT 'auto', -- auto | manual | h2h | smm
    h2h_provider      TEXT,
    provider_meta     JSONB DEFAULT '{}',  -- { open_denom, min_qty, max_qty }
    required_fields   JSONB DEFAULT '[]',  -- ["user_id", "zone_id"]
    validation        JSONB DEFAULT '{}',  -- { available, requires_zone_id }
    is_hidden         BOOLEAN DEFAULT false,
    is_active         BOOLEAN DEFAULT true,
    metadata          JSONB DEFAULT '{}',
    synced_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(product_id, vendor_variant_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pv_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_pv_vendor_variant ON product_variants(vendor_variant_id);
CREATE INDEX IF NOT EXISTS idx_pv_active ON product_variants(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_pv_not_hidden ON product_variants(is_hidden) WHERE is_hidden = false;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  STEP 3: Migrasi data variants JSONB → product_variants    │
-- │                                                            │
-- │  Mengekstrak setiap elemen dari kolom variants JSONB       │
-- │  di products (Sekalipay) ke baris terpisah di              │
-- │  product_variants.                                         │
-- │                                                            │
-- │  ON CONFLICT DO NOTHING: aman dijalankan berulang kali.    │
-- └─────────────────────────────────────────────────────────────┘

INSERT INTO product_variants (
    product_id, vendor_variant_id, name, base_price, markup, sell_price,
    stock, order_process, h2h_provider, provider_meta, required_fields,
    validation, is_hidden, is_active, synced_at
)
SELECT
    p.id,
    (v->>'id')::TEXT,                                      -- vendor_variant_id
    v->>'name',                                            -- name
    COALESCE((v->>'base_price')::INTEGER, 0),              -- base_price
    COALESCE((v->>'markup')::INTEGER, 1000),               -- markup
    COALESCE((v->>'sell_price')::INTEGER, 0),              -- sell_price
    COALESCE((v->>'stock')::INTEGER, 0),                   -- stock
    COALESCE(v->>'order_process', 'auto'),                 -- order_process
    v->>'h2h_provider',                                    -- h2h_provider
    COALESCE((v->'provider_meta')::JSONB, '{}'::JSONB),    -- provider_meta
    COALESCE((v->'required_fields')::JSONB, '[]'::JSONB),  -- required_fields
    COALESCE((v->'validation')::JSONB, '{}'::JSONB),       -- validation
    COALESCE((v->>'is_hidden')::BOOLEAN, false),           -- is_hidden
    true,                                                  -- is_active (default true)
    p.synced_at                                            -- synced_at (dari parent)
FROM products p,
     jsonb_array_elements(p.variants) AS v
WHERE p.vendor = 'sekalipay'
  AND jsonb_array_length(p.variants) > 0
ON CONFLICT (product_id, vendor_variant_id) DO NOTHING;


-- ══════════════════════════════════════════════════════════════
-- DONE! Verifikasi:
--   SELECT count(*) FROM product_variants;
--   -- Harus > 0 jika products sudah punya variants JSONB
--
--   SELECT p.name, count(pv.id) as variant_count
--   FROM products p
--   LEFT JOIN product_variants pv ON pv.product_id = p.id
--   WHERE p.vendor = 'sekalipay'
--   GROUP BY p.name
--   ORDER BY variant_count DESC
--   LIMIT 10;
-- ══════════════════════════════════════════════════════════════
