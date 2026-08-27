/**
 * productGrouping.js
 * Central utility for normalizing product names, generating canonical group keys,
 * deduplicating catalog items for public display, and constructing multi-vendor server payloads.
 */

const VENDOR_DISPLAY_NAMES = {
    sekalipay: 'Server 1 (Sekalipay)',
    okeconnect: 'Server 2 (OkeConnect)',
};

/**
 * Normalizes product name to generate a canonical group key.
 * Used to group identical products across different vendors (e.g. "DANA" and "DANA (OkeConnect)").
 *
 * @param {string} name - Raw product name
 * @returns {string} Normalized canonical key
 */
function getCanonicalKey(name) {
    if (!name || typeof name !== 'string') return '';

    let clean = name
        .toLowerCase()
        // Remove vendor tags
        .replace(/\(okeconnect\)/gi, '')
        .replace(/\(sekalipay\)/gi, '')
        .replace(/\(fincloud\)/gi, '')
        // Remove prefixes
        .replace(/^tpg\s+/i, '')
        .replace(/^top\s*up\s*(saldo)?\s*/i, '')
        .replace(/^topup\s*(saldo)?\s*/i, '')
        .replace(/^diamond\s+/i, '')
        .replace(/^game\s+(vcr|mobile)\s+/i, '')
        .replace(/^voucher\s+/i, '')
        // Normalize terms & brand variations
        .replace(/driver|customer|promo|entitas|admin|belum admin/gi, '')
        .replace(/zepetto/gi, 'zepeto')
        .replace(/go[\s-]?pay/gi, 'gopay')
        .replace(/shopee[\s-]?pay|shopee/gi, 'shopeepay')
        .replace(/link[\s-]?aja/gi, 'linkaja')
        .replace(/free[\s-]?fire/gi, 'freefire')
        .replace(/mobile[\s-]?legends?/gi, 'mobilelegends')
        .replace(/pubg[\s-]?mobile/gi, 'pubg')
        .replace(/call[\s-]?of[\s-]?duty/gi, 'codm')
        // Strip non-alphanumeric
        .replace(/[^a-z0-9]/g, '')
        .trim();

    return clean;
}

/**
 * Clean human-readable display name for canonical group.
 * Strips vendor tags, raw prefixes, and standardizes casing.
 *
 * @param {object} product - Product object
 * @returns {string} Clean display name
 */
function getCanonicalDisplayName(product) {
    let name = (product && product.name) ? product.name : '';
    name = name
        .replace(/\s*\(OkeConnect\)/gi, '')
        .replace(/\s*\(Sekalipay\)/gi, '')
        .replace(/\s*\(Fincloud\)/gi, '')
        .replace(/^TPG\s+/i, '')
        .replace(/^Top Up Saldo\s+/i, '')
        .replace(/^Topup Saldo\s+/i, '')
        .replace(/^Top Up\s+/i, '')
        .replace(/^Diamond\s+/i, '')
        .replace(/^Game Vcr\s+/i, 'Voucher ')
        .replace(/^Game Mobile\s+/i, '')
        .trim();

    // Standard brand naming cleanups
    if (/^go[\s-]?pay/i.test(name)) name = 'GoPay';
    if (/^shopee/i.test(name)) name = 'ShopeePay';
    if (/^link[\s-]?aja/i.test(name)) name = 'LinkAja';
    if (/^ovo/i.test(name)) name = 'OVO';
    if (/^dana/i.test(name)) name = 'DANA';
    if (/^free[\s-]?fire/i.test(name)) name = 'Free Fire';
    if (/^mobile[\s-]?legends/i.test(name)) name = 'Mobile Legends';

    return name || product.name || 'Produk';
}

/**
 * Maps raw variant rows to public-safe variant objects.
 *
 * @param {Array} rawVariants - Raw product_variants rows
 * @param {string} vendor - Vendor name
 * @param {number|string} productId - Product ID
 * @returns {Array} Public variants
 */
function formatPublicVariants(rawVariants = [], vendor = 'sekalipay', productId = null) {
    return (rawVariants || [])
        .filter(v => v.is_active !== false && !v.is_hidden)
        .map(v => ({
            id: v.vendor_variant_id,
            db_id: v.id,
            product_id: productId,
            vendor: vendor,
            sku: v.metadata?.sku || v.vendor_variant_id,
            name: v.name,
            price: v.sell_price || 0,
            sell_price: v.sell_price || 0,
            stock: v.stock !== undefined ? v.stock : 9999,
            order_process: v.order_process || 'auto',
            required_fields: v.required_fields || [],
            validation: v.validation || {},
            provider_meta: v.provider_meta || {},
        }))
        .sort((a, b) => (a.price || 0) - (b.price || 0));
}

