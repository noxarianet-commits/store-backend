-- ══════════════════════════════════════════════════════════════
-- Full Database Setup for Development (Store)
-- Run this script in a fresh Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. SETTINGS TABLE
-- Menyimpan konfigurasi admin (auth, status toko, banner, konten situs)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- Masukkan data default admin auth & sync config
INSERT INTO settings (key, value) VALUES
    ('admin_auth', '{"username": "admin", "password": "password"}'),
    ('sekalipay_last_sync', '{"timestamp": null, "synced_at": null, "type": null}')
ON CONFLICT (key) DO NOTHING;

-- 2. PRODUCTS TABLE (Terbaru dengan integrasi Sekalipay)
-- Menyimpan produk, varian, harga dasar, dan markup
CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    
    -- Sekalipay reference IDs
    sekalipay_item_id INTEGER,                      
    sekalipay_product_id INTEGER UNIQUE,             
    
    -- Display information
    category TEXT DEFAULT 'Uncategorized',           
    name TEXT NOT NULL,                              
    icon TEXT,                                       
    image TEXT,                                      
    
    -- Variants with pricing & stock (JSONB array)
    -- Format: [{id, sku, name, base_price, markup, sell_price, stock, ...}]
    variants JSONB DEFAULT '[]'::jsonb,
    
    -- Admin controls
    is_active BOOLEAN DEFAULT true,
    
    -- Timestamps
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes untuk Products
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_sekalipay_product_id ON products(sekalipay_product_id);

-- 3. ORDERS TABLE
-- Menyimpan riwayat transaksi pembeli
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,                             -- ID Pesanan unik (contoh: ORD-...)
    product TEXT NOT NULL,                           -- Nama Produk utama
    variant TEXT,                                    -- Varian yang dibeli
    price INTEGER DEFAULT 0,                         -- Total Harga
    email TEXT,                                      -- Email pembeli (opsional)
    wa_number TEXT,                                  -- Nomor WhatsApp
    payment_method TEXT,                             -- Metode Pembayaran
    testimonial TEXT,                                -- Testimoni pembeli
    proof_image TEXT,                                -- URL Gambar bukti transfer dari storage
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes untuk Orders
CREATE INDEX IF NOT EXISTS idx_orders_timestamp ON orders(timestamp);

-- 4. TESTIMONIALS TABLE
-- Menyimpan testimoni pembeli yang telah di-submit bersamaan dengan order
CREATE TABLE IF NOT EXISTS testimonials (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,                              -- Nomor WA / Nama Customer
    text TEXT NOT NULL,                              -- Isi Testimoni
    product TEXT,                                    -- Produk yang di-review
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. STORAGE BUCKET PREPARATION
-- (Hanya referensi, Supabase Storage harus dibuat secara manual / lewat dashboard)
-- Pastikan Anda membuat public bucket dengan nama:
-- 1. "proofs" (Untuk bukti transfer dan image banner)

-- ══════════════════════════════════════════════════════════════
-- DONE! Skema database siap digunakan.
-- ══════════════════════════════════════════════════════════════
