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


// ══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — Requires verifyAdmin middleware (applied in server.js)
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/sekalipay/sync
 * Trigger a manual sync (full or delta).
 */
router.post('/admin/sync', async (req, res) => {
    try {
        const { type = 'full' } = req.body;
        console.log(`[Admin] Manual sync triggered (${type})`);

        let result;
        if (type === 'delta') {
            result = await syncService.deltaSync();
        } else {
            result = await syncService.fullSync();
        }

        if (result.success) {
            res.json({
                success: true,
                message: `Sinkronisasi ${type} berhasil`,
                itemCount: result.itemCount,
                productCount: result.productCount,
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
            });
        }
    } catch (err) {
        console.error('Sync error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/sekalipay/sync-status
 * Get the last sync status.
 */
router.get('/admin/sync-status', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'sekalipay_last_sync')
            .maybeSingle();

        if (error) throw error;

        res.json({
            lastSync: data?.value || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/sekalipay/balance
 * Check Sekalipay reseller balance.
 */
router.get('/admin/balance', async (req, res) => {
    try {
        const result = await sekalipayService.checkBalance();
        if (!result.success) {
            return res.status(result.status || 500).json({ error: result.message });
        }
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/sekalipay/items
 * List all products with full pricing info (base_price, markup, sell_price).
 */
router.get('/admin/items', async (req, res) => {
    try {
        const { category, search } = req.query;

        let query = supabase
            .from('products')
            .select('*')
            .not('sekalipay_product_id', 'is', null)
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            query = query.or(`name.ilike.%${search}%,category.ilike.%${search}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/sekalipay/items/:id/markup
 * Set markup for a product. Can target specific variant or all variants.
 * Body: { variant_id?: number, markup: number }
 */
router.put('/admin/items/:id/markup', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { variant_id, markup } = req.body;

        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        const markupValue = parseInt(markup);
        if (isNaN(markupValue) || markupValue < 0) {
            return res.status(400).json({ error: 'Markup harus angka positif' });
        }

        let result;
        if (variant_id) {
            result = await syncService.updateVariantMarkup(productId, parseInt(variant_id), markupValue);
        } else {
            result = await syncService.updateProductMarkup(productId, markupValue);
        }

        if (result.success) {
            res.json({ success: true, message: 'Markup berhasil diupdate' });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/sekalipay/items/:id/toggle
 * Toggle is_active status of a product.
 */
router.put('/admin/items/:id/toggle', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);

        // Fetch current status
        const { data: product, error: fetchError } = await supabase
            .from('products')
            .select('is_active')
            .eq('id', productId)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const { error: updateError } = await supabase
            .from('products')
            .update({ is_active: !product.is_active })
            .eq('id', productId);

        if (updateError) throw updateError;

        res.json({
            success: true,
            is_active: !product.is_active,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/sekalipay/global-markup
 * Apply markup to ALL products and variants at once.
 * Body: { markup: number }
 */
router.put('/admin/global-markup', async (req, res) => {
    try {
        const { markup } = req.body;

        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        const markupValue = parseInt(markup);
        if (isNaN(markupValue) || markupValue < 0) {
            return res.status(400).json({ error: 'Markup harus angka positif' });
        }

        const result = await syncService.applyGlobalMarkup(markupValue);
        if (result.success) {
            res.json({
                success: true,
                message: `Markup global Rp ${markupValue.toLocaleString('id-ID')} diterapkan ke ${result.updatedCount} produk`,
                updatedCount: result.updatedCount,
            });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