/**
 * Groups an array of product rows by their canonical key.
 * Merges vendor options and variants while selecting the best representative metadata (icon, image).
 *
 * @param {Array} productRows - Array of product rows from Supabase (with product_variants joined)
 * @returns {Array} Deduplicated unified product list
 */
function groupProducts(productRows = []) {
    const groups = new Map();

    for (const p of productRows) {
        if (p.is_active === false) continue;

        const key = getCanonicalKey(p.name);
        const groupKey = key || `prod-${p.id}`;

        const publicVariants = formatPublicVariants(p.product_variants, p.vendor, p.id);

        if (!groups.has(groupKey)) {
            // Pick preferred representative metadata: prefer Sekalipay or first item with valid image/icon
            groups.set(groupKey, {
                id: p.id,
                canonical_key: groupKey,
                name: getCanonicalDisplayName(p),
                category: p.category,
                brand: p.brand,
                icon: p.icon || null,
                image: p.image || null,
                is_active: true,
                is_featured: p.is_featured || false,
                synced_at: p.synced_at,
                created_at: p.created_at,
                servers: [],
                variants: [],
            });
        }

        const group = groups.get(groupKey);

        // Prefer richer image/icon if current representative lacks one
        if (!group.image && p.image) group.image = p.image;
        if (!group.icon && p.icon) group.icon = p.icon;
        if (p.is_featured) group.is_featured = true;

        // Register vendor server
        const vendorKey = p.vendor || 'sekalipay';
        let server = group.servers.find(s => s.vendor === vendorKey);
        if (!server) {
            server = {
                vendor: vendorKey,
                server_name: VENDOR_DISPLAY_NAMES[vendorKey] || `Server (${vendorKey})`,
                product_id: p.id,
                variants: [],
            };
            group.servers.push(server);
        }

        // Add variants to this server
        server.variants.push(...publicVariants);
    }

    // Finalize each group: sort servers (sekalipay first, then okeconnect, etc.) and variants
    const result = [];
    for (const group of groups.values()) {
        // Sort servers so Server 1 (sekalipay) is always first if present
        group.servers.sort((a, b) => {
            if (a.vendor === 'sekalipay') return -1;
            if (b.vendor === 'sekalipay') return 1;
            return a.vendor.localeCompare(b.vendor);
        });

        // Set default top-level variants to the primary server's variants
        const primaryServer = group.servers[0];
        group.variants = primaryServer ? primaryServer.variants : [];
        group.vendor = primaryServer ? primaryServer.vendor : 'sekalipay';
        group.id = primaryServer ? primaryServer.product_id : group.id;

        result.push(group);
    }

    return result;
}

/**
 * Builds a unified multi-server product object for a single product detail request.
 *
 * @param {object} primaryProduct - Main product requested
 * @param {Array} peerProducts - Other products in the same canonical group (across all vendors)
 * @returns {object} Complete multi-server product payload
 */
function buildMultiServerProduct(primaryProduct, peerProducts = []) {
    const allProducts = [primaryProduct, ...peerProducts.filter(p => p.id !== primaryProduct.id)];
    const grouped = groupProducts(allProducts);

    if (grouped.length > 0) {
        const unified = grouped[0];
        return {
            ...unified,
            id: primaryProduct.id,
            requested_vendor: primaryProduct.vendor,
        };
    }

    // Fallback if grouping produced empty
    const publicVariants = formatPublicVariants(primaryProduct.product_variants, primaryProduct.vendor, primaryProduct.id);
    return {
        id: primaryProduct.id,
        vendor: primaryProduct.vendor,
        external_id: primaryProduct.external_id,
        category: primaryProduct.category,
        name: getCanonicalDisplayName(primaryProduct),
        brand: primaryProduct.brand,
        icon: primaryProduct.icon,
        image: primaryProduct.image,
        is_active: primaryProduct.is_active,
        is_featured: primaryProduct.is_featured,
        variants: publicVariants,
        servers: [
            {
                vendor: primaryProduct.vendor,
                server_name: VENDOR_DISPLAY_NAMES[primaryProduct.vendor] || `Server 1 (${primaryProduct.vendor})`,
                product_id: primaryProduct.id,
                variants: publicVariants,
            }
        ]
    };
}

module.exports = {
    VENDOR_DISPLAY_NAMES,
    getCanonicalKey,
    getCanonicalDisplayName,
    formatPublicVariants,
    groupProducts,
    buildMultiServerProduct,
};
