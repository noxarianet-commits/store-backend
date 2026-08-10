const supabase = require('../supabase');
const cacheService = require('../services/cacheService');

/**
 * GET /api/settings
 * List all public settings (non-sensitive keys filtered out).
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*');
        if (error) throw error;

        const settingsMap = {
            shop_status: { isOpen: true, message: 'Selamat datang!' },
            wa_group_link: 'https://chat.whatsapp.com/HQDNahAemv6GfmZqYZjSSD?s=sw&p=a&ilr=4&amv=3'
            // CATATAN: admin_auth TIDAK lagi ada di settings — sudah dipindah ke tabel admins
        };
        data.forEach(s => {
            // Pastikan kunci sensitif tidak pernah ter-expose ke publik
            if (s.key !== 'admin_auth') {
                settingsMap[s.key] = s.value;
            }
        });
        res.json(settingsMap);
    } catch (err) {
        console.error('GET Settings Error:', err);
        res.status(500).json({ error: err.message });
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
        console.log(`Updating setting: ${key}`);

        const { error } = await supabase
            .from('settings')
            .upsert({ key, value }, { onConflict: 'key' });

        if (error) {
            console.error('Supabase Error:', error);
            return res.status(500).json({ error: error.message });
        }
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        console.error('UPDATE Settings Error:', err);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list, update };
