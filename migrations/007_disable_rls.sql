-- Migration 007: Disable RLS for fincloud_products
-- Karena backend saat ini menggunakan anon key Supabase untuk melakukan write (upsert/insert),
-- RLS pada tabel fincloud_products harus dimatikan agar backend bisa mengisi data.
-- Jalankan query ini di Supabase SQL Editor Anda:

ALTER TABLE fincloud_products DISABLE ROW LEVEL SECURITY;
