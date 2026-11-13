/**
 * Public product presentation.
 *
 * Never expose base_price, markup, vendor commission, or vendor bill codes.
 * Postpaid variants expose admin_fee (the service fee charged to the customer)
 * instead of a fixed product price.
 */

const POSTPAID_META_KEYS = new Set([
    'inquiry_code',
    'payment_code',
    'commission',
    'vendor_fee',
    'vendor_cost',
]);

function sanitizeProviderMeta(meta, isPostpaid) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};

    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (POSTPAID_META_KEYS.has(key)) continue;
        out[key] = value;
    }

    if (isPostpaid) out.postpaid = true;
    return out;
}

function toPublicVariant(variant, product) {
    const isPostpaid = product?.product_type === 'postpaid';

    return {
        // Bill variants use the internal id as their public id so vendor
        // payment codes (BPLA/BPAM...) never leave the backend.
        id: isPostpaid ? String(variant.id) : variant.vendor_variant_id,
        db_id: variant.id,
        product_id: variant.product_id || product?.id,
        sku: isPostpaid ? null : (variant.metadata?.sku || variant.vendor_variant_id),
        name: variant.name,
        price: isPostpaid ? 0 : (variant.sell_price || 0),
        admin_fee: isPostpaid ? (variant.sell_price || 0) : undefined,
        stock: variant.stock,
        order_process: variant.order_process,
        required_fields: variant.required_fields || [],
        validation: variant.validation || {},
        provider_meta: sanitizeProviderMeta(variant.provider_meta, isPostpaid),
        note: variant.note || '',
    };
}

function toPublicProduct(product) {
    const isPostpaid = product?.product_type === 'postpaid';
    const variants = (product?.product_variants || [])
        .filter(v => v.is_active !== false && !v.is_hidden)
        .map(v => toPublicVariant(v, product));

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
        product_type: product.product_type || 'prepaid',
        is_postpaid: isPostpaid,
        variants,
    };
}

module.exports = {
    toPublicProduct,
    toPublicVariant,
    sanitizeProviderMeta,
};
