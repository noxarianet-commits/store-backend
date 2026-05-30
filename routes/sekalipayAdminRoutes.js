const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const sekalipayService = require('../services/sekalipayService');
const syncService = require('../services/syncService');

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

module.exports = router;
