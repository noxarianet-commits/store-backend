const supabase = require('../supabase');
const cacheService = require('./cacheService');

/**
 * Public product columns only. Admin-only fields such as base_price and
 * markup are never needed by the storefront and only add egress.
 */
const PUBLIC_PRODUCT_SELECT = [
    'id',
    'vendor',
    'external_id',
    'category',
    'name',
    'brand',
    'icon',
    'image',
    'is_active',
    'is_featured',
    'synced_at',
    'created_at',
    'product_variants(id, product_id, vendor_variant_id, name, sell_price, stock, order_process, required_fields, validation, provider_meta, is_hidden, is_active, metadata)',
].join(',');

async function fetchActiveCatalog() {
    const { data, error } = await supabase
        .from('products')
        .select(PUBLIC_PRODUCT_SELECT)
        .eq('is_active', true)
        .order('category', { ascending: true })
        .order('name', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * Cached catalog used by the home page and product detail peer lookup.
 *
 * The cache key starts with "home_" so the existing invalidateHome() calls
 * after sync/admin changes clear it automatically.
 *
 * @returns {Promise<Array<object>>}
 */
function getActiveCatalog() {
    return cacheService.getOrSet(
        cacheService.KEYS.CATALOG,
        fetchActiveCatalog,
        300
    );
}

module.exports = { getActiveCatalog, PUBLIC_PRODUCT_SELECT };
