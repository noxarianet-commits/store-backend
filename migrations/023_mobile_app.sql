-- ══════════════════════════════════════════════════════════════════════════
-- 023_mobile_app.sql
--
-- Backend support for the Android app:
--   • product channel visibility (web / app)
--   • product type (prepaid / postpaid bills)
--   • order channel, type, idempotency and bill quote reference
--   • bill_inquiries: short-lived vendor quotes for postpaid bills
--   • create_bill_order(): atomic quote validation + balance debit + order
--
-- Existing products default to {web,app} so the current web storefront keeps
-- showing the same catalog. App-only bill products are explicitly set to
-- {app} by the postpaid sync / admin UI.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Products: channel visibility + type ─────────────────────────────────

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS available_channels TEXT[] NOT NULL DEFAULT '{web,app}',
    ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'prepaid';

-- Keep values predictable. product_type is intentionally not constrained by a
-- CHECK because future types (e.g. 'manual') should not require a migration.
CREATE INDEX IF NOT EXISTS idx_products_channels
    ON products USING GIN (available_channels);

CREATE INDEX IF NOT EXISTS idx_products_type_active
    ON products (product_type, is_active);

COMMENT ON COLUMN products.available_channels IS
    'Storefronts that may display and sell this product. Example: {web,app} or {app}.';
COMMENT ON COLUMN products.product_type IS
    'prepaid = topup / digital product; postpaid = bill payment with vendor inquiry.';

-- ── 2. Orders: source channel, type, idempotency, bill quote ───────────────

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web',
    ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'prepaid',
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS bill_inquiry_id UUID;

