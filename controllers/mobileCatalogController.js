const supabase = require('../supabase');
const productController = require('./productController');
const { getActiveCatalog, PUBLIC_PRODUCT_SELECT } = require('../services/catalogService');
const { groupProducts, buildMultiServerProduct, getCanonicalKey } = require('../utils/productGrouping');
const { toPublicProduct } = require('../utils/publicProduct');
const { findProductByAnyId } = require('../utils/productLookup');
const { buildPublicSettings } = require('../utils/publicSettings');
const { isAvailableForChannel } = require('../utils/channel');
const { isMandatoryValidationEnabled } = require('../utils/settingFlags');
const { logger } = require('../utils/logger');

// Konten katalog bersifat publik dan tidak bergantung pada user. Header ini
// memberi tahu Cloudflare/Nginx bahwa respons aman di-cache sebentar; tanpa
// cache rule di edge, header ini tidak berefek.
const PUBLIC_CACHE_HEADER = 'public, max-age=30, stale-while-revalidate=60';

const DEFAULT_MOBILE_CONFIG = {
    min_version: '1.0.0',
    latest_version: '1.0.0',
    maintenance: false,
    features: {
        bills: true,
        topup: true,
        tickets: true,
    },
    payment_methods: ['balance', 'qris'],
};

function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

async function getConfig(req, res) {
    try {
        const [{ data, error }, mandatoryValidation] = await Promise.all([
            supabase
                .from('settings')
                .select('key, value')
                .in('key', ['mobile_app_config', 'shop_status']),
            isMandatoryValidationEnabled('app'),
        ]);

        if (error) throw error;

        const map = new Map((data || []).map(row => [row.key, row.value]));
        const stored = map.get('mobile_app_config');
        const config = {
            ...DEFAULT_MOBILE_CONFIG,
            ...(stored && typeof stored === 'object' ? stored : {}),
            features: {
                ...DEFAULT_MOBILE_CONFIG.features,
                ...(stored?.features && typeof stored.features === 'object' ? stored.features : {}),
            },
        };

        res.set('Cache-Control', 'public, max-age=60');
        res.json({
            success: true,
            data: {
                ...config,
                // Flag efektif channel app (master + override mandatory_validation_app).
                // Dipakai aplikasi untuk menampilkan/menyembunyikan cek ID.
                mandatory_validation: mandatoryValidation,
                shop_status: map.get('shop_status') || { isOpen: true, message: 'Selamat datang!' },
            },
        });
    } catch (err) {
        logger.error('mobile_config_failed', { error: err });
        res.status(500).json({ success: false, code: 'CONFIG_FAILED', error: 'Gagal memuat konfigurasi aplikasi.' });
    }
}

async function getHome(req, res) {
    try {
        const [catalog, testimonialsResult, settingsResult] = await Promise.all([
            getActiveCatalog('app'),
            supabase
                .from('testimonials')
                .select('id, name, rating, text, created_at')
                .order('created_at', { ascending: false })
                .limit(10),
            supabase.from('settings').select('key, value'),
        ]);

        if (testimonialsResult.error) throw testimonialsResult.error;
        if (settingsResult.error) throw settingsResult.error;

        const products = groupProducts(catalog || []);
        const prepaid = products.filter(p => p.product_type !== 'postpaid');
        const bills = products.filter(p => p.product_type === 'postpaid');

        const buildCategories = (items, type) => {
            const map = {};
            for (const product of items) {
                const name = product.category || 'Lainnya';
                if (!map[name]) {
                    map[name] = {
                        slug: slugify(name),
                        name,
                        icon: product.icon || null,
                        product_count: 0,
                        type,
                    };
                }
                map[name].product_count++;
            }
            return Object.values(map);
        };

        const prepaidCategories = buildCategories(prepaid, 'prepaid');
        const billCategories = buildCategories(bills, 'postpaid');

        const featured = [];
        for (const product of products) {
            if (product.is_featured && featured.length < 12) featured.push(product);
        }

        res.set('Cache-Control', PUBLIC_CACHE_HEADER);
        res.json({
            success: true,
            data: {
                settings: buildPublicSettings(settingsResult.data, {
                    shop_status: { isOpen: true, message: 'Selamat datang!' },
                }),
                categories: [...prepaidCategories, ...billCategories],
                prepaid_categories: prepaidCategories,
                bill_categories: billCategories,
                featured_products: featured,
                testimonials: testimonialsResult.data || [],
                quick_actions: [
                    { key: 'topup', label: 'Top Up Saldo' },
                    { key: 'bills', label: 'Bayar Tagihan' },
                    { key: 'orders', label: 'Riwayat Pesanan' },
                    { key: 'tickets', label: 'Bantuan CS' },
                ],
            },
        });
    } catch (err) {
        logger.error('mobile_home_failed', { error: err });
        res.status(500).json({ success: false, code: 'HOME_FAILED', error: 'Gagal memuat halaman utama.' });
    }
}

