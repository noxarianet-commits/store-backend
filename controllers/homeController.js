const supabase = require('../supabase');
const cacheService = require('../services/cacheService');
const { getActiveCatalog } = require('../services/catalogService');
const { groupProducts } = require('../utils/productGrouping');
const { buildPublicSettings } = require('../utils/publicSettings');
const { logger } = require('../utils/logger');

/**
 * Generate URL-friendly slug from text.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

/**
 * Map a service to public format (mark as service).
 * @param {object} service
 * @returns {object}
 */
function toPublicService(service) {
    return {
        ...service,
        is_service_table: true,
    };
}

/**
 * GET /api/home
 * Unified home page data: settings, categories, featured products, testimonials.
 * Cached for 5 minutes.
 */
async function getHomePage(req, res) {
    try {
        const responseData = await cacheService.getOrSet(
            cacheService.KEYS.HOME_PAGE,
            () => fetchHomePageData('web'),
            300
        );

        res.json(responseData);
    } catch (err) {
        logger.error('home_page_failed', { error: err });
        res.status(500).json({ error: 'Gagal memuat halaman utama' });
    }
}

/**
 * Fetch all home page data from Supabase.
 * @returns {Promise<object>} Home page response data
 */
async function fetchHomePageData(channel = 'web') {
    // Fetch all data in parallel. Services are a web/manual-WA flow, so the
    // app never receives them through this endpoint.
    const includeServices = channel === 'web';
    const [products, servicesResult, testimonialsResult, settingsResult] = await Promise.all([
        getActiveCatalog(channel),
        includeServices
            ? supabase
                .from('services')
                .select('id, category, name, icon, image, subtitle, features, variants, is_active, created_at')
                .eq('is_active', true)
                .order('created_at', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        supabase
            .from('testimonials')
            .select('id, name, rating, text, created_at')
            .order('created_at', { ascending: false })
            .limit(10),
        supabase
            .from('settings')
            .select('key, value'),
    ]);

    if (includeServices && servicesResult?.error) throw servicesResult.error;
    if (testimonialsResult.error) throw testimonialsResult.error;
    if (settingsResult.error) throw settingsResult.error;

    // Only allowlisted public settings are exposed. Secrets such as gateway
    // credentials must never be returned by /api/home.
    const settingsMap = buildPublicSettings(settingsResult.data, {
        shop_status: { isOpen: true, message: 'Selamat datang!' },
    });

    // Deduplicate and group products across multiple vendors
    const rawProducts = products || [];
    const dedupedProducts = groupProducts(rawProducts);

    // Build categories from deduplicated products
    const categoryMap = {};

    for (const product of dedupedProducts) {
        const cat = product.category || 'Uncategorized';
        if (!categoryMap[cat]) {
            categoryMap[cat] = {
                slug: slugify(cat),
                name: cat,
                icon: product.icon || null,
                product_count: 0,
                type: 'product',
            };
        }
        categoryMap[cat].product_count++;
    }

    // Add services as a category
    const services = includeServices ? (servicesResult?.data || []) : [];
    if (services.length > 0) {
        categoryMap['Layanan Jasa & Bot'] = {
            slug: 'layanan-jasa-bot',
            name: 'Layanan Jasa & Bot',
            icon: null,
            product_count: services.length,
            type: 'service',
        };
    }

    // Build featured products
    const featured = [];
    const MAX_FEATURED = 12;

    for (const p of dedupedProducts) {
        if (p.is_featured && featured.length < MAX_FEATURED) {
            featured.push(p);
        }
    }

    return {
        settings: settingsMap,
        categories: Object.values(categoryMap),
        featured_products: featured,
        all_products: dedupedProducts,
        testimonials: testimonialsResult.data || [],
    };
}

/**
 * GET /api/home/category/:slug
 * Get all products for a specific category.
 * Cached for 5 minutes per category.
 */
async function getCategoryProducts(req, res) {
    try {
        const { slug } = req.params;
        const cacheKey = `home_category_${slug}`;
        const cached = cacheService.get(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        // Check if this is the services category
        if (slug === 'layanan-jasa-bot') {
            const { data, error } = await supabase
                .from('services')
                .select('id, category, name, icon, image, subtitle, features, variants, is_active, created_at')
                .eq('is_active', true)
                .order('created_at', { ascending: true });

            if (error) throw error;

            const responseData = {
                category: {
                    slug: 'layanan-jasa-bot',
                    name: 'Layanan Jasa & Bot',
                    type: 'service',
                },
                products: (data || []).map(toPublicService),
            };

            cacheService.set(cacheKey, responseData, 300);
            return res.json(responseData);
        }

        // Regular product category — find by matching slug in the cached public catalog.
        const allProducts = await getActiveCatalog('web');

        // Find products whose category slugifies to the requested slug
        const matchingProducts = (allProducts || []).filter(
            p => slugify(p.category || '') === slug
        );

        if (matchingProducts.length === 0) {
            return res.status(404).json({ error: 'Kategori tidak ditemukan' });
        }

        const categoryName = matchingProducts[0].category;
        const dedupedCategoryProducts = groupProducts(matchingProducts);

        const responseData = {
            category: {
                slug,
                name: categoryName,
                type: 'product',
            },
            products: dedupedCategoryProducts,
        };

        cacheService.set(cacheKey, responseData, 300);
        res.json(responseData);
    } catch (err) {
        logger.error('home_category_failed', { slug: req.params.slug, error: err });
        res.status(500).json({ error: 'Gagal memuat kategori' });
    }
}

module.exports = { getHomePage, getCategoryProducts };

