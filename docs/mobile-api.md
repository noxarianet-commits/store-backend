# Mobile API — Android App

Base URL: `https://<backend-domain>/api/mobile`

Kontrak ini khusus aplikasi Android. Web tetap memakai `/api/*` tanpa perubahan.

## Autentikasi

- `POST /auth/login` dan `POST /auth/register/verify` menerbitkan JWT dengan claim `client: "android"` (berlaku 30 hari).
- Semua endpoint di bawah ini **wajib** header:

```http
Authorization: Bearer <app-token>
```

- Token web (tanpa claim `client`, atau `client: "web"`) akan ditolak `403 APP_ONLY`.
- Guest checkout tidak tersedia. Semua order memakai `user_id` dari token.
- `Idempotency-Key: <uuid>` wajib untuk `POST /orders` agar retry jaringan tidak membuat order/debit ganda.

## Konfigurasi & health

### `GET /config` (public)

```json
{
  "success": true,
  "data": {
    "min_version": "1.0.0",
    "latest_version": "1.0.0",
    "maintenance": false,
    "features": { "bills": true, "topup": true, "tickets": true },
    "payment_methods": ["balance", "qris"],
    "shop_status": { "isOpen": true, "message": "Selamat datang!" }
  }
}
```

## Auth

| Method | Path | Body |
|---|---|---|
| POST | `/auth/register` | `{ email, phone, display_name, password }` |
| POST | `/auth/register/verify` | `{ email, code }` → token app |
| POST | `/auth/register/resend` | `{ email }` |
| POST | `/auth/login` | `{ email, password }` → token app |
| POST | `/auth/forgot-password` | `{ email }` |
| POST | `/auth/forgot-password/verify` | `{ email, code, new_password }` |
| POST | `/auth/forgot-password/resend` | `{ email }` |

## Profil & saldo

| Method | Path | Keterangan |
|---|---|---|
| GET | `/me` | Profil + saldo |
| PUT | `/me` | `{ display_name?, phone? }` |
| PUT | `/me/password` | `{ current_password, new_password }` |
| GET/POST | `/api/balance/*` | Top-up dan riwayat saldo (token app tetap diterima) |

## Katalog

### `GET /home`

Kategori prepaid dan tagihan, featured, testimoni, quick actions.

### `GET /products?type=prepaid|postpaid&category=&search=&page=&per_page=`

Produk yang tersedia untuk channel `app`. Produk tagihan hanya muncul di sini.

- Produk prepaid: `variants[].id` = ID varian vendor.
- Produk tagihan: `variants[].id` = ID internal (kode vendor tidak diekspos), `admin_fee` = biaya layanan.
- Produk tagihan dikelompokkan per grup biller OkeConnect (mis. `PDAM Jawa Barat dan Jakarta`, `PBB Sumatera`), dan `variants[]` berisi biller/daerah di grup tersebut (mis. `PDAM Kota Jakarta Aetra`, `PDAM Kota Bandung`). `search` pada produk tagihan juga mencocokkan nama varian, jadi `search=bandung` tetap menemukan produk PDAM yang benar.

### `GET /products/:id`

Detail produk. Produk tagihan mengembalikan `product_type: "postpaid"`.

### `POST /products/validate`

Validasi ID game / e-wallet sebelum checkout.

```json
{
  "product_id": 123,
  "variant_id": "D10",
  "customer_id": "08123456789",
  "zone_id": "1234"
}
```

## Cek tagihan

### `POST /bills/inquiry`

```json
{
  "product_id": 10,
  "variant_id": "42",
  "customer_number": "123456789012"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "inquiry_id": "0f2c...",
    "expires_at": "2026-11-02T10:10:00.000Z",
    "product": { "id": 10, "name": "PLN Bulanan", "category": "Tagihan Listrik" },
    "variant": { "id": "42", "name": "PLN Pascabayar" },
    "customer": { "number": "123456789012", "name": "BUDI" },
    "bill": { "period": "NOV 2026", "amount": 350000, "admin_fee": 0, "total": 350000 },
    "payment_methods": ["balance"]
  }
}
```

