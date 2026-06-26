const NodeCache = require('node-cache');

/**
 * CacheService — In-memory cache wrapper using node-cache.
 * Provides TTL-based caching to reduce database queries.
 */
class CacheService {
    constructor() {
        this.cache = new NodeCache({
            stdTTL: 300,       // Default 5 minutes
            checkperiod: 60,   // Check for expired keys every 60s
            useClones: false,  // Return references for performance
        });

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
