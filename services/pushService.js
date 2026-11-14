const axios = require('axios');
const { randomUUID } = require('crypto');

const supabase = require('../supabase');
const { logger } = require('../utils/logger');

const pushLog = logger.child({ job: 'push' });

// ── Konfigurasi ─────────────────────────────────────────────────────────────
// Expo Push Service: https://docs.expo.dev/push-notifications/sending-notifications/
// Endpoint ini tidak butuh autentikasi, tapi BISA diberi access token lewat
// EXPO_ACCESS_TOKEN supaya token push yang bocor tidak bisa dipakai pihak lain.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

// Batas resmi Expo: maksimal 100 notifikasi per request.
const MAX_TOKENS_PER_REQUEST = 100;

function pushEnabled() {
    return String(process.env.PUSH_ENABLED || 'true').toLowerCase() !== 'false';
}

function channelId() {
    return process.env.PUSH_CHANNEL_ID || 'noxarianet_transaksi';
}

function requestTimeoutMs() {
    const n = Number(process.env.PUSH_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 5000;
}

function expoHeaders() {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    const token = process.env.EXPO_ACCESS_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// ── Format pesan ────────────────────────────────────────────────────────────
function formatRupiah(amount) {
    const n = Number(amount) || 0;
    return `Rp${n.toLocaleString('id-ID')}`;
}

function orderLabel(order) {
    if (!order) return 'pesanan Anda';
    const product = order.product || 'pesanan';
    const variant = order.variant && order.variant !== '-' ? order.variant : null;
    return variant ? `${product} (${variant})` : product;
}

// ── Pagar anti-duplikat ─────────────────────────────────────────────────────
/**
 * Catat niat mengirim notifikasi. Bila dedupe_key sudah pernah dipakai
 * (unique violation), artinya event ini sudah pernah dinotifikasi — skip.
 *
 * @returns {{ id?: string, alreadySent: boolean }}
 */
async function reserveNotification({ userId, dedupeKey, event, title, body, data }) {
    const { data: row, error } = await supabase
        .from('push_notifications')
        .insert([{
            user_id: userId || null,
            dedupe_key: dedupeKey,
            event,
            title,
            body,
            data: data || {},
        }])
        .select('id')
        .single();

    if (error) {
        if (error.code === '23505') return { alreadySent: true };
        throw error;
    }
    return { id: row.id, alreadySent: false };
}

async function finalizeNotification(id, patch) {
    if (!id) return;
    try {
        await supabase.from('push_notifications').update(patch).eq('id', id);
    } catch (err) {
        pushLog.warn('push_log_update_failed', { id, message: err.message });
    }
}

// ── Perangkat terdaftar ─────────────────────────────────────────────────────
async function registerDevice({ userId, pushToken, platform, appVersion }) {
    if (!userId || !pushToken) {
        return { success: false, error: 'user_id dan push_token wajib diisi' };
    }

    const cleanToken = String(pushToken).trim();
    const cleanPlatform = String(platform || 'android').toLowerCase();

    const { error } = await supabase
        .from('push_devices')
        .upsert([{
            push_token: cleanToken,
            user_id: userId,
            platform: ['android', 'ios', 'web'].includes(cleanPlatform) ? cleanPlatform : 'android',
            app_version: appVersion ? String(appVersion) : null,
            active: true,
            last_seen_at: new Date().toISOString(),
        }], { onConflict: 'push_token' });

    if (error) {
        // 23503 = foreign key violation: baris user_profiles untuk user ini sudah
        // tidak ada. Tokennya masih valid secara kriptografis (masa berlaku 30
        // hari) tapi akunnya sudah dihapus — "sesi hantu". Ini bukan kesalahan
        // sistem, jadi jangan log sebagai ERROR dan jangan balas 500.
        if (error.code === '23503') {
            pushLog.warn('push_device_register_unknown_user', { userId });
            return { success: false, reason: 'user_not_found' };
        }

        pushLog.error('push_device_register_failed', { userId, message: error.message });
        return { success: false, error: error.message };
    }

    pushLog.info('push_device_registered', { userId, platform: cleanPlatform });
    return { success: true };
}

async function unregisterDevice({ userId, pushToken }) {
    if (!userId || !pushToken) return { success: true };

    const { error } = await supabase
        .from('push_devices')
        .update({ active: false })
        .eq('push_token', String(pushToken).trim())
        .eq('user_id', userId);

    if (error) {
        pushLog.warn('push_device_unregister_failed', { userId, message: error.message });
        return { success: false, error: error.message };
    }

    return { success: true };
}

async function listUserDevices(userId) {
    const { data, error } = await supabase
        .from('push_devices')
        .select('id, platform, app_version, active, last_seen_at, created_at')
        .eq('user_id', userId)
        .order('last_seen_at', { ascending: false });

    if (error) return [];
    return data || [];
}

async function getActiveTokens(userId) {
    let query = supabase
        .from('push_devices')
        .select('id, push_token, user_id')
        .eq('active', true);

    if (userId) query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) {
        pushLog.error('push_tokens_query_failed', { userId, message: error.message });
        return [];
    }
    return data || [];
}

// ── Kirim ke Expo Push Service ──────────────────────────────────────────────
/**
 * Apakah sebuah kegagalan pengiriman bersifat sementara (layak dicoba ulang)?
 * - Tidak ada respons sama sekali → gangguan jaringan → transien
 * - 408 / 429 → timeout / kena rate limit → transien
 * - 5xx → gangguan layanan Expo → transien
 * - 4xx lain (400 payload salah, 401 kredensial, 404) → permanen, jangan diulang
 */
function isTransientStatus(status) {
    if (status === null || status === undefined) return true;
    const n = Number(status);
    if (!Number.isFinite(n)) return true;
    return n === 408 || n === 429 || n >= 500;
}

/**
 * Kirim satu pesan ke daftar token, dibagi per MAX_TOKENS_PER_REQUEST.
 *
 * Mengembalikan { sent, failed, deadTokenIds, ticketIds, errors }.
 * Tidak pernah melempar error — pengiriman notifikasi harus bisa gagal
 * tanpa mengganggu alur bisnis (order / refund / webhook).
 */
async function deliverToTokens(tokens, message) {
    const result = { sent: 0, failed: 0, deadTokenIds: [], ticketIds: [], errors: [] };

    for (let i = 0; i < tokens.length; i += MAX_TOKENS_PER_REQUEST) {
        const chunk = tokens.slice(i, i + MAX_TOKENS_PER_REQUEST);
        const payload = chunk.map((t) => ({
            to: t.push_token,
            title: message.title,
            body: message.body,
            data: message.data || {},
            // Wajib sama dengan channel yang dibuat aplikasi. Kalau channelId
            // menunjuk channel yang belum ada di perangkat, notifikasi TIDAK
            // tampil sama sekali.
            channelId: message.channelId || channelId(),
            sound: 'default',
            priority: 'high',
            ttl: message.ttl || 24 * 60 * 60,
        }));

        try {
            const res = await axios.post(EXPO_PUSH_URL, payload, {
                headers: expoHeaders(),
                timeout: requestTimeoutMs(),
            });

            const tickets = res.data?.data || [];
            tickets.forEach((ticket, idx) => {
                const device = chunk[idx];
                if (!device) return;

                if (ticket.status === 'ok') {
                    result.sent++;
                    if (ticket.id) result.ticketIds.push(ticket.id);
                    return;
                }

                result.failed++;
                result.errors.push({ message: ticket.message, code: ticket.details?.error });

                // Device sudah tidak terdaftar di FCM (app di-uninstall /
                // izin dicabut) — jangan kirim lagi ke token ini.
                if (ticket.details?.error === 'DeviceNotRegistered') {
                    result.deadTokenIds.push(device.id);
                }
            });
        } catch (err) {
            // Gagal di tingkat HTTP (network / 429 / 5xx) — seluruh chunk dihitung
            // gagal. Bila semua kegagalan bersifat transien, pemanggil menghapus
            // reservasi supaya notifikasi bisa dicoba lagi nanti.
            const status = err.response?.status ?? null;
            result.failed += chunk.length;
            result.errors.push({
                message: err.message,
                code: status ?? 'NETWORK',
                transient: isTransientStatus(status),
            });
            pushLog.warn('push_send_chunk_failed', {
                chunkSize: chunk.length,
                status,
                message: err.message,
            });
        }
    }

    if (result.deadTokenIds.length > 0) {
        try {
            await supabase
                .from('push_devices')
                .update({ active: false })
                .in('id', result.deadTokenIds);
            pushLog.info('push_tokens_deactivated', { count: result.deadTokenIds.length });
        } catch (err) {
            pushLog.warn('push_tokens_deactivate_failed', { message: err.message });
        }
    }

    return result;
}

/**
 * Batasi waktu tunggu sebuah promise. Pengiriman push adalah best-effort:
 * pemanggil (webhook / polling order) tidak boleh ikut melambat hanya karena
 * Expo Push Service lambat. Bila deadline lewat, pengiriman tetap berjalan di
 * latar belakang — pagar dedupe sudah dipasang lebih dulu, jadi aman.
 */
function withDeadline(promise, ms = 2500) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve({ skipped: true, reason: 'deadline' }), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Kirim notifikasi ke semua perangkat aktif milik satu user.
 * Aman dipanggil dari mana pun — tidak pernah melempar.
 */
async function sendPushToUser(userId, { title, body, data, dedupeKey, event }) {
    try {
        if (!pushEnabled()) return { skipped: true, reason: 'disabled' };
        if (!userId || !title || !body) return { skipped: true, reason: 'invalid_args' };

        if (dedupeKey) {
            // 1. Reservasi lebih dulu (satu INSERT cepat) — inilah pagar
            //    anti-duplikat. Bila sudah pernah ada, hentikan di sini.
            const reservation = await reserveNotification({
                userId, dedupeKey, event: event || 'system', title, body, data,
            });
            if (reservation.alreadySent) {
                pushLog.debug('push_dedupe_skip', { dedupeKey });
                return { skipped: true, reason: 'duplicate' };
            }

            // 2. Kirim — dibatasi waktunya supaya alur order tidak tertahan.
            return await withDeadline((async () => {
                const tokens = await getActiveTokens(userId);
                if (tokens.length === 0) {
                    await finalizeNotification(reservation.id, {
                        status: 'failed', error: 'Tidak ada perangkat terdaftar',
                        target_count: 0, sent_count: 0, failed_count: 0,
                    });
                    return { skipped: true, reason: 'no_devices' };
                }

                const outcome = await deliverToTokens(tokens, { title, body, data });

                // Semua kegagalan bersifat sementara (jaringan / 5xx / rate limit)
                // → hapus reservasi supaya notifikasi bisa dicoba ulang.
                // Kegagalan permanen (payload salah / kredensial) dibiarkan sebagai
                // 'failed' — mengulangnya tidak akan membantu.
                const allTransient = outcome.errors.length > 0
                    && outcome.errors.every((e) => e.transient === true);
                if (outcome.sent === 0 && outcome.failed > 0 && allTransient) {
                    await supabase.from('push_notifications').delete().eq('id', reservation.id);
                } else {
                    await finalizeNotification(reservation.id, {
                        status: outcome.sent > 0 ? 'sent' : 'failed',
                        target_count: tokens.length,
                        sent_count: outcome.sent,
                        failed_count: outcome.failed,
                        ticket_id: outcome.ticketIds[0] || null,
                        error: outcome.errors[0]?.message || null,
                    });
                }

                return outcome;
            })());
        }

        // Tanpa dedupeKey (broadcast) — pemanggil yang mengelola log-nya.
        const tokens = await getActiveTokens(userId);
        if (tokens.length === 0) return { skipped: true, reason: 'no_devices' };
        return await deliverToTokens(tokens, { title, body, data });
    } catch (err) {
        pushLog.error('push_send_failed', { userId, message: err.message });
        return { skipped: true, reason: 'error', error: err.message };
    }
}

// ── Template notifikasi transaksi ───────────────────────────────────────────
async function notifyOrderCompleted(order) {
    if (!order?.user_id) return { skipped: true, reason: 'no_user' };
    return sendPushToUser(order.user_id, {
        title: 'Transaksi Berhasil! 🎉',
        body: `Pesanan ${orderLabel(order)} telah selesai diproses. Tekan untuk melihat detail.`,
        data: {
            type: 'order_status',
            order_id: order.id,
            status: 'COMPLETED',
            url: `/pesanan/${order.id}`,
        },
        dedupeKey: `order:${order.id}:completed`,
        event: 'order_completed',
    });
}

async function notifyOrderFailed(order) {
    if (!order?.user_id) return { skipped: true, reason: 'no_user' };
    const refunded = ['REFUNDED', 'REFUND_PENDING'].includes(String(order.status || '').toUpperCase());
    return sendPushToUser(order.user_id, {
        title: 'Transaksi Gagal ❌',
        body: refunded
            ? `Pesanan ${orderLabel(order)} gagal diproses. Saldo akan dikembalikan ke akunmu.`
            : `Pesanan ${orderLabel(order)} gagal diproses. Tekan untuk melihat detail.`,
        data: {
            type: 'order_status',
            order_id: order.id,
            status: order.status || 'FAILED',
            url: `/pesanan/${order.id}`,
        },
        dedupeKey: `order:${order.id}:failed`,
        event: 'order_failed',
    });
}

async function notifyTopupCredited({ userId, amount, referenceId }) {
    if (!userId) return { skipped: true, reason: 'no_user' };
    return sendPushToUser(userId, {
        title: 'Saldo Berhasil Masuk! 💰',
        body: `Top up sebesar ${formatRupiah(amount)} berhasil ditambahkan ke saldo akunmu.`,
        data: {
            type: 'topup',
            reference_id: referenceId || null,
            amount: Number(amount) || 0,
            url: '/saldo/riwayat',
        },
        dedupeKey: referenceId ? `topup:${referenceId}:credited` : null,
        event: 'topup_credited',
    });
}

// ── Broadcast admin ─────────────────────────────────────────────────────────
/**
 * Kirim pengumuman ke semua perangkat aktif. Dipakai endpoint admin
 * POST /api/admin/push/broadcast.
 */
async function broadcast({ title, body, url }) {
    if (!pushEnabled()) return { skipped: true, reason: 'disabled' };

    const dedupeKey = `broadcast:${randomUUID()}`;
    const data = { type: 'broadcast', url: url || null };

    const reservation = await reserveNotification({
        userId: null,
        dedupeKey,
        event: 'broadcast',
        title,
        body,
        data,
    });

    const tokens = await getActiveTokens();
    const totalDevices = tokens.length;

    if (totalDevices === 0) {
        await finalizeNotification(reservation.id, {
            status: 'failed',
            error: 'Tidak ada perangkat terdaftar',
            target_count: 0,
        });
        return { devices_total: 0, devices_active: 0, sent: 0, failed: 0, skipped: 0 };
    }

    const outcome = await deliverToTokens(tokens, { title, body, data });

    await finalizeNotification(reservation.id, {
        status: outcome.sent > 0 ? 'sent' : 'failed',
        target_count: totalDevices,
        sent_count: outcome.sent,
        failed_count: outcome.failed,
        ticket_id: outcome.ticketIds[0] || null,
        error: outcome.errors[0]?.message || null,
    });

    return {
        devices_total: totalDevices,
        devices_active: totalDevices,
        sent: outcome.sent,
        failed: outcome.failed,
        skipped: 0,
    };
}

// ── Statistik & riwayat untuk panel admin ───────────────────────────────────
async function getPushStats() {
    const [devices, notifications] = await Promise.all([
        supabase.from('push_devices').select('id, active', { count: 'exact', head: true }),
        supabase.from('push_notifications').select('id, status'),
    ]);

    const deviceRows = devices.data || [];
    const notifRows = notifications.data || [];

    // head:true tidak mengembalikan baris, jadi hitung pakai dua query ringan.
    const [{ count: devicesTotal }, { count: devicesActive }] = await Promise.all([
        supabase.from('push_devices').select('*', { count: 'exact', head: true }),
        supabase.from('push_devices').select('*', { count: 'exact', head: true }).eq('active', true),
    ]);

    return {
        devices_total: devicesTotal || 0,
        devices_active: devicesActive || 0,
        devices_inactive: Math.max(0, (devicesTotal || 0) - (devicesActive || 0)),
        notifications_sent: notifRows.filter((r) => r.status === 'sent').length,
        notifications_failed: notifRows.filter((r) => r.status === 'failed').length,
        // Dipakai frontend untuk label "kirim ke N perangkat"
        _deviceRows: deviceRows.length,
    };
}

async function getPushHistory(limit = 20) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const { data, error } = await supabase
        .from('push_notifications')
        .select('id, event, title, body, data, status, target_count, sent_count, failed_count, created_at')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

    if (error) return [];
    return data || [];
}

