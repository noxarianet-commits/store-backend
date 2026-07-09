const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const fincloudSyncService = require('../services/fincloudSyncService');
const vendorRegistry = require('../services/vendors/vendorRegistry');
const cacheService = require('../services/cacheService');

/**
 * POST /api/admin/fincloud/sync
 * Trigger a manual sync for Fincloud PPOB.
 */
router.post('/sync', async (req, res) => {
    try {
        console.log(`[Admin] Manual sync triggered for Fincloud PPOB`);
        const result = await fincloudSyncService.syncAllProducts();

        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({
                success: false,
                error: result.message,
            });
        }
    } catch (err) {
        console.error('Sync error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/fincloud/sync-status
 * Get the last sync status.
 */
router.get('/sync-status', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'fincloud_last_sync')
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
 * GET /api/admin/fincloud/balance
 * Check Fincloud account balance.
 */
router.get('/balance', async (req, res) => {
    try {
        const adapter = vendorRegistry.get('fincloud');
        const result = await adapter.getBalance();
        
        if (!result.success) {
            return res.status(result.status || 500).json({ error: result.message });
        }
        res.json(result.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/fincloud/products
 * List all products with full pricing info.
 */
router.get('/products', async (req, res) => {
    try {
        const { category, search } = req.query;

        let query = supabase
            .from('fincloud_products')
            .select('*')
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            query = query.or(`name.ilike.%${search}%,category.ilike.%${search}%,sku.ilike.%${search}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/admin/fincloud/products/:sku/markup
 * Set markup for a Fincloud product.
 */
router.patch('/products/:sku/markup', async (req, res) => {
    try {
        const { sku } = req.params;
        const { markup } = req.body;

        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        const markupValue = parseInt(markup);
        if (isNaN(markupValue) || markupValue < 0) {
            return res.status(400).json({ error: 'Markup harus angka positif' });
        }

        // Ambil base_price untuk menghitung sell_price
        const { data: product, error: fetchError } = await supabase
            .from('fincloud_products')
            .select('base_price')
            .eq('sku', sku)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const newSellPrice = product.base_price + markupValue;

        const { error: updateError } = await supabase
            .from('fincloud_products')
            .update({
                markup: markupValue,
                sell_price: newSellPrice
            })
            .eq('sku', sku);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({ success: true, message: 'Markup berhasil diupdate' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/admin/fincloud/products/:sku/toggle
 * Toggle is_hidden status (note: fincloud uses is_hidden to hide from public while keeping active in admin).
 */
router.patch('/products/:sku/toggle', async (req, res) => {
    try {
        const { sku } = req.params;

        const { data: product, error: fetchError } = await supabase
            .from('fincloud_products')
            .select('is_hidden')
            .eq('sku', sku)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const { error: updateError } = await supabase
            .from('fincloud_products')
            .update({ is_hidden: !product.is_hidden })
            .eq('sku', sku);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({
            success: true,
            is_hidden: !product.is_hidden,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/admin/fincloud/products/brand/:brand/toggle
 * Set is_hidden status for all products within a brand.
 */
router.patch('/products/brand/:brand/toggle', async (req, res) => {
    try {
        const { brand } = req.params;
        const { is_hidden } = req.body;

        if (is_hidden === undefined) {
            return res.status(400).json({ error: 'is_hidden status is required' });
        }

        const { error: updateError } = await supabase
            .from('fincloud_products')
            .update({ is_hidden })
            .eq('brand', brand);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({
            success: true,
            is_hidden,
            message: `Brand ${brand} has been ${is_hidden ? 'hidden' : 'shown'}`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/fincloud/global-markup
 * Apply markup to ALL Fincloud products at once.
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

        const { data: products, error: fetchErr } = await supabase
            .from('fincloud_products')
            .select('id, sku, base_price');

        if (fetchErr) throw fetchErr;
        
        let updatedCount = 0;
        
        // Update in batches
        const BATCH_SIZE = 100;
        for (let i = 0; i < products.length; i += BATCH_SIZE) {
            const batch = products.slice(i, i + BATCH_SIZE).map(p => ({
                id: p.id,
                sku: p.sku, // needed for upsert to match if using sku constraint
                markup: markupValue,
                sell_price: p.base_price + markupValue
            }));
            
            // Note: upsert based on id/sku is safe here since we just fetched them
            const { error: updateErr } = await supabase
                .from('fincloud_products')
                .upsert(batch);
                
            if (updateErr) throw updateErr;
            updatedCount += batch.length;
        }

        cacheService.invalidateHome();
        res.json({
            success: true,
            message: `Markup global Rp ${markupValue.toLocaleString('id-ID')} diterapkan ke ${updatedCount} produk`,
            updatedCount,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
