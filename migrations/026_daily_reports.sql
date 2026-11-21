-- ══════════════════════════════════════════════════════════════════════════
-- 026 — Laporan Harian (Daily Report)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Satu baris = satu tanggal (report_date UNIQUE). Laporan di-generate dari
-- tabel `orders` + `products` oleh services/dailyReportService.js:
--   - cron 00:05 UTC membuat laporan hari sebelumnya secara otomatis
--   - admin bisa regenerate lewat POST /api/admin/reports/daily/generate
--   - GET /api/admin/reports/daily?date=YYYY-MM-DD membuat laporan jika
--     belum ada (idempoten, tidak menimpa laporan yang sudah ada)
--
-- SEMANTIK METRIK
--   total_orders     — semua order pada tanggal tersebut
--   completed_orders — order dengan status 'COMPLETED'
--   revenue          — omzet: Σ price order COMPLETED, fallback pg_total
--                      bila price 0/kosong (order gateway)
--   refunded         — Σ amount order status 'CANCELLED' (nilai order yang
--                      dibatalkan/kedaluwarsa; informasi, bukan pengurang)
--   total_profit     — estimasi laba: revenue − Σ base_price varian terkait
--                      (tabel product_variants, dicocokkan lewat nama
--                      produk+varian → vendor_variant_id → rata-rata produk;
--                      0 bila produk tidak ditemukan)
--   breakdown        — JSONB: by_status, by_payment_type, top_products,
--                      base_cost_estimate
--
-- report_date memakai tanggal UTC, konsisten dengan kolom orders.timestamp.
-- Regenerate memakai UPSERT per report_date (bukan baris baru) supaya
-- riwayat tetap satu baris per hari.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date      DATE NOT NULL,
    status           TEXT NOT NULL DEFAULT 'generated'
                     CHECK (status IN ('generated', 'regenerated')),
    total_orders     INTEGER NOT NULL DEFAULT 0,
    completed_orders INTEGER NOT NULL DEFAULT 0,
    revenue          INTEGER NOT NULL DEFAULT 0,
    refunded         INTEGER NOT NULL DEFAULT 0,
    total_profit     INTEGER NOT NULL DEFAULT 0,
    breakdown        JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by     TEXT,
    CONSTRAINT daily_reports_report_date_key UNIQUE (report_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date
    ON daily_reports (report_date DESC);

COMMENT ON TABLE daily_reports IS
    'Laporan harian agregat order: transaksi, omzet, refund, estimasi laba, dan breakdown per status/metode bayar/produk.';
COMMENT ON COLUMN daily_reports.report_date IS
    'Tanggal laporan (UTC). Satu laporan per tanggal; regenerate memakai UPSERT (ON CONFLICT report_date).';
COMMENT ON COLUMN daily_reports.status IS
    'generated = dibuat pertama kali; regenerated = dibuat ulang paksa oleh admin.';
COMMENT ON COLUMN daily_reports.revenue IS
    'Omzet order COMPLETED: Σ price, fallback pg_total bila price 0/kosong.';
COMMENT ON COLUMN daily_reports.refunded IS
    'Σ amount order CANCELLED pada tanggal tersebut. Informasi saja, tidak dikurangkan dari revenue.';
COMMENT ON COLUMN daily_reports.total_profit IS
    'Estimasi laba = revenue − Σ base_price varian terkait (product_variants; match nama produk+varian, lalu vendor_variant_id, lalu rata-rata produk).';
COMMENT ON COLUMN daily_reports.breakdown IS
    'Detail JSONB: { by_status, by_payment_type, top_products, base_cost_estimate }.';
COMMENT ON COLUMN daily_reports.generated_by IS
    'id admin yang memicu generate manual. NULL bila dibuat cron/endpoint GET otomatis.';

-- ══════════════════════════════════════════════════════════════════════════
-- DONE. Jalankan migrasi ini di Supabase SQL Editor sebelum deploy backend.
-- Verifikasi setelah dijalankan:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'daily_reports' ORDER BY ordinal_position;
-- ══════════════════════════════════════════════════════════════════════════