// ── Utilitas untuk pengujian / operasional ──────────────────────────────────
/**
 * Ambil push receipt dari Expo. Ticket_id harus diperoleh dari pengiriman
 * sebelumnya. Opsional — dipakai untuk diagnosa, bukan alur utama.
 */
async function fetchPushReceipts(ticketIds = []) {
    if (ticketIds.length === 0) return {};
    try {
        const res = await axios.post(EXPO_RECEIPTS_URL, { ids: ticketIds.slice(0, 1000) }, {
            headers: expoHeaders(),
            timeout: requestTimeoutMs(),
        });
        return res.data?.data || {};
    } catch (err) {
        pushLog.warn('push_receipts_failed', { message: err.message });
        return {};
    }
}

module.exports = {
    // Perangkat
    registerDevice,
    unregisterDevice,
    listUserDevices,
    getActiveTokens,

    // Pengiriman
    sendPushToUser,
    deliverToTokens,

    // Template
    notifyOrderCompleted,
    notifyOrderFailed,
    notifyTopupCredited,
    broadcast,

    // Operasional
    getPushStats,
    getPushHistory,
    fetchPushReceipts,

    // Ter-ekspor untuk unit test
    __test: {
        pushEnabled,
        channelId,
        requestTimeoutMs,
        expoHeaders,
        formatRupiah,
        orderLabel,
        reserveNotification,
        isTransientStatus,
        MAX_TOKENS_PER_REQUEST,
        EXPO_PUSH_URL,
    },
};
