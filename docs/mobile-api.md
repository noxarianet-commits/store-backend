# Mobile API — Android App

Base URL: `https://<backend-domain>/api/mobile`

Kontrak ini khusus aplikasi Android. Web tetap memakai `/api/*` tanpa perubahan.

Dokumen ini mencakup seluruh endpoint mobile, contoh request/response, model data,
rate limit, dan daftar error code. Nilai token, UUID, dan nominal di contoh bersifat
ilustratif.

## Daftar isi

1. [Konvensi umum](#1-konvensi-umum)
2. [Konfigurasi & health](#2-konfigurasi--health)
3. [Auth](#3-auth)
4. [Profil & saldo](#4-profil--saldo)
5. [Katalog](#5-katalog)
6. [Cek tagihan](#6-cek-tagihan)
7. [Order](#7-order)
8. [Error codes](#8-error-codes)
9. [Admin terkait](#9-admin-terkait)
10. [Deployment note](#10-deployment-note)
11. [Catatan implementasi Android](#11-catatan-implementasi-android)

---

## 1. Konvensi umum

### Base URL dan format

| Item | Nilai |
|---|---|
| Base URL mobile | `https://<backend-domain>/api/mobile` |
| Content-Type | `application/json` |
| Encoding | UTF-8 |
| Format respons standar | `{ "success": true, "data": ... }` |
| Format error standar | `{ "success": false, "code": "...", "error": "..." }` |

Beberapa endpoint memakai bentuk respons yang berbeda (auth, validasi produk,
polling pembayaran, dan saldo). Perbedaan ini dijelaskan di masing-masing endpoint.

### Autentikasi

- `POST /auth/login` dan `POST /auth/register/verify` menerbitkan JWT dengan claim
  `client: "android"` dan masa berlaku **30 hari**.
- Semua endpoint terautentikasi (selain `GET /config` dan endpoint `/auth/*`)
  **wajib** header:

```http
Authorization: Bearer <app-token>
```

- Token web (tanpa claim `client`, atau `client: "web"`) ditolak `403 APP_ONLY`
  pada endpoint `/api/mobile/*`. Endpoint `/api/balance/*` dan
  `/api/payments/status/:orderId` memakai `verifyUser`, jadi token web juga
  diterima di sana.
- Guest checkout tidak tersedia. Semua order memakai `user_id` dari token.
- `Idempotency-Key: <uuid>` wajib dari sisi client untuk `POST /orders` agar retry
  jaringan tidak membuat order/debit ganda. Server tidak menolak request tanpa
  header ini, tetapi retry tanpa key berisiko membuat order ganda.

Contoh isi token (setelah di-decode):

```json
{
  "id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
  "email": "budi@example.com",
  "display_name": "Budi Santoso",
  "type": "user",
  "client": "android",
  "iat": 1760000000,
  "exp": 1762592000
}
```

Error autentikasi yang mungkin muncul:

| HTTP | Body | Kapan |
|---|---|---|
| `401` | `{ "success": false, "code": "AUTH_REQUIRED", "error": "Token aplikasi tidak ditemukan." }` | Header `Authorization` tidak ada |
| `403` | `{ "success": false, "code": "APP_ONLY", "error": "Endpoint ini hanya dapat digunakan dari aplikasi Android." }` | Token web / bukan token app |
| `401` | `{ "error": "Sesi telah berakhir. Silakan login kembali." }` | Token kedaluwarsa |
| `403` | `{ "error": "Token tidak valid." }` | Signature/format token salah |
| `403` | `{ "error": "Token tidak valid untuk user." }` | Token admin dipakai di endpoint user |

> Catatan: error dari `verifyUser` (token kedaluwarsa/tidak valid) hanya berisi
> `error`, tanpa `success` dan `code`. Aplikasi sebaiknya menangani `401` sebagai
> "login ulang" dan `403` sebagai "token tidak berhak".

### Idempotensi

`POST /orders` menerima idempotency key dari:

1. Header `Idempotency-Key`, atau
2. Body `idempotency_key` (fallback).

Aturan:

- Key unik per user (`UNIQUE (user_id, idempotency_key)`).
- Request ulang dengan key yang sama mengembalikan order yang sudah ada dengan
  HTTP `200` dan `"idempotent": true`, bukan membuat order baru.
- Key yang sama dengan payload berbeda tetap mengembalikan order pertama. Gunakan
  UUID baru untuk order baru.
- Untuk order tagihan, pemakaian key yang sama juga dilindungi advisory lock di
  database (`create_bill_order`).

Contoh membuat key di Android:

```kotlin
val idempotencyKey = java.util.UUID.randomUUID().toString()
```

### Rate limit

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 15 request / 15 menit / IP |
| `POST /auth/register`, `/auth/register/resend`, `/auth/forgot-password`, `/auth/forgot-password/resend` | 10 request / jam / IP |
| `POST /auth/register/verify`, `/auth/forgot-password/verify` | 20 request / 15 menit / IP |
| `POST /orders` | 30 request / jam / user (fallback IP) |
| `POST /bills/inquiry` | 12 request / menit / user (fallback IP) |
| `GET /orders/:id` | 120 request / menit / user (fallback IP) |
| `GET /api/payments/status/:orderId` | 120 request / menit / IP |
| Global API | 600 request / 10 menit / IP |

Global limiter **dilewati** untuk:

- `GET /api/payments/status/*`
- `GET /api/mobile/orders/:id`
- semua path yang berakhiran `/stream`

Respons `429` dari limiter route mobile:

```json
{
  "success": false,
  "code": "RATE_LIMITED",
  "error": "Terlalu banyak pembuatan pesanan. Coba lagi nanti."
}
```

Respons `429` dari limiter global hanya berisi:

```json
{
  "error": "Terlalu banyak request, silakan coba lagi nanti."
}
```

### HTTP status yang dipakai

| Status | Arti umum |
|---|---|
| `200` | Sukses, termasuk replay idempotent |
| `201` | Resource baru dibuat (order, inquiry) |
| `400` | Validasi input / aturan bisnis gagal |
| `401` | Token tidak ada / kedaluwarsa |
| `403` | Token bukan app, akun nonaktif, toko tutup |
| `404` | Produk/order/tagihan tidak ditemukan, atau bukan milik user |
| `409` | Konflik status (quote sudah dipakai, order sudah diproses) |
| `422` | Vendor gagal memproses inquiry / konfigurasi tagihan tidak lengkap |
| `429` | Rate limit |
| `500` | Kesalahan server |
| `501` | Vendor belum mendukung fitur |
| `502`/`503` | Gagal membuat invoice / saldo vendor kurang |

### Pola respons per kelompok endpoint

| Kelompok | Pola sukses | Pola error |
|---|---|---|
| Mobile catalog/order/bill | `{ success: true, data: ... }` | `{ success: false, code, error }` |
| Auth | `{ success: true, token, user }` atau `{ success: true, message }` | `{ success: false, error }` (tanpa `code`) |
| Validasi produk | `{ valid: true, ... }` | `{ error, errors? }` (tanpa `success`/`code`) |
| Polling pembayaran | `{ data: {...} }` | `{ error }` |
| Saldo | `{ success: true, ... }` | `{ success: false, error }` |
| Admin | bervariasi, mengikuti controller admin | `{ success: false, error }` |

---

## 2. Konfigurasi & health

### `GET /config` (public)

Konfigurasi aplikasi, status toko, dan feature flag. Tidak butuh token.
Respons di-cache `Cache-Control: public, max-age=60`.

**Request**

```http
GET /api/mobile/config
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "min_version": "1.0.0",
    "latest_version": "1.0.0",
    "maintenance": false,
    "features": {
      "bills": true,
      "topup": true,
      "tickets": true
    },
    "payment_methods": ["balance", "qris"],
    "mandatory_validation": true,
    "shop_status": {
      "isOpen": true,
      "message": "Selamat datang!"
    }
  }
}
```

**Field**

| Field | Tipe | Keterangan |
|---|---|---|
| `min_version` | string | Versi minimum yang masih didukung |
| `latest_version` | string | Versi terbaru di store |
| `maintenance` | boolean | Mode maintenance |
| `features.bills` | boolean | Tampilkan menu tagihan |
| `features.topup` | boolean | Tampilkan menu top-up saldo |
| `features.tickets` | boolean | Tampilkan menu bantuan/CS |
| `payment_methods` | string[] | `balance` dan `qris` (label UI). Di order, `qris` dikirim sebagai `payment_type: "gateway"` |
| `mandatory_validation` | boolean | Flag efektif "Wajib Validasi Akun" untuk channel app. `false` = cek ID ke penyedia dilewati |
| `shop_status.isOpen` | boolean | Toko buka/tutup |
| `shop_status.message` | string | Pesan yang ditampilkan saat toko tutup |

Nilai default dapat dioverride oleh setting `mobile_app_config` di tabel
`settings`. Key `features` digabung dengan default, jadi menambahkan satu flag
tidak menghilangkan flag lain.

`mandatory_validation` **tidak** berasal dari `mobile_app_config`; nilainya
dihitung server dari setting `mandatory_validation` (master) dan
`mandatory_validation_app` (override channel app) dengan aturan yang sama
seperti validasi di `POST /orders`. Nilai hilang atau gagal dibaca berarti
`true` (fail-safe). Aplikasi lama yang belum membaca field ini tetap aman.

**Response `500`**

```json
{
  "success": false,
  "code": "CONFIG_FAILED",
  "error": "Gagal memuat konfigurasi aplikasi."
}
```

---

## 3. Auth

Semua endpoint auth di bawah ini **public** (tidak butuh token), kecuali disebutkan.

### `POST /auth/register`

Langkah 1 dari 2 registrasi. **Tidak membuat akun dan tidak mengembalikan token.**
Data ditahan di `pending_registrations`, lalu OTP 6 digit dikirim ke email.

**Request**

```http
POST /api/mobile/auth/register
Content-Type: application/json

{
  "email": "budi@example.com",
  "phone": "08123456789",
  "display_name": "Budi Santoso",
  "password": "rahasia123"
}
```

**Response `200`**

```json
{
  "success": true,
  "requires_verification": true,
  "email": "budi@example.com",
  "masked_email": "b***@example.com",
  "expires_in": 1800,
  "resend_available_in": 60
}
```

**Field**

| Field | Keterangan |
|---|---|
| `requires_verification` | Selalu `true`; lanjut ke `/auth/register/verify` |
| `email` | Email yang dinormalisasi (lowercase/trim) |
| `masked_email` | Email untuk ditampilkan di UI |
| `expires_in` | Masa berlaku data pending, dalam detik (1800 = 30 menit) |
| `resend_available_in` | Cooldown resend OTP, dalam detik (60) |

**Aturan OTP registrasi**

- Kode 6 digit, dikirim ke email.
- TTL 30 menit (mengikuti TTL pending registrasi).
- Maksimal 5 percobaan per kode.
- Resend minimal 60 detik sekali.
- Satu kode hanya bisa dipakai sekali.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Semua field wajib diisi." }` | Ada field kosong |
| `400` | `{ "success": false, "error": "Format email tidak valid." }` | Email tidak valid |
| `400` | `{ "success": false, "error": "Password minimal 8 karakter." }` | Password terlalu pendek |
| `400` | `{ "success": false, "error": "Email sudah terdaftar." }` | Email sudah punya akun |
| `429` | `{ "success": false, "error": "Terlalu sering meminta kode. Coba lagi dalam 42 detik.", "retry_after": 42 }` | Cooldown per email |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak permintaan kode verifikasi. Coba lagi nanti." }` | Limiter per IP |
| `500` | `{ "success": false, "error": "Gagal mengirim email verifikasi. Silakan coba lagi beberapa saat lagi." }` | Email gagal terkirim |

### `POST /auth/register/verify`

Langkah 2 dari 2. Mencocokkan OTP, membuat baris `user_profiles`, dan menerbitkan
token app.

**Request**

```http
POST /api/mobile/auth/register/verify
Content-Type: application/json

{
  "email": "budi@example.com",
  "code": "402817"
}
```

**Response `200`**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    "email": "budi@example.com",
    "display_name": "Budi Santoso",
    "phone": "08123456789",
    "balance": 0,
    "is_active": true,
    "email_verified": true
  }
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Email dan kode verifikasi wajib diisi." }` | Field kosong |
| `400` | `{ "success": false, "error": "Tidak ada pendaftaran yang menunggu verifikasi. Silakan daftar ulang." }` | Pending tidak ada / sudah dipakai |
| `400` | `{ "success": false, "error": "Kode verifikasi salah." }` | Kode salah / tidak ada |
| `400` | `{ "success": false, "error": "Kode verifikasi sudah kedaluwarsa. Silakan minta kode baru." }` | OTP kedaluwarsa |
| `429` | `{ "success": false, "error": "Terlalu banyak percobaan. Silakan minta kode baru." }` | Percobaan OTP habis |
| `400` | `{ "success": false, "error": "Pendaftaran sudah kedaluwarsa. Silakan daftar ulang." }` | Data pending kedaluwarsa |
| `400` | `{ "success": false, "error": "Email sudah terdaftar." }` | Email terisi di antara langkah 1 dan 2 |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak percobaan verifikasi. Coba lagi dalam 15 menit." }` | Limiter per IP |

### `POST /auth/register/resend`

Kirim ulang OTP registrasi.

**Request**

```http
POST /api/mobile/auth/register/resend
Content-Type: application/json

{
  "email": "budi@example.com"
}
```

**Response `200`**

```json
{
  "success": true,
  "masked_email": "b***@example.com",
  "expires_in": 1800,
  "resend_available_in": 60
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Email wajib diisi." }` | Email kosong |
| `400` | `{ "success": false, "error": "Tidak ada pendaftaran yang menunggu verifikasi. Silakan daftar ulang." }` | Tidak ada pending |
| `429` | `{ "success": false, "error": "Terlalu sering meminta kode. Coba lagi dalam 42 detik.", "retry_after": 42 }` | Cooldown |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak permintaan kode verifikasi. Coba lagi nanti." }` | Limiter per IP |

### `POST /auth/login`

Login customer dan terbitkan token app 30 hari.

**Request**

```http
POST /api/mobile/auth/login
Content-Type: application/json

{
  "email": "budi@example.com",
  "password": "rahasia123"
}
```

**Response `200`**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    "email": "budi@example.com",
    "phone": "08123456789",
    "display_name": "Budi Santoso",
    "balance": 125000,
    "is_active": true,
    "email_verified": true
  }
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Email dan password wajib diisi." }` | Field kosong |
| `401` | `{ "success": false, "error": "Email atau password salah." }` | Kredensial salah |
| `401` | `{ "success": false, "error": "Akun dinonaktifkan." }` | `is_active = false` |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak percobaan login. Coba lagi dalam 15 menit." }` | Limiter per IP |
| `500` | `{ "success": false, "error": "Terjadi kesalahan server." }` | Kesalahan server |

### `POST /auth/forgot-password`

Kirim OTP reset password. Endpoint **selalu** membalas sukses, baik email terdaftar
maupun tidak (mencegah enumerasi akun).

**Request**

```http
POST /api/mobile/auth/forgot-password
Content-Type: application/json

{
  "email": "budi@example.com"
}
```

**Response `200` (email terdaftar)**

```json
{
  "success": true,
  "message": "Kode verifikasi telah dikirim ke email Anda.",
  "resend_available_in": 60
}
```

**Response `200` (email tidak terdaftar)**

```json
{
  "success": true,
  "message": "Jika email tersebut terdaftar, kode verifikasi telah dikirim.",
  "resend_available_in": 60
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Email wajib diisi." }` | Email kosong |
| `429` | `{ "success": false, "error": "Terlalu sering meminta kode. Coba lagi dalam 42 detik.", "retry_after": 42 }` | Cooldown |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak permintaan kode verifikasi. Coba lagi nanti." }` | Limiter per IP |

### `POST /auth/forgot-password/verify`

Cocokkan OTP dan ganti password. **Tidak menerbitkan token baru**; user harus login
ulang dengan password baru.

**Request**

```http
POST /api/mobile/auth/forgot-password/verify
Content-Type: application/json

{
  "email": "budi@example.com",
  "code": "402817",
  "new_password": "passwordBaru123"
}
```

**Response `200`**

```json
{
  "success": true,
  "message": "Password berhasil diubah. Silakan masuk dengan password baru Anda."
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Email, kode verifikasi, dan password baru wajib diisi." }` | Field kosong |
| `400` | `{ "success": false, "error": "Password minimal 8 karakter." }` | Password terlalu pendek |
| `400` | `{ "success": false, "error": "Kode verifikasi salah." }` | Kode salah |
| `400` | `{ "success": false, "error": "Kode verifikasi sudah kedaluwarsa. Silakan minta kode baru." }` | OTP kedaluwarsa |
| `429` | `{ "success": false, "error": "Terlalu banyak percobaan. Silakan minta kode baru." }` | Percobaan habis |
| `400` | `{ "success": false, "error": "Akun tidak ditemukan. Silakan daftar ulang." }` | OTP valid tetapi akun hilang |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak percobaan verifikasi. Coba lagi dalam 15 menit." }` | Limiter per IP |

### `POST /auth/forgot-password/resend`

Kirim ulang OTP reset password. Sama seperti `forgot-password`, respons tidak
membocorkan keberadaan akun.

**Request**

```http
POST /api/mobile/auth/forgot-password/resend
Content-Type: application/json

{
  "email": "budi@example.com"
}
```

**Response `200`**

```json
{
  "success": true,
  "message": "Kode verifikasi telah dikirim ulang.",
  "resend_available_in": 60
}
```

Untuk email tidak terdaftar:

```json
{
  "success": true,
  "message": "Jika email tersebut terdaftar, kode verifikasi telah dikirim.",
  "resend_available_in": 60
}
```

**Error** sama dengan `forgot-password` (email kosong, cooldown, rate limit).

---

## 4. Profil & saldo

### `GET /me`

Profil customer yang sedang login, termasuk saldo.

**Request**

```http
GET /api/mobile/me
Authorization: Bearer <app-token>
```

**Response `200`**

```json
{
  "success": true,
  "user": {
    "id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    "email": "budi@example.com",
    "phone": "08123456789",
    "display_name": "Budi Santoso",
    "balance": 125000,
    "balance_limit": 1000000,
    "is_active": true,
    "email_verified": true,
    "created_at": "2026-01-15T08:00:00.000Z"
  }
}
```

**Error**

| HTTP | Body |
|---|---|
| `404` | `{ "success": false, "error": "User tidak ditemukan." }` |
| `500` | `{ "success": false, "error": "..." }` |

### `PUT /me`

Update nama tampilan dan/atau nomor telepon. Field yang tidak dikirim tidak diubah.

**Request**

```http
PUT /api/mobile/me
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "display_name": "Budi S.",
  "phone": "081298765432"
}
```

**Response `200`**

```json
{
  "success": true,
  "user": {
    "id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    "email": "budi@example.com",
    "phone": "081298765432",
    "display_name": "Budi S.",
    "balance": 125000,
    "is_active": true
  }
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Tidak ada data yang diupdate." }` | Tidak ada field yang dikirim |
| `500` | `{ "success": false, "error": "..." }` | Kesalahan server |

> `email` tidak bisa diubah lewat endpoint ini.

### `PUT /me/password`

Ganti password dengan memverifikasi password saat ini.

**Request**

```http
PUT /api/mobile/me/password
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "current_password": "rahasia123",
  "new_password": "passwordBaru123"
}
```

**Response `200`**

```json
{
  "success": true,
  "message": "Password berhasil diubah."
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Password saat ini dan baru wajib diisi." }` | Field kosong |
| `400` | `{ "success": false, "error": "Password minimal 8 karakter." }` | Password baru terlalu pendek |
| `401` | `{ "success": false, "error": "Password saat ini salah." }` | Password lama salah |
| `404` | `{ "success": false, "error": "User tidak ditemukan." }` | User hilang |
| `500` | `{ "success": false, "error": "..." }` | Kesalahan server |

### `GET /api/balance`

Saldo dan limit saldo user. Token app tetap diterima karena endpoint memakai
`verifyUser`.

**Request**

```http
GET /api/balance
Authorization: Bearer <app-token>
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "balance": 125000,
    "balance_limit": 1000000
  }
}
```

**Error `500`**

```json
{
  "success": false,
  "error": "..."
}
```

### `POST /api/balance/topup`

Buat top-up saldo via payment gateway aktif. Top-up pending sebelumnya milik user
otomatis dibatalkan agar tidak menumpuk.

**Request**

```http
POST /api/balance/topup
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "amount": 50000
}
```

**Response `200`**

```json
{
  "success": true,
  "topup_id": "TOPUP-AB12CD-654321",
  "qr_link": "https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=...",
  "total": 50000,
  "pg_provider": "dyqris",
  "status": "pending",
  "amount": 50000
}
```

**Field**

| Field | Keterangan |
|---|---|
| `topup_id` | Referensi top-up (`TOPUP-...`); pakai untuk cek status |
| `qr_link` | URL gambar QR untuk dibayar |
| `total` | Nominal yang harus dibayar (bisa termasuk kode unik/fee gateway) |
| `pg_provider` | `dyqris`, `sekalipay`, atau `fincloud` (legacy) |
| `status` | Selalu `pending` saat dibuat |

**Aturan**

- Kirim `amount` sebagai **number**, bukan string.
- Validasi server menolak `amount < 1000`. Pesan error saat ini menyebut
  "Minimal top-up adalah Rp 10.000" (inkonsistensi teks yang diketahui).
- Total saldo setelah top-up tidak boleh melebihi `balance_limit`.
- Top-up kedaluwarsa setelah ±30 menit.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "success": false, "error": "Minimal top-up adalah Rp 10.000" }` | `amount < 1000` |
| `400` | `{ "success": false, "error": "Top-up ditolak. Melebihi limit saldo (Rp 1.000.000)." }` | Melebihi `balance_limit` |
| `500` | `{ "success": false, "error": "Gagal membuat top-up" }` | Gateway/server gagal |

### `GET /api/balance/topup/pending`

Top-up pending terakhir yang masih punya QR. Jika sudah kedaluwarsa (>30 menit
atau melewati `pg_expired_at`), transaksi dibatalkan dan `data` bernilai `null`.

**Request**

```http
GET /api/balance/topup/pending
Authorization: Bearer <app-token>
```

**Response `200` (ada)**

```json
{
  "success": true,
  "data": {
    "id": "0b6f3a2c-1d4e-4f5a-8b9c-0d1e2f3a4b5c",
    "user_id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    "type": "topup",
    "amount": 50000,
    "balance_before": 125000,
    "balance_after": 125000,
    "reference_id": "TOPUP-AB12CD-654321",
    "status": "pending",
    "description": "Top-up Saldo",
    "pg_provider": "dyqris",
    "pg_invoice": "inv_123",
    "pg_qr_link": "https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=...",
    "pg_total": 50000,
    "pg_expired_at": "2026-11-09T10:30:00.000Z",
    "created_at": "2026-11-09T10:00:00.000Z"
  }
}
```

**Response `200` (tidak ada)**

```json
{
  "success": true,
  "data": null
}
```

### `POST /api/balance/topup/cancel`

Batalkan top-up pending. Jika `id` tidak dikirim, semua top-up pending milik user
dibatalkan.

**Request**

```http
POST /api/balance/topup/cancel
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "id": "TOPUP-AB12CD-654321"
}
```

`id` boleh berupa UUID baris `balance_transactions` atau `reference_id`
(`TOPUP-...`). Body juga boleh kosong.

**Response `200`**

```json
{
  "success": true,
  "message": "Top-up berhasil dibatalkan"
}
```

### `GET /api/balance/topup/:id/status`

Cek status top-up berdasarkan UUID atau `reference_id`. Jika masih pending,
backend ikut menanyakan status ke payment gateway dan dapat langsung mengkredit
saldo.

**Request**

```http
GET /api/balance/topup/TOPUP-AB12CD-654321/status
Authorization: Bearer <app-token>
```

**Response `200` (pending)**

```json
{
  "success": true,
  "status": "pending",
  "data": {
    "id": "0b6f3a2c-1d4e-4f5a-8b9c-0d1e2f3a4b5c",
    "reference_id": "TOPUP-AB12CD-654321",
    "amount": 50000,
    "status": "pending",
    "pg_provider": "dyqris",
    "pg_total": 50000,
    "pg_expired_at": "2026-11-09T10:30:00.000Z",
    "created_at": "2026-11-09T10:00:00.000Z"
  }
}
```

**Response `200` (selesai)**

```json
{
  "success": true,
  "status": "completed",
  "data": {
    "id": "0b6f3a2c-1d4e-4f5a-8b9c-0d1e2f3a4b5c",
    "reference_id": "TOPUP-AB12CD-654321",
    "amount": 50000,
    "status": "completed",
    "balance_before": 125000,
    "balance_after": 175000,
    "credited_at": "2026-11-09T10:05:00.000Z"
  }
}
```

Status yang mungkin: `pending`, `completed`, `cancelled`, `failed`.

**Error `404`**

```json
{
  "success": false,
  "error": "Transaksi tidak ditemukan"
}
```

### `GET /api/balance/history`

Riwayat transaksi saldo.

**Request**

```http
GET /api/balance/history?page=1&limit=10&type=topup
Authorization: Bearer <app-token>
```

**Query**

| Parameter | Default | Keterangan |
|---|---|---|
| `page` | `1` | Halaman |
| `limit` | `10` | Jumlah per halaman |
| `type` | semua | `topup`, `purchase`, atau `refund`; `semua`/`ALL` untuk semua |

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "0b6f3a2c-1d4e-4f5a-8b9c-0d1e2f3a4b5c",
      "user_id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
      "type": "topup",
      "amount": 50000,
      "balance_before": 125000,
      "balance_after": 175000,
      "reference_id": "TOPUP-AB12CD-654321",
      "status": "completed",
      "description": "Top-up Saldo",
      "pg_provider": "dyqris",
      "pg_invoice": "inv_123",
      "pg_qr_link": "https://...",
      "pg_total": 50000,
      "pg_expired_at": "2026-11-09T10:30:00.000Z",
      "created_at": "2026-11-09T10:00:00.000Z",
      "credited_at": "2026-11-09T10:05:00.000Z"
    }
  ],
  "pagination": {
    "total": 1,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
}
```

---

## 5. Katalog

Semua endpoint katalog di bawah ini membutuhkan token app.

### `GET /home`

Data beranda: kategori prepaid & tagihan, produk featured, testimoni, dan quick
actions. Produk digabung lintas vendor berdasarkan nama kanonik.

**Request**

```http
GET /api/mobile/home
Authorization: Bearer <app-token>
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "settings": {
      "shop_status": {
        "isOpen": true,
        "message": "Selamat datang!"
      },
      "site_content": {
        "hero_title": "Top Up & Bayar Tagihan",
        "hero_subtitle": "Cepat, aman, dan otomatis"
      },
      "wa_group_link": "https://chat.whatsapp.com/...",
      "whatsapp_cs": "628123456789",
      "info_modal_active": false,
      "info_modal_text": "",
      "info_modal_image": null,
      "payment_gateway": "dyqris"
    },
    "categories": [
      {
        "slug": "game",
        "name": "Game",
        "icon": "https://cdn.example.com/icons/game.png",
        "product_count": 12,
        "type": "prepaid"
      },
      {
        "slug": "tagihan-listrik",
        "name": "Tagihan Listrik",
        "icon": null,
        "product_count": 2,
        "type": "postpaid"
      }
    ],
    "prepaid_categories": [
      {
        "slug": "game",
        "name": "Game",
        "icon": "https://cdn.example.com/icons/game.png",
        "product_count": 12,
        "type": "prepaid"
      }
    ],
    "bill_categories": [
      {
        "slug": "tagihan-listrik",
        "name": "Tagihan Listrik",
        "icon": null,
        "product_count": 2,
        "type": "postpaid"
      }
    ],
    "featured_products": [
      {
        "id": 123,
        "canonical_key": "mobilelegends",
        "name": "Mobile Legends",
        "category": "Game",
        "brand": "Moonton",
        "icon": "https://cdn.example.com/icons/ml.png",
        "image": "https://cdn.example.com/banners/ml.jpg",
        "is_active": true,
        "is_featured": true,
        "product_type": "prepaid",
        "is_postpaid": false,
        "synced_at": "2026-11-09T03:00:00.000Z",
        "created_at": "2026-01-15T08:00:00.000Z",
        "servers": [
          {
            "vendor": "sekalipay",
            "server_name": "Server 1 (Sekalipay)",
            "product_id": 123,
            "variants": [
              {
                "id": "D10",
                "db_id": 501,
                "product_id": 123,
                "vendor": "sekalipay",
                "sku": "D10",
                "name": "10 Diamonds",
                "price": 5000,
                "sell_price": 5000,
                "stock": 9999,
                "order_process": "auto",
                "required_fields": [
                  {
                    "key": "customer_id",
                    "label": "User ID",
                    "type": "text",
                    "required": true
                  },
                  {
                    "key": "zone_id",
                    "label": "Zone ID",
                    "type": "text",
                    "required": true
                  }
                ],
                "validation": {
                  "available": true
                },
                "provider_meta": {},
                "note": ""
              }
            ]
          }
        ],
        "variants": [
          {
            "id": "D10",
            "db_id": 501,
            "product_id": 123,
            "vendor": "sekalipay",
            "sku": "D10",
            "name": "10 Diamonds",
            "price": 5000,
            "sell_price": 5000,
            "stock": 9999,
            "order_process": "auto",
            "required_fields": [
              {
                "key": "customer_id",
                "label": "User ID",
                "type": "text",
                "required": true
              },
              {
                "key": "zone_id",
                "label": "Zone ID",
                "type": "text",
                "required": true
              }
            ],
            "validation": {
              "available": true
            },
            "provider_meta": {},
            "note": ""
          }
        ],
        "vendor": "sekalipay"
      }
    ],
    "testimonials": [
      {
        "id": 1,
        "name": "Andi",
        "rating": 5,
        "text": "Prosesnya cepat, otomatis.",
        "created_at": "2026-11-01T12:00:00.000Z"
      }
    ],
    "quick_actions": [
      { "key": "topup", "label": "Top Up Saldo" },
      { "key": "bills", "label": "Bayar Tagihan" },
      { "key": "orders", "label": "Riwayat Pesanan" },
      { "key": "tickets", "label": "Bantuan CS" }
    ]
  }
}
```

**Catatan**

- `settings` hanya berisi key yang diizinkan untuk publik (`shop_status`,
  `site_content`, `wa_group_link`, `whatsapp_cs`, `info_modal_active`,
  `info_modal_text`, `info_modal_image`, `payment_gateway`).
- `categories` = `prepaid_categories` + `bill_categories`.
- `featured_products` maksimal 12 produk, sudah digabung lintas vendor.
- `variants` di level produk adalah varian dari server utama (`servers[0]`).
  Untuk melihat semua server, gunakan `servers[]`.
- `product_count` adalah jumlah produk gabungan per kategori.

**Response `500`**

```json
{
  "success": false,
  "code": "HOME_FAILED",
  "error": "Gagal memuat halaman utama."
}
```

### `GET /products`

Daftar produk yang tersedia untuk channel `app`. Produk tagihan (postpaid) hanya
muncul di katalog app, tidak di web.

**Request**

```http
GET /api/mobile/products?type=postpaid&search=bandung&page=1&per_page=50
Authorization: Bearer <app-token>
```

**Query**

| Parameter | Default | Keterangan |
|---|---|---|
| `type` | semua | `prepaid` atau `postpaid` |
| `category` | semua | Nama kategori persis, mis. `Game` |
| `search` | - | Mencari `name`, `category`, `brand`; khusus `type=postpaid` juga mencari nama varian |
| `page` | `1` | Halaman |
| `per_page` | `50` | Maksimal `200` |

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": 123,
      "vendor": "sekalipay",
      "external_id": "SHP-ML",
      "category": "Game",
      "name": "Mobile Legends",
      "brand": "Moonton",
      "icon": "https://cdn.example.com/icons/ml.png",
      "image": "https://cdn.example.com/banners/ml.jpg",
      "is_active": true,
      "is_featured": true,
      "product_type": "prepaid",
      "is_postpaid": false,
      "variants": [
        {
          "id": "D10",
          "db_id": 501,
          "product_id": 123,
          "sku": "D10",
          "name": "10 Diamonds",
          "price": 5000,
          "stock": 9999,
          "order_process": "auto",
          "required_fields": [
            {
              "key": "customer_id",
              "label": "User ID",
              "type": "text",
              "required": true
            },
            {
              "key": "zone_id",
              "label": "Zone ID",
              "type": "text",
              "required": true
            }
          ],
          "validation": {
            "available": true
          },
          "provider_meta": {},
          "note": ""
        }
      ]
    },
    {
      "id": 10,
      "vendor": "okeconnect",
      "external_id": "okc-bill-tagihan-pdam-jawa-barat-dan-jakarta",
      "category": "Tagihan Air",
      "name": "PDAM Jawa Barat dan Jakarta",
      "brand": "PDAM",
      "icon": null,
      "image": null,
      "is_active": true,
      "is_featured": false,
      "product_type": "postpaid",
      "is_postpaid": true,
      "variants": [
        {
          "id": "42",
          "db_id": 42,
          "product_id": 10,
          "sku": null,
          "name": "PDAM Kota Bandung",
          "price": 0,
          "admin_fee": 2500,
          "stock": 9999,
          "order_process": "auto",
          "required_fields": [
            {
              "key": "customer_number",
              "label": "Nomor Pelanggan / ID Meter",
              "type": "text",
              "required": true
            }
          ],
          "validation": {
            "available": true,
            "type": "bill_inquiry"
          },
          "provider_meta": {
            "postpaid": true
          },
          "note": ""
        }
      ]
    }
  ],
  "meta": {
    "total": 2,
    "page": 1,
    "per_page": 50,
    "total_pages": 1
  }
}
```

**Catatan penting**

- Endpoint ini mengembalikan baris produk **per vendor** (tidak menggabungkan
  produk prepaid lintas vendor). Untuk tampilan gabungan, gunakan `GET /home`
  atau `GET /products/:id`.
- Produk tagihan sudah dikelompokkan per grup biller OkeConnect. Contoh:
  produk `PDAM Jawa Barat dan Jakarta` memiliki varian `PDAM Kota Bandung`,
  `PDAM Kota Jakarta Aetra`, dst.
- `search` pada produk tagihan juga mencocokkan nama varian, jadi
  `type=postpaid&search=bandung` tetap menemukan produk PDAM yang benar.
- Untuk produk prepaid, `variants[].id` = `vendor_variant_id` (dipakai saat order).
- Untuk produk tagihan, `variants[].id` = ID internal varian (kode vendor tidak
  diekspos) dan `admin_fee` = biaya layanan. Gunakan `variants[].id` ini untuk
  inquiry dan order.

**Response `500`**

```json
{
  "success": false,
  "code": "PRODUCTS_FAILED",
  "error": "Gagal memuat produk."
}
```

### `GET /products/:id`

Detail produk. `:id` boleh berupa ID internal numerik atau `external_id`.

- Produk **prepaid**: respons digabung lintas vendor (multi-server).
- Produk **tagihan**: respons berupa satu produk postpaid (tidak digabung).

**Request prepaid**

```http
GET /api/mobile/products/123
Authorization: Bearer <app-token>
```

**Response `200` (prepaid, digabung)**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "canonical_key": "mobilelegends",
    "name": "Mobile Legends",
    "category": "Game",
    "brand": "Moonton",
    "icon": "https://cdn.example.com/icons/ml.png",
    "image": "https://cdn.example.com/banners/ml.jpg",
    "is_active": true,
    "is_featured": true,
    "product_type": "prepaid",
    "is_postpaid": false,
    "synced_at": "2026-11-09T03:00:00.000Z",
    "created_at": "2026-01-15T08:00:00.000Z",
    "servers": [
      {
        "vendor": "sekalipay",
        "server_name": "Server 1 (Sekalipay)",
        "product_id": 123,
        "variants": [
          {
            "id": "D10",
            "db_id": 501,
            "product_id": 123,
            "vendor": "sekalipay",
            "sku": "D10",
            "name": "10 Diamonds",
            "price": 5000,
            "sell_price": 5000,
            "stock": 9999,
            "order_process": "auto",
            "required_fields": [
              {
                "key": "customer_id",
                "label": "User ID",
                "type": "text",
                "required": true
              },
              {
                "key": "zone_id",
                "label": "Zone ID",
                "type": "text",
                "required": true
              }
            ],
            "validation": {
              "available": true
            },
            "provider_meta": {},
            "note": ""
          }
        ]
      },
      {
        "vendor": "okeconnect",
        "server_name": "Server 2 (OkeConnect)",
        "product_id": 124,
        "variants": [
          {
            "id": "ML10",
            "db_id": 701,
            "product_id": 124,
            "vendor": "okeconnect",
            "sku": "ML10",
            "name": "10 Diamonds",
            "price": 5100,
            "sell_price": 5100,
            "stock": 9999,
            "order_process": "auto",
            "required_fields": [
              {
                "key": "customer_id",
                "label": "User ID",
                "type": "text",
                "required": true
              },
              {
                "key": "zone_id",
                "label": "Zone ID",
                "type": "text",
                "required": true
              }
            ],
            "validation": {
              "available": true
            },
            "provider_meta": {},
            "note": ""
          }
        ]
      }
    ],
    "variants": [
      {
        "id": "D10",
        "db_id": 501,
        "product_id": 123,
        "vendor": "sekalipay",
        "sku": "D10",
        "name": "10 Diamonds",
        "price": 5000,
        "sell_price": 5000,
        "stock": 9999,
        "order_process": "auto",
        "required_fields": [
          {
            "key": "customer_id",
            "label": "User ID",
            "type": "text",
            "required": true
          },
          {
            "key": "zone_id",
            "label": "Zone ID",
            "type": "text",
            "required": true
          }
        ],
        "validation": {
          "available": true
        },
        "provider_meta": {},
        "note": ""
      }
    ],
    "vendor": "sekalipay",
    "requested_vendor": "sekalipay"
  }
}
```

**Request tagihan**

```http
GET /api/mobile/products/10
Authorization: Bearer <app-token>
```

**Response `200` (tagihan)**

```json
{
  "success": true,
  "data": {
    "id": 10,
    "vendor": "okeconnect",
    "external_id": "okc-bill-tagihan-pdam-jawa-barat-dan-jakarta",
    "category": "Tagihan Air",
    "name": "PDAM Jawa Barat dan Jakarta",
    "brand": "PDAM",
    "icon": null,
    "image": null,
    "is_active": true,
    "is_featured": false,
    "product_type": "postpaid",
    "is_postpaid": true,
    "variants": [
      {
        "id": "42",
        "db_id": 42,
        "product_id": 10,
        "sku": null,
        "name": "PDAM Kota Bandung",
        "price": 0,
        "admin_fee": 2500,
        "stock": 9999,
        "order_process": "auto",
        "required_fields": [
          {
            "key": "customer_number",
            "label": "Nomor Pelanggan / ID Meter",
            "type": "text",
            "required": true
          }
        ],
        "validation": {
          "available": true,
          "type": "bill_inquiry"
        },
        "provider_meta": {
          "postpaid": true
        },
        "note": ""
      }
    ]
  }
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `404` | `{ "success": false, "code": "PRODUCT_NOT_FOUND", "error": "Produk tidak ditemukan." }` | Produk tidak ada/nonaktif/tidak tersedia untuk app |
| `500` | `{ "success": false, "code": "PRODUCT_LOOKUP_FAILED", "error": "Gagal memuat produk." }` | Gagal query produk |
| `500` | `{ "success": false, "code": "PRODUCT_DETAIL_FAILED", "error": "Gagal memuat produk." }` | Kesalahan server |

### `POST /products/validate`

Validasi ID game / e-wallet sebelum checkout. Endpoint ini **tidak** memakai
envelope `{ success, data }`; periksa `valid` dan HTTP status.

**Request**

```http
POST /api/mobile/products/validate
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "product_id": 123,
  "variant_id": "D10",
  "customer_id": "08123456789",
  "zone_id": "1234"
}
```

**Body**

| Field | Wajib | Keterangan |
|---|---|---|
| `product_id` | disarankan | ID internal atau `external_id` produk |
| `variant_id` | disarankan | `variants[].id` dari katalog; alias `item_id` |
| `customer_id` | ya | User ID / nomor tujuan |
| `zone_id` | kondisional | Zone/Server ID untuk game tertentu |
| `product_name`, `brand`, `category`, `vendor` | tidak | Override opsional |

**Response `200` (validasi tersedia)**

```json
{
  "valid": true,
  "account_name": "BUDI SANTOSO",
  "display_name": "BUDI SANTOSO"
}
```

**Response `200` (produk tidak butuh validasi)**

```json
{
  "valid": true,
  "validation_available": false,
  "account_name": "08123456789",
  "display_name": "08123456789",
  "message": "Produk ini tidak memerlukan validasi ID"
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "error": "customer_id / Target ID wajib diisi" }` | `customer_id` kosong |
| `400` | `{ "error": "Produk tagihan harus dicek melalui alur inquiry tagihan." }` | `product_id` adalah produk postpaid |
| `400` | `{ "error": "Nomor tujuan e-wallet tidak boleh mengandung huruf. Masukkan nomor HP yang valid (contoh: 08123456789)" }` | Format e-wallet salah |
| `400` | `{ "error": "Format nomor e-wallet tidak valid. Harus diawali 08 dengan 10-14 digit angka." }` | Format e-wallet salah |
| `400` | `{ "error": "ID Akun tujuan tidak valid atau tidak ditemukan.", "errors": ... }` | Vendor menolak ID |
| `404` | `{ "error": "Produk tidak ditemukan" }` | Produk tidak ada/tidak tersedia untuk app |
| `400` | `{ "error": "Vendor '...' tidak ditemukan" }` | Vendor tidak terdaftar |
| `500` | `{ "error": "Gagal memvalidasi akun" }` | Kesalahan server |

**Catatan**

- Untuk e-wallet, nomor dinormalisasi ke format `08...`.
- Untuk **Token PLN**, `customer_id` adalah No. Meter / ID Pelanggan (6-20 digit).
  Nilainya **tidak** dinormalisasi seperti nomor HP, karena meter ID bisa diawali
  `62` atau `8`. Validasi memakai inquiry `CEKPLN` dan balasannya berisi nama
  pelanggan beserta tarif/daya, mis. `BUDI SANTOSO (R1/900VA)`.
- Jika varian tidak memerlukan validasi (`validation.available = false`), server
  langsung membalas `valid: true` tanpa memanggil vendor.
- Untuk produk tagihan, gunakan `POST /bills/inquiry`, bukan endpoint ini.

### Produk Token PLN (khusus app)

Produk token listrik PLN prabayar dari vendor OkeConnect. **Hanya tersedia di
app** (`available_channels = ["app"]`), tidak muncul di katalog web.

| Field | Nilai |
|---|---|
| `name` | `Token PLN (OkeConnect)` |
| `external_id` | `okc-token-pln` |
| `category` | `Token PLN` |
| `product_type` | `prepaid` |
| `brand` | `PLN` |

Varian memakai kode vendor OkeConnect sebagai `sku`/`id` (mis. `PLN20`,
`PLNB100A`, `PLNZ5JT`) dengan nama `Token PLN {nominal} — {rute}`. Rute yang
tersedia: `Reguler`, `H2H Terbaik`, `Promo`, `Full Reply`, `Direct`, `Racikan`.
Nominal mulai dari Rp 5.000 sampai Rp 10.000.000; harga jual = harga vendor +
markup admin.

**Field yang harus diisi**

| `key` | `label` | `type` | Keterangan |
|---|---|---|---|
| `customer_id` | `No. Meter / ID Pelanggan` | `text` | 6-20 digit, tanpa spasi/huruf |

`required_fields` pada varian ini memakai `type: "text"` (bukan `"tel"`), dan
varian selalu punya `validation.available = true`.

**Contoh order**

```json
{
  "type": "prepaid",
  "product_id": "okc-token-pln",
  "variant_id": "PLN20",
  "fields": {
    "customer_id": "51234567890"
  },
  "payment_type": "balance"
}
```

Nomor token listrik dikembalikan di `account_details` (`sn`, `serial_number`,
dan `licenses[0]`) setelah order selesai.

### Model produk & varian

#### Produk (respons `GET /products` dan detail postpaid)

| Field | Tipe | Keterangan |
|---|---|---|
| `id` | number | ID internal produk |
| `vendor` | string | `sekalipay` / `okeconnect` |
| `external_id` | string | ID produk di vendor |
| `category` | string | Kategori tampilan |
| `name` | string | Nama produk |
| `brand` | string \| null | Brand |
| `icon` | string \| null | URL icon |
| `image` | string \| null | URL banner |
| `is_active` | boolean | Status produk |
| `is_featured` | boolean | Tampil di featured |
| `product_type` | string | `prepaid` / `postpaid` |
| `is_postpaid` | boolean | Helper untuk UI |
| `variants` | array | Daftar varian |

#### Varian

| Field | Tipe | Keterangan |
|---|---|---|
| `id` | string | Prepaid: `vendor_variant_id`; postpaid: ID internal varian (string) |
| `db_id` | number | ID internal `product_variants.id` |
| `product_id` | number | ID produk induk |
| `sku` | string \| null | SKU; `null` untuk postpaid |
| `name` | string | Nama varian |
| `price` | number | Harga jual; `0` untuk postpaid |
| `admin_fee` | number | Khusus postpaid: biaya layanan |
| `stock` | number | Stok (`9999` = tersedia) |
| `order_process` | string | Proses order (`auto`, dll.) |
| `required_fields` | array | Field yang harus diisi, `{ key, label, type, required }` |
| `validation` | object | Mis. `{ "available": true }` atau `{ "available": true, "type": "bill_inquiry" }` |
| `provider_meta` | object | Metadata aman; kode vendor sensitif tidak diekspos |
| `note` | string | Catatan varian |

Pada payload produk gabungan (`/home` dan detail prepaid), varian juga memiliki
`sell_price` (sama dengan `price`) dan `vendor`, serta diurutkan dari harga
terendah.

---

## 6. Cek tagihan

### `POST /bills/inquiry`

Cek tagihan ke vendor dan buat quote sementara. Quote inilah yang dipakai untuk
membuat order tagihan.

**Request**

```http
POST /api/mobile/bills/inquiry
Authorization: Bearer <app-token>
Content-Type: application/json

{
  "product_id": 10,
  "variant_id": "42",
  "customer_number": "123456789012"
}
```

**Body**

| Field | Wajib | Keterangan |
|---|---|---|
| `product_id` | ya | ID internal produk tagihan (number) |
| `variant_id` | ya | `variants[].id` dari katalog tagihan (string ID internal) |
| `customer_number` | ya | Nomor pelanggan / ID meter |

**Response `201` (quote baru)**

```json
{
  "success": true,
  "data": {
    "inquiry_id": "9b1d7c2e-4a3f-4e8b-9c1d-2e3f4a5b6c7d",
    "expires_at": "2026-11-09T10:10:00.000Z",
    "product": {
      "id": 10,
      "name": "PLN Bulanan",
      "category": "Tagihan Listrik",
      "product_type": "postpaid"
    },
    "variant": {
      "id": "42",
      "db_id": 42,
      "name": "PLN Pascabayar"
    },
    "customer": {
      "number": "123456789012",
      "name": "BUDI"
    },
    "bill": {
      "period": "NOV 2026",
      "amount": 350000,
      "admin_fee": 2500,
      "total": 352500
    },
    "payment_methods": ["balance"]
  }
}
```

**Response `200` (quote dipakai ulang)**

Jika quote untuk kombinasi user + varian + nomor pelanggan yang sama dibuat
kurang dari 60 detik lalu dan masih berlaku, server mengembalikan quote yang sama
dengan `reused: true`:

```json
{
  "success": true,
  "reused": true,
  "data": {
    "inquiry_id": "9b1d7c2e-4a3f-4e8b-9c1d-2e3f4a5b6c7d",
    "expires_at": "2026-11-09T10:10:00.000Z",
    "product": {
      "id": 10,
      "name": "PLN Bulanan",
      "category": "Tagihan Listrik",
      "product_type": "postpaid"
    },
    "variant": {
      "id": "42",
      "db_id": 42,
      "name": "PLN Pascabayar"
    },
    "customer": {
      "number": "123456789012",
      "name": "BUDI"
    },
    "bill": {
      "period": "NOV 2026",
      "amount": 350000,
      "admin_fee": 2500,
      "total": 352500
    },
    "payment_methods": ["balance"]
  }
}
```

**Aturan**

- Quote berlaku **10 menit**.
- Tagihan hanya bisa dibayar dengan saldo (`payment_methods: ["balance"]`).
- `bill.amount` = total tagihan dari vendor; `bill.admin_fee` = biaya layanan
  aplikasi; `bill.total` = `amount + admin_fee`.
- Nominal tidak boleh diubah client. Order tagihan hanya mengirim `inquiry_id`.
- Satu quote hanya bisa dipakai sekali.
- Satu user + varian + nomor pelanggan hanya boleh punya satu quote `open`.
- Sebelum quote dibuat, backend mengecek saldo vendor. Jika kurang, quote ditolak
  `VENDOR_BALANCE_LOW`.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `403` | `{ "success": false, "code": "SHOP_CLOSED", "error": "Toko sedang tutup. Silakan coba lagi nanti." }` | Toko tutup |
| `403` | `{ "success": false, "code": "ACCOUNT_INACTIVE", "error": "Akun tidak ditemukan atau tidak aktif." }` | Akun nonaktif |
| `400` | `{ "success": false, "code": "PRODUCT_AND_VARIANT_REQUIRED", "error": "product_id dan variant_id wajib diisi." }` | Field kosong |
| `400` | `{ "success": false, "code": "CUSTOMER_NUMBER_REQUIRED", "error": "Nomor pelanggan / ID meter wajib diisi." }` | Nomor kosong |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_FOUND", "error": "Produk tagihan tidak ditemukan." }` | Produk tidak ada |
| `404` | `{ "success": false, "code": "VARIANT_NOT_FOUND", "error": "Varian tagihan tidak ditemukan." }` | Varian tidak ada |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_AVAILABLE", "error": "Produk tagihan tidak tersedia di aplikasi." }` | Produk tidak untuk channel app |
| `400` | `{ "success": false, "code": "NOT_POSTPAID", "error": "Produk ini bukan produk tagihan." }` | Produk prepaid |
| `400` | `{ "success": false, "code": "VARIANT_INACTIVE", "error": "Varian tagihan sedang tidak aktif." }` | Varian nonaktif/hidden |
| `422` | `{ "success": false, "code": "BILL_NOT_CONFIGURED", "error": "Konfigurasi tagihan belum lengkap." }` | `provider_meta` tidak lengkap |
| `501` | `{ "success": false, "code": "BILL_VENDOR_UNSUPPORTED", "error": "Vendor tagihan belum mendukung inquiry." }` | Vendor tidak punya `inquireBill` |
| `422` | `{ "success": false, "code": "BILL_INQUIRY_FAILED", "error": "Tagihan tidak ditemukan. Periksa kembali nomor pelanggan." }` | Vendor menolak inquiry |
| `422` | `{ "success": false, "code": "BILL_AMOUNT_INVALID", "error": "Nominal tagihan tidak valid." }` | Nominal tagihan <= 0 |
| `503` | `{ "success": false, "code": "VENDOR_BALANCE_LOW", "error": "Saldo server tagihan sedang diisi. Silakan coba beberapa saat lagi." }` | Saldo vendor kurang |
| `500` | `{ "success": false, "code": "BILL_INQUIRY_SAVE_FAILED", "error": "Gagal menyimpan hasil cek tagihan." }` | Gagal simpan quote |
| `500` | `{ "success": false, "code": "BILL_INQUIRY_FAILED", "error": "Gagal mengecek tagihan." }` | Kesalahan server |

---

## 7. Order

### `POST /orders` — prepaid

Membuat order prepaid (top-up game, e-wallet, pulsa, dll.). Nominal selalu
dihitung server-side.

**Header**

```http
Authorization: Bearer <app-token>
Idempotency-Key: 4b1c9e2a-7d3f-4a8b-9c1d-2e3f4a5b6c7d
Content-Type: application/json
```

**Request — bayar saldo**

```http
POST /api/mobile/orders
Authorization: Bearer <app-token>
Idempotency-Key: 4b1c9e2a-7d3f-4a8b-9c1d-2e3f4a5b6c7d
Content-Type: application/json

{
  "type": "prepaid",
  "product_id": 123,
  "variant_id": "D10",
  "fields": {
    "customer_id": "08123456789",
    "zone_id": "1234"
  },
  "payment_type": "balance"
}
```

**Request — bayar gateway (QRIS)**

```http
POST /api/mobile/orders
Authorization: Bearer <app-token>
Idempotency-Key: 4b1c9e2a-7d3f-4a8b-9c1d-2e3f4a5b6c7d
Content-Type: application/json

{
  "type": "prepaid",
  "product_id": 123,
  "variant_id": "D10",
  "fields": {
    "customer_id": "08123456789",
    "zone_id": "1234"
  },
  "payment_type": "gateway"
}
```

**Body**

| Field | Wajib | Keterangan |
|---|---|---|
| `type` | tidak | Default `prepaid`; isi `bill` untuk tagihan |
| `product_id` | kondisional | ID internal atau `external_id`; wajib jika `variant_id` tidak bisa resolve produk |
| `variant_id` | kondisional | `variants[].id` dari katalog; alias `sku` |
| `sku` | kondisional | Alternatif `variant_id` |
| `fields.customer_id` | ya* | Target / User ID / nomor tujuan |
| `fields.zone_id` | kondisional | Zone/Server ID untuk game tertentu |
| `fields.provider_qty` | kondisional | Nominal untuk varian open denom |
| `payment_type` | tidak | `balance` (default) atau `gateway` |

\* Target bisa juga dikirim sebagai `fields.user_id`, `fields.target`,
`fields.note`, atau di top-level `customer_id`/`user_id`/`note`. Urutan prioritas:
`fields.customer_id` → `fields.user_id` → `fields.target` → `fields.note` →
top-level `customer_id` → `user_id` → `note`.

**Response `201` — saldo**

```json
{
  "success": true,
  "data": {
    "order_id": "NX-M3XK9A-7F2Q1",
    "access_token": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
    "amount": 51000,
    "status": "PROCESSING",
    "pg_provider": "balance",
    "payment_type": "balance"
  }
}
```

**Response `201` — gateway**

```json
{
  "success": true,
  "data": {
    "order_id": "NX-M3XK9A-7F2Q2",
    "access_token": "b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1",
    "invoice": "inv_9f8e7d6c5b4a",
    "amount": 51000,
    "unique_code": 37,
    "fee": 0,
    "total": 51037,
    "payment_code": "QRIS",
    "payment_link": "https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=...",
    "qr_link": "https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=...",
    "status": "PENDING",
    "pg_provider": "dyqris",
    "payment_type": "gateway"
  }
}
```

**Response `200` — replay idempotent**

Jika `Idempotency-Key` sudah pernah dipakai, server mengembalikan order lama:

```json
{
  "success": true,
  "idempotent": true,
  "data": {
    "order_id": "NX-M3XK9A-7F2Q1",
    "access_token": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
    "amount": 51000,
    "status": "COMPLETED",
    "payment_type": "balance",
    "pg_provider": "balance",
    "product": "Mobile Legends",
    "variant": "10 Diamonds",
    "created_at": "2026-11-09T10:00:00.000Z"
  }
}
```

Untuk replay order gateway, `data` juga berisi `invoice`, `unique_code`, `fee`,
`total`, `payment_code`, `payment_link`, dan `qr_link`.

**Catatan**

- `amount`, `email`, `wa_number`, `product_name`, dan `variant_name` tidak dikirim
  client. `email` dan `wa_number` diambil dari `user_profiles`.
- `payment_type` hanya `"gateway"` yang dianggap gateway; nilai lain (termasuk
  `"qris"`) diperlakukan sebagai `"balance"`. Gunakan `"gateway"` untuk QRIS.
- Prepaid mendukung `payment_type: "balance"` atau `"gateway"`.
- `provider_qty` wajib untuk varian open denom. Nominal order =
  `ceil(provider_qty + sell_price)`.
- Minimal pembayaran Rp 1.000.
- Order saldo: saldo didebit dulu, order disimpan, lalu fulfillment vendor
  dijalankan async. Respons awal `PROCESSING`.
- Order gateway: invoice dibuat di gateway aktif (`dyqris` default, `sekalipay`,
  atau `fincloud` legacy), order disimpan `PENDING`.
- `access_token` adalah token akses order (64 hex). Untuk endpoint mobile,
  kepemilikan cukup dibuktikan dengan JWT; token ini berguna jika memakai
  `X-Order-Token`.
- `expired_at` tidak dikembalikan oleh endpoint create. Ambil `pg_expired_at`
  dari `GET /orders/:id` atau polling status.
- `unique_code` adalah kode unik yang dikembalikan backend. `fee` adalah fee
  gateway. `total` adalah nominal yang harus dibayar dan sudah memperhitungkan
  kode unik/fee gateway jika ada.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `403` | `{ "success": false, "code": "SHOP_CLOSED", "error": "Toko sedang tutup..." }` | Toko tutup |
| `403` | `{ "success": false, "code": "ACCOUNT_INACTIVE", "error": "Akun tidak ditemukan atau tidak aktif." }` | Akun nonaktif |
| `400` | `{ "success": false, "code": "PROFILE_INCOMPLETE", "error": "Lengkapi email dan nomor telepon di profil terlebih dahulu." }` | Profil belum lengkap |
| `400` | `{ "success": false, "code": "VARIANT_REQUIRED", "error": "variant_id / sku wajib diisi" }` | Tidak ada varian/produk |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_FOUND", "error": "Produk tidak ditemukan atau sedang tidak aktif" }` | Produk tidak ada/nonaktif |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_AVAILABLE", "error": "Produk tidak tersedia di aplikasi" }` | Produk bukan channel app |
| `400` | `{ "success": false, "code": "USE_BILL_FLOW", "error": "Produk tagihan harus dibuat melalui alur inquiry tagihan" }` | `product_id` postpaid dikirim ke flow prepaid |
| `400` | `{ "success": false, "code": "VENDOR_UNSUPPORTED", "error": "Vendor '...' tidak didukung" }` | Vendor tidak terdaftar |
| `404` | `{ "success": false, "code": "VARIANT_NOT_FOUND", "error": "Varian produk tidak ditemukan atau sedang tidak aktif" }` | Varian tidak ada/nonaktif/hidden |
| `500` | `{ "success": false, "code": "PRODUCT_LOOKUP_FAILED", "error": "Gagal memuat produk" }` | Gagal query produk |
| `500` | `{ "success": false, "code": "VARIANT_LOOKUP_FAILED", "error": "Gagal memuat varian produk" }` | Gagal query varian |
| `400` | `{ "success": false, "code": "TARGET_REQUIRED", "error": "Target / User ID wajib diisi." }` | Target kosong |
| `400` | `{ "success": false, "code": "PROVIDER_QTY_REQUIRED", "error": "Nominal (provider_qty) wajib diisi untuk produk ini" }` | Open denom tanpa nominal |
| `400` | `{ "success": false, "code": "PROVIDER_QTY_MIN", "error": "Nominal minimal adalah 10000" }` | Nominal di bawah minimum |
| `400` | `{ "success": false, "code": "PROVIDER_QTY_MAX", "error": "Nominal maksimal adalah 10000000" }` | Nominal di atas maksimum |
| `400` | `{ "success": false, "code": "AMOUNT_TOO_LOW", "error": "Minimal pembayaran Rp 1.000" }` | Nominal < 1000 |
| `503` | `{ "success": false, "code": "VENDOR_BALANCE_LOW", "error": "Saldo server sedang dalam pengisian. Silakan coba beberapa saat lagi." }` | Saldo vendor OkeConnect kurang |
| `400` | `{ "success": false, "code": "VENDOR_STOCK_EMPTY", "error": "Stok varian ini sedang habis. Silakan coba lagi nanti." }` | Stok vendor habis |
| `400` | `{ "success": false, "code": "INVALID_TARGET", "error": "Format nomor e-wallet tidak valid..." }` | Format e-wallet salah |
| `400` | `{ "success": false, "code": "TARGET_INVALID", "error": "ID Akun tujuan tidak valid atau tidak ditemukan." }` | Validasi vendor gagal |
| `400` | `{ "success": false, "code": "VARIANT_INACTIVE", "error": "Varian produk ini sedang tidak aktif di penyedia..." }` | Varian nonaktif di vendor |
| `400` | `{ "success": false, "code": "INSUFFICIENT_BALANCE", "error": "Saldo tidak mencukupi atau terjadi kesalahan" }` | Saldo user kurang |
| `500` | `{ "success": false, "code": "ORDER_INSERT_FAILED", "error": "Gagal menyimpan order" }` | Gagal simpan order |
| `502` | `{ "success": false, "code": "PG_CREATE_FAILED", "error": "Gagal membuat pembayaran Dyqris: ..." }` | Gateway gagal membuat invoice |
| `500` | `{ "success": false, "code": "PG_UNKNOWN", "error": "Payment gateway tidak dikenali" }` | Gateway tidak dikenal |
| `500` | `{ "success": false, "code": "ORDER_CREATE_FAILED", "error": "Gagal membuat pembayaran" }` | Kesalahan server |

### `POST /orders` — tagihan

Membuat order tagihan dari quote `inquiry_id`. Nominal diambil dari quote, bukan
dari client.

**Request**

```http
POST /api/mobile/orders
Authorization: Bearer <app-token>
Idempotency-Key: 5c2d0f3b-8e4a-4b9c-0d2e-3f4a5b6c7d8e
Content-Type: application/json

{
  "type": "bill",
  "inquiry_id": "9b1d7c2e-4a3f-4e8b-9c1d-2e3f4a5b6c7d",
  "payment_type": "balance"
}
```

**Body**

| Field | Wajib | Keterangan |
|---|---|---|
| `type` | ya | Harus `bill` |
| `inquiry_id` | ya | `inquiry_id` dari `POST /bills/inquiry` |
| `payment_type` | tidak | Tagihan selalu `balance`; nilai lain diabaikan |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "order_id": "NX-M3XK9A-7F2Q3",
    "access_token": "c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2",
    "amount": 352500,
    "status": "PROCESSING",
    "payment_type": "balance",
    "pg_provider": "balance"
  }
}
```

**Response `200` — replay idempotent**

```json
{
  "success": true,
  "idempotent": true,
  "data": {
    "order_id": "NX-M3XK9A-7F2Q3",
    "access_token": "c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2",
    "amount": 352500,
    "status": "PROCESSING",
    "payment_type": "balance",
    "pg_provider": "balance"
  }
}
```

**Catatan**

- `create_bill_order` melakukan semuanya dalam satu transaksi database:
  validasi quote → debit saldo → insert order → tandai quote `used`.
- Quote harus `open`, belum kedaluwarsa, dan milik user.
- `BILL_AMOUNT_MISMATCH` adalah pengaman internal jika nominal order tidak sama
  dengan quote.
- Fulfillment vendor dijalankan async setelah order dibuat.
- Idempotency key yang sama mengembalikan order yang sama tanpa debit ulang.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `403` | `{ "success": false, "code": "SHOP_CLOSED", "error": "Toko sedang tutup..." }` | Toko tutup |
| `403` | `{ "success": false, "code": "ACCOUNT_INACTIVE", "error": "Akun tidak ditemukan atau tidak aktif." }` | Akun nonaktif |
| `400` | `{ "success": false, "code": "INQUIRY_ID_REQUIRED", "error": "inquiry_id wajib diisi." }` | `inquiry_id` kosong |
| `404` | `{ "success": false, "code": "BILL_INQUIRY_NOT_FOUND", "error": "Tagihan tidak ditemukan." }` | Quote tidak ada / bukan milik user |
| `409` | `{ "success": false, "code": "BILL_INQUIRY_ALREADY_USED", "error": "Tagihan ini sudah diproses." }` | Quote sudah dipakai |
| `400` | `{ "success": false, "code": "BILL_INQUIRY_EXPIRED", "error": "Tagihan sudah kedaluwarsa. Silakan cek ulang." }` | Quote kedaluwarsa |
| `409` | `{ "success": false, "code": "BILL_AMOUNT_MISMATCH", "error": "Nominal tagihan berubah. Silakan cek ulang." }` | Nominal tidak cocok |
| `400` | `{ "success": false, "code": "INSUFFICIENT_BALANCE", "error": "Saldo tidak mencukupi." }` | Saldo user kurang |
| `403` | `{ "success": false, "code": "USER_NOT_FOUND", "error": "Akun tidak ditemukan atau tidak aktif." }` | Akun nonaktif |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_FOUND", "error": "Produk tagihan tidak ditemukan." }` | Produk hilang |
| `404` | `{ "success": false, "code": "PRODUCT_NOT_AVAILABLE", "error": "Produk tagihan tidak tersedia di aplikasi." }` | Produk tidak untuk app |
| `400` | `{ "success": false, "code": "NOT_POSTPAID", "error": "Produk ini bukan produk tagihan." }` | Produk berubah jadi prepaid |
| `400` | `{ "success": false, "code": "VARIANT_INACTIVE", "error": "Varian tagihan sedang tidak aktif." }` | Varian nonaktif |
| `400` | `{ "success": false, "code": "PROFILE_INCOMPLETE", "error": "Lengkapi email dan nomor telepon di profil terlebih dahulu." }` | Profil belum lengkap |
| `503` | `{ "success": false, "code": "VENDOR_BALANCE_LOW", "error": "Saldo server tagihan sedang diisi. Silakan coba beberapa saat lagi." }` | Saldo vendor kurang |
| `500` | `{ "success": false, "code": "BILL_ORDER_FAILED", "error": "Gagal membuat order tagihan." }` | Kesalahan server |
| `500` | `{ "success": false, "code": "BILL_ORDER_NOT_FOUND", "error": "Order tagihan tidak ditemukan setelah dibuat." }` | Order hilang setelah RPC |

### `GET /orders`

Riwayat order milik user yang sedang login (berdasarkan `user_id`, bukan email
atau nomor HP).

**Request**

```http
GET /api/mobile/orders?page=1&limit=20&status=ALL
Authorization: Bearer <app-token>
```

**Query**

| Parameter | Default | Keterangan |
|---|---|---|
| `page` | `1` | Halaman |
| `limit` | `20` | Maksimal `100` |
| `status` | semua | Status order; `ALL` atau kosong = semua |

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "NX-M3XK9A-7F2Q1",
      "product": "Mobile Legends",
      "variant": "10 Diamonds",
      "price": 51000,
      "status": "COMPLETED",
      "payment_method": "BALANCE",
      "payment_type": "balance",
      "pg_provider": "balance",
      "pg_paid_at": "2026-11-09T10:00:01.000Z",
      "pg_expired_at": null,
      "error_message": null,
      "account_details": {
        "vendor": "okeconnect",
        "note": "08123456789",
        "target": "08123456789",
        "customer_id": "08123456789",
        "user_id": "08123456789",
        "zone_id": null,
        "sn": "SN-ABC123",
        "serial_number": "SN-ABC123",
        "licenses": ["SN-ABC123"],
        "vendor_status_raw": null,
        "completed_at": "2026-11-09T10:00:30.000Z"
      },
      "timestamp": "2026-11-09T10:00:00.000Z",
      "channel": "android",
      "order_type": "prepaid"
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "limit": 20,
    "total_pages": 1
  }
}
```

**Catatan**

- `account_details` sudah disanitasi: `vendor_ref`, `inquiry_code`,
  `payment_code`, dan `use_inquiry_ref` tidak dikirim ke client.
- `pg_invoice` tidak di-select pada list order; ambil dari detail order atau
  polling status jika membutuhkannya.
- Order tagihan memiliki `order_type: "postpaid"` dan `account_details` berisi
  informasi tagihan (lihat model order).
- `payment_method` berupa `BALANCE` atau `QRIS` (uppercase).
- `channel` untuk order mobile selalu `android`.

**Error `500`**

```json
{
  "success": false,
  "code": "ORDERS_LIST_FAILED",
  "error": "Gagal memuat riwayat pesanan."
}
```

### `GET /orders/:id`

Detail order milik user. Untuk order saldo yang masih diproses, backend melakukan
refresh status ke vendor dengan throttle **30 detik**. Kirim `?force=true` untuk
memaksa refresh.

**Request**

```http
GET /api/mobile/orders/NX-M3XK9A-7F2Q1?force=true
Authorization: Bearer <app-token>
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "NX-M3XK9A-7F2Q1",
    "product": "Mobile Legends",
    "variant": "10 Diamonds",
    "price": 51000,
    "status": "PROCESSING",
    "payment_method": "BALANCE",
    "payment_type": "balance",
    "pg_provider": "balance",
    "pg_invoice": null,
    "pg_paid_at": "2026-11-09T10:00:01.000Z",
    "pg_expired_at": null,
    "error_message": null,
    "account_details": {
      "vendor": "okeconnect",
      "note": "08123456789",
      "target": "08123456789",
      "customer_id": "08123456789",
      "user_id": "08123456789",
      "zone_id": null
    },
    "timestamp": "2026-11-09T10:00:00.000Z",
    "channel": "android",
    "order_type": "prepaid"
  }
}
```

**Catatan**

- Respons memakai `Cache-Control: no-store`.
- `force=true` melewati throttle 30 detik.
- Refresh vendor hanya dilakukan untuk order `payment_type = balance` yang belum
  final dan berstatus `PROCESSING`/`PROCESSING_LOCK`.
- Order `PENDING` belum dikirim ke vendor, jadi tidak di-refresh.
- Endpoint ini dilewati global rate limit, tetapi tetap kena limiter 120/menit/user.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `404` | `{ "success": false, "code": "ORDER_NOT_FOUND", "error": "Pesanan tidak ditemukan." }` | Order tidak ada / bukan milik user |
| `429` | `{ "success": false, "code": "RATE_LIMITED", "error": "Terlalu banyak permintaan status pesanan." }` | Limiter 120/menit/user |
| `500` | `{ "success": false, "code": "ORDER_DETAIL_FAILED", "error": "Gagal memuat pesanan." }` | Kesalahan server |

### `POST /orders/:id/cancel`

Batalkan order. Hanya order berstatus `PENDING` yang bisa dibatalkan.

**Request**

```http
POST /api/mobile/orders/NX-M3XK9A-7F2Q2/cancel
Authorization: Bearer <app-token>
```

**Response `200` — order saldo**

```json
{
  "success": true,
  "message": "Pesanan berhasil dibatalkan dan saldo dikembalikan."
}
```

**Response `200` — order gateway**

```json
{
  "success": true,
  "message": "Pesanan berhasil dibatalkan."
}
```

**Catatan**

- Order saldo: status di-claim ke `REFUND_PENDING`, saldo dikembalikan, lalu
  status menjadi `CANCELLED`.
- Order gateway: untuk FinCloud legacy, invoice dibatalkan best-effort. Untuk
  Dyqris/Sekalipay, backend tidak memanggil cancel API; order langsung ditandai
  `CANCELLED` dan invoice akan kedaluwarsa sendiri.
- Jika refund gagal, respons `500 REFUND_FAILED`; order tetap `REFUND_PENDING`
  dan perlu penanganan CS.

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `404` | `{ "success": false, "code": "ORDER_NOT_FOUND", "error": "Pesanan tidak ditemukan." }` | Order tidak ada / bukan milik user |
| `400` | `{ "success": false, "code": "ORDER_NOT_CANCELLABLE", "error": "Pesanan tidak bisa dibatalkan (status: PROCESSING)." }` | Status bukan `PENDING` |
| `409` | `{ "success": false, "code": "ORDER_NOT_CANCELLABLE", "error": "Pesanan sudah diproses dan tidak bisa dibatalkan." }` | Kalah race dengan fulfillment |
| `500` | `{ "success": false, "code": "REFUND_FAILED", "error": "Refund gagal diproses. Silakan hubungi CS." }` | Refund saldo gagal |
| `500` | `{ "success": false, "code": "ORDER_CANCEL_FAILED", "error": "Gagal membatalkan pesanan." }` | Kesalahan server |

### Polling status

Gunakan endpoint di luar prefix mobile:

```http
GET /api/payments/status/:orderId?force=true
Authorization: Bearer <app-token>
```

Endpoint ini sudah mengecek kepemilikan via JWT (atau `X-Order-Token`) dan tidak
kena global rate limit. Untuk order saldo/tagihan, backend ikut menanyakan status
ke vendor.

**Request**

```http
GET /api/payments/status/NX-M3XK9A-7F2Q1?force=true
Authorization: Bearer <app-token>
```

**Response `200`**

```json
{
  "data": {
    "id": "NX-M3XK9A-7F2Q1",
    "status": "COMPLETED",
    "product": "Mobile Legends",
    "variant": "10 Diamonds",
    "price": 51000,
    "payment_method": "BALANCE",
    "payment_type": "balance",
    "pg_provider": "balance",
    "pg_invoice": null,
    "pg_paid_at": "2026-11-09T10:00:01.000Z",
    "pg_expired_at": null,
    "error_message": null,
    "account_details": {
      "vendor": "okeconnect",
      "note": "08123456789",
      "target": "08123456789",
      "customer_id": "08123456789",
      "user_id": "08123456789",
      "zone_id": null,
      "sn": "SN-ABC123",
      "serial_number": "SN-ABC123",
      "licenses": ["SN-ABC123"],
      "completed_at": "2026-11-09T10:00:30.000Z"
    },
    "user_id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f"
  }
}
```

**Mode slim**

Tambahkan `?view=slim` untuk payload lebih kecil (tanpa email/wa_number/customer_name/user_id):

```http
GET /api/payments/status/NX-M3XK9A-7F2Q1?force=true&view=slim
Authorization: Bearer <app-token>
```

**Catatan**

- `force=true` menurunkan interval pengecekan gateway dari 60 detik menjadi
  minimal 15 detik.
- Untuk order saldo, refresh vendor memakai throttle 30 detik; `force=true`
  melewatinya.
- `view=slim` **tidak** menjalankan refresh vendor untuk order saldo. Gunakan
  mode non-slim jika butuh refresh status order saldo.
- Respons sukses selalu `{ "data": ... }`, bukan `{ success, data }`.
- Order yang bukan milik user dibalas `404` (bukan `403`).

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `404` | `{ "error": "Order tidak ditemukan" }` | Order tidak ada / bukan milik user |
| `500` | `{ "error": "Gagal memeriksa status pesanan" }` | Kesalahan server |
| `429` | `{ "error": "Terlalu banyak request pengecekan status. Harap tunggu sebentar." }` | Limiter 120/menit/IP |

### Status order

| Status | Arti |
|---|---|
| `PENDING` | Order dibuat, belum dibayar/diproses |
| `PROCESSING_LOCK` | Order sudah di-claim fulfillment, sedang dikirim ke vendor |
| `PROCESSING` | Order sedang diproses vendor |
| `COMPLETED` | Order sukses |
| `FAILED` | Order gagal di vendor |
| `CANCELLED` | Order dibatalkan |
| `REFUND_PENDING` | Refund sedang diproses |
| `REFUNDED` | Saldo sudah dikembalikan |

### Model order (respons mobile)

| Field | Tipe | Keterangan |
|---|---|---|
| `id` | string | Order ID (`NX-...`) |
| `product` | string | Nama produk |
| `variant` | string | Nama varian |
| `price` | number | Nominal order |
| `status` | string | Status order |
| `payment_method` | string | `BALANCE` / `QRIS` |
| `payment_type` | string | `balance` / `gateway` |
| `pg_provider` | string | `balance`, `dyqris`, `sekalipay`, `fincloud` |
| `pg_invoice` | string \| null | Invoice gateway |
| `pg_paid_at` | string \| null | Waktu bayar |
| `pg_expired_at` | string \| null | Waktu kedaluwarsa invoice |
| `error_message` | string \| null | Pesan error vendor/order |
| `account_details` | object | Detail target; kode vendor sensitif sudah dihapus |
| `timestamp` | string | Waktu order dibuat |
| `channel` | string | `android` untuk order mobile |
| `order_type` | string | `prepaid` / `postpaid` |

`account_details` untuk order prepaid biasanya berisi `vendor`, `note`, `target`,
`customer_id`, `user_id`, `zone_id`, dan `provider_qty` (jika ada). Untuk order
yang sudah selesai, bisa bertambah `sn`, `serial_number`, `licenses`,
`vendor_status_raw`, dan `completed_at`.

Untuk order **Token PLN**, `account_details` juga berisi `target_type: "meter"`
dan `note`/`target` berisi No. Meter dalam bentuk digit saja (tidak pernah
dinormalisasi menjadi nomor HP). Nomor token listrik ada di `sn` /
`serial_number` / `licenses[0]`.

`account_details` untuk order tagihan berisi `type: "postpaid"`, `postpaid: true`,
`vendor`, `target`, `customer_number`, `note`, `customer_name`, `bill_period`,
`bill_amount`, `admin_fee`, `total_amount`, dan `inquiry_id`.

---

## 8. Error codes

### Auth & akses

| Code | HTTP | Arti |
|---|---|---|
| `AUTH_REQUIRED` | `401` | Header Authorization tidak ada |
| `APP_ONLY` | `403` | Token bukan token aplikasi Android |
| `RATE_LIMITED` | `429` | Terlalu banyak request |

### Katalog

| Code | HTTP | Arti |
|---|---|---|
| `CONFIG_FAILED` | `500` | Gagal memuat konfigurasi |
| `HOME_FAILED` | `500` | Gagal memuat beranda |
| `PRODUCTS_FAILED` | `500` | Gagal memuat daftar produk |
| `PRODUCT_NOT_FOUND` | `404` | Produk tidak ditemukan/nonaktif/tidak untuk channel |
| `PRODUCT_LOOKUP_FAILED` | `500` | Gagal query produk |
| `PRODUCT_DETAIL_FAILED` | `500` | Gagal memuat detail produk |

### Cek tagihan

| Code | HTTP | Arti |
|---|---|---|
| `SHOP_CLOSED` | `403` | Toko tutup |
| `ACCOUNT_INACTIVE` | `403` | Akun nonaktif |
| `PRODUCT_AND_VARIANT_REQUIRED` | `400` | `product_id`/`variant_id` kosong |
| `CUSTOMER_NUMBER_REQUIRED` | `400` | Nomor pelanggan kosong |
| `PRODUCT_NOT_FOUND` | `404` | Produk tagihan tidak ada |
| `VARIANT_NOT_FOUND` | `404` | Varian tagihan tidak ada |
| `PRODUCT_NOT_AVAILABLE` | `404` | Produk tidak tersedia untuk app |
| `NOT_POSTPAID` | `400` | Produk bukan tagihan |
| `VARIANT_INACTIVE` | `400` | Varian tagihan nonaktif |
| `BILL_NOT_CONFIGURED` | `422` | Konfigurasi tagihan tidak lengkap |
| `BILL_VENDOR_UNSUPPORTED` | `501` | Vendor belum mendukung inquiry |
| `BILL_INQUIRY_FAILED` | `422`/`500` | Vendor gagal / server gagal cek tagihan |
| `BILL_AMOUNT_INVALID` | `422` | Nominal tagihan tidak valid |
| `VENDOR_BALANCE_LOW` | `503` | Saldo vendor kurang |
| `BILL_INQUIRY_SAVE_FAILED` | `500` | Gagal menyimpan quote |

### Order tagihan

| Code | HTTP | Arti |
|---|---|---|
| `INQUIRY_ID_REQUIRED` | `400` | `inquiry_id` kosong |
| `BILL_INQUIRY_NOT_FOUND` | `404` | Quote tidak ada/bukan milik user |
| `BILL_INQUIRY_ALREADY_USED` | `409` | Quote sudah dipakai |
| `BILL_INQUIRY_EXPIRED` | `400` | Quote kedaluwarsa |
| `BILL_AMOUNT_MISMATCH` | `409` | Nominal order tidak sama dengan quote |
| `INSUFFICIENT_BALANCE` | `400` | Saldo user kurang |
| `USER_NOT_FOUND` | `403` | Akun nonaktif/hilang |
| `BILL_ORDER_FAILED` | `500` | Gagal membuat order tagihan |
| `BILL_ORDER_NOT_FOUND` | `500` | Order tagihan tidak ditemukan setelah dibuat |

### Order prepaid

| Code | HTTP | Arti |
|---|---|---|
| `SHOP_CLOSED` | `403` | Toko tutup |
| `ACCOUNT_INACTIVE` | `403` | Akun nonaktif |
| `PROFILE_INCOMPLETE` | `400` | Email/nomor telepon profil belum lengkap |
| `VARIANT_REQUIRED` | `400` | `variant_id`/`sku` kosong |
| `PRODUCT_NOT_FOUND` | `404` | Produk tidak ditemukan/nonaktif |
| `PRODUCT_NOT_AVAILABLE` | `404` | Produk tidak tersedia untuk app |
| `USE_BILL_FLOW` | `400` | Produk tagihan harus lewat alur inquiry |
| `VENDOR_UNSUPPORTED` | `400` | Vendor tidak terdaftar |
| `VARIANT_NOT_FOUND` | `404` | Varian tidak ditemukan/nonaktif |
| `PRODUCT_LOOKUP_FAILED` | `500` | Gagal query produk |
| `VARIANT_LOOKUP_FAILED` | `500` | Gagal query varian |
| `TARGET_REQUIRED` | `400` | Target/User ID kosong |
| `PROVIDER_QTY_REQUIRED` | `400` | Open denom tanpa nominal |
| `PROVIDER_QTY_MIN` | `400` | Nominal di bawah minimum |
| `PROVIDER_QTY_MAX` | `400` | Nominal di atas maksimum |
| `AMOUNT_TOO_LOW` | `400` | Nominal < Rp 1.000 |
| `VENDOR_BALANCE_LOW` | `503` | Saldo vendor kurang |
| `VENDOR_STOCK_EMPTY` | `400` | Stok vendor habis |
| `INVALID_TARGET` | `400` | Format target/e-wallet salah |
| `TARGET_INVALID` | `400` | Validasi ID ke vendor gagal |
| `VARIANT_INACTIVE` | `400` | Varian nonaktif di vendor |
| `INSUFFICIENT_BALANCE` | `400` | Saldo user kurang |
| `ORDER_INSERT_FAILED` | `500` | Gagal menyimpan order |
| `PG_CREATE_FAILED` | `502` | Gagal membuat invoice gateway |
| `PG_UNKNOWN` | `500` | Gateway tidak dikenal |
| `ORDER_CREATE_FAILED` | `500` | Kesalahan server saat membuat order |

### Order list/detail/cancel

| Code | HTTP | Arti |
|---|---|---|
| `ORDERS_LIST_FAILED` | `500` | Gagal memuat riwayat |
| `ORDER_NOT_FOUND` | `404` | Order tidak ada/bukan milik user |
| `ORDER_DETAIL_FAILED` | `500` | Gagal memuat detail |
| `ORDER_NOT_CANCELLABLE` | `400`/`409` | Status order tidak bisa dibatalkan |
| `REFUND_FAILED` | `500` | Refund saldo gagal |
| `ORDER_CANCEL_FAILED` | `500` | Kesalahan server saat cancel |

---

## 9. Admin terkait

Endpoint admin memakai token admin, bukan token app:

```http
Authorization: Bearer <admin-token>
```

Token admin didapat dari `POST /api/admin/login` dan berlaku 8 jam. Header legacy
`x-admin-token` juga masih diterima.

### `POST /api/admin/login`

**Request**

```http
POST /api/admin/login
Content-Type: application/json

