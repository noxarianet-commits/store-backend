const supabase = require('../supabase');
const cacheService = require('../services/cacheService');

/**
 * GET /api/services
 * List all services ordered by created_at.
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/services/:id
 * Get a single service by ID.
 * Returns 404 for inactive services.
 */
async function getById(req, res) {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!data || data.is_active === false) {
            return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        }
        res.json({ ...data, is_service_table: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/services
 * Create a new service. (Protected)
 */
async function create(req, res) {
    try {
        const { data, error } = await supabase
            .from('services')
            .insert([req.body]);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * PUT /api/services/:id
 * Update a service by ID. (Protected)
 */
async function update(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('services')
            .update(req.body)
            .eq('id', id);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * DELETE /api/services/:id
 * Delete a service by ID. (Protected)
 */
async function remove(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('services')
            .delete()
            .eq('id', id);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list, getById, create, update, remove };
