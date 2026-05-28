const supabase = require('../supabase');
const sekalipayService = require('./sekalipayService');

/**
 * SyncService — Handles synchronization of Sekalipay products to local DB.
 * 
 * Flattens the Sekalipay 3-level hierarchy (Item → Product → Variant) into 
 * a products table where each Sekalipay "Product" = one row, and variants 
 * are stored as a JSONB array within the product row.
 * 
 * Supports:
 * - Full sync: Fetch all items and upsert (daily at 3 AM)
 * - Delta sync: Fetch only changed items since last sync (every 3 hours)
 */
class SyncService {
    /**
     * Get the last sync timestamp from settings table.
     * @returns {Promise<string|null>} ISO 8601 timestamp or null
     */
    async getLastSyncTime() {
        try {
            const { data, error } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'sekalipay_last_sync')
                .maybeSingle();

            if (error || !data) return null;
            return data.value?.timestamp || null;
        } catch (err) {
            console.error('[SyncService] Error getting last sync time:', err.message);
            return null;
        }
    }

    /**
     * Save the sync timestamp and metadata to settings table.
     * @param {string} serverTime - server_time from Sekalipay response
     * @param {object} meta - Additional sync metadata
     */
    async setLastSyncTime(serverTime, meta = {}) {
        try {
            await supabase
                .from('settings')
                .upsert({
                    key: 'sekalipay_last_sync',
                    value: {
                        timestamp: serverTime,
                        synced_at: new Date().toISOString(),
                        ...meta,
                    }
                }, { onConflict: 'key' });
        } catch (err) {
            console.error('[SyncService] Error saving sync time:', err.message);
        }
    }

    /**
     * Flatten Sekalipay API response into product rows.
     * 
     * Sekalipay hierarchy:
     *   Item (category) → Product → Variant
     * 
     * Our DB:
     *   Each Sekalipay "Product" → one row in `products` table
     *   Variants stored as JSONB array
     * 
     * @param {Array} items - Raw items from Sekalipay API
     * @returns {Array} Flattened product rows ready for upsert
     */
    flattenItems(items) {
        const products = [];

        for (const item of items) {
            if (!item.products || !Array.isArray(item.products)) continue;

            for (const product of item.products) {
                if (!product.variants || !Array.isArray(product.variants)) continue;

                const variants = product.variants.map(v => ({
                    id: v.id,
                    sku: v.sku || '',
                    name: v.name || '',
                    base_price: v.price || 0,
                    markup: 0,           // Default markup, admin can override
                    sell_price: v.price || 0,  // base_price + markup
                    stock: v.stock || 0,
                    order_process: v.order_process || 'manual',
                    h2h_provider: v.h2h_provider || null,
                    provider_meta: v.provider_meta || null,
                    required_fields: v.required_fields || [],
                    validation: v.validation || null,
                    updated_at: v.updated_at || null,
                }));

                products.push({
                    sekalipay_item_id: item.id,
                    sekalipay_product_id: product.id,
                    category: item.name || 'Uncategorized',
                    name: product.name || 'Unknown Product',
                    icon: item.icon || null,
                    image: product.image || null,
                    variants,
                    is_active: true,
                    synced_at: new Date().toISOString(),
                });
            }
        }

        return products;
    }

    /**
     * Merge new variants with existing ones, preserving admin-set markups.
     * 
     * @param {Array} existingVariants - Current variants from DB
     * @param {Array} newVariants - Fresh variants from Sekalipay
     * @returns {Array} Merged variants
     */
    mergeVariants(existingVariants, newVariants) {
        const existingMap = {};
        if (Array.isArray(existingVariants)) {
            for (const v of existingVariants) {
                existingMap[v.id] = v;
            }
        }

        return newVariants.map(newV => {
            const existing = existingMap[newV.id];
            if (existing) {
                // Preserve admin markup, update everything else
                const markup = existing.markup || 0;
                return {
                    ...newV,
                    markup,
                    sell_price: newV.base_price + markup,
                };
            }
            return newV;
        });
    }

    /**
     * Full sync: Fetch ALL items from Sekalipay and upsert to DB.
     * This replaces all product data but preserves admin markups.
     * 
     * @returns {{ success: boolean, itemCount?: number, productCount?: number, error?: string }}
     */
    async fullSync() {
        console.log('[SyncService] Starting full sync...');
        try {
            const result = await sekalipayService.fetchAllItems(1);
            if (!result.success) {
                console.error('[SyncService] Failed to fetch items:', result.message);
                return { success: false, error: result.message };
            }

            const items = result.data;
            if (!items || items.length === 0) {
                console.log('[SyncService] No items returned from Sekalipay.');
                return { success: true, itemCount: 0, productCount: 0 };
            }

            const newProducts = this.flattenItems(items);
            console.log(`[SyncService] Flattened ${items.length} items into ${newProducts.length} products.`);

            // Fetch existing products to preserve markups
            const { data: existingProducts } = await supabase
                .from('products')
                .select('sekalipay_product_id, variants');

            const existingMap = {};
            if (existingProducts) {
                for (const ep of existingProducts) {
                    existingMap[ep.sekalipay_product_id] = ep.variants;
                }
            }

            // Merge variants (preserve markups) and upsert in batches
            let upsertedCount = 0;
            const batchSize = 50;

            for (let i = 0; i < newProducts.length; i += batchSize) {
                const batch = newProducts.slice(i, i + batchSize).map(product => {
                    const existingVars = existingMap[product.sekalipay_product_id];
                    if (existingVars) {
                        product.variants = this.mergeVariants(existingVars, product.variants);
                    }
                    return product;
                });

                const { error } = await supabase
                    .from('products')
                    .upsert(batch, { onConflict: 'sekalipay_product_id' });

                if (error) {
                    console.error(`[SyncService] Batch upsert error (batch ${i / batchSize + 1}):`, error.message);
                } else {
                    upsertedCount += batch.length;
                }
            }

            // Optionally: deactivate products no longer in Sekalipay
            const activeProductIds = newProducts.map(p => p.sekalipay_product_id);
            if (activeProductIds.length > 0) {
                await supabase
                    .from('products')
                    .update({ is_active: false })
                    .not('sekalipay_product_id', 'in', `(${activeProductIds.join(',')})`);
            }

            // Save sync metadata
            await this.setLastSyncTime(result.serverTime, {
                type: 'full',
                itemCount: items.length,
                productCount: upsertedCount,
            });

            console.log(`[SyncService] Full sync completed. ${upsertedCount} products upserted.`);
            return {
                success: true,
                itemCount: items.length,
                productCount: upsertedCount,
            };
        } catch (err) {
            console.error('[SyncService] Full sync error:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Delta sync: Fetch only items updated since last sync.
     * Falls back to full sync if no previous sync timestamp exists.
     * 
     * @returns {{ success: boolean, itemCount?: number, productCount?: number, error?: string }}
     */
    async deltaSync() {
        console.log('[SyncService] Starting delta sync...');

        const lastSync = await this.getLastSyncTime();
        if (!lastSync) {
            console.log('[SyncService] No previous sync found, falling back to full sync.');
            return this.fullSync();
        }

        try {
            const result = await sekalipayService.fetchItemsDelta(lastSync, 1);
            if (!result.success) {
                console.error('[SyncService] Failed to fetch delta items:', result.message);
                return { success: false, error: result.message };
            }

            const items = result.data;
            if (!items || items.length === 0) {
                console.log('[SyncService] No items changed since last sync.');
                await this.setLastSyncTime(result.serverTime, {
                    type: 'delta',
                    itemCount: 0,
                    productCount: 0,
                });
                return { success: true, itemCount: 0, productCount: 0 };
            }

            const newProducts = this.flattenItems(items);
            console.log(`[SyncService] Delta: ${items.length} items → ${newProducts.length} products changed.`);

            // Fetch existing to preserve markups
            const changedIds = newProducts.map(p => p.sekalipay_product_id);
            const { data: existingProducts } = await supabase
                .from('products')
                .select('sekalipay_product_id, variants')
                .in('sekalipay_product_id', changedIds);

            const existingMap = {};
            if (existingProducts) {
                for (const ep of existingProducts) {
                    existingMap[ep.sekalipay_product_id] = ep.variants;
                }
            }

            // Merge and upsert
            let upsertedCount = 0;
            const batchSize = 50;

            for (let i = 0; i < newProducts.length; i += batchSize) {
                const batch = newProducts.slice(i, i + batchSize).map(product => {
                    const existingVars = existingMap[product.sekalipay_product_id];
                    if (existingVars) {
                        product.variants = this.mergeVariants(existingVars, product.variants);
                    }
                    return product;
                });

                const { error } = await supabase
                    .from('products')
                    .upsert(batch, { onConflict: 'sekalipay_product_id' });

                if (error) {
                    console.error(`[SyncService] Delta batch error:`, error.message);
                } else {
                    upsertedCount += batch.length;
                }
            }

            await this.setLastSyncTime(result.serverTime, {
                type: 'delta',
                itemCount: items.length,
                productCount: upsertedCount,
            });

            console.log(`[SyncService] Delta sync completed. ${upsertedCount} products updated.`);
            return {
                success: true,
                itemCount: items.length,
                productCount: upsertedCount,
            };
        } catch (err) {
            console.error('[SyncService] Delta sync error:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Update markup for a specific variant within a product.
     * Recalculates sell_price = base_price + markup.
     * 
     * @param {number} productId - DB product ID (primary key)
     * @param {number} variantId - Sekalipay variant ID
     * @param {number} markup - Markup amount in Rupiah
     * @returns {{ success: boolean, error?: string }}
     */
    async updateVariantMarkup(productId, variantId, markup) {
        try {
            // Fetch current product
            const { data: product, error: fetchError } = await supabase
                .from('products')
                .select('variants')
                .eq('id', productId)
                .single();

            if (fetchError || !product) {
                return { success: false, error: 'Product not found' };
            }

            // Update the specific variant
            const variants = (product.variants || []).map(v => {
                if (v.id === variantId) {
                    return {
                        ...v,
                        markup: Math.max(0, markup), // No negative markups
                        sell_price: v.base_price + Math.max(0, markup),
                    };
                }
                return v;
            });

            const { error: updateError } = await supabase
                .from('products')
                .update({ variants })
                .eq('id', productId);

            if (updateError) {
                return { success: false, error: updateError.message };
            }

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Apply bulk markup to all variants in a product.
     * 
     * @param {number} productId - DB product ID
     * @param {number} markup - Markup amount in Rupiah
     * @returns {{ success: boolean, error?: string }}
     */
    async updateProductMarkup(productId, markup) {
        try {
            const { data: product, error: fetchError } = await supabase
                .from('products')
                .select('variants')
                .eq('id', productId)
                .single();

            if (fetchError || !product) {
                return { success: false, error: 'Product not found' };
            }

            const variants = (product.variants || []).map(v => ({
                ...v,
                markup: Math.max(0, markup),
                sell_price: v.base_price + Math.max(0, markup),
            }));

            const { error: updateError } = await supabase
                .from('products')
                .update({ variants })
                .eq('id', productId);

            if (updateError) {
                return { success: false, error: updateError.message };
            }

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Apply global markup to ALL products and variants.
     * 
     * @param {number} markup - Markup amount in Rupiah
     * @returns {{ success: boolean, updatedCount?: number, error?: string }}
     */
    async applyGlobalMarkup(markup) {
        try {
            const { data: products, error: fetchError } = await supabase
                .from('products')
                .select('id, variants');

            if (fetchError) {
                return { success: false, error: fetchError.message };
            }

            let updatedCount = 0;
            for (const product of products) {
                const variants = (product.variants || []).map(v => ({
                    ...v,
                    markup: Math.max(0, markup),
                    sell_price: v.base_price + Math.max(0, markup),
                }));

                const { error } = await supabase
                    .from('products')
                    .update({ variants })
                    .eq('id', product.id);

                if (!error) updatedCount++;
            }

            return { success: true, updatedCount };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

module.exports = new SyncService();
