---

### Base URL & Autentikasi

- **Base URL:** `https://sekalipay.com/api`
- **API Key:** Setiap request wajib menyertakan header `X-APIKEY` dengan API Key reseller. Header `Accept: application/json` juga wajib, dan `Content-Type: application/json` untuk request POST/PUT.
- **IP Whitelist:** Hanya IP yang terdaftar di dashboard reseller yang dapat mengakses API.
- **Error Autentikasi Umum:**
    - `401 INVALID_API_KEY` → API Key tidak valid.
    - `401 ACCOUNT_MUST_BE_RESELLER` → Akun bukan reseller.
    - `401 INVALID_IP` → IP tidak terdaftar.
    - `403 THE_ACCOUNT_HAS_BEEN_SUSPENDED` → Akun disuspend.

---

### Format Umum

- **Auth Header:** `X-APIKEY: sk_live_xxxxx`
- **Content-Type:** `application/json` (untuk POST/PUT)
- **Response Sukses:** `{ "message": "OK", "data": ... }`
- **Response Error:** `{ "message": "ERROR_CODE", "errors": { "field_name": ["deskripsi"] } }`

---

### Daftar Endpoint dengan Contoh

#### 1. Cek Saldo
- **GET** `/v1/balance`
- **Contoh Request:**
  ```bash
  curl --request GET \
    --url https://sekalipay.com/api/v1/balance \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response (Sukses):**
  ```json
  {
    "message": "OK",
    "data": {
      "balance": 1250000
    }
  }
  ```

#### 2. Top Up Saldo
- **POST** `/v1/balance`
- **Request Body:**
    - `amount` (integer, required) – minimal 10.000.
    - `channel` (string, required) – kode channel dari endpoint `/v1/balance/channels`.
- **Contoh Request:**
  ```bash
  curl --request POST \
    --url https://sekalipay.com/api/v1/balance \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Content-Type: application/json' \
    --data '{
      "amount": 100000,
      "channel": "QRIS"
    }'
  ```
- **Contoh Response:**
  ```json
  {
    "message": "OK",
    "data": {
      "payment_url": "https://payment.sekalipay.com/pay/INV12345",
      "amount": 100000,
      "expires_at": "2026-05-11T18:00:00+07:00"
    }
  }
  ```

#### 3. List Payment Channels
- **GET** `/v1/balance/channels`
- **Contoh Request:**
  ```bash
  curl --request GET \
    --url https://sekalipay.com/api/v1/balance/channels \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response:**
  ```json
  {
    "message": "OK",
    "data": [
      { "code": "QRIS", "name": "QRIS", "fee": 750, "min_amount": 10000, "max_amount": 5000000 },
      { "code": "VA_BCA", "name": "VA BCA", "fee": 4000, "min_amount": 50000, "max_amount": 10000000 }
    ]
  }
  ```

#### 4. List Semua Item (Produk)
- **GET** `/v1/item`
- **Query Parameters:**
    - `page` (integer, optional)
    - `per_page` (integer/string, optional) – default 100, max 500, atau `"all"`.
    - `updated_since` (string, optional) – timestamp ISO 8601 untuk delta sync.
    - `category` (string, optional)
    - `search` (string, optional)
- **Contoh Request (ambil semua item):**
  ```bash
  curl --request GET \
    --url 'https://sekalipay.com/api/v1/item?per_page=all' \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response (dipangkas):**
  ```json
  {
      "message": "OK",
      "data": [
        {
          "id": 1,
          "name": "Aplikasi Premium",
          "icon": "app-icon.png",
          "products": [
            {
              "id": 10,
              "name": "Gemini Advanced",
              "image": "gemini.png",
              "variants": [
                {
                  "id": 3342,
                  "sku": "GA-1BAB",
                  "name": "12 Bulan",
                  "price": 6000,
                  "order_process": "h2h",
                  "h2h_provider": "h2h",
                  "provider_meta": {
                    "open_denom": true,
                    "min_qty": 10000,
                    "max_qty": 10000000,
                    "step_qty": 1,
                    "qty_label": "Nominal"
                  },
                  "required_fields": [
                    {
                      "key": "note",
                      "label": "User ID",
                      "required": true
                    },
                    {
                      "key": "provider_qty",
                      "label": "Nominal",
                      "required": true,
                      "min": 10000,
                      "max": 10000000
                    }
                  ],
                  "validation": {
                    "available": true,
                    "endpoint": "/api/v1/item/validate",
                    "requires_zone_id": true,
                    "fields": [
                      { "key": "customer_id", "label": "User ID", "required": true },
                      { "key": "zone_id", "label": "Server ID", "required": true }
                    ]
                  },
                  "stock": 50,
                  "updated_at": "2026-02-26T14:01:10.000000Z"
                }
              ]
            }
          ]
        }
      ],
      "meta": {
        "total_items": 2891,
        "is_delta": false
      },
      "server_time": "2026-02-26T22:00:00+07:00"
    }
  ```
> **Catatan:** Selalu gunakan `variant.id` (misal 101) sebagai `item_id` pada transaksi.

#### 5. Detail Item
- **GET** `/v1/item/{id}`
- **Contoh Request (detail variant 101):**
  ```bash
  curl --request GET \
    --url https://sekalipay.com/api/v1/item/101 \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response:**
  ```json
  {
                  "message": "OK",
                  "data": {
                    "id": 123,
                    "name": "Netflix 1 Bulan",
                    "price": 45000,
                    "stock": 50,
                    "order_process": "h2h",
                    "h2h_provider": "h2h",
                    "provider_meta": {
                      "open_denom": true,
                      "min_qty": 10000,
                      "max_qty": 10000000,
                      "step_qty": 1
                    },
                    "required_fields": [
                      {
                        "key": "note",
                        "label": "User ID",
                        "required": true
                      },
                      {
                        "key": "provider_qty",
                        "label": "Nominal",
                        "required": true
                      }
                    ],
                    "validation": {
                      "available": true,
                      "endpoint": "/api/v1/item/validate",
                      "requires_zone_id": true
                    },
                    "description": "..."
                  }
                }
  ```

