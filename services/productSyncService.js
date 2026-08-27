const supabase = require('../supabase');
const vendorRegistry = require('./vendors/vendorRegistry');
const cacheService = require('./cacheService');

/**
 * Unified Product Sync Service.
 * Syncs products from any registered vendor into the unified `products`
 * and `product_variants` relational database tables.
 */
class ProductSyncService {
    /**
     * Get last sync status from settings table.
     * @param {string} vendorName
     */
    async getLastSyncTime(vendorName) {
        try {
            const { data, error } = await supabase
                .from('settings')
                .select('value')
                .eq('key', `${vendorName}_last_sync`)
                .maybeSingle();

            if (error || !data) return null;
            return data.value || null;
        } catch (err) {
            console.error(`[ProductSyncService] Error getting last sync for ${vendorName}:`, err.message);
            return null;
        }
    }

    /**
     * Save sync status metadata to settings table.
     */
    async setLastSyncTime(vendorName, meta = {}) {
        try {
            await supabase
                .from('settings')
                .upsert({
                    key: `${vendorName}_last_sync`,
                    value: {
                        synced_at: new Date().toISOString(),
                        ...meta,
                    }
                }, { onConflict: 'key' });
        } catch (err) {
            console.error(`[ProductSyncService] Error saving sync time for ${vendorName}:`, err.message);
        }
    }

    /**
     * Sync products for a given vendor.
     * @param {string} vendorName - 'sekalipay' | 'fincloud' | custom vendor
     * @param {Object} options - { type: 'full'|'delta', category?: number|string }
     */
    async syncVendor(vendorName, { type = 'full', category } = {}) {
        console.log(`[ProductSyncService] Starting ${type} sync for vendor: ${vendorName}...`);
        const adapter = vendorRegistry.get(vendorName);
        if (!adapter) {
            throw new Error(`Vendor adapter '${vendorName}' is not registered`);
        }

        if (vendorName === 'sekalipay') {
            return await this._syncSekalipay(adapter, { type, category });
        } else {
            return await this._syncGenericVendor(adapter, vendorName, { type });
        }
    }

    /**
     * Sekalipay sync handler (handles 3-level hierarchy: Item -> Product -> Variant).
     */
    async _syncSekalipay(adapter, { type = 'full', category } = {}) {
        const lastSyncInfo = await this.getLastSyncTime('sekalipay');
        const lastTimestamp = (type === 'delta' && lastSyncInfo?.timestamp) ? lastSyncInfo.timestamp : null;

        const res = await adapter.fetchProducts({
            type: lastTimestamp ? 'delta' : 'full',
            updatedSince: lastTimestamp,
            category,
        });

        if (!res.success || !res.data) {
            throw new Error(res.message || 'Gagal mengambil data produk dari Sekalipay');
        }

        const categoryMap = { 1: 'Aplikasi Premium', 3: 'Game', 4: 'E-Wallet' };
        const flattened = [];

        for (const catGroup of res.data) {
            const defaultCatName = categoryMap[catGroup.categoryId] || 'Lainnya';
            for (const item of (catGroup.items || [])) {
                if (!item.products || !Array.isArray(item.products)) continue;

                for (const prod of item.products) {
                    if (!prod.variants || !Array.isArray(prod.variants)) continue;

                    const rawVariants = prod.variants.map(v => ({
                        vendor_variant_id: String(v.id),
                        name: v.name || '',
                        base_price: Math.ceil(v.price || 0),
                        stock: v.stock || 0,
                        order_process: v.order_process || 'manual',
                        h2h_provider: v.h2h_provider || null,
                        provider_meta: v.provider_meta || {},
                        required_fields: v.required_fields || [],
                        validation: v.validation || {},
                        is_active: true,
                        metadata: { sku: v.sku || '' },
                    }));

                    flattened.push({
                        vendor: 'sekalipay',
                        external_id: String(prod.id),
                        category: defaultCatName,
                        name: prod.name || item.name || 'Unknown Product',
                        icon: item.icon || null,
                        image: prod.image || null,
                        brand: null,
                        is_active: true,
                        metadata: { itemId: item.id },
                        variants: rawVariants,
                    });
                }
            }
        }

        const stats = await this._persistUnifiedProducts('sekalipay', flattened, type === 'full');
        await this.setLastSyncTime('sekalipay', {
            type,
            timestamp: res.serverTime || new Date().toISOString(),
            itemCount: flattened.length,
            productCount: stats.productsUpserted,
        });

        cacheService.invalidateHome();
        return { success: true, vendor: 'sekalipay', count: flattened.length, ...stats };
    }

    /**
     * Generic Vendor sync fallback.
     */
    async _syncGenericVendor(adapter, vendorName, { type = 'full' } = {}) {
        const res = await adapter.fetchProducts({ type });
        if (!res.success || !Array.isArray(res.data)) {
            throw new Error(res.message || `Gagal mengambil produk dari ${vendorName}`);
        }

        const stats = await this._persistUnifiedProducts(vendorName, res.data, type === 'full');
        await this.setLastSyncTime(vendorName, {
            type,
            productCount: stats.productsUpserted,
        });

        cacheService.invalidateHome();
        return { success: true, vendor: vendorName, ...stats };
    }

