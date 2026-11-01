const supabase = require('../supabase');
const vendorRegistry = require('../services/vendors/vendorRegistry');
const cacheService = require('../services/cacheService');
const { getActiveCatalog, PUBLIC_PRODUCT_SELECT } = require('../services/catalogService');
const { groupProducts, buildMultiServerProduct, getCanonicalKey } = require('../utils/productGrouping');
const { normalizePhoneNumber } = require('../utils/phoneUtils');
const { findProductByAnyId, findVariantByPublicId, findVariantInProduct } = require('../utils/productLookup');
const { toBigIntId } = require('../utils/dbIds');
const { logger } = require('../utils/logger');

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
            note: v.note || '',
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
            .select(PUBLIC_PRODUCT_SELECT, { count: 'exact' })
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
        logger.error('product_list_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat produk' });
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
        logger.error('product_categories_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat kategori' });
    }
}

/**
 * GET /api/products/:id
 * Get a single product by internal ID or external ID, with peer server options.
 */
async function getById(req, res) {
    try {
        const { id } = req.params;

        // 1. Fetch the primary target product. Numeric values are tried as the
        // internal BIGINT id first; non-numeric values only query external_id.
        const { data: primary, error } = await findProductByAnyId(
            supabase,
            id,
            PUBLIC_PRODUCT_SELECT
        );

        if (error) {
            logger.error('product_detail_lookup_failed', { productId: id, code: error.code });
            return res.status(500).json({ error: 'Gagal memuat produk' });
        }
        if (!primary || primary.is_active === false) {
            return res.status(404).json({ error: 'Produk tidak ditemukan' });
        }

        // 2. Find peer products from the cached public catalog. This replaces
        // an unbounded per-request query that fetched every variant in the
        // category.
        const targetCanonicalKey = getCanonicalKey(primary.name);
        const catalog = await getActiveCatalog();
        const peerProducts = catalog.filter(p =>
            String(p.id) !== String(primary.id) &&
            p.category === primary.category &&
            getCanonicalKey(p.name) === targetCanonicalKey
        );

        // 3. Build unified multi-server product payload
        const multiServerProduct = buildMultiServerProduct(primary, peerProducts);

        res.json(multiServerProduct);
    } catch (err) {
        logger.error('product_detail_failed', { productId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal memuat produk' });
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
            const { data, error } = await findProductByAnyId(
                supabase,
                product_id,
                'id, name, brand, category, vendor'
            );
            if (error) {
                logger.warn('product_validate_lookup_failed', {
                    productId: product_id,
                    code: error.code,
                });
            }
            if (data) {
                dbProduct = data;
                if (!resolvedVendor) resolvedVendor = data.vendor;
            }
        }

        let variantValidation = null;
        if (targetVariantId) {
            const columns = 'id, product_id, vendor_variant_id, validation, products(id, name, brand, category, vendor)';
            const { data: vRow, error: variantError } = dbProduct?.id
                ? await findVariantInProduct(supabase, dbProduct.id, targetVariantId, columns)
                : await findVariantByPublicId(supabase, targetVariantId, columns);

            if (variantError) {
                logger.warn('variant_validate_lookup_failed', {
                    variantId: targetVariantId,
                    code: variantError.code,
                });
            }

            if (vRow) {
                variantValidation = vRow.validation;
                // Prefer the product already resolved from product_id. Only use
                // the joined product when product_id was not supplied.
                if (!dbProduct && vRow.products) {
                    dbProduct = vRow.products;
                    if (!resolvedVendor) resolvedVendor = vRow.products.vendor;
                }
            }
        }

        // Jika produk / varian tidak memerlukan validasi akun (validation.available === false)
        if (variantValidation && variantValidation.available === false) {
            return res.json({
                valid: true,
                validation_available: false,
                account_name: customer_id,
                display_name: customer_id,
                message: 'Produk ini tidak memerlukan validasi ID',
            });
        }

        if (!resolvedVendor) resolvedVendor = 'sekalipay';

        const adapter = vendorRegistry.get(resolvedVendor);
        if (!adapter) {
            return res.status(400).json({ error: `Vendor '${resolvedVendor}' tidak ditemukan` });
        }

        // Normalize e-wallet number to 08xxx format (stripping spaces, dashes, +62)
        const cat = (category || dbProduct?.category || '').toLowerCase();
        const pName = (product_name || dbProduct?.name || '').toLowerCase();
        let targetCustomerId = String(customer_id).trim();
        if (cat.includes('wallet') || /dana|ovo|gopay|gojek|shopee|linkaja|isaku|maxim/i.test(pName)) {
            if (/[a-zA-Z]/.test(targetCustomerId)) {
                return res.status(400).json({ error: 'Nomor tujuan e-wallet tidak boleh mengandung huruf. Masukkan nomor HP yang valid (contoh: 08123456789)' });
            }
            const normalized = normalizePhoneNumber(targetCustomerId);
            if (!normalized || !/^08[0-9]{8,13}$/.test(normalized)) {
                return res.status(400).json({ error: 'Format nomor e-wallet tidak valid. Harus diawali 08 dengan 10-14 digit angka.' });
            }
            targetCustomerId = normalized;
        } else if (!zone_id && /^[0-9\s\-\+\(\)]+$/.test(targetCustomerId)) {
            const normalized = normalizePhoneNumber(targetCustomerId);
            if (normalized && normalized.startsWith('08')) {
                targetCustomerId = normalized;
            }
        }

        const result = await adapter.validateAccount({
            variantId: targetVariantId,
            customerId: targetCustomerId,
            zoneId: zone_id,
            productName: product_name || dbProduct?.name,
            brand: brand || dbProduct?.brand,
            category: category || dbProduct?.category,
        });

        if (result.validation_available === false) {
            return res.json({
                valid: true,
                validation_available: false,
                account_name: targetCustomerId,
                display_name: targetCustomerId,
                message: 'Produk ini tidak memerlukan validasi ID',
                data: result.data,
            });
        }

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
        logger.error('product_validate_failed', { error: err });
        res.status(500).json({ error: 'Gagal memvalidasi akun' });
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
        logger.error('product_create_failed', { error: err });
        res.status(500).json({ error: 'Gagal membuat produk' });
    }
}

/**
 * PUT /api/products/:id (Protected)
 */
async function update(req, res) {
    try {
        const productId = toBigIntId(req.params.id);
        if (!productId) {
            return res.status(400).json({ error: 'ID produk tidak valid' });
        }
        const { error } = await supabase.from('products').update(req.body).eq('id', productId);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        logger.error('product_update_failed', { productId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal memperbarui produk' });
    }
}

/**
 * DELETE /api/products/:id (Protected)
 */
async function remove(req, res) {
    try {
        const productId = toBigIntId(req.params.id);
        if (!productId) {
            return res.status(400).json({ error: 'ID produk tidak valid' });
        }
        const { error } = await supabase.from('products').delete().eq('id', productId);
        if (error) throw error;
        cacheService.invalidateHome();
        res.json({ success: true });
    } catch (err) {
        logger.error('product_delete_failed', { productId: req.params.id, error: err });
        res.status(500).json({ error: 'Gagal menghapus produk' });
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

