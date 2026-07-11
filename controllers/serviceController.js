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

module.exports = { list, create, update, remove };
