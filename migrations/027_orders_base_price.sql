-- ══════════════════════════════════════════════════════════════════════════
-- 027 — orders.base_price (harga modal per order, INTERNAL)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Menyimpan harga modal (COGS) varian pada saat order dibuat. Laporan harian
-- memakai kolom ini agar laba dihitung dari data transaksi yang tersimpan,
-- bukan dari join katalog yang base_price-nya bisa berubah setelahnya.
--
-- Nilai yang disimpan (lihat utils/orderCost.js):
--   - varian biasa        → product_variants.base_price
--   - varian open denom   → nominal provider_qty (vendor menagih per nominal)
--   - NULL                → order lama/manual/tagihan (tidak ada data varian);
--                           laporan harian fallback ke estimasi product_variants
--
-- PENTING: kolom ini INTERNAL. Jangan pernah memasukkannya ke select('*')
-- yang dikembalikan endpoint API — controller harus menghapusnya sebelum
-- response (lihat orderController.list & paymentController.toSafeOrderResponse).
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS base_price INTEGER;

COMMENT ON COLUMN orders.base_price IS
    'Harga modal (COGS) varian saat order dibuat. INTERNAL — tidak boleh dikembalikan API. NULL untuk order lama/manual.';

-- ══════════════════════════════════════════════════════════════════════════
-- DONE. Jalankan di Supabase SQL Editor sebelum deploy backend.
-- Verifikasi:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'orders' AND column_name = 'base_price';
-- ══════════════════════════════════════════════════════════════════════════
