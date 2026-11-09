const supabase = require('../supabase');
const { logger } = require('./logger');

/**
 * Flag "Wajib Validasi Akun" (settings key: mandatory_validation).
 *
 * When true (default), products whose variants expose validation metadata
 * must pass the provider account check before an order can be created.
 * Admin can switch it off from the dashboard when the provider validation
 * endpoint is disrupted, so transactions keep flowing without the check.
 *
 * Fail-safe: any missing/invalid value means mandatory validation stays ON.
 */
const DEFAULT_MANDATORY_VALIDATION = true;

function toBooleanStrict(val) {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
        const str = val.trim().toLowerCase();
        if (str === 'true') return true;
        if (str === 'false') return false;
    }
    return null;
}

function parseBooleanSetting(raw) {
    let val = raw;
    if (typeof val === 'string') {
        try {
            val = JSON.parse(val);
        } catch (e) {
            return toBooleanStrict(val);
        }
    }
    if (typeof val === 'object' && val !== null) {
        val = val.value ?? val.enabled ?? val.active;
    }
    return toBooleanStrict(val);
}

/**
 * @returns {Promise<boolean>} true when account validation is mandatory.
 */
async function isMandatoryValidationEnabled() {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'mandatory_validation')
            .maybeSingle();

        if (error) throw error;
        const parsed = parseBooleanSetting(data?.value);
        return parsed === null ? DEFAULT_MANDATORY_VALIDATION : parsed;
    } catch (err) {
        logger.sampled(
            'warn',
            'mandatory_validation_read_failed',
            60000,
            'mandatory_validation_read_failed',
            { message: err.message, fallback: DEFAULT_MANDATORY_VALIDATION }
        );
        return DEFAULT_MANDATORY_VALIDATION;
    }
}

module.exports = { isMandatoryValidationEnabled, parseBooleanSetting, DEFAULT_MANDATORY_VALIDATION };
