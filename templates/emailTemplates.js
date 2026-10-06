/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — Email Templates
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Template HTML email yang profesional untuk notifikasi transaksi.
 * - buildCompletedEmailHtml(order) → Email sukses + data akun/license
 * - buildFailedEmailHtml(order)    → Email gagal (tanpa error_message internal)
 *
 * Product type detection:
 *   - Premium App  → Sekalipay auto (order_process=auto, licenses contain EMAIL/PASSWORD)
 *   - H2H Top-Up   → Sekalipay h2h (order_process=h2h, h2h_results.sn)
 *   - Fincloud PPOB → Has rrn field, no raw_items
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
 * Detect product type from account_details.
 * Returns one of: 'premium_app' | 'h2h_topup' | 'fincloud' | 'unknown'
 *
 * - premium_app: Sekalipay auto products (e.g. Capcut, Spotify) with account credentials
 * - h2h_topup:   Sekalipay h2h products (e.g. DANA, pulsa, top-up)
 * - fincloud:    Fincloud PPOB products (e.g. e-wallet top-up via fincloud)
 * - unknown:     Fallback
 *
 * @param {Object} accountDetails
 * @returns {'premium_app'|'h2h_topup'|'fincloud'|'unknown'}
 */
function detectProductType(accountDetails) {
    if (!accountDetails) return 'unknown';

    // Fincloud: has rrn field at top level, no raw_items
    if (accountDetails.rrn !== undefined) {
        return 'fincloud';
    }

    const rawItems = accountDetails.raw_items || [];

    if (rawItems.length > 0) {
        // Check if any item has order_process === 'auto' (premium app with credentials)
        const hasAutoProcess = rawItems.some(item => item.order_process === 'auto');
        const hasH2HProcess = rawItems.some(item => item.order_process === 'h2h');

        if (hasAutoProcess) return 'premium_app';
        if (hasH2HProcess) return 'h2h_topup';
    }

    return 'unknown';
}

/**
 * Get the product name from account_details for contextual display.
 * @param {Object} accountDetails
 * @returns {string|null}
 */
function getProductNameFromDetails(accountDetails) {
    if (!accountDetails) return null;

    const rawItems = accountDetails.raw_items || [];
    if (rawItems.length > 0 && rawItems[0].product_name) {
        return rawItems[0].product_name;
    }
    return null;
}

/**
 * Mengekstrak dan memformat data akun/license dari account_details.
 * Renders different layouts based on product type.
 * @param {Object} accountDetails - field account_details dari order
 * @returns {{ html: string, productType: string }}
 */
function buildAccountDetailsHtml(accountDetails) {
    const productType = detectProductType(accountDetails);

    if (!accountDetails) {
        return {
            html: '<p style="color:#888; font-style:italic;">Tidak ada data akun tersedia.</p>',
            productType
        };
    }

    // ── Premium App (Sekalipay auto): show credentials in a styled card ─────
    if (productType === 'premium_app') {
        return { html: buildPremiumAppHtml(accountDetails), productType };
    }

    // ── H2H Top-Up (Sekalipay h2h): show SN/ref in a receipt-style layout ──
    if (productType === 'h2h_topup') {
        return { html: buildH2HTopUpHtml(accountDetails), productType };
    }

    // ── Fincloud PPOB: show SN/RRN receipt ──────────────────────────────────
    if (productType === 'fincloud') {
        return { html: buildFincloudHtml(accountDetails), productType };
    }

    // ── Fallback: generic table ─────────────────────────────────────────────
    return { html: buildGenericDetailsHtml(accountDetails), productType };
}

/**
 * Build HTML for premium app credentials (EMAIL/PASSWORD style).
 */