#### 6. Validasi Akun (Cek ID Game)
- **POST** `/v1/item/validate`
- **Request Body:**
    - `item_id` (integer, required) – ID variant.
    - `customer_id` (string, required) – User ID / No. HP / No. Rekening.
    - `zone_id` (string, optional) – Wajib jika `validation.requires_zone_id == true`.
- **Contoh Request:**
  ```bash
  curl --request POST \
    --url https://sekalipay.com/api/v1/item/validate \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Content-Type: application/json' \
    --data '{
      "item_id": 101,
      "customer_id": "123456789",
      "zone_id": "1234"
    }'
  ```
- **Contoh Response:**
  ```json
  {
    "message": "OK",
    "data": {
      "display_name": "PlayerName (Indonesia)",
      "account_name": "PlayerName",
      "region": "Indonesia",
      "cached": false,
      "details": {}
    }
  }
  ```
> **Penting:** Hanya panggil endpoint ini jika `validation.available == true` pada item.

#### 7. Buat Transaksi (Pembelian)
- **POST** `/v1/trx`
- **Request Body:**
    - `ref_id` (string, required) – ID unik dari sistem Anda (maks. 191 karakter).
    - `carts` (array, required) – Array item yang dibeli.
        - `carts.*.item_id` (integer, required) – ID variant.
        - `carts.*.quantity` (integer, required).
        - `carts.*.note` (string/json, conditional) – **Format bergantung pada jenis produk** (lihat di bawah).
- **Format `note` khusus:**
    1. **Produk Biasa / H2H non-open-denom:** String biasa, misal ID akun game: `"123456789"`.
    2. **Item Open Denom:** JSON string `{"target":"08123xxxx","provider_qty":10000}`
    3. **Produk SMM:** JSON string `{"target":"https://instagram.com/...", "opt_smm":["like"], "comment_smm":"Nice post!"}`

**Contoh Request 1 – Produk H2H reguler:**
```bash
curl --request POST \
  --url https://sekalipay.com/api/v1/trx \
  --header 'X-APIKEY: sk_live_abc123' \
  --header 'Content-Type: application/json' \
  --data '{
    "ref_id": "INV-20260511-001",
    "carts": [
      {
        "item_id": 101,
        "quantity": 1,
        "note": "123456789"
      }
    ]
  }'
```

**Contoh Request 2 – Pulsa Open Denom:**
```bash
curl ... --data '{
  "ref_id": "INV-20260511-002",
  "carts": [
    {
      "item_id": 205,
      "quantity": 1,
      "note": "{\"target\":\"08123456789\",\"provider_qty\":50000}"
    }
  ]
}'
```

**Contoh Request 3 – Produk SMM (Instagram Likes):**
```bash
curl ... --data '{
  "ref_id": "INV-20260511-003",
  "carts": [
    {
      "item_id": 310,
      "quantity": 1,
      "note": "{\"target\":\"https://www.instagram.com/p/xyz/\",\"opt_smm\":[\"like\"],\"comment_smm\":\"\"}"
    }
  ]
}'
```

- **Respons Sukses Umum:**
  ```json
  {
    "message": "OK",
    "data": {
      "invoice": "INV-987654321",
      "ref_id": "INV-20260511-001",
      "total_amount": 23000,
      "status": "pending"
    }
  }
  ```

- **Error Spesifik:**
    - `400 BALANCE_IS_INSUFFICIENT` (saldo tidak cukup)
    - `400 SMM_ORDER_REQUIRES_JSON_NOTE` (produk SMM butuh note JSON)
    - `422 REF_ID_ALREADY_EXIST` (ref_id sudah dipakai)

