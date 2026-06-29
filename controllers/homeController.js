const supabase = require('../supabase');
const cacheService = require('../services/cacheService');

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
 * Map a product to public format (hide base_price/markup).
 * @param {object} product
 * @returns {object}
 */
function toPublicProduct(product) {
    return {
        ...product,
        variants: (product.variants || []).filter(v => !v.is_hidden).map(v => ({
            id: v.id,
            sku: v.sku,
            name: v.name,
            price: product.sekalipay_product_id ? v.sell_price : (v.price || v.sell_price),
            stock: v.stock,
            order_process: v.order_process,
            required_fields: v.required_fields,
            validation: v.validation,
            provider_meta: v.provider_meta,
        })),
    };
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
        const cacheKey = 'home_page';
        const cached = cacheService.get(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        // Fetch all data in parallel
        const [productsResult, servicesResult, testimonialsResult, settingsResult] = await Promise.all([
            supabase
                .from('products')
                .select('*')
                .eq('is_active', true)
                .order('category', { ascending: true })
                .order('name', { ascending: true }),
            supabase
                .from('services')
                .select('*')
                .eq('is_active', true)
                .order('created_at', { ascending: true }),
            supabase
                .from('testimonials')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(10),
            supabase
                .from('settings')
                .select('*'),
        ]);

        // Process settings (filter sensitive keys)
        const settingsMap = {
            shop_status: { isOpen: true, message: 'Selamat datang!' },
        };
        if (settingsResult.data) {
            settingsResult.data.forEach(s => {
                if (s.key !== 'admin_auth' && s.key !== 'sekalipay_last_sync') {
                    settingsMap[s.key] = s.value;
                }
            });
        }

        // Build categories from products
        const allProducts = productsResult.data || [];
        const categoryMap = {};

        for (const product of allProducts) {
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

        // Build featured products:
        // Priority 1: Products marked as featured by admin
        const featured = [];
        const featuredIds = new Set();
        const MAX_FEATURED = 12;

        for (const p of allProducts) {
            if (p.is_featured && featured.length < MAX_FEATURED) {
                featured.push(toPublicProduct(p));
                featuredIds.add(p.id);
            }
        }

        const responseData = {
            settings: settingsMap,
            categories: Object.values(categoryMap),
            featured_products: featured,
            all_products: allProducts.map(toPublicProduct),
            testimonials: testimonialsResult.data || [],
        };

        // Cache for 5 minutes
        cacheService.set(cacheKey, responseData, 300);

        res.json(responseData);
    } catch (err) {
        console.error('[HomeController] getHomePage error:', err.message);
        res.status(500).json({ error: err.message });
    }
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
                .select('*')
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
            .select('*')
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

        const responseData = {
            category: {
                slug,
                name: categoryName,
                type: 'product',
            },
            products: matchingProducts.map(toPublicProduct),
        };

        cacheService.set(cacheKey, responseData, 300);
        res.json(responseData);
    } catch (err) {
        console.error('[HomeController] getCategoryProducts error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { getHomePage, getCategoryProducts };