-- A mobile client may retry after a timeout. The same idempotency key must
-- resolve to the same order and must never debit balance twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency
    ON orders (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_channel
    ON orders (user_id, channel, timestamp DESC);

COMMENT ON COLUMN orders.channel IS
    'Client that created the order: web or android.';
COMMENT ON COLUMN orders.order_type IS
    'prepaid = topup / digital product; postpaid = bill payment.';

-- ── 3. Bill inquiries ──────────────────────────────────────────────────────
--
-- A quote is created by a vendor inquiry (Cek Tagihan). It is deliberately
-- short-lived because the bill amount can change between inquiry and payment.
-- The order creation path locks this row and marks it used atomically.

CREATE TABLE IF NOT EXISTS bill_inquiries (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    product_id        BIGINT NOT NULL REFERENCES products(id),
    variant_id        BIGINT NOT NULL REFERENCES product_variants(id),
    customer_number   TEXT NOT NULL,
    customer_name     TEXT,
    bill_period       TEXT,
    bill_amount       INTEGER NOT NULL,
    admin_fee         INTEGER NOT NULL DEFAULT 0,
    total_amount      INTEGER NOT NULL,
    vendor            TEXT NOT NULL,
    inquiry_code      TEXT NOT NULL,
    payment_code      TEXT NOT NULL,
    vendor_ref        TEXT,
    raw_response      JSONB,
    status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','used','expired','failed','cancelled')),
    expires_at        TIMESTAMPTZ NOT NULL,
    order_id          TEXT REFERENCES orders(id),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    used_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bill_inquiries_user
    ON bill_inquiries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bill_inquiries_expires
    ON bill_inquiries (expires_at)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_bill_inquiries_variant
    ON bill_inquiries (variant_id);

-- One open quote per user + variant + customer number. Concurrent inquiry
-- requests must share/return the same quote instead of creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_inquiries_one_open
    ON bill_inquiries (user_id, variant_id, customer_number)
    WHERE status = 'open';

COMMENT ON TABLE bill_inquiries IS
    'Vendor bill quotes. Only an open, unexpired quote owned by the user may be converted into an order.';

-- ── 4. Atomic bill order creation ──────────────────────────────────────────
--
-- Supabase JS cannot run a multi-statement transaction. This function keeps
-- quote validation, balance debit, order insert and quote consumption in one
-- database transaction. If any step fails, everything rolls back.
--
-- p_order is a JSONB payload prepared by billService with:
--   id, product, variant, price, wa_number, email, customer_name,
--   order_access_token, vendor, vendor_variant_id, account_details, timestamp
--
-- Return shape:
--   { success: true, order_id, idempotent? }
--   { success: false, error: CODE, message? }

CREATE OR REPLACE FUNCTION create_bill_order(
    p_user_id UUID,
    p_inquiry_id UUID,
    p_order JSONB,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_existing orders%ROWTYPE;
    v_inquiry bill_inquiries%ROWTYPE;
    v_balance INTEGER;
    v_total INTEGER;
    v_order_id TEXT;
    v_order_price INTEGER;
BEGIN
    -- Serialize retries with the same key. Without this, two concurrent
    -- requests can both pass the "existing order" check before either insert.
    IF p_idempotency_key IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
            hashtext(p_user_id::text || ':' || p_idempotency_key)
        );

        SELECT * INTO v_existing
        FROM orders
        WHERE user_id = p_user_id
          AND idempotency_key = p_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent', true,
                'order_id', v_existing.id
            );
        END IF;
    END IF;

    -- Lock the quote so it cannot be consumed by a second request.
    SELECT * INTO v_inquiry
    FROM bill_inquiries
    WHERE id = p_inquiry_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BILL_INQUIRY_NOT_FOUND',
            'message', 'Tagihan tidak ditemukan.'
        );
    END IF;

    IF v_inquiry.status <> 'open' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BILL_INQUIRY_ALREADY_USED',
            'message', 'Tagihan ini sudah diproses.'
        );
    END IF;

    IF v_inquiry.expires_at <= NOW() THEN
        UPDATE bill_inquiries SET status = 'expired' WHERE id = v_inquiry.id;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BILL_INQUIRY_EXPIRED',
            'message', 'Tagihan sudah kedaluwarsa. Silakan cek ulang.'
        );
    END IF;

    v_order_price := COALESCE((p_order->>'price')::INTEGER, 0);
    v_total := v_inquiry.total_amount;

    IF v_order_price <> v_total THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BILL_AMOUNT_MISMATCH',
            'message', 'Nominal tagihan berubah. Silakan cek ulang.'
        );
    END IF;

    -- Lock the user row and verify balance inside the same transaction.
    SELECT balance INTO v_balance
    FROM user_profiles
    WHERE id = p_user_id
      AND is_active = true
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'USER_NOT_FOUND',
            'message', 'Akun tidak ditemukan atau tidak aktif.'
        );
    END IF;

    IF v_balance < v_total THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'INSUFFICIENT_BALANCE',
            'message', 'Saldo tidak mencukupi.'
        );
    END IF;

    UPDATE user_profiles
       SET balance = v_balance - v_total,
           updated_at = NOW()
     WHERE id = p_user_id;

    INSERT INTO balance_transactions (
        user_id, type, amount, balance_before, balance_after,
        reference_id, status, description
    ) VALUES (
        p_user_id,
        'purchase',
        v_total,
        v_balance,
        v_balance - v_total,
        p_order->>'id',
        'completed',
        COALESCE(p_order->>'description', 'Pembelian tagihan')
    );

    INSERT INTO orders (
        id, product, variant, price, wa_number, email, customer_name,
        payment_method, payment_type, user_id, order_access_token, status,
        pg_provider, pg_paid_at, vendor, vendor_variant_id, vendor_status,
        account_details, timestamp, channel, order_type, bill_inquiry_id,
        idempotency_key
    ) VALUES (
        p_order->>'id',
        p_order->>'product',
        p_order->>'variant',
        v_total,
        p_order->>'wa_number',
        p_order->>'email',
        p_order->>'customer_name',
        'BALANCE',
        'balance',
        p_user_id,
        p_order->>'order_access_token',
        'PENDING',
        'balance',
        NOW(),
        p_order->>'vendor',
        p_order->>'vendor_variant_id',
        'none',
        p_order->'account_details',
        COALESCE((p_order->>'timestamp')::TIMESTAMPTZ, NOW()),
        COALESCE(p_order->>'channel', 'android'),
        'postpaid',
        v_inquiry.id,
        p_idempotency_key
    )
    RETURNING id INTO v_order_id;

    UPDATE bill_inquiries
       SET status = 'used',
           order_id = v_order_id,
           used_at = NOW()
     WHERE id = v_inquiry.id;

    RETURN jsonb_build_object(
        'success', true,
        'order_id', v_order_id
    );
END;
$$;

COMMENT ON FUNCTION create_bill_order(UUID, UUID, JSONB, TEXT) IS
    'Atomically validates a bill quote, debits user balance, inserts the order and consumes the quote.';
