-- ══════════════════════════════════════════════════════════════
-- Sekalipay Integration — Database Migration Script
-- Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- Step 1: Backup existing products (optional — uncomment if needed)
-- CREATE TABLE products_backup AS SELECT * FROM products;

-- Step 2: Drop and recreate the products table
DROP TABLE IF EXISTS products CASCADE;

CREATE TABLE products (
    id BIGSERIAL PRIMARY KEY,
    
    -- Sekalipay reference IDs
    sekalipay_item_id INTEGER,                      -- Item (top-level category)
    sekalipay_product_id INTEGER UNIQUE,             -- Product within an item
    
    -- Display information
    category TEXT DEFAULT 'Uncategorized',           -- item.name from Sekalipay
    name TEXT NOT NULL,                              -- product.name from Sekalipay
    icon TEXT,                                       -- item.icon
    image TEXT,                                      -- product.image
    
    -- Variants with pricing & stock (JSONB array)
    -- Each element: { id, sku, name, base_price, markup, sell_price, stock, 
    --                  order_process, h2h_provider, provider_meta, 
    --                  required_fields, validation, updated_at }
    variants JSONB DEFAULT '[]'::jsonb,
    
    -- Admin controls
    is_active BOOLEAN DEFAULT true,
    
    -- Timestamps
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: Create indexes for performance
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_products_sekalipay_product_id ON products(sekalipay_product_id);
CREATE INDEX idx_products_sekalipay_item_id ON products(sekalipay_item_id);

-- Step 4: Enable Row Level Security (if your Supabase project uses RLS)
-- ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access
-- CREATE POLICY "Public can read active products" ON products
--     FOR SELECT USING (is_active = true);

-- Create policies for service role (full access)
-- CREATE POLICY "Service role full access" ON products
--     FOR ALL USING (auth.role() = 'service_role');

-- Step 5: Ensure settings table has the key column as unique
-- (This may already exist, will not error if it does)
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

-- Step 6: Insert default sync settings
INSERT INTO settings (key, value) 
VALUES ('sekalipay_last_sync', '{"timestamp": null, "synced_at": null, "type": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- DONE! Now run the first sync from the admin dashboard or API:
-- POST /api/admin/sekalipay/sync
-- ══════════════════════════════════════════════════════════════
