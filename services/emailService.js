/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — Email Service (Nodemailer + Resend SMTP & Brevo Fallback)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Service untuk pengiriman email transaksional menggunakan Nodemailer.
 * - Primary  : Resend SMTP relay (smtp.resend.com:465)
 * - Fallback : Brevo SMTP relay (smtp-relay.brevo.com:587) jika Resend limit / error.
 *
 * Env Variables:
 *   RESEND_API_KEY    — API key dari Resend (digunakan sebagai SMTP password)
 *   BREVO_SMTP_USER   — Username / email akun Brevo
 *   BREVO_SMTP_KEY    — SMTP key dari Brevo (atau BREVO_API_KEY)
 *   BREVO_SMTP_HOST   — Host Brevo SMTP (default: smtp-relay.brevo.com)
 *   BREVO_SMTP_PORT   — Port Brevo SMTP (default: 587)
 *   BREVO_SMTP_SECURE — Boolean string 'true' / 'false' (default: false pada port 587)
 *   SMTP_FROM_EMAIL   — Alamat pengirim (harus verified di Resend / Brevo)
 *   SMTP_FROM_NAME    — Nama pengirim (display name)
 */

const nodemailer = require('nodemailer');
const supabase = require('../supabase');
const { buildCompletedEmailHtml, buildFailedEmailHtml } = require('../templates/emailTemplates');

/**
 * Fetch WhatsApp CS setting from Supabase with fallback
 */
async function getWaCsNumber() {
    try {
        const { data } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'whatsapp_cs')
            .maybeSingle();
        if (data && data.value) {
            return String(data.value);
        }
    } catch (err) {
        console.warn('[EmailService] Gagal fetch whatsapp_cs setting:', err.message);
    }
    return '6285199605580';
}

// ══════════════════════════════════════════════════════════════════════════
// SMTP TRANSPORTERS SETUP
// ══════════════════════════════════════════════════════════════════════════

const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@noxarianet.web.id';
const FROM_NAME = process.env.SMTP_FROM_NAME || 'Noxarianet Store';

/**
 * Lazy-initialized Nodemailer transporters.
 * @type {import('nodemailer').Transporter|null}
 */
let resendTransporter = null;
let brevoTransporter = null;

function getResendTransporter() {
    if (resendTransporter) return resendTransporter;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        return null;
    }

    const host = process.env.RESEND_SMTP_HOST || 'smtp.resend.com';
    const port = parseInt(process.env.RESEND_SMTP_PORT || '465', 10);

    resendTransporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: {
            user: process.env.RESEND_SMTP_USER || 'resend',
            pass: apiKey,
        },
    });

    console.log('[EmailService] Resend SMTP transporter berhasil diinisialisasi.');
    return resendTransporter;
}

function getBrevoTransporter() {
    if (brevoTransporter) return brevoTransporter;

    const user = process.env.BREVO_SMTP_USER || process.env.BREVO_USER;
    const pass = process.env.BREVO_SMTP_KEY || process.env.BREVO_SMTP_PASS || process.env.BREVO_API_KEY;

    if (!user || !pass) {
        return null;
    }

    const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
    const port = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
    const secure = process.env.BREVO_SMTP_SECURE === 'true' || port === 465;

    brevoTransporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
            user,
            pass,
        },
    });

    console.log('[EmailService] Brevo SMTP transporter berhasil diinisialisasi.');
    return brevoTransporter;
}

// ══════════════════════════════════════════════════════════════════════════
// SEND EMAIL (with automatic fallback to Brevo)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Kirim email menggunakan Resend SMTP dengan fallback ke Brevo SMTP jika terjadi limit / error.
 * @param {Object} options
 * @param {string} options.to - Email penerima
 * @param {string} options.subject - Subject email
 * @param {string} options.html - Body email dalam HTML
 * @returns {Promise<{success: boolean, messageId?: string, provider?: string, fallback?: boolean, error?: string}>}
 */