/**
 * Bill products are grouped (one product per OkeConnect biller group), so the
 * region a customer types ("bandung", "jakarta") lives on the variant name and
 * not on the product name. Returns the bill product ids whose variants match.
 */
async function findBillProductIdsByVariantName(search) {
    const { data, error } = await supabase
        .from('product_variants')
        .select('product_id, products!inner(product_type)')
        .ilike('name', `%${search}%`)
        .eq('is_active', true)
        .eq('is_hidden', false)
        .eq('products.product_type', 'postpaid')
        .limit(500);

    if (error) {
        logger.warn('mobile_variant_search_failed', { code: error.code });
        return [];
    }

    return [...new Set((data || []).map(row => row.product_id).filter(Boolean))];
}

async function listProducts(req, res) {
    try {
        const {
            type,
            category,
            search,
            page = 1,
            per_page = 50,
        } = req.query;

        const limit = Math.min(Math.max(parseInt(per_page, 10) || 50, 1), 200);
        const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

        let query = supabase
            .from('products')
            .select(PUBLIC_PRODUCT_SELECT, { count: 'exact' })
            .eq('is_active', true)
            .contains('available_channels', ['app'])
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (type === 'prepaid' || type === 'postpaid') {
            query = query.eq('product_type', type);
        }
        if (category) {
            query = query.eq('category', category);
        }
        if (search) {
            // Commas and parentheses would break the PostgREST `or=` filter.
            const term = String(search).replace(/[,()\\]/g, ' ').trim();
            if (term) {
                const filters = [
                    `name.ilike.%${term}%`,
                    `category.ilike.%${term}%`,
                    `brand.ilike.%${term}%`,
                ];

                if (type === 'postpaid') {
                    const variantProductIds = await findBillProductIdsByVariantName(term);
                    if (variantProductIds.length > 0) {
                        filters.push(`id.in.(${variantProductIds.join(',')})`);
                    }
                }

                query = query.or(filters.join(','));
            }
        }

        const { data, error, count } = await query.range(offset, offset + limit - 1);
        if (error) throw error;

        res.set('Cache-Control', PUBLIC_CACHE_HEADER);
        res.json({
            success: true,
            data: (data || []).map(toPublicProduct),
            meta: {
                total: count || 0,
                page: parseInt(page, 10) || 1,
                per_page: limit,
                total_pages: Math.ceil((count || 0) / limit) || 1,
            },
        });
    } catch (err) {
        logger.error('mobile_products_failed', { error: err });
        res.status(500).json({ success: false, code: 'PRODUCTS_FAILED', error: 'Gagal memuat produk.' });
    }
}

async function getProductById(req, res) {
    try {
        const { id } = req.params;

        const { data: primary, error } = await findProductByAnyId(
            supabase,
            id,
            PUBLIC_PRODUCT_SELECT
        );

        if (error) {
            logger.error('mobile_product_detail_lookup_failed', { productId: id, code: error.code });
            return res.status(500).json({ success: false, code: 'PRODUCT_LOOKUP_FAILED', error: 'Gagal memuat produk.' });
        }
        if (!primary || primary.is_active === false || !isAvailableForChannel(primary, 'app')) {
            return res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', error: 'Produk tidak ditemukan.' });
        }

        // Bill products are standalone; do not merge peer products across
        // billers whose display names happen to normalize to the same key.
        if (primary.product_type === 'postpaid') {
            res.set('Cache-Control', PUBLIC_CACHE_HEADER);
            return res.json({ success: true, data: toPublicProduct(primary) });
        }

        const targetCanonicalKey = getCanonicalKey(primary.name);
        const primaryType = primary.product_type || 'prepaid';
        const catalog = await getActiveCatalog('app');
        const peers = catalog.filter(product =>
            String(product.id) !== String(primary.id) &&
            (product.product_type || 'prepaid') === primaryType &&
            product.category === primary.category &&
            getCanonicalKey(product.name) === targetCanonicalKey
        );

        res.set('Cache-Control', PUBLIC_CACHE_HEADER);
        res.json({
            success: true,
            data: buildMultiServerProduct(primary, peers),
        });
    } catch (err) {
        logger.error('mobile_product_detail_failed', { productId: req.params.id, error: err });
        res.status(500).json({ success: false, code: 'PRODUCT_DETAIL_FAILED', error: 'Gagal memuat produk.' });
    }
}

async function validateProduct(req, res) {
    req.channel = 'app';
    return productController.validate(req, res);
}

module.exports = {
    getConfig,
    getHome,
    listProducts,
    getProductById,
    validateProduct,
    DEFAULT_MOBILE_CONFIG,
};
