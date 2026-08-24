-- ══════════════════════════════════════════════════════════════
-- NoxariaNet Store — Full Database Setup (Current State)
-- Generated: 2026-08-20
-- 
-- Snapshot dari seluruh skema database SEBELUM cleanup/refactor.
-- Gunakan file ini untuk:
--   1. Rollback ke state database sebelum migration 011+
--   2. Setup fresh database development environment
--   3. Referensi skema yang sedang berjalan di production
--
-- Urutan eksekusi: Jalankan semua dari atas ke bawah di 
-- Supabase SQL Editor (atau psql).
--
-- CATATAN: File ini TIDAK termasuk data (hanya skema + seed minimal).
-- ══════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────────────────────────┐
-- │  1. SETTINGS TABLE                                         │
-- │  Key-value store untuk konfigurasi aplikasi.               │
-- │  Menyimpan: status toko, payment gateway, sync timestamps, │
-- │  hero content, WA links, dll.                              │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- Unique constraint pada key (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'settings_key_key'
    ) THEN
        ALTER TABLE settings ADD CONSTRAINT settings_key_key UNIQUE (key);
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'settings_key_key constraint may already exist';
END $$;

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('sekalipay_last_sync', '{"timestamp": null, "synced_at": null, "type": null}'::jsonb),
    ('shop_status', '{"isOpen": true, "message": "Selamat datang!"}'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  2. PRODUCTS TABLE (Sekalipay)                             │
-- │  Produk digital dari Sekalipay Reseller API.               │
-- │  Variants disimpan sebagai JSONB array.                    │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS products (
    id                    BIGSERIAL PRIMARY KEY,

    -- Sekalipay reference IDs
    sekalipay_item_id     INTEGER,
    sekalipay_product_id  INTEGER UNIQUE,

    -- Display information
    category              TEXT DEFAULT 'Uncategorized',
    name                  TEXT NOT NULL,
    icon                  TEXT,
    image                 TEXT,

    -- Variants with pricing & stock (JSONB array)
    -- Format per element:
    --   { id, sku, name, base_price, markup, sell_price, stock,
    --     order_process, h2h_provider, provider_meta,
    --     required_fields, validation, updated_at, is_hidden }
    variants              JSONB DEFAULT '[]'::jsonb,

    -- Admin controls
    is_active             BOOLEAN DEFAULT true,
    is_featured           BOOLEAN DEFAULT false,

    -- Timestamps
    synced_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_products_category
    ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active
    ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_sekalipay_product_id
    ON products(sekalipay_product_id);
CREATE INDEX IF NOT EXISTS idx_products_sekalipay_item_id
    ON products(sekalipay_item_id);


-- ┌─────────────────────────────────────────────────────────────┐
-- │  3. FINCLOUD_PRODUCTS TABLE                                │
-- │  Produk PPOB dari Fincloud API (pulsa, data, e-money,      │
-- │  voucher game). Flat structure: 1 SKU = 1 row.             │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS fincloud_products (
    id            BIGSERIAL PRIMARY KEY,
    sku           TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    category      TEXT,
    brand         TEXT,
    base_price    INTEGER NOT NULL,
    markup        INTEGER DEFAULT 1000,
    sell_price    INTEGER,
    is_available  BOOLEAN DEFAULT TRUE,
    is_hidden     BOOLEAN DEFAULT FALSE,
    product_meta  JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_fincloud_products_category
    ON fincloud_products(category);
CREATE INDEX IF NOT EXISTS idx_fincloud_products_brand
    ON fincloud_products(brand);
CREATE INDEX IF NOT EXISTS idx_fincloud_products_sku
    ON fincloud_products(sku);

-- RLS disabled (backend menggunakan anon key untuk write)
ALTER TABLE fincloud_products DISABLE ROW LEVEL SECURITY;


-- ┌─────────────────────────────────────────────────────────────┐
-- │  4. SERVICES TABLE                                         │
-- │  Layanan jasa kustom (website, bot) — manual checkout      │
-- │  via WhatsApp, bukan auto-fulfillment vendor.              │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS services (
    id          BIGSERIAL PRIMARY KEY,
    category    TEXT DEFAULT 'Layanan Jasa',
    name        TEXT NOT NULL,
    icon        TEXT,
    image       TEXT,
    subtitle    TEXT,
    features    JSONB DEFAULT '[]'::jsonb,
    variants    JSONB DEFAULT '[]'::jsonb,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_services_category
    ON services(category);
CREATE INDEX IF NOT EXISTS idx_services_active
    ON services(is_active);


-- ┌─────────────────────────────────────────────────────────────┐
-- │  5. ORDERS TABLE                                           │
-- │  Transaksi pembelian lengkap: buyer info, payment gateway, │
-- │  vendor fulfillment, dan status lifecycle.                 │
-- │                                                            │
-- │  Status lifecycle:                                         │
-- │    PENDING → PROCESSING_LOCK → PROCESSING → COMPLETED     │
-- │                                            → FAILED        │
-- │           → CANCELLED                                      │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS orders (
    -- ── Identity & Buyer ──────────────────────────────────────
    id                    TEXT PRIMARY KEY,
    customer_name         TEXT,
    wa_number             TEXT,
    email                 TEXT,
    product               TEXT NOT NULL,
    variant               TEXT,
    price                 INTEGER DEFAULT 0,
    timestamp             TIMESTAMPTZ DEFAULT NOW(),

    -- ── Legacy fields (manual order flow) ─────────────────────
    payment_method        TEXT,
    testimonial           TEXT,
    proof_image           TEXT,

    -- ── Lifecycle status ──────────────────────────────────────
    status                TEXT DEFAULT 'PENDING',
    error_message         TEXT,

    -- ── Payment Gateway (PG) ──────────────────────────────────
    pg_provider           TEXT DEFAULT 'fincloud',
    pg_invoice            TEXT,
    pg_payment_link       TEXT,
    pg_qr_link            TEXT,
    pg_virtual_account    TEXT,
    pg_payment_code       TEXT,
    pg_fee                INTEGER DEFAULT 0,
    pg_total              INTEGER DEFAULT 0,
    unique_code           INTEGER DEFAULT 0,
    pg_expired_at         TIMESTAMPTZ,
    pg_paid_at            TIMESTAMPTZ,

    -- ── PG provider-specific refs ─────────────────────────────
    dyqris_ref_id         TEXT,
    sayabayar_ref_id      TEXT,

    -- ── Vendor fulfillment ────────────────────────────────────
    vendor                TEXT DEFAULT 'sekalipay',
    vendor_status         TEXT DEFAULT 'none',
    vendor_ref_id         TEXT,
    vendor_invoice        TEXT,

    -- ── Sekalipay-specific ────────────────────────────────────
    sekalipay_ref_id      TEXT,
    sekalipay_invoice     TEXT,
    sekalipay_variant_id  INTEGER,

    -- ── Fincloud-specific ─────────────────────────────────────
    fincloud_sku          TEXT,

    -- ── Fulfillment result ────────────────────────────────────
    account_details       JSONB
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_timestamp
    ON orders(timestamp);
CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_pg_invoice
    ON orders(pg_invoice);
CREATE INDEX IF NOT EXISTS idx_orders_pg_provider
    ON orders(pg_provider);
CREATE INDEX IF NOT EXISTS idx_orders_sekalipay_ref_id
    ON orders(sekalipay_ref_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor
    ON orders(vendor);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_ref_id
    ON orders(vendor_ref_id);
CREATE INDEX IF NOT EXISTS idx_orders_dyqris_ref_id
    ON orders(dyqris_ref_id);
CREATE INDEX IF NOT EXISTS idx_orders_sayabayar_ref_id
    ON orders(sayabayar_ref_id);


-- ┌─────────────────────────────────────────────────────────────┐
-- │  6. TESTIMONIALS TABLE                                     │
-- │  Review dan rating dari pembeli.                           │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS testimonials (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    text        TEXT NOT NULL,
    product     TEXT,
    rating      INTEGER DEFAULT 5,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ┌─────────────────────────────────────────────────────────────┐
-- │  7. ADMINS TABLE                                           │
-- │  Autentikasi admin dashboard (bcrypt hashed password).     │
-- │  Menggantikan settings.admin_auth yang deprecated.         │
-- └─────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS admins (
    id          BIGSERIAL PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_admins_username
    ON admins(username);

-- Trigger: auto-update updated_at
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


-- ┌─────────────────────────────────────────────────────────────┐
-- │  8. STORAGE BUCKETS (Manual Setup Required)                │
-- │                                                            │
-- │  Buat bucket berikut di Supabase Dashboard → Storage:      │
-- │    • "proofs" (public bucket)                              │
-- │      ├── proofs/      — Bukti transfer manual              │
-- │      ├── banners/     — Carousel banner images             │
-- │      └── hero/        — Hero section image                 │
-- └─────────────────────────────────────────────────────────────┘


-- ══════════════════════════════════════════════════════════════
-- DONE! Database schema siap.
--
-- Langkah selanjutnya:
--   1. Buat storage bucket "proofs" (public) di Supabase Dashboard
--   2. Jalankan: cd backend && node utils/seed-admin.js
--   3. Jalankan backend: npm start
--   4. Trigger sync pertama dari admin dashboard
-- ══════════════════════════════════════════════════════════════
