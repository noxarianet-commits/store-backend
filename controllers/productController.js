const supabase = require('../supabase');
const cacheService = require('../services/cacheService');

/**
 * GET /api/products
 * List all products ordered by created_at.
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/products/:id
 * Get a single product by ID.
 */
async function getById(req, res) {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Produk tidak ditemukan' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/products
 * Create a new product. (Protected)
 */
async function create(req, res) {
    try {
        const { data, error } = await supabase
            .from('products')
            .insert([req.body]);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * PUT /api/products/:id
 * Update a product by ID. (Protected)
 */
async function update(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('products')
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
 * DELETE /api/products/:id
 * Delete a product by ID. (Protected)
 */
async function remove(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('products')
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
