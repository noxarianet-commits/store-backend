-- ══════════════════════════════════════════════════════════════════════════
-- 024 — Push Notification (Expo Push Service)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Fitur push notification untuk aplikasi Android (Expo SDK, paket
-- com.noxarianet.store). Aplikasi mendaftarkan Expo Push Token-nya ke backend
-- (POST /api/mobile/devices), lalu backend mengirim notifikasi lewat Expo Push
-- Service (https://exp.host/--/api/v2/push/send) yang meneruskannya ke FCM.
--
-- DUA TABEL:
--   push_devices      — token push per perangkat, milik seorang user
--   push_notifications — log pengiriman + pagar anti-duplikat
--
-- DESAIN ANTI-DUPLIKAT (penting)
-- Satu transisi status order bisa ditulis oleh BANYAK pihak secara bersamaan:
--   - webhook vendor (OkeConnect callback / Sekalipay order.completed)
--   - cron reconcileProcessingOrders() (PM2 / VPS; TIDAK jalan di Vercel)
--   - polling paksa dari aplikasi (GET /api/mobile/orders/:id?force=true)
-- Tanpa pagar, user akan menerima 2-3 notifikasi identik untuk satu order.
-- Solusinya: push_notifications.dedupe_key UNIQUE. Pengirim wajib INSERT baris
-- dengan dedupe_key lebih dulu; bila kena unique violation (SQLSTATE 23505)
-- berarti notifikasi untuk event itu SUDAH pernah dicatat → skip.
--
-- Nilai dedupe_key yang dipakai backend:
--   order:{orderId}:completed      → order COMPLETED
--   order:{orderId}:failed         → order FAILED
--   topup:{reference_id}:credited  → saldo top-up masuk
--   broadcast:{uuid}               → pengumuman admin (sekali kirim)
--
-- STATUS push_notifications:
--   pending — reservasi dibuat, pengiriman sedang berjalan
--   sent    — sudah diterima Expo Push Service (ticket_id terisi)
--   failed  — pengiriman gagal permanen (payload salah / kredensial salah)
-- Bila pengiriman gagal TRANSIEN (network / 5xx), baris dihapus lagi supaya
-- bisa dicoba ulang; bila gagal permanen, baris dibiarkan sebagai 'failed'.
--
-- KEAMANAN TOKEN
-- push_token adalah identifier publik, tapi tetap data milik user:
--   - endpoint hanya boleh mengembalikan device milik user yang login
--   - admin TIDAK boleh melihat isi push_token (hanya agregat)
--   - token yang sudah tidak terdaftar di FCM ditandai active=false
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Perangkat terdaftar
CREATE TABLE IF NOT EXISTS push_devices (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    push_token   TEXT NOT NULL UNIQUE,
    platform     TEXT NOT NULL DEFAULT 'android'
                 CHECK (platform IN ('android', 'ios', 'web')),
    app_version  TEXT,
    active       BOOLEAN NOT NULL DEFAULT true,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_devices_user_id   ON push_devices (user_id);
CREATE INDEX IF NOT EXISTS idx_push_devices_active    ON push_devices (active);
CREATE INDEX IF NOT EXISTS idx_push_devices_user_act  ON push_devices (user_id, active);

-- 2. Log pengiriman notifikasi + pagar anti-duplikat
CREATE TABLE IF NOT EXISTS push_notifications (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    dedupe_key   TEXT NOT NULL UNIQUE,
    event        TEXT NOT NULL
                 CHECK (event IN ('order_completed', 'order_failed',
                                  'topup_credited', 'broadcast', 'system')),
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    data         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'failed')),
    target_count INTEGER NOT NULL DEFAULT 0,
    sent_count   INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    ticket_id    TEXT,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_created ON push_notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_notifications_status  ON push_notifications (status);
CREATE INDEX IF NOT EXISTS idx_push_notifications_user    ON push_notifications (user_id);

-- 3. Trigger updated_at (pola sama dengan tickets — migration 021)
CREATE OR REPLACE FUNCTION update_push_notifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_push_notifications_updated_at ON push_notifications;
CREATE TRIGGER trg_push_notifications_updated_at
    BEFORE UPDATE ON push_notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_push_notifications_updated_at();

COMMENT ON COLUMN push_devices.push_token IS
    'Expo Push Token (ExponentPushToken[...]). Unik per perangkat. Ditandai active=false bila FCM melaporkan DeviceNotRegistered.';
COMMENT ON COLUMN push_devices.last_seen_at IS
    'Terakhir kali token didaftarkan ulang oleh aplikasi. Dipakai untuk membersihkan token yang lama tidak aktif.';
COMMENT ON COLUMN push_notifications.dedupe_key IS
    'Kunci unik anti-duplikat, mis. order:{orderId}:completed. INSERT yang kena unique violation berarti notifikasi untuk event ini sudah pernah dicatat.';
COMMENT ON COLUMN push_notifications.data IS
    'Payload data yang dikirim ke aplikasi. Field `url` dipakai aplikasi untuk deep link (path Expo Router, mis. /pesanan/{id}).';
COMMENT ON COLUMN push_notifications.sent_count IS
    'Jumlah perangkat yang berhasil menerima ticket dari Expo Push Service (bukan bukti sampai ke layar).';

-- ══════════════════════════════════════════════════════════════════════════
-- DONE. Jalankan migrasi ini di Supabase SQL Editor sebelum deploy backend.
-- Perintah verifikasi setelah dijalankan:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('push_devices', 'push_notifications');
-- ══════════════════════════════════════════════════════════════════════════
