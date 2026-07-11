const NodeCache = require('node-cache');

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
};

class CacheService {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 300,       // Default 5 minutes
            checkperiod: 60,   // Check for expired keys every 60s
            useClones: false,  // Return references for performance
        });
        this.KEYS = KEYS;

        this.cache.on('expired', (key) => {
            console.log(`[Cache] Key expired: ${key}`);
        });
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
     * Avoids repetitive get→check→set boilerplate in controllers.
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

        const data = await fetchFn();
        this.set(key, data, ttl);
        return data;
    }

    /**
     * Delete a specific key from cache.
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
            console.log(`[Cache] Invalidated ${matchingKeys.length} keys with prefix "${prefix}"`);
        }
    }

    /**
     * Invalidate ALL home-related cache keys.
     * Call this after sync or product updates.
     */
    invalidateHome() {
        this.invalidateByPrefix('home_');
        console.log('[Cache] Home cache invalidated');
    }

    /**
     * Flush entire cache.
     */
    flushAll() {
        this.cache.flushAll();
        console.log('[Cache] All cache flushed');
    }

    /**
     * Get cache statistics.
     * @returns {object}
     */
    getStats() {
        return this.cache.getStats();
    }
}

module.exports = new CacheService();
