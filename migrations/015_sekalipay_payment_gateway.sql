-- ============================================================================
-- Migration 015: Sekalipay Payment Gateway (QRIS) & Cleanup Saya Bayar
-- Description: Mengganti provider 'sayabayar' ke 'sekalipay' pada settings payment_gateway
--              dan membersihkan konfigurasi lama sayabayar_config.
-- ============================================================================

-- 1. Update setting payment_gateway jika sebelumnya diset 'sayabayar'
UPDATE settings
SET value = '"sekalipay"'::jsonb
WHERE key = 'payment_gateway'
  AND (value = '"sayabayar"'::jsonb OR value::text ILIKE '%sayabayar%');

-- 2. Hapus setting lama sayabayar_config jika ada
DELETE FROM settings WHERE key = 'sayabayar_config';

-- 3. Siapkan default setting sekalipay_gateway_config jika belum ada
INSERT INTO settings (key, value)
VALUES (
    'sekalipay_gateway_config',
    '{
        "base_url": "https://sekalipay.com/api/v1/gateway",
        "api_key": "",
        "secret_key": "",
        "merchant_code": "",
        "payment_code": "QRIS"
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
