const supabase = require('../supabase');
const vendorRegistry = require('../services/vendors/vendorRegistry');
const productSyncService = require('../services/productSyncService');
const cacheService = require('../services/cacheService');
const { toBigIntId } = require('../utils/dbIds');
const { findVariantByPublicId, findVariantInProduct } = require('../utils/productLookup');
const { logger } = require('../utils/logger');

/**
 * Admin Product Controller.
 * Handles admin management of products across all vendors (sync, markup, toggle, etc.)
 */

/**
 * POST /api/admin/products/sync
 * Trigger sync for a vendor.
 * Body: { vendor: 'sekalipay'|'fincloud', type: 'full'|'delta' }
 */
async function sync(req, res) {
    try {
        const { vendor = 'sekalipay', type = 'full' } = req.body;
        const result = await productSyncService.syncVendor(vendor, { type });
        res.json({
            success: true,
            message: `Sinkronisasi ${vendor} (${type}) berhasil`,
            ...result,
        });
    } catch (err) {
        logger.error('admin_product_sync_failed', { vendor, type, error: err });
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/admin/products/sync-status?vendor=
 */
async function syncStatus(req, res) {
    try {
        const { vendor = 'sekalipay' } = req.query;
        const lastSync = await productSyncService.getLastSyncTime(vendor);
        res.json({ success: true, vendor, lastSync });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/admin/products/balance?vendor=
 */
async function getBalance(req, res) {
    try {
        const { vendor = 'sekalipay' } = req.query;
        const adapter = vendorRegistry.get(vendor);
        if (!adapter) {
            return res.status(400).json({ error: `Vendor '${vendor}' tidak ditemukan` });
        }
        const result = await adapter.getBalance();
        if (!result.success && result.message) {
            return res.status(result.status || 500).json({ error: result.message });
        }
        res.json({ success: true, vendor, data: result.data || result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/admin/products/products?vendor=&category=&search=
 * Returns products with their relational variants.
 */
async function getProducts(req, res) {
    try {
        const { vendor, category, search } = req.query;

        let query = supabase
            .from('products')
            .select('*, product_variants(*)')
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (vendor && vendor !== 'all') {
            query = query.eq('vendor', vendor);
        }
        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            query = query.or(`name.ilike.%${search}%,category.ilike.%${search}%,brand.ilike.%${search}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Normalize variants array for admin view
        const normalized = (data || []).map(p => ({
            ...p,
            variants: (p.product_variants && p.product_variants.length > 0)
                ? p.product_variants.map(v => ({
                    id: v.vendor_variant_id,
                    db_id: v.id,
                    sku: v.metadata?.sku || v.vendor_variant_id,
                    name: v.name,
                    base_price: v.base_price,
                    markup: v.markup,
                    sell_price: v.sell_price,
                    stock: v.stock,
                    order_process: v.order_process,
                    is_hidden: v.is_hidden,
                    is_active: v.is_active,
                    required_fields: v.required_fields,
                    validation: v.validation,
                    provider_meta: v.provider_meta,
                }))
                : (p.variants || []),
        }));

        res.json(normalized);
    } catch (err) {
        logger.error('admin_products_list_failed', { error: err });
        res.status(500).json({ error: err.message });
    }
}

/**
 * PATCH /api/admin/products/products/:id/markup
 * Body: { variantId?: string|number, markup: number }
 */
async function updateMarkup(req, res) {
    try {
        const productId = toBigIntId(req.params.id);
        const { variantId, markup } = req.body;

        if (!productId) {
            return res.status(400).json({ error: 'ID produk tidak valid' });
        }
        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        let result;
        if (variantId !== undefined && variantId !== null && variantId !== '') {
            result = await productSyncService.updateVariantMarkup(productId, variantId, markup);
        } else {
            result = await productSyncService.updateProductMarkup(productId, markup);
        }

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({ success: true, message: 'Markup berhasil diupdate' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * PATCH /api/admin/products/products/:id/toggle
 */
async function toggleActive(req, res) {
    try {
        const productId = toBigIntId(req.params.id);
        if (!productId) {
            return res.status(400).json({ error: 'ID produk tidak valid' });
        }

        const { data: product, error: fetchError } = await supabase
            .from('products')
            .select('is_active')
            .eq('id', productId)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const newStatus = !product.is_active;
        const { error: updateError } = await supabase
            .from('products')
            .update({ is_active: newStatus })
            .eq('id', productId);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({ success: true, is_active: newStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * PATCH /api/admin/products/products/:id/featured
 */
async function toggleFeatured(req, res) {
    try {
        const productId = toBigIntId(req.params.id);
        if (!productId) {
            return res.status(400).json({ error: 'ID produk tidak valid' });
        }

        const { data: product, error: fetchError } = await supabase
            .from('products')
            .select('is_featured')
            .eq('id', productId)
            .single();

        if (fetchError || !product) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        const newFeatured = !product.is_featured;
        const { error: updateError } = await supabase
            .from('products')
            .update({ is_featured: newFeatured })
            .eq('id', productId);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({ success: true, is_featured: newFeatured });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/admin/products/featured
 */
async function getFeatured(req, res) {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*, product_variants(*)')
            .eq('is_featured', true)
            .order('name', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/admin/products/featured-options
 *
 * The Featured tab needs all products (so an admin can mark any product as
 * featured), but it only needs a small subset of each product's data. This
 * avoids downloading the full catalog with markup/base_price for every tab.
 */
async function getFeaturedOptions(req, res) {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('id, name, category, icon, is_featured, product_variants(id, vendor_variant_id, sell_price, stock, is_hidden, is_active)')
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (error) throw error;

        const normalized = (data || []).map(product => ({
            id: product.id,
            name: product.name,
            category: product.category,
            icon: product.icon,
            is_featured: product.is_featured,
            variants: (product.product_variants || [])
                .filter(v => v.is_hidden !== true && v.is_active !== false)
                .map(v => ({
                    id: v.vendor_variant_id,
                    sell_price: v.sell_price,
                    price: v.sell_price,
                    stock: v.stock,
                })),
        }));

        res.json(normalized);
    } catch (err) {
        logger.error('admin_featured_options_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat produk unggulan' });
    }
}

/**
 * PATCH /api/admin/products/variants/:id/toggle-hidden
 * or /api/admin/products/products/:productId/variant/:variantId/toggle-hidden
 */
async function toggleVariantHidden(req, res) {
    try {
        const { id, productId, variantId } = req.params;
        const targetVariantId = id || variantId;
        const targetProductId = productId;

        if (!targetVariantId) {
            return res.status(400).json({ error: 'ID varian tidak valid' });
        }

        const columns = 'id, product_id, is_hidden, vendor_variant_id';
        const result = targetProductId
            ? await findVariantInProduct(supabase, targetProductId, targetVariantId, columns)
            : await findVariantByPublicId(supabase, targetVariantId, columns);

        if (result.error) {
            logger.error('variant_hidden_lookup_failed', {
                productId: targetProductId || null,
                variantId: targetVariantId,
                code: result.error.code,
            });
            return res.status(500).json({ error: 'Gagal memuat varian' });
        }

        const variant = result.data;
        if (!variant) {
            return res.status(404).json({ error: 'Variant tidak ditemukan' });
        }

        const newHidden = !variant.is_hidden;
        const { error: updateError } = await supabase
            .from('product_variants')
            .update({ is_hidden: newHidden })
            .eq('id', variant.id);

        if (updateError) throw updateError;

        cacheService.invalidateHome();
        res.json({ success: true, is_hidden: newHidden });
    } catch (err) {
        logger.error('variant_hidden_toggle_failed', {
            productId: req.params.productId || null,
            variantId: req.params.id || req.params.variantId || null,
            error: err,
        });
        res.status(500).json({ error: 'Gagal mengubah visibilitas varian' });
    }
}


/**
 * POST /api/admin/products/global-markup
 * Body: { vendor: 'sekalipay'|'fincloud'|'all', markup: number }
 */
async function globalMarkup(req, res) {
    try {
        const { vendor = 'all', markup } = req.body;
        if (markup === undefined || markup === null) {
            return res.status(400).json({ error: 'Markup harus diisi' });
        }

        const result = await productSyncService.applyGlobalMarkup(vendor, markup);
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: `Markup global Rp ${parseInt(markup).toLocaleString('id-ID')} diterapkan ke ${result.updatedCount} produk (${vendor})`,
            updatedCount: result.updatedCount,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    sync,
    syncStatus,
    getBalance,
    getProducts,
    updateMarkup,
    toggleActive,
    toggleFeatured,
    getFeatured,
    getFeaturedOptions,
    toggleVariantHidden,
    globalMarkup,
};