async function sendEmail({ to, subject, html }) {
    if (!to) {
        console.warn('[EmailService] Alamat email penerima kosong — skip.');
        return { success: false, error: 'Recipient email is empty' };
    }

    const mailOptions = {
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to,
        subject,
        html,
    };

    const resendSmtp = getResendTransporter();
    const brevoSmtp = getBrevoTransporter();

    if (!resendSmtp && !brevoSmtp) {
        console.warn('[EmailService] Tidak ada transporter SMTP yang terkonfigurasi (Resend & Brevo belum diset di .env) — skip pengiriman email.');
        return { success: false, error: 'No SMTP transporter configured' };
    }

    // 1. Jika Resend tidak dikonfigurasi tetapi Brevo ada, langsung kirim via Brevo
    if (!resendSmtp) {
        console.log('[EmailService] RESEND_API_KEY tidak diset. Mengirim langsung via Brevo SMTP...');
        try {
            const info = await brevoSmtp.sendMail(mailOptions);
            console.log(`[EmailService] Email terkirim via Brevo ke ${to} — messageId: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'brevo' };
        } catch (brevoErr) {
            console.error(`[EmailService] Gagal kirim email via Brevo ke ${to}:`, brevoErr.message);
            return { success: false, error: brevoErr.message, provider: 'brevo' };
        }
    }

    // 2. Coba kirim via Resend terlebih dahulu (Primary)
    try {
        const info = await resendSmtp.sendMail(mailOptions);
        console.log(`[EmailService] Email terkirim via Resend ke ${to} — messageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId, provider: 'resend' };
    } catch (resendErr) {
        const isLimit = /limit|quota|429|exceeded|too many|throttl/i.test(resendErr.message || '');
        if (isLimit) {
            console.warn(`[EmailService] Resend limit/quota terdeteksi (${resendErr.message}).`);
        } else {
            console.warn(`[EmailService] Gagal kirim via Resend (${resendErr.message}).`);
        }

        // 3. Jika Brevo tersedia, coba fallback
        if (brevoSmtp) {
            console.log(`[EmailService] Mengalihkan pengiriman email ke fallback Brevo SMTP untuk ${to}...`);
            try {
                const info = await brevoSmtp.sendMail(mailOptions);
                console.log(`[EmailService] Email berhasil terkirim via Brevo (fallback) ke ${to} — messageId: ${info.messageId}`);
                return { success: true, messageId: info.messageId, provider: 'brevo', fallback: true };
            } catch (brevoErr) {
                console.error(`[EmailService] Fallback Brevo juga gagal ke ${to}:`, brevoErr.message);
                return {
                    success: false,
                    error: `Resend error: ${resendErr.message} | Brevo error: ${brevoErr.message}`,
                };
            }
        }

        console.warn('[EmailService] Fallback Brevo tidak terkonfigurasi di .env.');
        return { success: false, error: resendErr.message, provider: 'resend' };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Kirim email notifikasi ORDER COMPLETED (sukses) ke pembeli.
 * Memuat data akun/license dari account_details.
 * @param {Object} order - Data order lengkap dari Supabase
 * @returns {Promise<{success: boolean, messageId?: string, provider?: string, fallback?: boolean, error?: string}>}
 */
async function sendOrderCompletedEmail(order) {
    const waNumber = await getWaCsNumber();
    const html = buildCompletedEmailHtml(order, waNumber);

    return sendEmail({
        to: order.email,
        subject: `✅ Pesanan ${order.id} Berhasil — Noxarianet Store`,
        html,
    });
}

/**
 * Kirim email notifikasi ORDER FAILED / CANCELLED ke pembeli.
 * CATATAN: error_message internal TIDAK dikirimkan ke user.
 * @param {Object} order - Data order dari Supabase
 * @returns {Promise<{success: boolean, messageId?: string, provider?: string, fallback?: boolean, error?: string}>}
 */
async function sendOrderFailedEmail(order) {
    const waNumber = await getWaCsNumber();
    const html = buildFailedEmailHtml(order, waNumber);

    return sendEmail({
        to: order.email,
        subject: `❌ Pesanan ${order.id} Gagal Diproses — Noxarianet Store`,
        html,
    });
}

module.exports = {
    sendEmail,
    sendOrderCompletedEmail,
    sendOrderFailedEmail,
    getResendTransporter,
    getBrevoTransporter,
};
