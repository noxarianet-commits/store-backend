-- ══════════════════════════════════════════════════════════════════════════
-- 019 — Top-up credit atomik & idempoten
-- ══════════════════════════════════════════════════════════════════════════
--
-- MASALAH
-- creditTopup() (services/balanceService.js) memakai pola check-then-act tanpa
-- transaksi:
--     SELECT status  ->  rpc('credit_balance')  ->  UPDATE status='completed'
-- Tiga pemanggil bisa berjalan bersamaan untuk top-up yang sama:
--   1. webhook payment gateway   (controllers/webhookController.js)
--   2. cron 1 menit              (services/paymentPollingService.js)
--   3. polling user              (controllers/balanceController.js — tanpa throttle)
-- Semuanya membaca status='pending', semua lanjut kredit. Row lock FOR UPDATE
-- di credit_balance hanya men-serialize, tidak mencegah pengulangan.
--
-- Kenapa tidak cukup dengan UNIQUE constraint?
-- credit_balance meng-INSERT baris ledger kedua (balance_transactions) untuk
-- top-up yang sama, lalu balanceService.js:46 menghapusnya dengan DELETE
-- terpisah. Claim ada di dua statement berbeda, jadi ada jendela di mana
-- kedua baris itu ada bersamaan. UNIQUE constraint apa pun akan salah gagal
-- pada layout itu.
--
-- SOLUSI
-- credit_topup() melakukan claim + kredit + penandaan dalam SATU transaksi DB.
-- Karena semuanya atomik, tidak ada celah: pemanggil kedua yang datang
-- status='pending' setelah winner selesai -> otomatis idempoten.
--
-- Efek samping yang ikut hilang: baris top-up itu sendiri menjadi satu-satunya
-- catatan ledger (kolom balance_before/balance_after sudah ada di tabel), jadi
-- tidak ada lagi duplikat di riwayat transaksi user seperti yang terjadi pada
-- jalur Sekalipay & Dyqris (webhookController.js:324, :436).
--
-- CATATAN: credit_balance SENGAJA dibiarkan apa adanya. Fungsi itu masih dipakai
-- adminController.adjustBalance untuk penyesuaian saldo manual, yang memang tidak
-- punya baris top-up pending. Jangan pakai credit_balance(type='topup') untuk
-- kredit top-up yang sudah punya baris di balance_transactions — itu jalur yang
-- lama dan tidak idempoten.

-- 1. Kapan saldo benar-benar dikreditkan (dipisah dari status='completed' agar
--    bisa direkonsiliasi: top-up yang dikredit via webhook vs cron 1 menit).
ALTER TABLE balance_transactions
    ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;

-- 2. Kredit top-up atomik & idempoten.
CREATE OR REPLACE FUNCTION credit_topup(p_topup_id UUID)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx        balance_transactions%ROWTYPE;
  v_user_id   UUID;
  v_amount    INTEGER;
  v_balance   INTEGER;
  v_limit     INTEGER;
  v_new       INTEGER;
BEGIN
  -- ── Claim: kunci baris top-up. Menyerentakan semua pemanggil untuk top-up ini.
  SELECT * INTO v_tx
  FROM balance_transactions
  WHERE id = p_topup_id AND type = 'topup'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Transaksi topup tidak ditemukan');
  END IF;

  -- ── Idempotensi. Baris yang tidak lagi 'pending' berarti sudah pernah
  --    dikreditkan (atau dibatalkan) oleh pemanggil lain. early return inilah
  --    yang menutup double-credit. Mengembalikan success=false + already_processed
  --    supaya pemanggil membedaikannya dari kegagalan kredit sungguhan.
  IF v_tx.status <> 'pending' THEN
    RETURN json_build_object(
      'success', false,
      'already_processed', true,
      'error', format('Topup sudah diproses (status: %s)', v_tx.status),
      'balance_before', v_tx.balance_before,
      'balance_after',  v_tx.balance_after
    );
  END IF;

  v_user_id := v_tx.user_id;
  v_amount  := v_tx.amount;

  -- ── Kunci baris user, sama seperti credit_balance.
  SELECT balance, balance_limit INTO v_balance, v_limit
  FROM user_profiles
  WHERE id = v_user_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User tidak ditemukan atau tidak aktif');
  END IF;

  v_new := v_balance + v_amount;

  IF v_new > v_limit THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Saldo akan melebihi limit (Rp %s). Sisa kapasitas: Rp %s',
        to_char(v_limit, 'FM999,999,999'),
        to_char(v_limit - v_balance, 'FM999,999,999'))
    );
  END IF;

  -- ── Kredit + tandai selesai. Semua dalam transaksi yang sama, tidak ada
  --    jendela antara kredit dan penandaan.
  UPDATE user_profiles
  SET balance = v_new, updated_at = NOW()
  WHERE id = v_user_id;

  UPDATE balance_transactions
  SET status = 'completed',
      balance_before = v_balance,
      balance_after = v_new,
      credited_at = NOW()
  WHERE id = p_topup_id;

  RETURN json_build_object(
    'success', true,
    'already_processed', false,
    'transaction_id', p_topup_id,
    'balance_before', v_balance,
    'balance_after', v_new
  );
END;
$$;

COMMENT ON FUNCTION credit_topup(UUID) IS
    'Kredit top-up secara atomik dan idempoten. Claim (pending->completed), update saldo, dan set credited_at terjadi dalam satu transaksi DB. Selalu idempoten untuk p_topup_id yang sama.';
