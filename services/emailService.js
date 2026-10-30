/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOXARIANET STORE — Email Service (Resend → Brevo → Mailketing Fallback)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Service untuk pengiriman email transaksional dengan 3-tier fallback:
 * - Primary    : Resend SMTP relay (smtp.resend.com:465)
 * - Fallback 1 : Brevo SMTP relay (smtp-relay.brevo.com:587)
 * - Fallback 2 : Mailketing HTTP API (api.mailketing.co.id/api/v2/send)
 *
 * Saat provider kena limit / quota / error, relay tersebut di-MARK COOLDOWN
 * sehingga email berikutnya langsung dikirim via provider berikutnya tanpa
 * mencoba lagi. Cooldown berakhir otomatis setelah SMTP_FAILOVER_COOLDOWN_MS
 * (default 15 menit).
 *
 * Env Variables:
 *   RESEND_API_KEY    — API key dari Resend (digunakan sebagai SMTP password)
 *   BREVO_SMTP_USER   — Username / email akun Brevo
 *   BREVO_SMTP_KEY    — SMTP key dari Brevo (atau BREVO_API_KEY)
 *   BREVO_SMTP_HOST   — Host Brevo SMTP (default: smtp-relay.brevo.com)
 *   BREVO_SMTP_PORT   — Port Brevo SMTP (default: 587)
 *   BREVO_SMTP_SECURE — Boolean string 'true' / 'false' (default: false pada port 587)
 *   MAILKETING_API_TOKEN — API token dari Mailketing (menu API Integration)
 *   MAILKETING_FROM_EMAIL — Alamat pengirim Mailketing (opsional, default: SMTP_FROM_EMAIL)
 *   SMTP_FROM_EMAIL   — Alamat pengirim (harus verified di Resend / Brevo / Mailketing)
 *   SMTP_FROM_NAME    — Nama pengirim (display name)
 *   SMTP_FAILOVER_COOLDOWN_MS — Lama cooldown per-provider setelah kena limit (default: 900000 = 15 menit)
 */

const nodemailer = require('nodemailer');
const supabase = require('../supabase');
const { maskEmail } = require('../utils/logger');
const {
    buildCompletedEmailHtml,
    buildFailedEmailHtml,
    buildVerificationEmailHtml,
    buildResetPasswordEmailHtml,
} = require('../templates/emailTemplates');

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