    /**
     * Core persistence routine to upsert products and variants while preserving
     * existing markups and hidden states in product_variants.
     */
    async _persistUnifiedProducts(vendorName, productList, isFullSync = false) {
        if (!productList || productList.length === 0) {
            return { productsUpserted: 0, variantsUpserted: 0 };
        }

        const externalIds = productList.map(p => p.external_id);

        // 1. Fetch existing products and their variants with pagination to preserve admin settings
        // Eliminates PostgREST default 1,000-row cap so all 2,000+ variants are mapped
        const existingMap = new Map();
        const existingIds = [];

        let pFrom = 0;
        const P_PAGE_SIZE = 1000;
        let pHasMore = true;
        while (pHasMore) {
            const { data: pChunk, error: pErr } = await supabase
                .from('products')
                .select('id, external_id, is_active, is_featured, image, icon')
                .eq('vendor', vendorName)
                .range(pFrom, pFrom + P_PAGE_SIZE - 1);

            if (pErr) {
                console.error(`[ProductSyncService] Error fetching existing products for ${vendorName}:`, pErr.message);
                break;
            }
            if (pChunk && pChunk.length > 0) {
                for (const ep of pChunk) {
                    existingMap.set(String(ep.external_id), ep);
                    existingIds.push(ep.id);
                }
                pFrom += P_PAGE_SIZE;
                if (pChunk.length < P_PAGE_SIZE) pHasMore = false;
            } else {
                pHasMore = false;
            }
        }

        // Fetch existing variants using pagination loop across ID chunks
        const variantMap = new Map();
        if (existingIds.length > 0) {
            const ID_CHUNK_SIZE = 100;
            const V_PAGE_SIZE = 1000;

            for (let c = 0; c < existingIds.length; c += ID_CHUNK_SIZE) {
                const idChunk = existingIds.slice(c, c + ID_CHUNK_SIZE);
                let chunkFrom = 0;
                let chunkHasMore = true;

                while (chunkHasMore) {
                    const { data: vChunk, error: vErr } = await supabase
                        .from('product_variants')
                        .select('product_id, vendor_variant_id, markup, is_hidden, is_active')
                        .in('product_id', idChunk)
                        .range(chunkFrom, chunkFrom + V_PAGE_SIZE - 1);

                    if (vErr) {
                        console.error(`[ProductSyncService] Error fetching variants for ${vendorName}:`, vErr.message);
                        break;
                    }
                    if (vChunk && vChunk.length > 0) {
                        for (const ev of vChunk) {
                            variantMap.set(`${ev.product_id}:${String(ev.vendor_variant_id)}`, ev);
                        }
                        chunkFrom += V_PAGE_SIZE;
                        if (vChunk.length < V_PAGE_SIZE) chunkHasMore = false;
                    } else {
                        chunkHasMore = false;
                    }
                }
            }
        }


        let productsUpserted = 0;
        let variantsUpserted = 0;
        const nowIso = new Date().toISOString();

        // 2. Upsert products in batches
        const BATCH_SIZE = 50;
        for (let i = 0; i < productList.length; i += BATCH_SIZE) {
            const batch = productList.slice(i, i + BATCH_SIZE);

            const productRows = batch.map(p => {
                const existing = existingMap.get(p.external_id);
                // Preserve existing image & icon (crucial for OkeConnect which does not provide image URLs)
                const preservedImage = (existing && existing.image) ? existing.image : (p.image || null);
                const preservedIcon = (existing && existing.icon) ? existing.icon : (p.icon || null);

                return {
                    vendor: vendorName,
                    external_id: p.external_id,
                    category: p.category,
                    name: p.name,
                    icon: preservedIcon,
                    image: preservedImage,
                    brand: p.brand || null,
                    is_active: existing ? existing.is_active : p.is_active,
                    is_featured: existing ? (existing.is_featured || false) : false,
                    metadata: p.metadata || {},
                    synced_at: nowIso,
                };
            });

            const { data: savedProducts, error: prodErr } = await supabase
                .from('products')
                .upsert(productRows, { onConflict: 'vendor,external_id' })
                .select('id, external_id');

            if (prodErr) {
                console.error(`[ProductSyncService] Product upsert error for ${vendorName}:`, prodErr.message);
                continue;
            }

            productsUpserted += (savedProducts || []).length;

            // Map saved product IDs back to variants
            const idMap = new Map();
            for (const sp of (savedProducts || [])) {
                idMap.set(sp.external_id, sp.id);
            }

            const variantRowMap = new Map();

            for (const p of batch) {
                const dbProductId = idMap.get(p.external_id);
                if (!dbProductId) continue;

                for (const v of (p.variants || [])) {
                    if (!v.vendor_variant_id) continue;
                    const key = `${dbProductId}:${v.vendor_variant_id}`;
                    const existingV = variantMap.get(key);
                    const markup = existingV && existingV.markup !== undefined ? existingV.markup : (v.markup ?? 1000);
                    const isHidden = existingV ? existingV.is_hidden : (v.is_hidden ?? false);
                    const sellPrice = Math.ceil((v.base_price || 0) + markup);

                    variantRowMap.set(key, {
                        product_id: dbProductId,
                        vendor_variant_id: v.vendor_variant_id,
                        name: v.name,
                        base_price: v.base_price || 0,
                        markup: markup,
                        sell_price: sellPrice,
                        stock: v.stock !== undefined ? v.stock : 9999,
                        order_process: v.order_process || 'auto',
                        h2h_provider: v.h2h_provider || null,
                        provider_meta: v.provider_meta || {},
                        required_fields: v.required_fields || [],
                        validation: v.validation || {},
                        is_hidden: isHidden,
                        is_active: v.is_active ?? true,
                        metadata: v.metadata || {},
                        synced_at: nowIso,
                    });
                }
            }

            const variantRows = Array.from(variantRowMap.values());

            // Upsert variants to product_variants table in chunks of 100
            const VAR_CHUNK_SIZE = 100;
            for (let j = 0; j < variantRows.length; j += VAR_CHUNK_SIZE) {
                const varChunk = variantRows.slice(j, j + VAR_CHUNK_SIZE);
                const { error: varErr } = await supabase
                    .from('product_variants')
                    .upsert(varChunk, { onConflict: 'product_id,vendor_variant_id' });

                if (varErr) {
                    console.error(`[ProductSyncService] Variant upsert error for ${vendorName} (chunk ${j}):`, varErr.message);
                } else {
                    variantsUpserted += varChunk.length;
                }
            }
        }


        // 3. If full sync, deactivate products missing from vendor response
        if (isFullSync && externalIds.length > 0) {
            await this._deactivateMissing(vendorName, externalIds);
        }

        return { productsUpserted, variantsUpserted };
    }

