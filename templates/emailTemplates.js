/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — Email Templates
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Template HTML email yang profesional untuk notifikasi transaksi.
 * - buildCompletedEmailHtml(order) → Email sukses + data akun/license
 * - buildFailedEmailHtml(order)    → Email gagal (tanpa error_message internal)
 */

/**
 * Format angka ke Rupiah (e.g. 50000 → "Rp 50.000")
 * @param {number} amount
 * @returns {string}
 */
function formatRupiah(amount) {
    return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`;
}

/**
 * Escape HTML entities untuk mencegah XSS di template email.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Mengekstrak dan memformat data akun/license dari account_details.
 * @param {Object} accountDetails - field account_details dari order
 * @returns {string} HTML string berisi data akun
 */
function buildAccountDetailsHtml(accountDetails) {
    if (!accountDetails) {
        return '<p style="color:#888; font-style:italic;">Tidak ada data akun tersedia.</p>';
    }

    const licenses = accountDetails.licenses || [];
    const rawItems = accountDetails.raw_items || [];

    // Jika ada licenses (produk auto)
    if (licenses.length > 0) {
        const rows = licenses.map((license, idx) => `
            <tr>
                <td style="padding:10px 14px; border-bottom:1px solid #eee; color:#555; font-size:14px;">${idx + 1}</td>
                <td style="padding:10px 14px; border-bottom:1px solid #eee; font-size:14px;">
                    <code style="background:#f0f4ff; padding:4px 8px; border-radius:4px; color:#1a237e; font-weight:600; word-break:break-all;">
                        ${escapeHtml(license)}
                    </code>
                </td>
            </tr>
        `).join('');

        return `
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; overflow:hidden;">
                <thead>
                    <tr style="background:#f5f7ff;">
                        <th style="padding:10px 14px; text-align:left; color:#333; font-size:13px; width:40px;">No</th>
                        <th style="padding:10px 14px; text-align:left; color:#333; font-size:13px;">Akun / Serial Number</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;
    }

    // Jika ada raw_items tapi tidak ada licenses
    if (rawItems.length > 0) {
        const itemDetails = rawItems.map(item => {
            const itemLicenses = item.licenses || [];
            if (itemLicenses.length > 0) {
                return itemLicenses.map(l => `<code style="background:#f0f4ff; padding:4px 8px; border-radius:4px; color:#1a237e; font-weight:600; word-break:break-all;">${escapeHtml(l)}</code>`).join('<br/>');
            }
            return `<span style="color:#888;">${escapeHtml(item.name || 'Item')} - Menunggu proses</span>`;
        }).join('<br/><br/>');

        return `<div style="padding:12px; background:#fafbff; border-radius:8px; border:1px solid #e0e0e0;">${itemDetails}</div>`;
    }

    return '<p style="color:#888; font-style:italic;">Data akun sedang diproses.</p>';
}

/**
 * Build HTML email untuk order COMPLETED (sukses).
 * @param {Object} order - Data order lengkap dari Supabase
 * @returns {string} HTML string
 */
