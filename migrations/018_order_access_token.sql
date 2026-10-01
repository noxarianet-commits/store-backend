-- 018_order_access_token.sql
--
-- Menutup IDOR pada GET /api/payments/status/:orderId dan POST /api/payments/cancel.
--
-- Order ID bisa ditebak (lihat paymentController.js:generateOrderId — hanya 36^3
-- kombinasi acak), jadi ID itu BUKAN bukti kepemilikan. Dua endpoint tersebut
-- sebelumnya tanpa autentikasi sama sekali dan mengembalikan seluruh baris `orders`
-- (termasuk account_details = kredensial game, email, wa_number).
--
-- Sekarang akses ke sebuah order harus dibuktikan dengan salah satu:
--   1. order_access_token — diberikan hanya kepada pembeli saat order dibuat, atau
--   2. req.user.id === order.user_id — untuk order milik user yang login.
--
-- Kolom nullable: order lama/lain yang tidak punya token tetap bisa dibaca oleh
-- pemiliknya lewat jalur (2). Order hasil createPayment selalu punya token.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS order_access_token TEXT;

-- Index untuk lookup token (dipakai saat debugging/incident response).
CREATE INDEX IF NOT EXISTS idx_orders_access_token
    ON orders (order_access_token)
    WHERE order_access_token IS NOT NULL;

COMMENT ON COLUMN orders.order_access_token IS
    'Token akses order (32 byte hex, diiwa sendiri purchaser). Wajib untuk GET /payments/status/:orderId dan POST /payments/cancel. Catatan: GET /api/orders memakai select(''*'') jadi nilai ini ikut muncul di respons admin — endpoint itu sudah verifyAdmin, tapi jangan pernah dikembalikan ke endpoint publik.';
