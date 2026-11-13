const { logger } = require('../utils/logger');

/**
 * Read the active payment gateway setting.
 *
 * DYQRIS is the safe default. FinCloud may still be selected explicitly for
 * historical compatibility, but missing/invalid configuration must never
 * silently reactivate the legacy provider.
 *
 * Returns 'dyqris' (default) | 'sekalipay' | 'fincloud'.
 */
const DEFAULT_PAYMENT_GATEWAY = 'dyqris';

async function getActivePaymentGateway() {
    try {
        // Resolve at call time so tests can replace the Supabase module
        // without having to invalidate this module's cache.
        const supabase = require('../supabase');

        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'payment_gateway')
            .maybeSingle();

        if (error || !data || !data.value) return DEFAULT_PAYMENT_GATEWAY;

        let val = data.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (e) { /* keep string */ }
        }
        if (typeof val === 'object' && val !== null) {
            val = val.provider || val.value || val.gateway || DEFAULT_PAYMENT_GATEWAY;
        }

        const strVal = String(val).toLowerCase().trim();
        if (strVal === 'sekalipay') return 'sekalipay';
        if (strVal === 'dyqris') return 'dyqris';
        if (strVal === 'fincloud') {
            // Never create new FinCloud invoices while its webhook is
            // disabled: confirmations would be ignored and payments could be
            // lost. Historical FinCloud orders are still handled by polling.
            if (process.env.FINCLOUD_WEBHOOK_ENABLED === 'true') return 'fincloud';

            logger.sampled(
                'warn',
                'fincloud_gateway_disabled_fallback',
                60000,
                'fincloud_gateway_disabled_fallback',
                { fallback: DEFAULT_PAYMENT_GATEWAY }
            );
            return DEFAULT_PAYMENT_GATEWAY;
        }
        return DEFAULT_PAYMENT_GATEWAY;
    } catch {
        return DEFAULT_PAYMENT_GATEWAY;
    }
}

module.exports = { getActivePaymentGateway, DEFAULT_PAYMENT_GATEWAY };