// ══════════════════════════════════════════════════════════════════════════
// FAILOVER STATE (in-memory, per-process)
// ══════════════════════════════════════════════════════════════════════════

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = (() => {
    const raw = parseInt(process.env.SMTP_FAILOVER_COOLDOWN_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_MS;
})();

/** Timestamp (ms) kapan Resend boleh dicoba lagi. 0 = tidak dalam cooldown. */
let resendCooldownUntil = 0;
/** Timestamp (ms) kapan Brevo boleh dicoba lagi. 0 = tidak dalam cooldown. */
let brevoCooldownUntil = 0;

function isResendInCooldown() {
    return Date.now() < resendCooldownUntil;
}

function isBrevoInCooldown() {
    return Date.now() < brevoCooldownUntil;
}

function getResendCooldownRemainingMs() {
    return Math.max(0, resendCooldownUntil - Date.now());
}

function getBrevoCooldownRemainingMs() {
    return Math.max(0, brevoCooldownUntil - Date.now());
}

/**
 * Format durasi ms jadi string yang enak dibaca untuk log.
 * @param {number} ms
 * @returns {string} contoh: "15 menit" / "30 detik"
 */
function formatCooldownDuration(ms) {
    if (ms < 60000) {
        return `${Math.max(1, Math.round(ms / 1000))} detik`;
    }
    return `${Math.round(ms / 60000)} menit`;
}

function markResendCooldown(reason) {
    resendCooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
    console.warn(
        `[EmailService] Resend masuk cooldown ${formatCooldownDuration(RESEND_COOLDOWN_MS)} (${reason}). ` +
        'Email berikutnya dialihkan ke Brevo / Mailketing.'
    );
}

function markBrevoCooldown(reason) {
    brevoCooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
    console.warn(
        `[EmailService] Brevo masuk cooldown ${formatCooldownDuration(RESEND_COOLDOWN_MS)} (${reason}). ` +
        'Email berikutnya dialihkan ke Mailketing.'
    );
}

/**
 * Pola error yang menandakan limit / quota (bukan error konfigurasi permanen).
 * 450 = SMTP "greylisting" / throttling, 429 = HTTP rate limit.
 */
const LIMIT_ERROR_PATTERN = /limit|quota|429|450|exceeded|too many|throttl/i;

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
// MAILKETING HTTP API SENDER
// ══════════════════════════════════════════════════════════════════════════

const MAILKETING_BASE_URL = 'https://api.mailketing.co.id/api/v2';

/**
 * Cek apakah Mailketing API token terkonfigurasi.
 * @returns {boolean}
 */
function isMailketingConfigured() {
    return !!process.env.MAILKETING_API_TOKEN;
}

/**
 * Kirim email via Mailketing HTTP API (POST /send).
 * @param {Object} options
 * @param {string} options.to - Email penerima
 * @param {string} options.subject - Subject email
 * @param {string} options.html - Body email (HTML)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendViaMailketing({ to, subject, html }) {
    const apiToken = process.env.MAILKETING_API_TOKEN;
    if (!apiToken) {
        return { success: false, error: 'MAILKETING_API_TOKEN not configured' };
    }

    const fromEmail = process.env.MAILKETING_FROM_EMAIL || FROM_EMAIL;

    const body = JSON.stringify({
        from_name: FROM_NAME,
        from_email: fromEmail,
        subject,
        recipient: to,
        content: html,
    });

    const res = await fetch(`${MAILKETING_BASE_URL}/send`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': apiToken,
        },
        body,
    });

    const json = await res.json();

    if (!res.ok || !json.success) {
        const errMsg = json.message || `HTTP ${res.status}`;
        return { success: false, error: errMsg };
    }

    const messageId = json.data?.message_id || null;
    return { success: true, messageId };
}

// ══════════════════════════════════════════════════════════════════════════
// SEND EMAIL (Resend → Brevo → Mailketing fallback chain)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Coba kirim via Brevo SMTP. Mengembalikan result atau null jika tidak bisa dicoba.
 * @param {import('nodemailer').Transporter|null} brevoSmtp
 * @param {Object} mailOptions
 * @param {string} to
 * @param {string} context - label untuk log (e.g. 'fallback', 'failover cooldown')
 * @returns {Promise<{success: boolean, messageId?: string, provider: string, fallback?: boolean, failover?: boolean, error?: string}|null>}
 */
async function tryBrevo(brevoSmtp, mailOptions, to, context) {
    if (!brevoSmtp || isBrevoInCooldown()) return null;

    console.log(`[EmailService] Mengirim via Brevo SMTP (${context}) ke ${maskEmail(to)}...`);
    try {
        const info = await brevoSmtp.sendMail(mailOptions);
        console.log(`[EmailService] Email terkirim via Brevo (${context}) ke ${maskEmail(to)} — messageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId, provider: 'brevo', fallback: context !== 'primary' };
    } catch (brevoErr) {
        const isLimit = LIMIT_ERROR_PATTERN.test(brevoErr.message || '');
        if (isLimit) {
            console.warn(`[EmailService] Brevo limit/quota terdeteksi (${brevoErr.message}).`);
            markBrevoCooldown(brevoErr.message);
        } else {
            console.warn(`[EmailService] Gagal kirim via Brevo (${context}) ke ${maskEmail(to)}: ${brevoErr.message}`);
        }
        return null; // signal: lanjut ke provider berikutnya
    }
}

/**
 * Coba kirim via Mailketing HTTP API. Mengembalikan result atau null.
 * @param {Object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} context - label untuk log
 * @returns {Promise<{success: boolean, messageId?: string, provider: string, fallback?: boolean, error?: string}|null>}
 */
async function tryMailketing({ to, subject, html }, context) {
    if (!isMailketingConfigured()) return null;

    console.log(`[EmailService] Mengirim via Mailketing API (${context}) ke ${maskEmail(to)}...`);
    try {
        const result = await sendViaMailketing({ to, subject, html });
        if (result.success) {
            console.log(`[EmailService] Email terkirim via Mailketing (${context}) ke ${maskEmail(to)} — messageId: ${result.messageId}`);
            return { success: true, messageId: result.messageId, provider: 'mailketing', fallback: true };
        }
        console.warn(`[EmailService] Mailketing API gagal (${context}) ke ${maskEmail(to)}: ${result.error}`);
        return null;
    } catch (mkErr) {
        console.error(`[EmailService] Mailketing API error (${context}) ke ${maskEmail(to)}:`, mkErr.message);
        return null;
    }
}

/**
 * Kirim email menggunakan 3-tier fallback: Resend → Brevo → Mailketing.
 * @param {Object} options
 * @param {string} options.to - Email penerima
 * @param {string} options.subject - Subject email
 * @param {string} options.html - Body email dalam HTML
 * @returns {Promise<{success: boolean, messageId?: string, provider?: string, fallback?: boolean, failover?: boolean, error?: string}>}
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
    const hasMailketing = isMailketingConfigured();

    if (!resendSmtp && !brevoSmtp && !hasMailketing) {
        console.warn('[EmailService] Tidak ada provider email yang terkonfigurasi (Resend, Brevo, Mailketing belum diset di .env) — skip pengiriman email.');
        return { success: false, error: 'No email provider configured' };
    }

    const errors = [];

    // ── 1. Resend (Primary) ──────────────────────────────────────────────
    if (resendSmtp && !isResendInCooldown()) {
        try {
            const info = await resendSmtp.sendMail(mailOptions);
            console.log(`[EmailService] Email terkirim via Resend ke ${maskEmail(to)} — messageId: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'resend' };
        } catch (resendErr) {
            const isLimit = LIMIT_ERROR_PATTERN.test(resendErr.message || '');
            if (isLimit) {
                console.warn(`[EmailService] Resend limit/quota terdeteksi (${resendErr.message}).`);
                markResendCooldown(resendErr.message);
            } else {
                console.warn(`[EmailService] Gagal kirim via Resend (${resendErr.message}).`);
            }
            errors.push(`Resend: ${resendErr.message}`);
        }
    } else if (resendSmtp && isResendInCooldown()) {
        const remaining = formatCooldownDuration(getResendCooldownRemainingMs());
        console.log(`[EmailService] Resend dalam cooldown (sisa ~${remaining}) — skip.`);
    }

    // ── 2. Brevo (Fallback 1) ────────────────────────────────────────────
    const brevoResult = await tryBrevo(brevoSmtp, mailOptions, to, errors.length ? 'fallback' : 'failover cooldown');
    if (brevoResult) return brevoResult;
    if (brevoSmtp && isBrevoInCooldown()) {
        const remaining = formatCooldownDuration(getBrevoCooldownRemainingMs());
        console.log(`[EmailService] Brevo dalam cooldown (sisa ~${remaining}) — skip.`);
    }

    // ── 3. Mailketing (Fallback 2) ───────────────────────────────────────
    const mkResult = await tryMailketing({ to, subject, html }, 'fallback');
    if (mkResult) return mkResult;

    // ── Semua provider gagal ─────────────────────────────────────────────
    const errorSummary = errors.length
        ? errors.join(' | ')
        : 'Semua provider gagal atau tidak terkonfigurasi';
    console.error(`[EmailService] Semua provider gagal mengirim email ke ${maskEmail(to)}: ${errorSummary}`);
    return { success: false, error: errorSummary };
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Status failover saat ini (untuk debugging / observability).
 * @returns {{resendInCooldown: boolean, resendCooldownRemainingMs: number, brevoInCooldown: boolean, brevoCooldownRemainingMs: number, mailketingConfigured: boolean, cooldownMs: number}}
 */
function getSmtpFailoverStatus() {
    return {
        resendInCooldown: isResendInCooldown(),
        resendCooldownRemainingMs: getResendCooldownRemainingMs(),
        brevoInCooldown: isBrevoInCooldown(),
        brevoCooldownRemainingMs: getBrevoCooldownRemainingMs(),
        mailketingConfigured: isMailketingConfigured(),
        cooldownMs: RESEND_COOLDOWN_MS,
    };
}

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

/**
 * Kirim email OTP verifikasi.
 *
 * Berbeda dengan email notifikasi order, PENGIRIMAN DI-AWAIT oleh pemanggil.
 * Email OTP adalah satu-satunya jalan melewati verifikasi, jadi kegagalan
 * pengiriman tidak boleh diam-diam diabaikan — pemanggil harus membatalkan
 * pending data dan memberi tahu user agar tidak terkunci di layar OTP.
 *
 * @param {Object} options
 * @param {string} options.to - Email penerima
 * @param {string} options.code - Kode OTP 6 digit
 * @param {'register'|'reset_password'} options.purpose - Menentukan template
 * @param {string} [options.displayName] - Nama untuk sapaan
 * @param {number} [options.expiresMinutes=10]
 * @returns {Promise<{success: boolean, messageId?: string, provider?: string, error?: string}>}
 */
async function sendOtpEmail({ to, code, purpose, displayName, expiresMinutes = 10 }) {
    const waNumber = await getWaCsNumber();
    const isRegister = purpose === 'register';

    const html = isRegister
        ? buildVerificationEmailHtml({ code, displayName, expiresMinutes, waNumber })
        : buildResetPasswordEmailHtml({ code, displayName, expiresMinutes, waNumber });

    return sendEmail({
        to,
        subject: isRegister
            ? `Verifikasi Email — Kode ${code} — Noxarianet Store`
            : `Reset Password — Kode ${code} — Noxarianet Store`,
        html,
    });
}

module.exports = {
    sendEmail,
    sendOrderCompletedEmail,
    sendOrderFailedEmail,
    sendOtpEmail,
    getWaCsNumber,
    getResendTransporter,
    getBrevoTransporter,
    getSmtpFailoverStatus,
};
