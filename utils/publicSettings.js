/**
 * Settings that are safe to expose to the public storefront.
 *
 * This is an allowlist, not a denylist. Adding a new secret-bearing key to
 * the settings table must never make it public by default.
 */
const PUBLIC_SETTING_KEYS = new Set([
    'shop_status',
    'site_content',
    'wa_group_link',
    'whatsapp_cs',
    'info_modal_active',
    'info_modal_text',
    'info_modal_image',
    'payment_gateway',
    'mandatory_validation',
    'mandatory_validation_web',
]);

/**
 * @param {Array<{key: string, value: unknown}>|null|undefined} rows
 * @param {Record<string, unknown>} [defaults]
 * @returns {Record<string, unknown>}
 */
function buildPublicSettings(rows, defaults = {}) {
    const out = { ...defaults };

    for (const row of rows || []) {
        if (!row || !PUBLIC_SETTING_KEYS.has(row.key)) continue;
        out[row.key] = row.value;
    }

    return out;
}

module.exports = { PUBLIC_SETTING_KEYS, buildPublicSettings };
