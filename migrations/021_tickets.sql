-- ══════════════════════════════════════════════════════════════════════════
-- 020 — Tiket Bantuan CS
-- ══════════════════════════════════════════════════════════════════════════
--
-- Fitur "open ticket" untuk pelanggan yang butuh bantuan CS di luar WhatsApp.
-- Data masuk ke Supabase supaya bisa dibalas admin dari dashboard dan
-- dinotifikasi ke grup WhatsApp lewat bot (realtime).
--
-- DESAIN AKSES (meniru pola orders.order_access_token — migration 018)
-- Order/tiket ID bisa ditebak, jadi ID bukan bukti kepemilikan. Sebuah tiket
-- bisa diakses lewat salah satu jalur:
--   1. user_id cocok dengan JWT user yang login, atau
--   2. header X-Ticket-Token cocok dengan tickets.access_token (tamu).
-- access_token: 32 byte hex dari crypto.randomBytes, dibuat backend.
--
-- TAMU: tidak wajib punya akun. Minimal salah satu guest_email / guest_wa
-- harus terisi supaya CS masih bisa follow-up bila percakapan di web terputus.
--
-- STATUS:
--   open    — menunggu balasan admin / percakapan aktif
--   pending — dibalas user terakhir, menunggu admin (opsional dipakai admin)
--   closed  — selesai; composer pelanggan dikunci (bisa dibuka lagi / reopen)
--
-- PRIORITAS: low | normal | high | urgent (badge warna di dashboard admin)
--
-- CATATAN: lampiran gambar sengaja tidak ada dulu. Bila nanti ditambahkan,
-- buat kolom JSONB `attachments` di ticket_messages — tidak perlu ubah
-- struktur relasi.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Tiket
CREATE TABLE IF NOT EXISTS tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number   TEXT NOT NULL UNIQUE,       -- TK-20261009-A3F7 (human-facing)
    user_id         UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    guest_name      TEXT NOT NULL,
    guest_email     TEXT,
    guest_wa        TEXT,
    order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
    category        TEXT NOT NULL DEFAULT 'umum'
                    CHECK (category IN ('umum', 'pesanan', 'pembayaran', 'produk', 'akun', 'lainnya')),
    subject         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'pending', 'closed')),
    priority        TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    access_token    TEXT NOT NULL,              -- 32 byte hex, bukti kepemilikan untuk tamu
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_by TEXT CHECK (last_message_by IN ('user', 'admin')),
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id        ON tickets (user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_access_token   ON tickets (access_token);
CREATE INDEX IF NOT EXISTS idx_tickets_order_id       ON tickets (order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_number         ON tickets (ticket_number);

-- 2. Pesan dalam tiket
CREATE TABLE IF NOT EXISTS ticket_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author     TEXT NOT NULL CHECK (author IN ('user', 'admin')),
    admin_id   TEXT,                            -- req.admin.id bila author='admin'
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);

-- 3. Trigger updated_at (pola sama dengan admins — migration 004)
CREATE OR REPLACE FUNCTION update_tickets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW
    EXECUTE FUNCTION update_tickets_updated_at();

-- 4. Publikasikan ke Supabase Realtime supaya bot bisa subscribe INSERT
--    tiket baru (notifikasi grup WA + Telegram). Idempoten: hanya menambah
--    bila tabel belum terdaftar di publication supabase_realtime.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'tickets'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE tickets;
    END IF;
END $$;

COMMENT ON COLUMN tickets.access_token IS
    'Token akses tiket (32 byte hex, dibuat backend). Bukti kepemilikan untuk tamu; header X-Ticket-Token. Jangan pernah dikembalikan endpoint publik selain ke pembuat tiket itu sendiri.';
COMMENT ON COLUMN tickets.ticket_number IS
    'Nomor tiket yang ditampilkan ke pengguna, format TK-YYYYMMDD-XXXX. Dipakai di URL /ticket/:ticketNumber.';

-- ══════════════════════════════════════════════════════════════════════════
-- DONE. Jalankan migrasi ini di Supabase SQL Editor sebelum deploy backend.
-- ══════════════════════════════════════════════════════════════════════════
