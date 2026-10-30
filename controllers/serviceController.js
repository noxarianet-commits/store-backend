const supabase = require('../supabase');
const cacheService = require('../services/cacheService');
const { toBigIntId } = require('../utils/dbIds');
const { logger } = require('../utils/logger');

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
        logger.error('services_list_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat layanan' });
    }
}

/**
 * GET /api/services/:id
 * Get a single service by ID.
 * Returns 404 for inactive services or non-numeric IDs.
 */
async function getById(req, res) {
    try {
        const serviceId = toBigIntId(req.params.id);
        if (!serviceId) {
            return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        }

        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('id', serviceId)
            .maybeSingle();

        if (error) throw error;
        if (!data || data.is_active === false) {
            return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        }
        res.json({ ...data, is_service_table: true });
    } catch (err) {
        logger.error('service_detail_failed', { serviceId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal memuat layanan' });
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
        logger.error('service_create_failed', { error: err });
        res.status(500).json({ error: 'Gagal membuat layanan' });
    }
}

/**
 * PUT /api/services/:id
 * Update a service by ID. (Protected)
 */
async function update(req, res) {
    try {
        const serviceId = toBigIntId(req.params.id);
        if (!serviceId) {
            return res.status(400).json({ error: 'ID layanan tidak valid' });
        }

        const { error } = await supabase
            .from('services')
            .update(req.body)
            .eq('id', serviceId);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        logger.error('service_update_failed', { serviceId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal memperbarui layanan' });
    }
}

/**
 * DELETE /api/services/:id
 * Delete a service by ID. (Protected)
 */
async function remove(req, res) {
    try {
        const serviceId = toBigIntId(req.params.id);
        if (!serviceId) {
            return res.status(400).json({ error: 'ID layanan tidak valid' });
        }

        const { error } = await supabase
            .from('services')
            .delete()
            .eq('id', serviceId);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        logger.error('service_delete_failed', { serviceId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal menghapus layanan' });
    }
}

module.exports = { list, getById, create, update, remove };