function buildPremiumAppHtml(accountDetails) {
    const rawItems = accountDetails.raw_items || [];
    const licenses = accountDetails.licenses || [];

    const credentials = [];

    // Extract from top-level licenses
    licenses.forEach(lic => {
        if (typeof lic === 'string') {
            credentials.push(lic);
        } else if (lic && lic.product_license) {
            credentials.push(lic.product_license);
        }
    });

    // Extract from raw_items.licenses (deduped)
    rawItems.forEach(item => {
        const itemLicenses = item.licenses || [];
        itemLicenses.forEach(lic => {
            let text = '';
            if (typeof lic === 'string') {
                text = lic;
            } else if (lic && lic.product_license) {
                text = lic.product_license;
            }
            if (text && !credentials.includes(text)) {
                credentials.push(text);
            }
        });
    });

    if (credentials.length === 0) {
        return '<p style="color:#888; font-style:italic;">Data akun sedang diproses.</p>';
    }

    // Parse EMAIL/PASSWORD format for cleaner display
    const rows = credentials.map((cred, idx) => {
        // Try to parse "EMAIL : xxx | PASSWORD : yyy" format
        const emailMatch = cred.match(/EMAIL\s*:\s*(.+?)(?:\s*\|\s*PASSWORD\s*:\s*(.+))?$/i);

        if (emailMatch) {
            const email = emailMatch[1].trim();
            const password = emailMatch[2] ? emailMatch[2].trim() : null;

            let html = `
                <tr>
                    <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08); color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; width:100px;">Email</td>
                    <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08);">
                        <code style="background:#f0f4ff; padding:5px 10px; border-radius:6px; color:#1a237e; font-weight:600; font-size:14px; word-break:break-all; display:inline-block;">${escapeHtml(email)}</code>
                    </td>
                </tr>`;

            if (password) {
                html += `
                <tr>
                    <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08); color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Password</td>
                    <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08);">
                        <code style="background:#fff3e0; padding:5px 10px; border-radius:6px; color:#e65100; font-weight:600; font-size:14px; word-break:break-all; display:inline-block;">${escapeHtml(password)}</code>
                    </td>
                </tr>`;
            }
            return html;
        }

        // Fallback: display as-is
        return `
            <tr>
                <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08); color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Akun ${idx + 1}</td>
                <td style="padding:10px 14px; border-bottom:1px solid rgba(26,35,126,0.08);">
                    <code style="background:#f0f4ff; padding:5px 10px; border-radius:6px; color:#1a237e; font-weight:600; font-size:14px; word-break:break-all; display:inline-block;">${escapeHtml(cred)}</code>
                </td>
            </tr>`;
    }).join('');

    const productName = getProductNameFromDetails(accountDetails);
    const variantName = accountDetails.raw_items?.[0]?.variant_name || '';
    const headerLabel = productName
        ? `🔐 Kredensial ${escapeHtml(productName)}${variantName ? ' — ' + escapeHtml(variantName) : ''}`
        : '🔐 Kredensial Akun';

    return `
        <div style="border:2px solid #1a237e; border-radius:12px; overflow:hidden;">
            <div style="background:linear-gradient(135deg,#1a237e 0%,#3949ab 100%); padding:12px 18px;">
                <p style="margin:0; color:#fff; font-size:14px; font-weight:600;">${headerLabel}</p>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafbff;">
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>`;
}

/**
 * Build HTML for H2H top-up results (SN/receipt style).
 */
function buildH2HTopUpHtml(accountDetails) {
    const rawItems = accountDetails.raw_items || [];
    const results = [];

    rawItems.forEach(item => {
        if (item.h2h_results) {
            const sn = item.h2h_results.sn || '';
            const refId = item.h2h_results.ref_id || '';
            const target = item.target || '';
            const productName = item.product_name || 'Top-Up';
            const variantName = item.variant_name || '';

            results.push({ sn, refId, target, productName, variantName });
        }
    });

    if (results.length === 0) {
        return '<p style="color:#888; font-style:italic;">Data transaksi sedang diproses.</p>';
    }

    const cards = results.map(r => {
        const rows = [];

        if (r.target) {
            rows.push(`
                <tr>
                    <td style="padding:8px 14px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; width:120px; border-bottom:1px solid #f0f0f0;">Nomor Tujuan</td>
                    <td style="padding:8px 14px; font-size:14px; font-weight:600; color:#333; border-bottom:1px solid #f0f0f0;">${escapeHtml(r.target)}</td>
                </tr>`);
        }

        if (r.sn) {
            rows.push(`
                <tr>
                    <td style="padding:8px 14px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid #f0f0f0;">Serial Number</td>
                    <td style="padding:8px 14px; border-bottom:1px solid #f0f0f0;">
                        <code style="background:#e8f5e9; padding:4px 8px; border-radius:4px; color:#2e7d32; font-weight:600; font-size:13px; word-break:break-all; display:inline-block;">${escapeHtml(r.sn)}</code>
                    </td>
                </tr>`);
        }

        if (r.refId) {
            rows.push(`
                <tr>
                    <td style="padding:8px 14px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Ref. ID</td>
                    <td style="padding:8px 14px; font-size:13px; color:#555;">${escapeHtml(r.refId)}</td>
                </tr>`);
        }

        return `
        <div style="border:1px solid #e0e0e0; border-radius:12px; overflow:hidden; margin-bottom:12px;">
            <div style="background:linear-gradient(135deg,#2e7d32 0%,#43a047 100%); padding:10px 18px;">
                <p style="margin:0; color:#fff; font-size:13px; font-weight:600;">📱 ${escapeHtml(r.productName)}${r.variantName ? ' — ' + escapeHtml(r.variantName) : ''}</p>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>`;
    }).join('');

    return cards;
}

