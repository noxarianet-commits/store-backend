const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — No authentication required
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/fincloud/products
 * List all active Fincloud PPOB products with sell_price.
 * Supports: ?category=, ?search=, ?page=, ?per_page=
 */
router.get('/products', async (req, res) => {
    try {
        const { category, search, page = 1, per_page = 50 } = req.query;
        const limit = Math.min(parseInt(per_page) || 50, 200);
        const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

        let query = supabase
            .from('fincloud_products')
            .select('*', { count: 'exact' })
            .eq('is_available', true)
            .eq('is_hidden', false)
            .order('category', { ascending: true })
            .order('name', { ascending: true })
            .range(offset, offset + limit - 1);

        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            query = query.or(`name.ilike.%${search}%,category.ilike.%${search}%,brand.ilike.%${search}%`);
        }

        const { data, error, count } = await query;
        if (error) throw error;

        // Return products formatted similarly to public view
        const publicProducts = (data || []).map(p => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            category: p.category,
            brand: p.brand,
            price: p.sell_price,
            stock: 9999, // Fincloud doesn't return stock
            order_process: 'auto',
            required_fields: {},
            validation: {},
            provider_meta: p.product_meta
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
        console.error('GET /fincloud/products error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/fincloud/categories
 * Get unique categories from products.
 */
router.get('/categories', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('fincloud_products')
            .select('category')
            .eq('is_available', true)
            .eq('is_hidden', false);

        if (error) throw error;

        const categories = [...new Set((data || []).map(p => p.category))].sort();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
