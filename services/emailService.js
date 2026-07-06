/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — Email Service (Nodemailer + Resend SMTP)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Service untuk pengiriman email transaksional menggunakan Nodemailer
 * via SMTP relay dari Resend (smtp.resend.com:465).
 *
 * Env Variables:
 *   RESEND_API_KEY   — API key dari Resend (digunakan sebagai SMTP password)
 *   SMTP_FROM_EMAIL  — Alamat pengirim (harus verified di Resend)
 *   SMTP_FROM_NAME   — Nama pengirim (display name)
 */

const nodemailer = require('nodemailer');
const { buildCompletedEmailHtml, buildFailedEmailHtml } = require('../templates/emailTemplates');

// ══════════════════════════════════════════════════════════════════════════
// SMTP TRANSPORTER SETUP
// ══════════════════════════════════════════════════════════════════════════

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@noxarianet.web.id';
const FROM_NAME = process.env.SMTP_FROM_NAME || 'Noxarianet Store';

/**
 * Lazy-initialized Nodemailer transporter.
 * Hanya dibuat saat pertama kali dibutuhkan agar tidak crash jika env belum diset.
 * @type {import('nodemailer').Transporter|null}
 */
let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    if (!RESEND_API_KEY) {
        console.warn('[EmailService] RESEND_API_KEY belum diset di .env — email tidak akan dikirim.');
        return null;
    }

    transporter = nodemailer.createTransport({
        host: 'smtp.resend.com',
        port: 465,
        secure: true,
        auth: {
            user: 'resend',
            pass: RESEND_API_KEY,
        },
    });

    console.log('[EmailService] SMTP transporter berhasil diinisialisasi (Resend).');
    return transporter;
}

// ══════════════════════════════════════════════════════════════════════════
// SEND EMAIL (internal helper)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Kirim email menggunakan transporter Nodemailer.
 * @param {Object} options
 * @param {string} options.to - Email penerima
 * @param {string} options.subject - Subject email
 * @param {string} options.html - Body email dalam HTML
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmail({ to, subject, html }) {
    const smtp = getTransporter();

    if (!smtp) {
        console.warn('[EmailService] Transporter tidak tersedia — skip pengiriman email.');
        return { success: false, error: 'SMTP transporter not configured' };
    }

    if (!to) {
        console.warn('[EmailService] Alamat email penerima kosong — skip.');
        return { success: false, error: 'Recipient email is empty' };
    }

    try {
        const info = await smtp.sendMail({
            from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
            to,
            subject,
            html,
        });

        console.log(`[EmailService] Email terkirim ke ${to} — messageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error(`[EmailService] Gagal kirim email ke ${to}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Kirim email notifikasi ORDER COMPLETED (sukses) ke pembeli.
 * Memuat data akun/license dari account_details.
 * @param {Object} order - Data order lengkap dari Supabase
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendOrderCompletedEmail(order) {
    const html = buildCompletedEmailHtml(order);

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
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendOrderFailedEmail(order) {
    const html = buildFailedEmailHtml(order);

    return sendEmail({
        to: order.email,
        subject: `❌ Pesanan ${order.id} Gagal Diproses — Noxarianet Store`,
        html,
    });
}

module.exports = { sendOrderCompletedEmail, sendOrderFailedEmail };
