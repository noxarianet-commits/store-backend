const NodeCache = require('node-cache');
const { logger } = require('../utils/logger');

/**
 * CacheService — In-memory cache wrapper using node-cache.
 * Provides TTL-based caching to reduce database queries.
 */
/**
 * Standard cache key prefixes.
 * All home-related keys use 'home_' prefix so invalidateHome() clears them.
 */
const KEYS = {
    HOME_PAGE: 'home_page',
    HOME_CATEGORY: (slug) => `home_category_${slug}`,
    CATALOG: 'home_catalog',
    PUBLIC_SETTINGS: 'home_public_settings',
    VENDOR_BALANCE: (vendor) => `vendor_balance_${vendor}`,
    ACCOUNT_VALIDATION: (vendor, key) => `val_${vendor}_${key}`,
};

class CacheService {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 300,       // Default 5 minutes
            checkperiod: 60,   // Check for expired keys every 60s
            useClones: false,  // Return references for performance
        });
        this.pending = new Map();
        this.KEYS = KEYS;
    }

    /**
     * Get a value from cache.
     * @param {string} key
     * @returns {any|undefined}
     */
    get(key) {
        return this.cache.get(key);
    }

    /**
     * Set a value in cache.
     * @param {string} key
     * @param {any} value
     * @param {number} [ttl] - TTL in seconds (optional, uses default if not set)
     */
    set(key, value, ttl) {
        if (ttl !== undefined) {
            this.cache.set(key, value, ttl);
        } else {
            this.cache.set(key, value);
        }
    }

    /**
     * Get from cache or fetch and cache the result.
     *
     * Concurrent misses for the same key share one in-flight promise. Without
     * this, several cold requests can fetch the entire product catalog in
     * parallel, multiplying Supabase egress.
     *
     * @param {string} key - Cache key
     * @param {Function} fetchFn - Async function that returns the data to cache
     * @param {number} [ttl=300] - TTL in seconds (default 5 minutes)
     * @returns {Promise<any>} Cached or freshly fetched data
     */
    async getOrSet(key, fetchFn, ttl = 300) {
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const existing = this.pending.get(key);
        if (existing) return existing;

        const promise = (async () => {
            try {
                const data = await fetchFn();
                this.set(key, data, ttl);
                return data;
            } finally {
                this.pending.delete(key);
            }
        })();

        this.pending.set(key, promise);
        return promise;
    }

    /**
     * Delete a specific key.
     * @param {string} key
     */
    del(key) {
        this.cache.del(key);
    }

    /**
     * Invalidate all keys matching a prefix.
     * @param {string} prefix
     */
    invalidateByPrefix(prefix) {
        const keys = this.cache.keys();
        const matchingKeys = keys.filter(k => k.startsWith(prefix));
        if (matchingKeys.length > 0) {
            this.cache.del(matchingKeys);
            logger.debug('cache_invalidated', { prefix, count: matchingKeys.length });
        }
    }

    /**
     * Optimistically deduct cached balance for a vendor.
     * @param {string} vendor
     * @param {number} amount
     */
    deductCachedBalance(vendor, amount) {
        const key = this.KEYS.VENDOR_BALANCE(vendor);
        const cached = this.get(key);
        if (cached && typeof cached.balance === 'number') {
            const newBalance = Math.max(0, cached.balance - (amount || 0));
            this.set(key, {
                ...cached,
                balance: newBalance,
                data: {
                    ...(cached.data || {}),
                    balance: newBalance,
                    formatted: `Rp ${newBalance.toLocaleString('id-ID')}`
                }
            }, 60);
            logger.debug('vendor_balance_optimistic_deduction', { vendor, amount, newBalance });
        }
    }

    /**
     * Invalidate ALL home-related cache keys.
     * Call this after sync or product updates.
     */
    invalidateHome() {
        this.invalidateByPrefix('home_');
    }

    /**
     * Flush entire cache.
     */
    flushAll() {
        this.cache.flushAll();
    }

    /**
     * Get cache statistics.
     */
    getStats() {
        return this.cache.getStats();
    }
}

module.exports = new CacheService();
