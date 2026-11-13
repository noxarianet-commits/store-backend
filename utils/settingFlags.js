const supabase = require('../supabase');
const { logger } = require('./logger');

/**
 * Flag "Wajib Validasi Akun".
 *
 * Settings keys:
 *   mandatory_validation       -> master switch, berlaku untuk semua channel
 *   mandatory_validation_web   -> override khusus channel web (opsional)
 *   mandatory_validation_app   -> override khusus channel app (opsional)
 *
 * Aturan efektif untuk sebuah channel:
 *   master harus ON, dan override channel (bila ada) tidak boleh OFF.
 *
 * Contoh: master ON + mandatory_validation_web=false
 *   -> web tidak mewajibkan cek ID ke penyedia
 *   -> app tetap mewajibkan cek ID
 *
 * Fail-safe: nilai hilang / tidak valid / gagal dibaca berarti validasi tetap ON.
 */
const DEFAULT_MANDATORY_VALIDATION = true;

const MASTER_VALIDATION_KEY = 'mandatory_validation';

/**
 * Override per channel. Key tidak ada (atau null) = ikut master.
 */
const CHANNEL_VALIDATION_KEYS = Object.freeze({
    web: 'mandatory_validation_web',
    app: 'mandatory_validation_app',
});

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
 * Baca satu setting boolean.
 *
 * @param {string} key
 * @returns {Promise<boolean|null>} null = key tidak ada / bukan boolean
 */
async function readBooleanSetting(key) {
    const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (error) throw error;
    return parseBooleanSetting(data?.value);
}

/**
 * Effective flag untuk sebuah channel.
 *
 * @param {string|null} [channel] 'web' | 'app'. Tanpa channel -> hanya master.
 * @returns {Promise<boolean>} true ketika validasi akun wajib dilakukan.
 */
async function isMandatoryValidationEnabled(channel = null) {
    let master = null;
    try {
        master = await readBooleanSetting(MASTER_VALIDATION_KEY);
    } catch (err) {
        logger.sampled(
            'warn',
            'mandatory_validation_read_failed',
            60000,
            'mandatory_validation_read_failed',
            { message: err.message, fallback: DEFAULT_MANDATORY_VALIDATION }
        );
    }

    const masterOn = master === null ? DEFAULT_MANDATORY_VALIDATION : master;
    if (!masterOn) return false;

    const channelKey = CHANNEL_VALIDATION_KEYS[String(channel || '').toLowerCase()];
    if (!channelKey) return true;

    let override = null;
    try {
        override = await readBooleanSetting(channelKey);
    } catch (err) {
        logger.sampled(
            'warn',
            'mandatory_validation_read_failed',
            60000,
            'mandatory_validation_read_failed',
            { channel, message: err.message, fallback: 'inherit' }
        );
    }

    // Override hanya boleh mematikan validasi, tidak menyalakannya di atas master.
    return override === false ? false : true;
}

module.exports = {
    isMandatoryValidationEnabled,
    parseBooleanSetting,
    DEFAULT_MANDATORY_VALIDATION,
    MASTER_VALIDATION_KEY,
    CHANNEL_VALIDATION_KEYS,
};
