-- ══════════════════════════════════════════════════════════════════════════
-- NoxariaNet Store — Refund balance concurrency guard
-- Run this in Supabase SQL Editor
--
-- Auto-refund sekarang dipakai juga untuk order QRIS, sehingga satu order
-- bisa direfund dari beberapa jalur sekaligus (webhook vendor, cron payment
-- sweep, polling status aplikasi). Fungsi lama mengecek "sudah pernah
-- refund" SEBELUM mengunci baris user, jadi dua request yang berjalan
-- bersamaan bisa sama-sama lolos pengecekan dan mengkredit saldo dua kali.
--
-- Advisory lock per order membuat seluruh pemeriksaan + kredit berjalan
-- serial untuk order yang sama. Lock otomatis dilepas saat transaksi RPC
-- selesai (commit/rollback).
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refund_balance(
  p_user_id UUID,
  p_amount INTEGER,
  p_order_id TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance INTEGER;
  v_balance_limit INTEGER;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_already_refunded BOOLEAN;
BEGIN
  -- Serialize concurrent refunds for the same order (webhook + cron +
  -- polling). hashtextextended is stable for the same order id.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id, 0));

  -- Check if already refunded
  SELECT EXISTS(
    SELECT 1 FROM balance_transactions
    WHERE user_id = p_user_id AND reference_id = p_order_id AND type = 'refund' AND status = 'completed'
  ) INTO v_already_refunded;

  IF v_already_refunded THEN
    RETURN json_build_object('success', false, 'error', 'Order sudah pernah di-refund');
  END IF;

  SELECT balance, balance_limit INTO v_current_balance, v_balance_limit
  FROM user_profiles
  WHERE id = p_user_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User tidak ditemukan atau tidak aktif');
  END IF;

  -- Refund bypasses balance limit (returning user's own money)
  v_new_balance := v_current_balance + p_amount;

  UPDATE user_profiles SET balance = v_new_balance, updated_at = NOW()
  WHERE id = p_user_id;

  INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_id, status, description)
  VALUES (p_user_id, 'refund', p_amount, v_current_balance, v_new_balance, p_order_id, 'completed', 
    COALESCE(p_description, 'Refund otomatis untuk order ' || p_order_id))
  RETURNING id INTO v_tx_id;

  RETURN json_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'balance_before', v_current_balance,
    'balance_after', v_new_balance
  );
END;
$$;
