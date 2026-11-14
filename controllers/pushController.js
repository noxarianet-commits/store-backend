const pushService = require('../services/pushService');
const { logger } = require('../utils/logger');

const controllerLog = logger.child({ job: 'push-controller' });

// ── Aplikasi Android (di balik verifyAppUser) ───────────────────────────────

/**
 * POST /api/mobile/devices
 * Daftarkan / perbarui Expo Push Token milik user yang login.
 */
async function registerDevice(req, res) {
    try {
        const { push_token, platform, app_version } = req.body || {};

        if (!push_token || typeof push_token !== 'string') {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                error: 'push_token wajib diisi.',
            });
        }

        const trimmed = push_token.trim();
        if (trimmed.length < 10 || trimmed.length > 512) {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                error: 'push_token tidak valid.',
            });
        }

        const result = await pushService.registerDevice({
            userId: req.user.id,
            pushToken: trimmed,
            platform,
            appVersion: app_version,
        });

        if (!result.success) {
            // Sesi untuk akun yang sudah dihapus ("sesi hantu"): token JWT masih
            // valid tapi user_profiles-nya sudah tidak ada. Endpoint ini best-
            // effort, jadi balas 200 dengan registered:false — jangan 500.
            if (result.reason === 'user_not_found') {
                return res.json({
                    success: true,
                    data: { registered: false, reason: 'user_not_found' },
                });
            }

            return res.status(500).json({
                success: false,
                code: 'DEVICE_REGISTER_FAILED',
                error: 'Gagal mendaftarkan perangkat.',
            });
        }

        return res.json({ success: true, data: { registered: true } });
    } catch (err) {
        controllerLog.error('push_register_device_error', { message: err.message });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            error: 'Terjadi kesalahan server.',
        });
    }
}

/**
 * DELETE /api/mobile/devices
 * Nonaktifkan push token (dipanggil saat user logout).
 * Token boleh dikirim lewat query string (?push_token=) atau body —
 * sebagian proxy membuang body pada request DELETE.
 */
async function unregisterDevice(req, res) {
    try {
        const push_token = req.query?.push_token || req.body?.push_token;

        // Tanpa token tetap sukses — logout tidak boleh gagal karena notifikasi.
        if (!push_token || typeof push_token !== 'string') {
            return res.json({ success: true, data: { unregistered: false } });
        }

        await pushService.unregisterDevice({
            userId: req.user.id,
            pushToken: push_token.trim(),
        });

        return res.json({ success: true, data: { unregistered: true } });
    } catch (err) {
        controllerLog.warn('push_unregister_device_error', { message: err.message });
        return res.json({ success: true, data: { unregistered: false } });
    }
}

/**
 * GET /api/mobile/devices
 * Daftar perangkat milik user yang login (tanpa isi push_token).
 */
async function listDevices(req, res) {
    try {
        const devices = await pushService.listUserDevices(req.user.id);
        return res.json({ success: true, data: { devices } });
    } catch (err) {
        controllerLog.error('push_list_devices_error', { message: err.message });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            error: 'Terjadi kesalahan server.',
        });
    }
}

// ── Panel admin (di balik verifyAdmin) ──────────────────────────────────────

/**
 * POST /api/admin/push/broadcast
 * Kirim pengumuman ke semua perangkat aktif.
 */
async function broadcast(req, res) {
    try {
        const { title, body, url } = req.body || {};

        const cleanTitle = String(title || '').trim();
        const cleanBody = String(body || '').trim();
        const cleanUrl = url ? String(url).trim() : null;

        if (!cleanTitle || cleanTitle.length > 80) {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                error: 'Judul wajib diisi (maksimal 80 karakter).',
            });
        }

        if (!cleanBody || cleanBody.length > 250) {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                error: 'Pesan wajib diisi (maksimal 250 karakter).',
            });
        }

        if (cleanUrl && !cleanUrl.startsWith('/')) {
            return res.status(400).json({
                success: false,
                code: 'VALIDATION_ERROR',
                error: 'URL harus berupa path dalam aplikasi, misalnya /katalog.',
            });
        }

        const result = await pushService.broadcast({
            title: cleanTitle,
            body: cleanBody,
            url: cleanUrl,
        });

        controllerLog.info('push_broadcast_dispatched', {
            adminId: req.admin?.id,
            sent: result.sent,
            failed: result.failed,
        });

        return res.json({ success: true, data: result });
    } catch (err) {
        controllerLog.error('push_broadcast_error', { message: err.message });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            error: 'Gagal mengirim notifikasi.',
        });
    }
}

/**
 * GET /api/admin/push/history
 */
async function history(req, res) {
    try {
        const notifications = await pushService.getPushHistory(req.query?.limit);
        return res.json({ success: true, data: { notifications } });
    } catch (err) {
        controllerLog.error('push_history_error', { message: err.message });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            error: 'Terjadi kesalahan server.',
        });
    }
}

/**
 * GET /api/admin/push/stats
 */
async function stats(req, res) {
    try {
        const data = await pushService.getPushStats();
        // push_token bersifat privat — jangan pernah bocor ke admin.
        delete data._deviceRows;
        return res.json({ success: true, data });
    } catch (err) {
        controllerLog.error('push_stats_error', { message: err.message });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            error: 'Terjadi kesalahan server.',
        });
    }
}

module.exports = {
    registerDevice,
    unregisterDevice,
    listDevices,
    broadcast,
    history,
    stats,
};
