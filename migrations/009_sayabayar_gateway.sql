-- Migration 009: Saya Bayar Payment Gateway Support & Orkut Deprecation
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sayabayar_ref_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_sayabayar_ref_id ON orders(sayabayar_ref_id);

-- Update existing settings where payment_gateway is 'orkut' to 'sayabayar'
UPDATE settings SET value = '"sayabayar"'::jsonb WHERE key = 'payment_gateway' AND value = '"orkut"'::jsonb;
