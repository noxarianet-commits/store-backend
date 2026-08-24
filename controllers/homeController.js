const supabase = require('../supabase');
const cacheService = require('../services/cacheService');
const { groupProducts } = require('../utils/productGrouping');

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
            () => fetchHomePageData(),
            300
        );

        res.json(responseData);
    } catch (err) {
        console.error('[HomeController] getHomePage error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * Fetch all home page data from Supabase.
 * @returns {Promise<object>} Home page response data
 */
async function fetchHomePageData() {
    // Fetch all data in parallel
    const [productsResult, servicesResult, testimonialsResult, settingsResult] = await Promise.all([
        supabase
            .from('products')
            .select('*, product_variants(*)')
            .eq('is_active', true)
            .order('category', { ascending: true })
            .order('name', { ascending: true }),
        supabase
            .from('services')
            .select('id, category, name, icon, image, subtitle, features, variants, is_active, created_at')
            .eq('is_active', true)
            .order('created_at', { ascending: true }),
        supabase
            .from('testimonials')
            .select('id, name, rating, text, created_at')
            .order('created_at', { ascending: false })
            .limit(10),
        supabase
            .from('settings')
            .select('key, value'),
    ]);

    if (productsResult.error) throw productsResult.error;
    if (servicesResult.error) throw servicesResult.error;
    if (testimonialsResult.error) throw testimonialsResult.error;
    if (settingsResult.error) throw settingsResult.error;

    // Process settings (filter sensitive keys)
    const settingsMap = {
        shop_status: { isOpen: true, message: 'Selamat datang!' },
    };
    if (settingsResult.data) {
        settingsResult.data.forEach(s => {
            if (s.key !== 'admin_auth' && !s.key.endsWith('_last_sync')) {
                settingsMap[s.key] = s.value;
            }
        });
    }

    // Deduplicate and group products across multiple vendors
    const rawProducts = productsResult.data || [];
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
    const services = servicesResult.data || [];
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

        // Regular product category — find by matching slug
        const { data: allProducts, error } = await supabase
            .from('products')
            .select('*, product_variants(*)')
            .eq('is_active', true)
            .order('name', { ascending: true });

        if (error) throw error;

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
        console.error('[HomeController] getCategoryProducts error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { getHomePage, getCategoryProducts };

