/**
 * Channel helpers.
 *
 * A product may be sold on one or more storefronts. The array lives on
 * products.available_channels and is intentionally small:
 *   {web}      -> web only
 *   {app}      -> Android app only
 *   {web,app}  -> both
 *
 * Hiding a product from a catalog is only presentation. The order creation
 * paths must also call isAvailableForChannel() so an app-only product cannot
 * be bought through /api/payments/create by guessing its ID.
 */

const CHANNELS = Object.freeze({
    WEB: 'web',
    APP: 'app',
});

const CHANNEL_VALUES = Object.freeze(Object.values(CHANNELS));
const DEFAULT_CHANNELS = Object.freeze([CHANNELS.WEB, CHANNELS.APP]);

/**
 * Normalize admin input into a deduplicated channel array.
 * Returns null when the input is not a non-empty array of known channels.
 *
 * @param {unknown} input
 * @returns {string[]|null}
 */
function normalizeChannels(input) {
    if (!Array.isArray(input) || input.length === 0) return null;

    const values = [];
    for (const raw of input) {
        const value = String(raw || '').trim().toLowerCase();
        if (!CHANNEL_VALUES.includes(value)) return null;
        if (!values.includes(value)) values.push(value);
    }

    return values.length > 0 ? values : null;
}

/**
 * Read the channels from a product row. Legacy rows without the column are
 * treated as available everywhere, matching the migration default.
 *
 * @param {object} product
 * @returns {string[]}
 */
function productChannels(product) {
    const raw = product?.available_channels;
    if (Array.isArray(raw) && raw.length > 0) {
        const cleaned = raw
            .map(v => String(v || '').trim().toLowerCase())
            .filter(v => CHANNEL_VALUES.includes(v));
        if (cleaned.length > 0) return cleaned;
    }
    return [...DEFAULT_CHANNELS];
}

/**
 * @param {object} product
 * @param {string} channel
 * @returns {boolean}
 */
function isAvailableForChannel(product, channel) {
    const target = String(channel || '').trim().toLowerCase();
    if (!CHANNEL_VALUES.includes(target)) return false;
    return productChannels(product).includes(target);
}

/**
 * @param {object[]} products
 * @param {string} channel
 * @returns {object[]}
 */
function filterProductsForChannel(products, channel) {
    return (products || []).filter(product => isAvailableForChannel(product, channel));
}

/**
 * Resolve the channel of a request. Mobile routes set req.channel explicitly
 * in verifyAppUser; web routes default to web.
 *
 * @param {object} req
 * @returns {string}
 */
function channelFromRequest(req) {
    const explicit = String(req?.channel || '').trim().toLowerCase();
    if (CHANNEL_VALUES.includes(explicit)) return explicit;

    const client = String(req?.user?.client || '').trim().toLowerCase();
    if (client === 'android' || client === 'app') return CHANNELS.APP;

    return CHANNELS.WEB;
}

module.exports = {
    CHANNELS,
    CHANNEL_VALUES,
    DEFAULT_CHANNELS,
    normalizeChannels,
    productChannels,
    isAvailableForChannel,
    filterProductsForChannel,
    channelFromRequest,
};