#### 8. List Transaksi
- **GET** `/v1/trx`
- **Query Parameters:** `page`, `per_page`, `status` (pending/paid/completed/canceled).
- **Contoh Request:**
  ```bash
  curl --request GET \
    --url 'https://sekalipay.com/api/v1/trx?status=completed&per_page=5' \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response:**
  ```json
  {
    "message": "OK",
    "data": [
      {
        "id": 1501,
        "invoice": "INV-987654321",
        "ref_id": "INV-20260511-001",
        "amount": 23000,
        "status": "completed",
        "created_at": "2026-05-11T07:20:00Z"
      }
    ]
  }
  ```

#### 9. Detail Transaksi (Ambil Status, Serial Number, dll.)
- **GET** `/v1/trx/{ref_id}`
- **Parameter:** `ref_id` (string) – Reference ID atau Invoice.
- **Contoh Request:**
  ```bash
  curl --request GET \
    --url https://sekalipay.com/api/v1/trx/INV-20260511-001 \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Contoh Response (Produk H2H dengan serial number):**
  ```json
  {
    "message": "OK",
    "data": {
      "invoice": "INV-987654321",
      "ref_id": "INV-20260511-001",
      "status": "completed",
      "amount": 23000,
      "items": [
        {
          "item_id": 101,
          "name": "86 Diamonds",
          "price": 23000,
          "quantity": 1
        }
      ],
      "h2h_results": [
        {
          "item_id": 101,
          "sn": "SN-ABCD1234"
        }
      ]
    }
  }
  ```
- **Jika gagal di sisi H2H:**
  ```json
  "h2h_results": [
    {
      "item_id": 101,
      "sn": "failed: USER_NOT_FOUND"
    }
  ]
  ```
- **Untuk produk SMM:**
  ```json
  "smm_results": [
    {
      "item_id": 310,
      "status": "Completed",
      "start_count": 0,
      "remains": 0
    }
  ]
  ```

#### 10. Leaderboard
- **GET** `/v1/leaderboard`
- **Contoh Request:**
  ```bash
  curl --request GET \
    --url https://sekalipay.com/api/v1/leaderboard \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Accept: application/json'
  ```
- **Response:** Array 10 peringkat teratas dengan `ranking`, `name`, `total_trx`.

#### 11. Sandbox Order (Testing)
- **POST** `/v1/order/sandbox`
- **Request Body:** `ref_id`, `item_id`, `quantity` (semua required).
- **Contoh Request:**
  ```bash
  curl --request POST \
    --url https://sekalipay.com/api/v1/order/sandbox \
    --header 'X-APIKEY: sk_live_abc123' \
    --header 'Content-Type: application/json' \
    --data '{
      "ref_id": "TEST-001",
      "item_id": 101,
      "quantity": 1
    }'
  ```
- **Response:** `{ "message": "OK", "data": { "invoice": "SAND-123" } }` (tidak memotong saldo).

---

### Error Handling (Contoh)

- **Response Error 422 (Validasi):**
  ```json
  {
    "message": "REF_ID_ALREADY_EXIST",
    "errors": {
      "ref_id": ["The ref id has already been used."]
    }
  }
  ```
- **Response Error 400 (Saldo tidak cukup):**
  ```json
  {
    "message": "BALANCE_IS_INSUFFICIENT",
    "errors": {
      "balance": ["Your balance is insufficient for this transaction."]
    }
  }
  ```

---

### Catatan Penting untuk AI Agent

- **Gunakan `per_page=all` pada `/v1/item` untuk sinkronisasi penuh pertama kali.** Kemudian gunakan `updated_since` dengan `server_time` dari response sebelumnya untuk delta sync.
- **Selalu periksa `order_process` pada item** untuk menentukan alur pemrosesan: `auto` (produk digital instan), `manual` (diproses manual), `h2h` (host-to-host, perlu cek `h2h_results`), `smm` (social media marketing, perlu cek `smm_results`).
- **Untuk item H2H dengan `provider_meta.open_denom = true`, kirim `note` dalam format JSON `{"target":"...", "provider_qty": ...}`.** Pastikan `provider_qty` sesuai batasan `min_qty`, `max_qty`, dan kelipatan `step_qty`.
- **Produk SMM memerlukan struktur JSON `{"target":"...", "opt_smm":[...], "comment_smm":"..."}`.** Jika tidak, akan error `SMM_ORDER_REQUIRES_JSON_NOTE`.
- **Validasi akun hanya bisa dilakukan jika `validation.available == true`.** Jangan panggil endpoint validasi jika false.
- **`ref_id` harus unik untuk setiap transaksi.** Gunakan kombinasi prefix dan timestamp untuk menghindari duplikasi.
- **IP harus di-whitelist.** Jika IP dinamis, pastikan whitelist di-update secara berkala.