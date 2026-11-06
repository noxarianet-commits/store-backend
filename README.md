# Store Backend

Backend untuk NoxariaNet Store — Express 5 + Supabase (Postgres + Storage + Realtime).
Entry point: `server.js`.

## Ringkasan Cara Kerja

- `server.js` merangkai middleware, route, cron job, dan error handler.
  Saat `NODE_ENV=production` (mis. Vercel) app hanya di-`export`, tidak `listen()`.
- Semua data (produk, order, testimonial, settings, user) disimpan di Supabase.
- Alur order: `POST /api/payments/create` → pembayaran QRIS → webhook/polling
  konfirmasi pembayaran → fulfillment otomatis ke vendor → status order berubah.
- Gateway pembayaran dipilih dari setting `payment_gateway` (default **DYQRIS**;
  `sekalipay` didukung; `fincloud` legacy, nonaktif kecuali `FINCLOUD_WEBHOOK_ENABLED=true`).
- Backend **tidak** mengirim pesan WhatsApp langsung — notifikasi lewat bot
  terpisah di `../bot-noxarianet` (Order + tiket baru, via Supabase Realtime).
  Backend tetap berfungsi tanpa bot.

## Setup

```bash
npm install
cp .env.example .env   # isi SUPABASE_URL, SUPABASE_KEY, JWT_SECRET, dst.
npm start              # port 3000 (atau PORT)
```

`.env.example` adalah sumber kebenaran env vars — tambahkan variabel baru di sana
saat menambah konfigurasi.

## Perintah

| Perintah | Keterangan |
|---|---|
| `npm start` | Jalankan server |
| `npm test` | Test suite (`node --test test/*.test.js`) |
| `RUN_DB_TESTS=1 npm test` | Termasuk live-DB tests (read-only, memakai Supabase di `.env`) |
| `npm run seed:admin` | Buat/update akun admin di Supabase |

## Endpoint Penting

Publik:
- `POST /api/payments/create` — buat order + invoice pembayaran (guest atau user)
- `GET /api/payments/status/:orderId` — cek status pembayaran
- `GET /api/products` · `GET /api/services` · `GET /api/home` · `GET /api/testimonials` · `GET /api/settings`
- `POST /api/auth/register` + `/auth/register/verify` — registrasi 2 langkah (OTP email)
- `POST /api/auth/login` — login customer web
- `GET/POST /api/tickets[...]` — tiket bantuan CS (guest pakai `X-Ticket-Token` / `?token=`)
- `POST /api/webhooks/*` — callback payment gateway (mounted sebelum `express.json()`, body mentah untuk verifikasi signature)

Admin (`Authorization: Bearer <admin token>`; `POST /api/admin/login` untuk mendapatkan token):
- `GET /api/orders` — daftar order · `PUT /api/orders/:id` · `DELETE /api/orders/:id` · `GET /api/orders/stats`
- `PUT /api/settings/:key` — update setting
- `/api/admin/*` — manajemen produk, user, saldo, tiket, statistik

## Database

- Migrasi SQL bernomor ada di `migrations/` (sampai `023_mobile_app.sql`).
  **Tidak ada migration runner** — jalankan manual via Supabase SQL editor.
  Jangan renumber/rename file yang sudah diterapkan.

## Skrip Tambahan (`utils/`)

- `seed-admin.js` — dipanggil via `npm run seed:admin`
- `seed-website-service.js` — seed layanan jasa website
- `add_games.js` — tambah produk demo/game ke Supabase
- `check_db.js` — cek koneksi Supabase
- `migrate.js` — skrip arsip migrasi data lama dari `data/db.json` (sudah tidak dipakai rutin)
- `test_cors.js` / `test_post.js` — skrip manual lama; gunakan `npm test` sebagai gantinya

## Deploy

- Vercel (`vercel.json` → semua route ke `server.js`). **Cron tidak jalan di Vercel**
  (hanya PM2 instance 0 yang menjalankan node-cron; matikan dengan `CRON_ENABLED=false`).
  Untuk production serverless, scheduler eksternal diperlukan untuk payment polling.