/**
 * Build HTML for Fincloud PPOB results (SN/RRN receipt style).
 */
function buildFincloudHtml(accountDetails) {
    const rrn = accountDetails.rrn || '';
    const target = accountDetails.target || '';
    const licenses = accountDetails.licenses || [];

    const sn = (licenses.length > 0 && typeof licenses[0] === 'string')
        ? licenses[0]
        : rrn;

    if (!sn && !target) {
        return '<p style="color:#888; font-style:italic;">Data transaksi sedang diproses.</p>';
    }

    const rows = [];

    if (target) {
        rows.push(`
            <tr>
                <td style="padding:8px 14px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; width:120px; border-bottom:1px solid #f0f0f0;">Nomor Tujuan</td>
                <td style="padding:8px 14px; font-size:14px; font-weight:600; color:#333; border-bottom:1px solid #f0f0f0;">${escapeHtml(target)}</td>
            </tr>`);
    }

    if (sn) {
        rows.push(`
            <tr>
                <td style="padding:8px 14px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid #f0f0f0;">Serial Number</td>
                <td style="padding:8px 14px; border-bottom:1px solid #f0f0f0;">
                    <code style="background:#e8f5e9; padding:4px 8px; border-radius:4px; color:#2e7d32; font-weight:600; font-size:13px; word-break:break-all; display:inline-block;">${escapeHtml(sn)}</code>
                </td>
            </tr>`);
    }

    return `
        <div style="border:1px solid #e0e0e0; border-radius:12px; overflow:hidden;">
            <div style="background:linear-gradient(135deg,#2e7d32 0%,#43a047 100%); padding:10px 18px;">
                <p style="margin:0; color:#fff; font-size:13px; font-weight:600;">📱 Bukti Transaksi</p>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>`;
}

/**
 * Fallback: generic table for unknown product types.
 */
function buildGenericDetailsHtml(accountDetails) {
    const displayTexts = [];
    const licenses = accountDetails.licenses || [];
    const rawItems = accountDetails.raw_items || [];

    licenses.forEach(lic => {
        if (typeof lic === 'string') {
            displayTexts.push(lic);
        } else if (lic && lic.product_license) {
            displayTexts.push(lic.product_license);
        } else if (lic && lic.sn) {
            displayTexts.push(lic.sn);
        } else if (lic && typeof lic === 'object') {
            displayTexts.push(JSON.stringify(lic));
        }
    });

    rawItems.forEach(item => {
        if (item.h2h_results && item.h2h_results.sn) {
            displayTexts.push(item.h2h_results.sn);
        } else if (item.h2h_results && item.h2h_results.ref_id) {
            displayTexts.push("Ref ID: " + item.h2h_results.ref_id);
        }

        const itemLicenses = item.licenses || [];
        itemLicenses.forEach(lic => {
            let text = '';
            if (typeof lic === 'string') {
                text = lic;
            } else if (lic && lic.product_license) {
                text = lic.product_license;
            } else if (lic && lic.sn) {
                text = lic.sn;
            }
            if (text && !displayTexts.includes(text)) {
                displayTexts.push(text);
            }
        });
    });

    const validTexts = displayTexts.filter(t => t);

    if (validTexts.length > 0) {
        const rows = validTexts.map((text, idx) => `
            <tr>
                <td style="padding:10px 14px; border-bottom:1px solid #eee; color:#555; font-size:14px;">${idx + 1}</td>
                <td style="padding:10px 14px; border-bottom:1px solid #eee; font-size:14px;">
                    <code style="background:#f0f4ff; padding:4px 8px; border-radius:4px; color:#1a237e; font-weight:600; word-break:break-all;">${escapeHtml(text)}</code>
                </td>
            </tr>
        `).join('');

        return `
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; overflow:hidden;">
                <thead>
                    <tr style="background:#f5f7ff;">
                        <th style="padding:10px 14px; text-align:left; color:#333; font-size:13px; width:40px;">No</th>
                        <th style="padding:10px 14px; text-align:left; color:#333; font-size:13px;">Detail</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>`;
    }

    if (rawItems.length > 0) {
        const itemDetails = rawItems.map(item => {
            return `<span style="color:#888;">${escapeHtml(item.product_name || item.name || 'Item')} - Sedang diproses / Data tidak terbaca</span>`;
        }).join('<br/><br/>');

        return `<div style="padding:12px; background:#fafbff; border-radius:8px; border:1px solid #e0e0e0;">${itemDetails}</div>`;
    }

    return '<p style="color:#888; font-style:italic;">Data akun sedang diproses.</p>';
}

