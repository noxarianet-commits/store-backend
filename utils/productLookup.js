const { toBigIntId } = require('./dbIds');

/**
 * Execute a Supabase select and return at most one row.
 *
 * `.maybeSingle()` is deliberately not used: vendor_variant_id is only unique
 * per product, and external_id is only unique per vendor. A filter can
 * therefore match more than one row; `.limit(1)` gives deterministic
 * "first row" behaviour without turning a duplicate into a 406/PGRST116 error.
 *
 * @param {any} query Supabase query builder
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function firstRow(query) {
    const { data, error } = await query.limit(1);
    return { data: data?.[0] ?? null, error: error || null };
}

/**
 * Resolve a public variant identifier.
 *
 * Public product payloads expose product_variants.vendor_variant_id as `id`
 * (TEXT). Internal product_variants.id (BIGINT) is only a fallback for
 * backwards-compatible callers that still send a database ID.
 *
 * The TEXT lookup runs first so values like "SHP60" never reach a BIGINT
 * comparison.
 *
 * @param {any} db Supabase client
 * @param {unknown} value
 * @param {string} columns
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function findVariantByPublicId(db, value, columns) {
    const key = String(value ?? '').trim();
    if (!key) return { data: null, error: null };

    const byVendorId = await firstRow(
        db.from('product_variants').select(columns).eq('vendor_variant_id', key)
    );
    if (byVendorId.error || byVendorId.data) return byVendorId;

    const internalId = toBigIntId(key);
    if (!internalId) return { data: null, error: null };

    return firstRow(
        db.from('product_variants').select(columns).eq('id', internalId)
    );
}

/**
 * Resolve a product from either its internal BIGINT id or its external TEXT id.
 *
 * Numeric input is attempted as the internal ID first (preserves the old
 * behaviour), then falls back to external_id. Non-numeric input only queries
 * external_id, which is the important fix for values like "SHP60".
 *
 * @param {any} db Supabase client
 * @param {unknown} value
 * @param {string} columns
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function findProductByAnyId(db, value, columns) {
    const key = String(value ?? '').trim();
    if (!key) return { data: null, error: null };

    const internalId = toBigIntId(key);
    if (internalId) {
        const byId = await firstRow(
            db.from('products').select(columns).eq('id', internalId)
        );
        if (byId.error || byId.data) return byId;
    }

    return firstRow(
        db.from('products').select(columns).eq('external_id', key)
    );
}

async function findProductByExternalId(db, value, columns) {
    const key = String(value ?? '').trim();
    if (!key) return { data: null, error: null };
    return firstRow(db.from('products').select(columns).eq('external_id', key));
}

/**
 * Resolve a variant scoped to one product. Used by admin endpoints where the
 * route contains both productId and variantId.
 *
 * @param {any} db Supabase client
 * @param {unknown} productId
 * @param {unknown} variantId
 * @param {string} columns
 * @returns {Promise<{data: object|null, error: object|null}>}
 */
async function findVariantInProduct(db, productId, variantId, columns) {
    const internalProductId = toBigIntId(productId);
    const key = String(variantId ?? '').trim();
    if (!internalProductId || !key) return { data: null, error: null };

    const byVendorId = await firstRow(
        db.from('product_variants')
            .select(columns)
            .eq('product_id', internalProductId)
            .eq('vendor_variant_id', key)
    );
    if (byVendorId.error || byVendorId.data) return byVendorId;

    const internalVariantId = toBigIntId(key);
    if (!internalVariantId) return { data: null, error: null };

    return firstRow(
        db.from('product_variants')
            .select(columns)
            .eq('product_id', internalProductId)
            .eq('id', internalVariantId)
    );
}

module.exports = {
    findVariantByPublicId,
    findProductByAnyId,
    findProductByExternalId,
    findVariantInProduct,
};
