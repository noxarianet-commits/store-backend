const supabase = require('../supabase');
const vendorRegistry = require('../services/vendors/vendorRegistry');
const cacheService = require('../services/cacheService');
const { groupProducts, buildMultiServerProduct, getCanonicalKey } = require('../utils/productGrouping');

/**
 * Format a product row and its variants for public display.
 * Hides base_price and markup; maps sell_price to price.
 */
function toPublicProduct(product) {
    const variants = (product.product_variants || [])
        .filter(v => v.is_active !== false && !v.is_hidden)
        .map(v => ({
            id: v.vendor_variant_id,
            db_id: v.id,
            sku: v.metadata?.sku || v.vendor_variant_id,
            name: v.name,
            price: v.sell_price,
            stock: v.stock,
            order_process: v.order_process,
            required_fields: v.required_fields || [],
            validation: v.validation || {},
            provider_meta: v.provider_meta || {},
        }));

    return {
        id: product.id,
        vendor: product.vendor,
        external_id: product.external_id,
        category: product.category,
        name: product.name,
        brand: product.brand,
        icon: product.icon,
        image: product.image,
        is_active: product.is_active,
        is_featured: product.is_featured,
        variants,
    };
}

/**
 * GET /api/products
 * List all active products. Supports ?vendor=, ?category=, ?search=, ?page=, ?per_page=
 */
async function list(req, res) {
    try {
        const { vendor, category, search, page = 1, per_page = 50 } = req.query;
        const limit = Math.min(parseInt(per_page) || 50, 200);
        const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

        let query = supabase
            .from('products')
            .select('*, product_variants(*)', { count: 'exact' })
            .eq('is_active', true)
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

        const { data, error, count } = await query;
        if (error) throw error;

        // If vendor filter is specified, return raw public products for that vendor
        if (vendor && vendor !== 'all') {
            const publicProducts = (data || []).map(toPublicProduct);
            const paginated = publicProducts.slice(offset, offset + limit);
            return res.json({
                data: paginated,
                meta: {
                    total: count || publicProducts.length,
                    page: parseInt(page) || 1,
                    per_page: limit,
                    total_pages: Math.ceil((count || publicProducts.length) / limit),
                },
            });
        }

        // Otherwise deduplicate across vendors
        const deduped = groupProducts(data || []);
        const paginated = deduped.slice(offset, offset + limit);

        res.json({
            data: paginated,
            meta: {
                total: deduped.length,
                page: parseInt(page) || 1,
                per_page: limit,
                total_pages: Math.ceil(deduped.length / limit),
            },
        });
    } catch (err) {
        console.error('GET /api/products error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/products/categories
 * Get distinct active categories. Supports ?vendor=
 */
async function getCategories(req, res) {
    try {
        const { vendor } = req.query;
        let query = supabase
            .from('products')
            .select('category')
            .eq('is_active', true);

        if (vendor && vendor !== 'all') {
            query = query.eq('vendor', vendor);
        }

        const { data, error } = await query;
        if (error) throw error;

        const categories = [...new Set((data || []).map(p => p.category))].sort();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/products/:id
 * Get a single product by ID with its variants and peer server options.
 */
async function getById(req, res) {
    try {
        const { id } = req.params;

        // 1. Fetch the primary target product
        const { data: primary, error } = await supabase
            .from('products')
            .select('*, product_variants(*)')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!primary || primary.is_active === false) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        // 2. Find peer products in the same canonical group across all vendors
        const targetCanonicalKey = getCanonicalKey(primary.name);
        const { data: peerCandidates } = await supabase
            .from('products')
            .select('*, product_variants(*)')
            .eq('is_active', true)
            .eq('category', primary.category);

        const peerProducts = (peerCandidates || []).filter(p =>
            getCanonicalKey(p.name) === targetCanonicalKey
        );

        // 3. Build unified multi-server product payload
        const multiServerProduct = buildMultiServerProduct(primary, peerProducts);

        res.json(multiServerProduct);
    } catch (err) {
        console.error('GET /api/products/:id error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/products/validate
 * Proxy customer validation to the appropriate vendor adapter.
 * Body: { vendor?: string, variant_id?: string|number, customer_id: string, zone_id?: string, product_id?: number|string, product_name?: string }
 */
async function validate(req, res) {
    try {
        let { vendor, variant_id, item_id, customer_id, zone_id, product_id, product_name, brand, category } = req.body;
        const targetVariantId = variant_id || item_id;

        if (!customer_id) {
            return res.status(400).json({ error: 'customer_id / Target ID wajib diisi' });
        }

        // Auto-resolve vendor and product details from database
        let resolvedVendor = vendor;
        let dbProduct = null;

        if (product_id) {
            const { data } = await supabase
                .from('products')
                .select('id, name, brand, category, vendor')
                .eq('id', product_id)
                .maybeSingle();
            if (data) {
                dbProduct = data;
                if (!resolvedVendor) resolvedVendor = data.vendor;
            }
        }

        if (targetVariantId && (!resolvedVendor || resolvedVendor === 'sekalipay')) {
            const { data: vRow } = await supabase
                .from('product_variants')
                .select('product_id, products(id, name, brand, category, vendor)')
                .eq('vendor_variant_id', targetVariantId)
                .maybeSingle();
            if (vRow?.products) {
                dbProduct = vRow.products;
                resolvedVendor = vRow.products.vendor;
            }
        }

        if (!resolvedVendor) resolvedVendor = 'sekalipay';

        const adapter = vendorRegistry.get(resolvedVendor);
        if (!adapter) {
            return res.status(400).json({ error: `Vendor '${resolvedVendor}' tidak ditemukan` });
        }

        const result = await adapter.validateAccount({
            variantId: targetVariantId,
            customerId: customer_id,
            zoneId: zone_id,
            productName: product_name || dbProduct?.name,
            brand: brand || dbProduct?.brand,
            category: category || dbProduct?.category,
        });

        if (!result.success || result.valid === false) {
            const statusCode = result.status >= 500 ? 400 : (result.status || 400);
            return res.status(statusCode).json({
                error: result.message || 'Validasi akun gagal',
                errors: result.errors,
            });
        }

        res.json({
            valid: true,
            ...(result.data || { account_name: customer_id, display_name: customer_id })
        });
    } catch (err) {
        console.error('POST /api/products/validate error:', err.message);
        res.status(500).json({ error: err.message });
    }
}


/**
 * POST /api/products (Protected)
 */
async function create(req, res) {
    try {
        const { data, error } = await supabase.from('products').insert([req.body]);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * PUT /api/products/:id (Protected)
 */
async function update(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('products').update(req.body).eq('id', id);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * DELETE /api/products/:id (Protected)
 */
async function remove(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('products').delete().eq('id', id);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    list,
    getCategories,
    getById,
    validate,
    create,
    update,
    remove,
};