- Quote berlaku 10 menit.
- Tagihan hanya bisa dibayar dengan saldo.
- Nominal tidak boleh diubah client; order memakai `inquiry_id`.

## Order

### `POST /orders`

Header:

```http
Authorization: Bearer <app-token>
Idempotency-Key: 4b1c...
```

Prepaid:

```json
{
  "type": "prepaid",
  "product_id": 123,
  "variant_id": "D10",
  "fields": {
    "customer_id": "08123456789",
    "zone_id": "1234",
    "provider_qty": 50000
  },
  "payment_type": "balance"
}
```

Tagihan:

```json
{
  "type": "bill",
  "inquiry_id": "0f2c...",
  "payment_type": "balance"
}
```

Catatan:

- `amount`, `email`, `wa_number`, `product_name`, dan `variant_name` tidak dikirim client.
- `email` dan `wa_number` diambil dari `user_profiles`.
- Prepaid mendukung `payment_type: "balance"` atau `"gateway"`.
- Tagihan hanya `"balance"`.
- `provider_qty` wajib untuk varian open denom.

Response prepaid balance:

```json
{
  "success": true,
  "data": {
    "order_id": "NX-...",
    "access_token": "...",
    "amount": 51000,
    "status": "PROCESSING",
    "payment_type": "balance",
    "pg_provider": "balance"
  }
}
```

Response gateway menyertakan `invoice`, `payment_link`, `qr_link`, `total`, `expired_at`.

### `GET /orders?page=&limit=&status=`

Riwayat berdasarkan `user_id` (bukan email/nomor HP).

### `GET /orders/:id`

Detail order milik user. Untuk order saldo yang masih diproses, backend melakukan refresh status vendor dengan throttle 30 detik.

### `POST /orders/:id/cancel`

Hanya order `PENDING`. Order saldo otomatis direfund ke saldo.

### Polling status

Gunakan:

```http
GET /api/payments/status/:orderId?force=true
```

Endpoint ini sudah mengecek kepemilikan via JWT dan tidak terkena global rate limit. Untuk order saldo/tagihan, backend ikut menanyakan status ke vendor.

## Error codes

| Code | Arti |
|---|---|
| `APP_ONLY` | Token bukan token aplikasi |
| `PRODUCT_NOT_AVAILABLE` | Produk tidak tersedia untuk channel |
| `VARIANT_REQUIRED` | `variant_id` / `sku` kosong |
| `TARGET_REQUIRED` | Target/ID pelanggan kosong |
| `TARGET_INVALID` | Validasi ID gagal |
| `INSUFFICIENT_BALANCE` | Saldo kurang |
| `VENDOR_BALANCE_LOW` | Saldo server vendor kurang |
| `BILL_INQUIRY_EXPIRED` | Quote tagihan kedaluwarsa |
| `BILL_INQUIRY_ALREADY_USED` | Quote sudah dipakai |
| `BILL_AMOUNT_MISMATCH` | Nominal tagihan berubah |
| `BILL_INQUIRY_FAILED` | Cek tagihan gagal |
| `ORDER_NOT_CANCELLABLE` | Status order tidak bisa dibatalkan |
| `RATE_LIMITED` | Terlalu banyak request |

## Admin terkait

| Method | Path | Body |
|---|---|---|
| PATCH | `/api/admin/products/products/:id/channels` | `{ channels: ["web","app"] }` |
| POST | `/api/admin/products/sync` | `{ vendor: "okeconnect", type: "full", product_type: "postpaid" }` |
| GET | `/api/admin/products/sync-status?vendor=okeconnect&product_type=postpaid` | - |
| GET | `/api/orders?channel=android&order_type=postpaid` | - |

## Deployment note

Jalankan migration `023_mobile_app.sql` **sebelum** men-deploy kode ini. Kode channel dan `create_bill_order` membutuhkan kolom/tabel baru.
