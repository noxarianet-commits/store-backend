const supabase = require('../supabase');
const vendorRegistry = require('./vendors/vendorRegistry');
const cacheService = require('./cacheService');

/**
 * FincloudSyncService — Handles synchronization of Fincloud PPOB products to local DB.
 * 
 * Maps Fincloud flat product structure into the `fincloud_products` table.
 */
class FincloudSyncService {
    /**
     * Get the last sync timestamp from settings table.
     */
    async getLastSyncTime() {
        try {
            const { data, error } = await supabase
                .from('settings')
                .select('value')
                .eq('key', 'fincloud_last_sync')
                .maybeSingle();

            if (error || !data) return null;
            return data.value?.synced_at || null;
        } catch (err) {
            console.error('[FincloudSyncService] Error getting last sync time:', err.message);
            return null;
        }
    }

    /**
     * Save the sync timestamp and metadata to settings table.
     */
    async setLastSyncTime(meta = {}) {
        try {
            await supabase
                .from('settings')
                .upsert({
                    key: 'fincloud_last_sync',
                    value: {
                        synced_at: new Date().toISOString(),
                        ...meta,
                    }
                }, { onConflict: 'key' });
        } catch (err) {
            console.error('[FincloudSyncService] Error saving sync time:', err.message);
        }
    }

    /**
     * Run a full sync of all Fincloud products
     */
    async syncAllProducts() {
        console.log('[FincloudSyncService] Starting full sync...');
        const startTime = Date.now();
        let totalUpserted = 0;
        let totalErrors = 0;

        try {
            const adapter = vendorRegistry.get('fincloud');
            const res = await adapter.fetchProducts();

            if (!res.success || !res.data || !Array.isArray(res.data.data)) {
                throw new Error(res.message || 'Invalid response from Fincloud API');
            }

            let rawProducts = res.data.data;
            
            // Filter hanya untuk E-Money dan Games
            rawProducts = rawProducts.filter(p => {
                const cat = p.category || p.kategori;
                return cat === 'E-Money' || cat === 'Games';
            });
            
            // Map Fincloud products to our db schema
            const products = rawProducts.map(p => ({
                sku: p.sku,
                name: p.product_name || p.name || p.produk || '',
                category: p.category || p.kategori || 'Uncategorized',
                brand: p.brand || p.provider || '',
                base_price: Math.ceil(p.price || p.harga || 0),
                markup: 1000,
                sell_price: Math.ceil(p.price || p.harga || 0) + 1000,
                is_available: p.status === 'active' || p.status === 'normal' || p.status === 'tersedia' || p.status === true,
                is_hidden: false,
                product_meta: p
            }));

            // Fetch existing products to preserve markup and visibility
            const { data: existingProducts, error: fetchErr } = await supabase
                .from('fincloud_products')
                .select('sku, markup, sell_price, is_hidden');
            
            if (fetchErr) throw fetchErr;
            
            const existingMap = new Map();
            if (existingProducts) {
                for (const ep of existingProducts) {
                    existingMap.set(ep.sku, ep);
                }
            }

            // Merge with existing data
            for (const p of products) {
                if (existingMap.has(p.sku)) {
                    const ep = existingMap.get(p.sku);
                    p.markup = ep.markup;
                    p.sell_price = p.base_price + p.markup;
                    p.is_hidden = ep.is_hidden;
                }
            }

            // Upsert in batches of 100
            const BATCH_SIZE = 100;
            for (let i = 0; i < products.length; i += BATCH_SIZE) {
                const batch = products.slice(i, i + BATCH_SIZE);
                
                const { error: upsertErr } = await supabase
                    .from('fincloud_products')
                    .upsert(batch, { onConflict: 'sku' });
                
                if (upsertErr) {
                    console.error(`[FincloudSyncService] Batch upsert error:`, upsertErr.message);
                    totalErrors += batch.length;
                } else {
                    totalUpserted += batch.length;
                }
            }

            // Mark unavailable those that were not in the API response
            const currentSkus = new Set(products.map(p => p.sku));
            const skusToDeactivate = [];
            for (const ep of existingProducts || []) {
                if (!currentSkus.has(ep.sku)) {
                    skusToDeactivate.push(ep.sku);
                }
            }

            if (skusToDeactivate.length > 0) {
                const { error: deactErr } = await supabase
                    .from('fincloud_products')
                    .update({ is_available: false })
                    .in('sku', skusToDeactivate);
                
                if (deactErr) console.error('[FincloudSyncService] Error deactivating old products:', deactErr.message);
            }

            await this.setLastSyncTime({
                total_products: products.length,
                total_upserted: totalUpserted,
                total_errors: totalErrors,
                deactivated: skusToDeactivate.length
            });

            // Invalidate cache
            cacheService.invalidateHome();

            const duration = (Date.now() - startTime) / 1000;
            console.log(`[FincloudSyncService] Sync completed in ${duration}s. Upserted: ${totalUpserted}, Errors: ${totalErrors}`);
            
            return {
                success: true,
                message: `Synced ${totalUpserted} products`,
                stats: { total: products.length, upserted: totalUpserted, errors: totalErrors, deactivated: skusToDeactivate.length }
            };

        } catch (error) {
            console.error('[FincloudSyncService] Sync failed:', error.message);
            return { success: false, message: error.message };
        }
    }
}

module.exports = new FincloudSyncService();