function buildCompletedEmailHtml(order) {
    const accountHtml = buildAccountDetailsHtml(order.account_details);

    return `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pesanan Berhasil — Noxarianet Store</title>
</head>
<body style="margin:0; padding:0; background:#f4f6fb; font-family:'Segoe UI',Roboto,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb; padding:30px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg,#1a237e 0%,#3949ab 100%); padding:32px 40px; text-align:center;">
                            <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:700; letter-spacing:0.5px;">✅ Pesanan Berhasil!</h1>
                            <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:14px;">Terima kasih telah berbelanja di Noxarianet Store</p>
                        </td>
                    </tr>
                    
                    <!-- Body -->
                    <tr>
                        <td style="padding:32px 40px;">
                            
                            <!-- Greeting -->
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 20px;">
                                Halo <strong>${escapeHtml(order.customer_name || 'Kak')}</strong>,<br/>
                                Pesanan Anda telah <strong style="color:#2e7d32;">berhasil diproses</strong>. Berikut detail pesanan dan data akun Anda:
                            </p>
                            
                            <!-- Order Info Box -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fe; border-radius:10px; margin-bottom:24px;">
                                <tr>
                                    <td style="padding:20px 24px;">
                                        <table width="100%" cellpadding="0" cellspacing="0">
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px; width:130px;">Order ID</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.id)}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Produk</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.product)}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Varian</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.variant || '-')}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Total Bayar</td>
                                                <td style="padding:6px 0; color:#1a237e; font-size:14px; font-weight:700;">${formatRupiah(order.price)}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Account Details Section -->
                            <h2 style="color:#1a237e; font-size:16px; margin:0 0 14px; padding-bottom:10px; border-bottom:2px solid #e8eaf6;">
                                🔑 Data Akun / Serial Number
                            </h2>
                            ${accountHtml}
                            
                            <!-- Warning Box -->
                            <div style="background:#fff3e0; border-left:4px solid #ff9800; padding:14px 18px; border-radius:0 8px 8px 0; margin:24px 0 20px;">
                                <p style="margin:0; color:#e65100; font-size:13px; font-weight:600;">⚠️ Penting!</p>
                                <p style="margin:6px 0 0; color:#bf360c; font-size:13px; line-height:1.5;">
                                    Simpan data akun di atas dengan baik. Jangan bagikan kepada orang lain. 
                                    Kami tidak bertanggung jawab jika data akun Anda bocor karena kelalaian.
                                </p>
                            </div>
                            
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f5f5f7; padding:24px 40px; text-align:center; border-top:1px solid #eee;">
                            <p style="margin:0 0 6px; color:#888; font-size:12px;">Ada kendala? Hubungi kami via WhatsApp</p>
                            <p style="margin:0 0 12px; color:#1a237e; font-size:13px; font-weight:600;">wa.me/6285199605580</p>
                            <p style="margin:0; color:#bbb; font-size:11px;">© ${new Date().getFullYear()} Noxarianet Store — noxarianet.web.id</p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/**
 * Build HTML email untuk order FAILED / CANCELLED.
 * CATATAN: error_message TIDAK ditampilkan ke user (hanya info umum).
 * @param {Object} order - Data order dari Supabase
 * @returns {string} HTML string
 */
function buildFailedEmailHtml(order) {
    return `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pesanan Gagal — Noxarianet Store</title>
</head>
<body style="margin:0; padding:0; background:#f4f6fb; font-family:'Segoe UI',Roboto,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb; padding:30px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg,#b71c1c 0%,#e53935 100%); padding:32px 40px; text-align:center;">
                            <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:700; letter-spacing:0.5px;">❌ Pesanan Gagal Diproses</h1>
                            <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:14px;">Mohon maaf atas ketidaknyamanannya</p>
                        </td>
                    </tr>
                    
                    <!-- Body -->
                    <tr>
                        <td style="padding:32px 40px;">
                            
                            <!-- Greeting -->
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 20px;">
                                Halo <strong>${escapeHtml(order.customer_name || 'Kak')}</strong>,<br/>
                                Mohon maaf, pesanan Anda <strong style="color:#c62828;">tidak dapat diproses</strong>. Berikut detail pesanan Anda:
                            </p>
                            
                            <!-- Order Info Box -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef5f5; border-radius:10px; margin-bottom:24px;">
                                <tr>
                                    <td style="padding:20px 24px;">
                                        <table width="100%" cellpadding="0" cellspacing="0">
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px; width:130px;">Order ID</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.id)}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Produk</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.product)}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Varian</td>
                                                <td style="padding:6px 0; color:#222; font-size:13px; font-weight:600;">${escapeHtml(order.variant || '-')}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:6px 0; color:#666; font-size:13px;">Total</td>
                                                <td style="padding:6px 0; color:#c62828; font-size:14px; font-weight:700;">${formatRupiah(order.price)}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Info Box -->
                            <div style="background:#e3f2fd; border-left:4px solid #1565c0; padding:14px 18px; border-radius:0 8px 8px 0; margin:0 0 20px;">
                                <p style="margin:0; color:#0d47a1; font-size:13px; font-weight:600;">ℹ️ Apa yang harus dilakukan?</p>
                                <p style="margin:6px 0 0; color:#1565c0; font-size:13px; line-height:1.5;">
                                    Jika Anda sudah melakukan pembayaran, dana akan dikembalikan secara otomatis (refund). 
                                    Silakan hubungi Admin kami via WhatsApp untuk bantuan lebih lanjut.
                                </p>
                            </div>
                            
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f5f5f7; padding:24px 40px; text-align:center; border-top:1px solid #eee;">
                            <p style="margin:0 0 6px; color:#888; font-size:12px;">Butuh bantuan? Hubungi Admin kami</p>
                            <p style="margin:0 0 12px; color:#1a237e; font-size:13px; font-weight:600;">wa.me/6285199605580</p>
                            <p style="margin:0; color:#bbb; font-size:11px;">© ${new Date().getFullYear()} Noxarianet Store — noxarianet.web.id</p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

module.exports = { buildCompletedEmailHtml, buildFailedEmailHtml };