    /**
     * Deactivate products no longer present in vendor full sync.
     */
    async _deactivateMissing(vendorName, activeExternalIds) {
        try {
            const { error } = await supabase
                .from('products')
                .update({ is_active: false })
                .eq('vendor', vendorName)
                .not('external_id', 'in', `(${activeExternalIds.join(',')})`);

            if (error) {
                console.error(`[ProductSyncService] Deactivate missing error for ${vendorName}:`, error.message);
            }
        } catch (err) {
            console.error(`[ProductSyncService] Deactivate missing exception:`, err.message);
        }
    }

    /**
     * Update markup for a specific variant.
     */
    async updateVariantMarkup(productId, variantId, markup) {
        const markupVal = Math.max(0, parseInt(markup) || 0);

        let query = supabase.from('product_variants').select('id, base_price');
        if (productId) {
            query = query.eq('product_id', productId).eq('vendor_variant_id', String(variantId));
        } else {
            query = query.or(`id.eq.${variantId},vendor_variant_id.eq.${variantId}`);
        }

        const { data: variant, error: varFetchErr } = await query.maybeSingle();
        if (varFetchErr || !variant) {
            return { success: false, error: 'Variant tidak ditemukan' };
        }

        const newSell = Math.ceil(variant.base_price + markupVal);
        const { error: updateErr } = await supabase
            .from('product_variants')
            .update({ markup: markupVal, sell_price: newSell })
            .eq('id', variant.id);

        if (updateErr) return { success: false, error: updateErr.message };

        cacheService.invalidateHome();
        return { success: true };
    }

    /**
     * Update markup for all variants in a single product.
     */
    async updateProductMarkup(productId, markup) {
        const markupVal = Math.max(0, parseInt(markup) || 0);

        const { data: variants } = await supabase
            .from('product_variants')
            .select('id, base_price')
            .eq('product_id', productId);

        if (variants) {
            for (const v of variants) {
                await supabase
                    .from('product_variants')
                    .update({
                        markup: markupVal,
                        sell_price: Math.ceil(v.base_price + markupVal),
                    })
                    .eq('id', v.id);
            }
        }

        cacheService.invalidateHome();
        return { success: true };
    }

    /**
     * Apply global markup to all products and variants of a vendor.
     */
    async applyGlobalMarkup(vendorName, markup) {
        const markupVal = Math.max(0, parseInt(markup) || 0);

        let query = supabase.from('products').select('id');
        if (vendorName && vendorName !== 'all') {
            query = query.eq('vendor', vendorName);
        }

        const { data: products, error } = await query;
        if (error) return { success: false, error: error.message };

        let updatedCount = 0;
        for (const p of (products || [])) {
            await this.updateProductMarkup(p.id, markupVal);
            updatedCount++;
        }

        cacheService.invalidateHome();
        return { success: true, updatedCount };
    }
}

module.exports = new ProductSyncService();
