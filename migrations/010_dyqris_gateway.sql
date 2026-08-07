-- ══════════════════════════════════════════════════════════════
-- Migration 010: DYQRIS Payment Gateway Support & Orkut Column Reuse
-- Rename orkut_ref_id to dyqris_ref_id (or add dyqris_ref_id if orkut_ref_id missing)
-- Jalankan di Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'orders' AND column_name = 'orkut_ref_id'
    ) THEN
        ALTER TABLE orders RENAME COLUMN orkut_ref_id TO dyqris_ref_id;
    ELSIF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'orders' AND column_name = 'dyqris_ref_id'
    ) THEN
        ALTER TABLE orders ADD COLUMN dyqris_ref_id TEXT;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_orders_orkut_ref_id;
CREATE INDEX IF NOT EXISTS idx_orders_dyqris_ref_id ON orders(dyqris_ref_id);

-- Update setting payment_gateway if it was orkut (or set default if needed)
-- ══════════════════════════════════════════════════════════════
-- DONE!
-- ══════════════════════════════════════════════════════════════
