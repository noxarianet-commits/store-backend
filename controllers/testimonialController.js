const supabase = require('../supabase');

/**
 * GET /api/testimonials
 * List latest 20 testimonials from Supabase.
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase
            .from('testimonials')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/testimonials
 * Simpan testimoni baru setelah pesanan selesai.
 * Body: name, text, product, rating (1-5), order_id
 */
async function create(req, res) {
    try {
        const { name, text, product, rating, order_id } = req.body;

        if (!name || !text) {
            return res.status(400).json({ error: 'Nama dan pesan testimoni wajib diisi.' });
        }

        const ratingVal = Math.min(5, Math.max(1, parseInt(rating) || 5));

        const { data, error } = await supabase
            .from('testimonials')
            .insert([{
                name,
                text,
                product: product || null,
                rating: ratingVal,
                order_id: order_id || null,
            }])
            .select()
            .single();

        if (error) throw error;

        console.log(`[testimonial] Testimoni dari ${name} (rating: ${ratingVal}, order: ${order_id})`);
        res.status(201).json({ success: true, data });
    } catch (err) {
        console.error('[testimonialController] create error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list, create };
