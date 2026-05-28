-- ══════════════════════════════════════════════════════════════
-- Migration: Create Services Table and migrate data
-- Run this script in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. Create the services table
CREATE TABLE IF NOT EXISTS services (
    id BIGSERIAL PRIMARY KEY,
    category TEXT DEFAULT 'Layanan Jasa',
    name TEXT NOT NULL,
    icon TEXT,
    image TEXT,
    subtitle TEXT,
    features JSONB DEFAULT '[]'::jsonb,
    variants JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for Services
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
CREATE INDEX IF NOT EXISTS idx_services_active ON services(is_active);

-- 2. Migrate existing "Layanan Jasa" from products table
INSERT INTO services (category, name, icon, image, variants, is_active, created_at)
SELECT category, name, icon, image, variants, is_active, created_at
FROM products
WHERE category ILIKE '%jasa%' OR category ILIKE '%web%' OR category ILIKE '%bot%';

-- 3. Delete the migrated "Layanan Jasa" from products table
DELETE FROM products
WHERE category ILIKE '%jasa%' OR category ILIKE '%web%' OR category ILIKE '%bot%';

-- ══════════════════════════════════════════════════════════════
-- DONE!
-- ══════════════════════════════════════════════════════════════
