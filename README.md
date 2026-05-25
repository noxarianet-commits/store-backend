# Store Backend

## Ringkasan Cara Kerja

- `server.js` adalah backend utama.
- Backend menggunakan Express dan Supabase untuk menyimpan dan membaca data.
- Data produk, order, testimonial, dan settings disimpan di Supabase.
- Endpoint penting:
  - `GET /api/products` — daftar produk
  - `POST /api/order` — buat order publik dan upload bukti pembayaran
  - `GET /api/orders` — daftar order (admin)
  - `POST /api/admin/login` — login admin sederhana
  - `PUT /api/settings/:key` — update setting (admin)
- Upload file (bukti atau banner) disimpan ke Supabase Storage.
- Backend ini tidak mengirim pesan WhatsApp langsung.

## Bot WhatsApp

- `bot.js` dan `start-bot.js` adalah layanan terpisah untuk notifikasi WhatsApp.
- Bot mendengarkan perubahan `orders` di Supabase via realtime.
- Saat ada order baru, bot akan mengirimkan pesan ke admin dan mengirimkan japri ke customer.
- Jika backend dijalankan tanpa bot, backend tetap berfungsi; bot hanya diperlukan bila ingin notifikasi WA.

## Skrip Tambahan

- `utils/add_games.js` — menambahkan produk demo/game ke Supabase.
- `utils/migrate.js` — migrasi data dari `data/db.json` ke Supabase.
- `utils/check_db.js` — helper sederhana untuk memeriksa koneksi Supabase.
- `utils/test_cors.js` / `utils/test_post.js` — skrip tes lokal untuk endpoint order.

## Catatan

- `supabase.js` menginisialisasi koneksi Supabase.
- Pastikan `.env` berisi `SUPABASE_URL` dan `SUPABASE_KEY`.
- `uploads/` tampaknya tidak digunakan oleh `server.js` saat ini.
