const supabase = require('../supabase');
const cacheService = require('../services/cacheService');
const { buildPublicSettings } = require('../utils/publicSettings');
const { logger } = require('../utils/logger');

const PUBLIC_SETTINGS_DEFAULTS = {
    shop_status: { isOpen: true, message: 'Selamat datang!' },
    wa_group_link: 'https://chat.whatsapp.com/HQDNahAemv6GfmZqYZjSSD?s=sw&p=a&ilr=4&amv=3',
};

/**
 * GET /api/settings
 * List public settings only. Secrets and admin-only keys are filtered by an
 * allowlist in utils/publicSettings.js.
 */
async function list(req, res) {
    try {
        const rows = await cacheService.getOrSet(
            cacheService.KEYS.PUBLIC_SETTINGS,
            async () => {
                const { data, error } = await supabase
                    .from('settings')
                    .select('key, value');
                if (error) throw error;
                return data || [];
            },
            60
        );

        res.json(buildPublicSettings(rows, PUBLIC_SETTINGS_DEFAULTS));
    } catch (err) {
        logger.error('settings_public_read_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat pengaturan' });
    }
}

/**
 * GET /api/admin/settings
 * Full settings map for the admin dashboard. This route is protected by
 * verifyAdmin in routes/adminRoutes.js.
 */
async function listAdmin(req, res) {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('key, value');
        if (error) throw error;

        const settingsMap = {};
        for (const row of data || []) {
            settingsMap[row.key] = row.value;
        }

        res.json(settingsMap);
    } catch (err) {
        logger.error('settings_admin_read_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat pengaturan admin' });
    }
}

/**
 * PUT /api/settings/:key
 * Upsert a setting by key. (Protected)
 */
async function update(req, res) {
    try {
        const { key } = req.params;
        const { value } = req.body;

        const { error } = await supabase
            .from('settings')
            .upsert({ key, value }, { onConflict: 'key' });

        if (error) {
            logger.error('settings_update_failed', { key, error });
            return res.status(500).json({ error: 'Gagal menyimpan pengaturan' });
        }

        // Both public settings and the home page embed settings.
        cacheService.invalidateHome();
        logger.info('settings_updated', { key });
        res.json({ success: true });
    } catch (err) {
        logger.error('settings_update_crashed', { key: req.params.key, error: err });
        res.status(500).json({ error: 'Gagal menyimpan pengaturan' });
    }
}

module.exports = { list, listAdmin, update };
