-- ══════════════════════════════════════════════════════════════
-- Migration: Add rating column to testimonials table
-- Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

ALTER TABLE testimonials
ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 5;

-- Set existing testimonials to 5 stars (default)
UPDATE testimonials SET rating = 5 WHERE rating IS NULL;
