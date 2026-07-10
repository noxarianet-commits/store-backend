-- 1. Tabel Fincloud Products (flat structure sesuai API Fincloud)
CREATE TABLE IF NOT EXISTS fincloud_products (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,              -- SKU dari Fincloud pricelist
  name TEXT NOT NULL,
  category TEXT,                         -- E-Money, Pulsa, Voucher Game, dll
  brand TEXT,                            -- DANA, TELKOMSEL, dll
  base_price INTEGER NOT NULL,           -- Harga beli dari Fincloud
  markup INTEGER DEFAULT 1000,           -- Markup admin
  sell_price INTEGER,                    -- Harga jual = base_price + markup
  is_available BOOLEAN DEFAULT TRUE,
  is_hidden BOOLEAN DEFAULT FALSE,
  product_meta JSONB DEFAULT '{}',       -- Metadata tambahan dari API
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fincloud_products_category ON fincloud_products(category);
CREATE INDEX IF NOT EXISTS idx_fincloud_products_brand ON fincloud_products(brand);
CREATE INDEX IF NOT EXISTS idx_fincloud_products_sku ON fincloud_products(sku);

-- 2. Tambah kolom vendor-agnostic di orders (ADDITIVE, tidak mengubah yang ada)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor TEXT DEFAULT 'sekalipay';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_ref_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_status TEXT DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fincloud_sku TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(vendor);
CREATE INDEX IF NOT EXISTS idx_orders_vendor_ref_id ON orders(vendor_ref_id);