{
  "username": "admin",
  "password": "rahasiaAdmin123"
}
```

**Response `200`**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

Rate limit: 5 percobaan / 15 menit / IP.

### `PATCH /api/admin/products/products/:id/channels`

Atur channel visibilitas produk. Nilai yang valid: `web`, `app`; minimal satu.

**Request**

```http
PATCH /api/admin/products/products/10/channels
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "channels": ["app"]
}
```

**Response `200`**

```json
{
  "success": true,
  "available_channels": ["app"]
}
```

**Error**

| HTTP | Body | Penyebab |
|---|---|---|
| `400` | `{ "error": "ID produk tidak valid" }` | `:id` bukan ID numerik |
| `400` | `{ "error": "channels harus berisi minimal satu dari: web, app" }` | Array kosong/tidak valid |
| `500` | `{ "error": "Gagal memperbarui channel produk" }` | Kesalahan server |

> Catatan: channel produk memakai nilai `app`, sedangkan kolom `orders.channel`
> untuk order mobile memakai nilai `android`.

### `POST /api/admin/products/sync`

Sinkronisasi katalog dari vendor. Untuk produk tagihan gunakan
`vendor: "okeconnect"` dan `product_type: "postpaid"`.

**Request**

```http
POST /api/admin/products/sync
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "vendor": "okeconnect",
  "type": "full",
  "product_type": "postpaid"
}
```

**Body**

| Field | Default | Keterangan |
|---|---|---|
| `vendor` | `sekalipay` | Vendor yang disinkronkan |
| `type` | `full` | `full` atau `delta` |
| `product_type` | `prepaid` | `prepaid` atau `postpaid` |

> Sync prepaid `okeconnect` juga mengambil produk **Token PLN**
> (`external_id: okc-token-pln`, app-only, varian `PLNxxx`). Harga list publik
> OkeConnect sering membalas HTTP 429; adapter mencoba ulang, dan produk yang
> gagal di-refresh tidak dinonaktifkan.

**Response `200`**

```json
{
  "success": true,
  "message": "Sinkronisasi okeconnect postpaid (full) berhasil",
  "vendor": "okeconnect",
  "productType": "postpaid",
  "productsUpserted": 12,
  "variantsUpserted": 45
}
```

**Error `500`**

```json
{
  "success": false,
  "error": "Vendor adapter '...' is not registered"
}
```

### `GET /api/admin/products/sync-status`

**Request**

```http
GET /api/admin/products/sync-status?vendor=okeconnect&product_type=postpaid
Authorization: Bearer <admin-token>
```

**Response `200`**

```json
{
  "success": true,
  "vendor": "okeconnect",
  "product_type": "postpaid",
  "lastSync": {
    "synced_at": "2026-11-09T04:00:00.000Z",
    "type": "full",
    "productCount": 12
  }
}
```

Jika belum pernah sync:

```json
{
  "success": true,
  "vendor": "okeconnect",
  "product_type": "postpaid",
  "lastSync": null
}
```

### `GET /api/orders` (admin)

Daftar order untuk dashboard admin. Mendukung filter channel dan tipe order.

**Request**

```http
GET /api/orders?channel=android&order_type=postpaid&page=1&limit=20&status=ALL
Authorization: Bearer <admin-token>
```

**Query**

| Parameter | Keterangan |
|---|---|
| `page` | Default `1` |
| `limit` | Default `20`, maksimal `100` |
| `search` | Mencari `id` atau `wa_number` |
| `status` | Status order; `ALL` = semua |
| `channel` | `web` atau `android` |
| `order_type` | `prepaid` atau `postpaid` |

**Response `200`**

```json
{
  "orders": [
    {
      "id": "NX-M3XK9A-7F2Q3",
      "product": "PLN Bulanan",
      "variant": "PLN Pascabayar",
      "price": 352500,
      "status": "COMPLETED",
      "payment_method": "BALANCE",
      "payment_type": "balance",
      "channel": "android",
      "order_type": "postpaid",
      "user_id": "6f1c2a3e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
      "account_details": {
        "type": "postpaid",
        "postpaid": true,
        "vendor": "okeconnect",
        "target": "123456789012",
        "customer_number": "123456789012",
        "customer_name": "BUDI",
        "bill_period": "NOV 2026",
        "bill_amount": 350000,
        "admin_fee": 2500,
        "total_amount": 352500,
        "inquiry_id": "9b1d7c2e-4a3f-4e8b-9c1d-2e3f4a5b6c7d"
      },
      "timestamp": "2026-11-09T10:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

> Admin melihat baris order lengkap (termasuk kode vendor di `account_details`).
> Jangan pernah mengirim payload admin ini ke client Android.

---

## 10. Deployment note

Jalankan migration `023_mobile_app.sql` **sebelum** men-deploy kode ini. Kode
channel dan `create_bill_order` membutuhkan kolom/tabel baru.

Migration tersebut menambahkan:

- `products.available_channels` (`TEXT[]`, default `{web,app}`) dan
  `products.product_type` (`prepaid`/`postpaid`).
- `orders.channel`, `orders.order_type`, `orders.idempotency_key`,
  `orders.bill_inquiry_id`.
- Unique partial index `(user_id, idempotency_key)`.
- Tabel `bill_inquiries` + index quote unik per user/varian/nomor.
- Function `create_bill_order(...)` untuk validasi quote + debit saldo + insert
  order + konsumsi quote dalam satu transaksi.

Catatan deployment:

- Produk lama otomatis mendapat `available_channels = {web,app}`.
- Sync postpaid OkeConnect menulis produk dengan channel `{app}`.
- Tanpa migration ini, `GET /products`, `POST /orders`, dan `POST /bills/inquiry`
  akan gagal karena kolom/tabel/RPC belum ada.
- `create_bill_order` wajib ada di database; backend tidak memiliki fallback
  transaksi multi-statement.
- Setelah deploy, jalankan sync postpaid sekali:
  `POST /api/admin/products/sync` dengan
  `{ "vendor": "okeconnect", "type": "full", "product_type": "postpaid" }`.

---

## 11. Catatan implementasi Android

- Simpan `token` di secure storage (EncryptedSharedPreferences/Keystore), bukan
  log biasa.
- Selalu kirim `Authorization: Bearer <app-token>` untuk endpoint mobile.
- Buat `Idempotency-Key` baru (UUID v4) untuk setiap order baru; simpan key yang
  sama saat retry request yang gagal di jaringan.
- Jangan pernah mengirim `amount`, `email`, `wa_number`, `product_name`, atau
  `variant_name`; server menghitung/mengambil semuanya sendiri.
- Gunakan `variants[].id` dari katalog sebagai `variant_id`:
  - prepaid: `vendor_variant_id`
  - postpaid: ID internal varian (string)
- Untuk tagihan, alurnya selalu:
  `GET /products?type=postpaid` → `POST /bills/inquiry` → tampilkan tagihan →
  `POST /orders` dengan `type: "bill"` dan `inquiry_id`.
- Untuk QRIS, kirim `payment_type: "gateway"` (bukan `"qris"`).
- Polling status sebaiknya memakai `GET /api/payments/status/:orderId?force=true`
  dengan backoff (mis. 5s, 10s, 20s, 30s) dan berhenti saat status final.
- Tangani `401` dengan logout + login ulang; tangani `403 APP_ONLY` dengan
  memastikan login lewat endpoint mobile, bukan web.
- `account_details` bisa berisi data akun game (User ID/Zone ID) dan serial
  number. Jangan tampilkan/log data sensitif tanpa kebutuhan.
- `access_token` order bersifat rahasia; jangan bagikan ke pihak lain.
- Untuk pencarian produk tagihan berdasarkan daerah/biller, gunakan
  `GET /products?type=postpaid&search=bandung`.