/**
 * Build the warning/info box. Only shows "jangan bagikan akun" for premium apps.
 * For other types, shows a generic "simpan bukti transaksi" message.
 * @param {'premium_app'|'h2h_topup'|'fincloud'|'unknown'} productType
 * @returns {string}
 */
function buildWarningHtml(productType) {
    if (productType === 'premium_app') {
        return `
            <div style="background:#fff3e0; border-left:4px solid #ff9800; padding:14px 18px; border-radius:0 8px 8px 0; margin:24px 0 20px;">
                <p style="margin:0; color:#e65100; font-size:13px; font-weight:700;">⚠️ Penting — Jaga Kerahasiaan Akun</p>
                <p style="margin:8px 0 0; color:#bf360c; font-size:13px; line-height:1.6;">
                    Data login di atas bersifat <strong>rahasia</strong>. Jangan bagikan email & password kepada siapa pun. 
                    Kami tidak bertanggung jawab atas penyalahgunaan akun akibat kelalaian pengguna.
                </p>
            </div>`;
    }

    // H2H / Fincloud / unknown — simpan bukti saja, tanpa peringatan akun
    return `
        <div style="background:#e8f5e9; border-left:4px solid #43a047; padding:14px 18px; border-radius:0 8px 8px 0; margin:24px 0 20px;">
            <p style="margin:0; color:#2e7d32; font-size:13px; font-weight:700;">💡 Simpan Bukti Transaksi</p>
            <p style="margin:8px 0 0; color:#1b5e20; font-size:13px; line-height:1.6;">
                Simpan serial number di atas sebagai bukti transaksi Anda. 
                Jika ada kendala, sertakan bukti ini saat menghubungi admin.
            </p>
        </div>`;
}

/**
 * Build the section header label depending on product type.
 * @param {'premium_app'|'h2h_topup'|'fincloud'|'unknown'} productType
 * @returns {string}
 */
function getSectionTitle(productType) {
    switch (productType) {
        case 'premium_app': return '🔑 Data Akun Anda';
        case 'h2h_topup':   return '🧾 Bukti Transaksi';
        case 'fincloud':    return '🧾 Bukti Transaksi';
        default:            return '🔑 Data Akun / Serial Number';
    }
}

/**
 * Build HTML email untuk order COMPLETED (sukses).
 * @param {Object} order - Data order lengkap dari Supabase
 * @param {string} [waNumber='6285199605580'] - Nomor WhatsApp CS
 * @returns {string} HTML string
 */
