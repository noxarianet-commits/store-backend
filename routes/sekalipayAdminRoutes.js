const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const sekalipayService = require('../services/sekalipayService');
const syncService = require('../services/syncService');
const cacheService = require('../services/cacheService');

/**
 * POST /api/admin/sekalipay/sync
 * Trigger a manual sync (full or delta).
 */
router.post('/sync', async (req, res) => {
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
router.get('/sync-status', async (req, res) => {
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
router.get('/balance', async (req, res) => {
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
 * GET /api/admin/sekalipay/products
 * List all products with full pricing info (base_price, markup, sell_price).
 */
router.get('/products', async (req, res) => {
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
 * PATCH /api/admin/sekalipay/products/:id/markup
 * Set markup for a product. Can target specific variant or all variants.
 * Body: { variantId?: number, markup: number }
 */
router.patch('/products/:id/markup', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { variantId, markup } = req.body;

        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        const markupValue = parseInt(markup);
        if (isNaN(markupValue) || markupValue < 0) {
            return res.status(400).json({ error: 'Markup harus angka positif' });
        }

        let result;
        if (variantId) {
            result = await syncService.updateVariantMarkup(productId, parseInt(variantId), markupValue);
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
 * PATCH /api/admin/sekalipay/products/:id/toggle
 * Toggle is_active status of a product.
 */
router.patch('/products/:id/toggle', async (req, res) => {
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
 * POST /api/admin/sekalipay/global-markup
 * Apply markup to ALL products and variants at once.
 * Body: { markup: number }
 */
router.post('/global-markup', async (req, res) => {
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

/**
 * PATCH /api/admin/sekalipay/products/:id/featured
 * Toggle is_featured status of a product.
 */
router.patch('/products/:id/featured', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);

        const { data: product, error: fetchError } = await supabase
            .from('products')
            .select('is_featured')
            .eq('id', productId)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const newValue = !product.is_featured;
        const { error: updateError } = await supabase
            .from('products')
            .update({ is_featured: newValue })
            .eq('id', productId);

        if (updateError) throw updateError;

        // Invalidate home cache so changes appear immediately
        cacheService.invalidateHome();

        res.json({ success: true, is_featured: newValue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/sekalipay/featured
 * List all featured products.
 */
router.get('/featured', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('is_featured', true)
            .order('name', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/admin/sekalipay/products/:id/variant/:variantId/toggle-hidden
 * Toggle is_hidden status of a specific variant within a product.
 */
router.patch('/products/:id/variant/:variantId/toggle-hidden', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const variantId = parseInt(req.params.variantId);

        // Fetch current product
        const { data: product, error: fetchError } = await supabase
            .from('products')
            .select('variants')
            .eq('id', productId)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        // Toggle is_hidden for the specific variant
        let found = false;
        let newHiddenState = false;
        const variants = (product.variants || []).map(v => {
            if (v.id === variantId) {
                found = true;
                newHiddenState = !v.is_hidden;
                return { ...v, is_hidden: newHiddenState };
            }
            return v;
        });

        if (!found) {
            return res.status(404).json({ error: 'Varian tidak ditemukan' });
        }

        const { error: updateError } = await supabase
            .from('products')
            .update({ variants })
            .eq('id', productId);

        if (updateError) throw updateError;

        // Invalidate home cache
        cacheService.invalidateHome();

        res.json({ success: true, is_hidden: newHiddenState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
