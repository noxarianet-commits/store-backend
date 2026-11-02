const supabase = require('../supabase');
const cacheService = require('./cacheService');
const { filterProductsForChannel } = require('../utils/channel');

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
    'product_type',
    'available_channels',
    'synced_at',
    'created_at',
    'product_variants(id, product_id, vendor_variant_id, name, sell_price, stock, order_process, required_fields, validation, provider_meta, note, is_hidden, is_active, metadata)',
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
 * The full catalog is cached once. Channel filtering happens in memory so web
 * and app share the same cache entry instead of maintaining two copies.
 *
 * @param {string} [channel] - 'web' | 'app'. Omit for the unfiltered catalog.
 * @returns {Promise<Array<object>>}
 */
async function getActiveCatalog(channel) {
    const catalog = await cacheService.getOrSet(
        cacheService.KEYS.CATALOG,
        fetchActiveCatalog,
        300
    );

    if (!channel) return catalog;

    const filtered = filterProductsForChannel(catalog, channel);
    // Bill products are app-only by policy, even if an admin accidentally
    // enables the web channel on one of them.
    return channel === 'web'
        ? filtered.filter(product => product.product_type !== 'postpaid')
        : filtered;
}

module.exports = { getActiveCatalog, fetchActiveCatalog, PUBLIC_PRODUCT_SELECT };
