const vendors = new Map();

module.exports = {
    /**
     * Register a new vendor adapter
     * @param {string} name - The vendor identifier (e.g., 'sekalipay', 'fincloud')
     * @param {Object} adapter - The adapter instance extending VendorAdapter
     */
    register(name, adapter) {
        if (!adapter || typeof adapter.createOrder !== 'function') {
            throw new Error(`Invalid adapter provided for vendor '${name}'`);
        }
        vendors.set(name, adapter);
    },

    /**
     * Get a registered vendor adapter
     * @param {string} name - The vendor identifier
     * @returns {Object} The adapter instance
     */
    get(name) {
        const vendor = vendors.get(name);
        if (!vendor) {
            throw new Error(`Vendor '${name}' not registered`);
        }
        return vendor;
    },

    /**
     * List all registered vendor names
     * @returns {string[]} Array of vendor names
     */
    list() {
        return Array.from(vendors.keys());
    },

    /**
     * Check if a vendor is registered
     * @param {string} name - The vendor identifier
     * @returns {boolean}
     */
    has(name) {
        return vendors.has(name);
    }
};
