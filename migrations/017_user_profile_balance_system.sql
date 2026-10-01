-- ══════════════════════════════════════════════════════════════════════════
-- NoxariaNet Store — User Profiles & Balance System Migration
-- Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════════════

-- 1. User Profiles Table
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  balance INTEGER DEFAULT 0 CHECK (balance >= 0),
  balance_limit INTEGER DEFAULT 1000000,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_phone ON user_profiles(phone);

-- 2. Balance Transactions Table
CREATE TABLE IF NOT EXISTS balance_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('topup', 'purchase', 'refund')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reference_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  description TEXT,
  pg_provider TEXT,
  pg_invoice TEXT,
  pg_qr_link TEXT,
  pg_total INTEGER,
  pg_expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_balance_tx_status ON balance_transactions(status);
CREATE INDEX IF NOT EXISTS idx_balance_tx_pg_invoice ON balance_transactions(pg_invoice);
CREATE INDEX IF NOT EXISTS idx_balance_tx_reference ON balance_transactions(reference_id);

-- 3. Modify orders table — add user_id and payment_type columns
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES user_profiles(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'gateway';

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

-- 4. Atomic balance operations (stored procedures)

-- Credit balance (for topup/refund)
CREATE OR REPLACE FUNCTION credit_balance(
  p_user_id UUID,
  p_amount INTEGER,
  p_type TEXT,
  p_reference_id TEXT DEFAULT NULL,
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
BEGIN
  -- Lock the user row to prevent concurrent modifications
  SELECT balance, balance_limit INTO v_current_balance, v_balance_limit
  FROM user_profiles
  WHERE id = p_user_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User tidak ditemukan atau tidak aktif');
  END IF;

  v_new_balance := v_current_balance + p_amount;

  -- Check balance limit
  IF v_new_balance > v_balance_limit THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Saldo akan melebihi limit (Rp %s). Sisa kapasitas: Rp %s', 
        to_char(v_balance_limit, 'FM999,999,999'),
        to_char(v_balance_limit - v_current_balance, 'FM999,999,999'))
    );
  END IF;

  -- Update balance
  UPDATE user_profiles SET balance = v_new_balance, updated_at = NOW()
  WHERE id = p_user_id;

  -- Insert transaction log
  INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_id, status, description)
  VALUES (p_user_id, p_type, p_amount, v_current_balance, v_new_balance, p_reference_id, 'completed', p_description)
  RETURNING id INTO v_tx_id;

  RETURN json_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'balance_before', v_current_balance,
    'balance_after', v_new_balance
  );
END;
$$;

-- Debit balance (for purchase)
CREATE OR REPLACE FUNCTION debit_balance(
  p_user_id UUID,
  p_amount INTEGER,
  p_reference_id TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance INTEGER;
  v_new_balance INTEGER;
  v_tx_id UUID;
BEGIN
  -- Lock the user row
  SELECT balance INTO v_current_balance
  FROM user_profiles
  WHERE id = p_user_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User tidak ditemukan atau tidak aktif');
  END IF;

  IF v_current_balance < p_amount THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Saldo tidak mencukupi. Saldo: Rp %s, Dibutuhkan: Rp %s',
        to_char(v_current_balance, 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999'))
    );
  END IF;

  v_new_balance := v_current_balance - p_amount;

  UPDATE user_profiles SET balance = v_new_balance, updated_at = NOW()
  WHERE id = p_user_id;

  INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_id, status, description)
  VALUES (p_user_id, 'purchase', p_amount, v_current_balance, v_new_balance, p_reference_id, 'completed', p_description)
  RETURNING id INTO v_tx_id;

  RETURN json_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'balance_before', v_current_balance,
    'balance_after', v_new_balance
  );
END;
$$;

-- Refund balance (for failed/cancelled orders)
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
