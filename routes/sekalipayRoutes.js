const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const sekalipayService = require('../services/sekalipayService');
const syncService = require('../services/syncService');

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — No authentication required
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sekalipay/items
 * List all active Sekalipay products with sell_price.
 * Supports: ?category=, ?search=, ?page=, ?per_page=
 */
router.get('/items', async (req, res) => {
    try {
        const { category, search, page = 1, per_page = 50 } = req.query;
        const limit = Math.min(parseInt(per_page) || 50, 200);
        const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

        let query = supabase
            .from('products')
            .select('*', { count: 'exact' })
            .eq('is_active', true)
            .not('sekalipay_product_id', 'is', null)
            .order('category', { ascending: true })
            .order('name', { ascending: true })
            .range(offset, offset + limit - 1);

        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            query = query.or(`name.ilike.%${search}%,category.ilike.%${search}%`);
        }

        const { data, error, count } = await query;
        if (error) throw error;

        // Return products with sell_price (not base_price) for public view
        const publicProducts = (data || []).map(p => ({
            ...p,
            variants: (p.variants || [])
                .filter(v => p.sekalipay_product_id ? v.stock > 0 : true) // Only filter stock for Sekalipay products
                .map(v => ({
                    id: v.id,
                    sku: v.sku,
                    name: v.name,
                    price: p.sekalipay_product_id ? v.sell_price : v.price, // Use sell_price for Sekalipay, original price for manual products
                    stock: v.stock,
                    order_process: v.order_process,
                    required_fields: v.required_fields,
                    validation: v.validation,
                    provider_meta: v.provider_meta,
                })),
        }));

        res.json({
            data: publicProducts,
            meta: {
                total: count,
                page: parseInt(page) || 1,
                per_page: limit,
                total_pages: Math.ceil((count || 0) / limit),
            },
        });
    } catch (err) {
        console.error('GET /sekalipay/items error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/sekalipay/items/:id
 * Get a single product detail (public view with sell_price).
 */
router.get('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('id', id)
            .eq('is_active', true)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        // Public view — show sell_price as "price"
        const publicProduct = {
            ...data,
            variants: (data.variants || []).map(v => ({
                id: v.id,
                sku: v.sku,
                name: v.name,
                price: data.sekalipay_product_id ? v.sell_price : v.price,
                stock: v.stock,
                order_process: v.order_process,
                required_fields: v.required_fields,
                validation: v.validation,
                provider_meta: v.provider_meta,
            })),
        };

        res.json(publicProduct);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/sekalipay/categories
 * Get unique categories from products.
 */
router.get('/categories', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('category')
            .eq('is_active', true)
            .not('sekalipay_product_id', 'is', null);

        if (error) throw error;

        const categories = [...new Set((data || []).map(p => p.category))].sort();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sekalipay/validate
 * Proxy account validation to Sekalipay API.
 */
router.post('/validate', async (req, res) => {
    try {
        const { item_id, customer_id, zone_id } = req.body;

        if (!item_id || !customer_id) {
            return res.status(400).json({ error: 'item_id dan customer_id wajib diisi' });
        }

        const result = await sekalipayService.validateAccount(item_id, customer_id, zone_id);
        if (!result.success) {
            return res.status(result.status || 400).json({
                error: result.message,
                errors: result.errors,
            });
        }

        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Admin routes have been moved to sekalipayAdminRoutes.js

module.exports = router;