function buildCompletedEmailHtml(order, waNumber = '6285199605580') {
    const { html: accountHtml, productType } = buildAccountDetailsHtml(order.account_details);
    const warningHtml = buildWarningHtml(productType);
    const sectionTitle = getSectionTitle(productType);
    const cleanWa = String(waNumber || '6285199605580').replace(/\D/g, '') || '6285199605580';

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
                            <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:14px;">Terima kasih sudah berbelanja di Noxarianet Store</p>
                        </td>
                    </tr>
                    
                    <!-- Body -->
                    <tr>
                        <td style="padding:32px 40px;">
                            
                            <!-- Greeting -->
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 24px;">
                                Halo <strong>${escapeHtml(order.customer_name || 'Kak')}</strong> 👋<br/>
                                Kabar baik! Pesanan kamu sudah <strong style="color:#2e7d32;">berhasil diproses</strong> dan siap digunakan. 
                                Berikut detail lengkap transaksi kamu:
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
                                ${sectionTitle}
                            </h2>
                            ${accountHtml}
                            
                            <!-- Warning / Info Box (conditional) -->
                            ${warningHtml}
                            
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f5f5f7; padding:24px 40px; text-align:center; border-top:1px solid #eee;">
                            <p style="margin:0 0 6px; color:#888; font-size:12px;">Ada kendala? Hubungi kami via WhatsApp</p>
                            <p style="margin:0 0 12px; color:#1a237e; font-size:13px; font-weight:600;">wa.me/${cleanWa}</p>
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
 * @param {string} [waNumber='6285199605580'] - Nomor WhatsApp CS
 * @returns {string} HTML string
 */
function buildFailedEmailHtml(order, waNumber = '6285199605580') {
    const cleanWa = String(waNumber || '6285199605580').replace(/\D/g, '') || '6285199605580';

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
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 24px;">
                                Halo <strong>${escapeHtml(order.customer_name || 'Kak')}</strong>,<br/>
                                Mohon maaf, pesanan kamu <strong style="color:#c62828;">tidak dapat diproses</strong> oleh sistem kami. 
                                Hal ini bisa terjadi karena nomor tujuan tidak valid atau gangguan pada server. 
                                Berikut detail pesanan kamu:
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
                                <p style="margin:0; color:#0d47a1; font-size:13px; font-weight:700;">💬 Langkah Selanjutnya</p>
                                <p style="margin:8px 0 0; color:#1565c0; font-size:13px; line-height:1.6;">
                                    Silakan periksa kembali nomor tujuan yang kamu masukkan. 
                                    Jika merasa sudah benar, hubungi admin kami via WhatsApp dengan menyertakan <strong>Order ID</strong> di atas 
                                    agar kami bisa membantu menyelesaikan kendala ini.
                                </p>
                            </div>
                            
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background:#f5f5f7; padding:24px 40px; text-align:center; border-top:1px solid #eee;">
                            <p style="margin:0 0 6px; color:#888; font-size:12px;">Butuh bantuan? Hubungi Admin kami</p>
                            <p style="margin:0 0 12px; color:#1a237e; font-size:13px; font-weight:600;">wa.me/${cleanWa}</p>
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

// ══════════════════════════════════════════════════════════════════════════
// OTP EMAIL TEMPLATES (registrasi & lupa password)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Bangun kerangka HTML bersama untuk email OTP.
 * Memakai bahasa visual yang sama dengan template order (indigo #1a237e,
 * kartu 600px, footer WhatsApp) supaya email OTP tidak terlihat seperti mail
 * dari situs lain.
 *
 * @param {Object} options
 * @param {string} options.heading - Judul besar di header
 * @param {string} options.subtitle - Baris kecil di header
 * @param {string} options.introHtml - Paragraf pembuka (sudah berupa HTML)
 * @param {string} options.code - Kode OTP 6 digit
 * @param {number} options.expiresMinutes - Masa berlaku
 * @param {string} options.footnoteHtml - Catatan di bawah kotak kode
 * @param {string} [options.waNumber] - Nomor WhatsApp CS
 * @returns {string} HTML string
 */
function buildOtpLayoutHtml({ heading, subtitle, introHtml, code, expiresMinutes, footnoteHtml, waNumber }) {
    const cleanWa = String(waNumber || '6285199605580').replace(/\D/g, '') || '6285199605580';

    return `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(heading)} — Noxarianet Store</title>
</head>
<body style="margin:0; padding:0; background:#f4f6fb; font-family:'Segoe UI',Roboto,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb; padding:30px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">

                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg,#1a237e 0%,#3949ab 100%); padding:32px 40px; text-align:center;">
                            <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:700; letter-spacing:0.5px;">${escapeHtml(heading)}</h1>
                            <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:14px;">${escapeHtml(subtitle)}</p>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="padding:32px 40px;">

                            ${introHtml}

                            <!-- Kode OTP -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fe; border-radius:10px; margin:0 0 20px;">
                                <tr>
                                    <td style="padding:28px 24px; text-align:center;">
                                        <p style="margin:0 0 12px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Kode Verifikasi Anda</p>
                                        <p style="margin:0; font-size:38px; font-weight:700; color:#1a237e; letter-spacing:14px; font-family:'Courier New',Consolas,monospace;">${escapeHtml(code)}</p>
                                        <p style="margin:14px 0 0; color:#888; font-size:12px;">Berlaku ${expiresMinutes} menit sejak dikirim</p>
                                    </td>
                                </tr>
                            </table>

                            ${footnoteHtml}

                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background:#f5f5f7; padding:24px 40px; text-align:center; border-top:1px solid #eee;">
                            <p style="margin:0 0 6px; color:#888; font-size:12px;">Butuh bantuan? Hubungi Admin kami</p>
                            <p style="margin:0 0 12px; color:#1a237e; font-size:13px; font-weight:600;">wa.me/${cleanWa}</p>
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
 * Email verifikasi email untuk registrasi akun baru.
 * Dipanggil SETELAH OTP dibuat, jadi email ini adalah bukti kepemilikan —
 * tanpa kode di dalamnya, akun tidak akan pernah dibuat.
 *
 * @param {Object} options
 * @param {string} options.code - Kode OTP 6 digit
 * @param {string} [options.displayName] - Nama yang diisi user di form registrasi
 * @param {number} [options.expiresMinutes=10]
 * @param {string} [options.waNumber] - Nomor WhatsApp CS
 * @returns {string} HTML string
 */
function buildVerificationEmailHtml({ code, displayName, expiresMinutes = 10, waNumber }) {
    const greeting = displayName
        ? `Halo <strong>${escapeHtml(displayName)}</strong>,`
        : 'Halo,';

    return buildOtpLayoutHtml({
        heading: 'Verifikasi Email Anda',
        subtitle: 'Satu langkah lagi sebelum akun aktif',
        expiresMinutes,
        waNumber,
        introHtml: `
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 24px;">
                                ${greeting}<br/>
                                Terima kasih sudah mendaftar di Noxarianet Store. Masukkan kode di bawah ini di halaman
                                pendaftaran untuk mengaktifkan akun Anda.
                            </p>`,
        code,
        footnoteHtml: `
                            <div style="background:#fff8e1; border-left:4px solid #f9a825; padding:14px 18px; border-radius:6px; margin-bottom:20px;">
                                <p style="margin:0; color:#7a5c00; font-size:13px; line-height:1.6;">
                                    <strong>Jangan bagikan kode ini kepada siapa pun</strong>, termasuk pihak yang mengaku sebagai admin Noxarianet Store.
                                    Kami tidak pernah meminta kode ini lewat telepon, WhatsApp, atau chat.
                                </p>
                            </div>
                            <p style="color:#888; font-size:13px; line-height:1.6; margin:0;">
                                Tidak menerima email ini? Periksa folder spam, atau kembali ke halaman pendaftaran untuk meminta kode baru.
                            </p>`,
    });
}

/**
 * Email OTP untuk lupa password.
 *
 * @param {Object} options
 * @param {string} options.code - Kode OTP 6 digit
 * @param {string} [options.displayName]
 * @param {number} [options.expiresMinutes=10]
 * @param {string} [options.waNumber] - Nomor WhatsApp CS
 * @returns {string} HTML string
 */
function buildResetPasswordEmailHtml({ code, displayName, expiresMinutes = 10, waNumber }) {
    const greeting = displayName
        ? `Halo <strong>${escapeHtml(displayName)}</strong>,`
        : 'Halo,';

    return buildOtpLayoutHtml({
        heading: 'Reset Password',
        subtitle: 'Kode untuk mengatur ulang password akun Anda',
        expiresMinutes,
        waNumber,
        introHtml: `
                            <p style="color:#333; font-size:15px; line-height:1.6; margin:0 0 24px;">
                                ${greeting}<br/>
                                Kami menerima permintaan untuk mengatur ulang password akun Anda. Masukkan kode di bawah ini,
                                lalu tentukan password baru Anda.
                            </p>`,
        code,
        footnoteHtml: `
                            <div style="background:#ffebee; border-left:4px solid #e53935; padding:14px 18px; border-radius:6px; margin-bottom:20px;">
                                <p style="margin:0; color:#8c1d18; font-size:13px; line-height:1.6;">
                                    <strong>Tidak pernah meminta reset password?</strong> Abaikan email ini. Password Anda tidak akan berubah
                                    selama kode ini tidak dipakai.
                                </p>
                            </div>
                            <p style="color:#888; font-size:13px; line-height:1.6; margin:0;">
                                Selesai? Kode ini langsung hangus dan tidak bisa dipakai lagi.
                            </p>`,
    });
}

module.exports = {
    buildCompletedEmailHtml,
    buildFailedEmailHtml,
    buildVerificationEmailHtml,
    buildResetPasswordEmailHtml,
};
