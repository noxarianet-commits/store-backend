const supabase = require('../supabase');
const fs = require('fs');
const path = require('path');

/**
 * GET /api/testimonials
 * List latest 20 testimonials with fallback to db.json.
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase
            .from('testimonials')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);
        if (error) throw error;

        if (!data || data.length === 0) {
            // Fallback ke data/db.json jika Supabase kosong
            try {
                const dbPath = path.join(__dirname, '..', 'data', 'db.json');
                const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                if (dbData.testimonials && dbData.testimonials.length > 0) {
                    return res.json(dbData.testimonials);
                }
            } catch (e) {
                console.error('Error reading fallback testimonials from db.json:', e);
            }
        }

        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list };
