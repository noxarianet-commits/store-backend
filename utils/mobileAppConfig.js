/**
 * Konfigurasi aplikasi Android (settings key `mobile_app_config`).
 *
 * Nilai yang disimpan admin harus aman dipakai aplikasi: versi dengan format
 * angka/titik, `min_version` tidak boleh lebih tinggi dari `latest_version`,
 * dan link unduhan hanya boleh http(s). Saat membaca config lama, nilai yang
 * rusak di-fallback ke default supaya satu salah ketik tidak mengunci semua
 * pengguna.
 */

const DEFAULT_MOBILE_APP_CONFIG = Object.freeze({
    min_version: '1.0.0',
    latest_version: '1.0.0',
    download_url: '',
    release_notes: '',
    maintenance: false,
    features: Object.freeze({
        bills: true,
        topup: true,
        tickets: true,
    }),
    payment_methods: Object.freeze(['balance', 'qris']),
});

const VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
const MAX_RELEASE_NOTES_LENGTH = 2000;
const MAX_DOWNLOAD_URL_LENGTH = 2048;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersion(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return VERSION_PATTERN.test(text) ? text : null;
}

/**
 * Bandingkan dua versi numerik bertitik. Mengembalikan 1 jika a > b,
 * -1 jika a < b, dan 0 jika sama.
 */
function compareVersions(a, b) {
    const parse = (value) =>
        String(value)
            .split('.')
            .map((part) => parseInt(part.replace(/\D.*$/, ''), 10) || 0);

    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.length, right.length);

    for (let i = 0; i < length; i += 1) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        if (l > r) return 1;
        if (l < r) return -1;
    }
    return 0;
}

function normalizeDownloadUrl(value) {
    if (value === undefined || value === null || value === '') {
        return { value: '' };
    }
    if (typeof value !== 'string') {
        return { error: 'Link unduhan harus berupa teks.' };
    }

    const text = value.trim();
    if (!text) return { value: '' };
    if (text.length > MAX_DOWNLOAD_URL_LENGTH) {
        return { error: 'Link unduhan terlalu panjang.' };
    }

    try {
        const url = new URL(text);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return { error: 'Link unduhan harus diawali http:// atau https://.' };
        }
    } catch (err) {
        return { error: 'Link unduhan tidak valid.' };
    }

    return { value: text };
}

function normalizeReleaseNotes(value) {
    if (value === undefined || value === null) return { value: '' };
    if (typeof value !== 'string') {
        return { error: 'Catatan rilis harus berupa teks.' };
    }

    const text = value.trim();
    if (text.length > MAX_RELEASE_NOTES_LENGTH) {
        return { error: `Catatan rilis maksimal ${MAX_RELEASE_NOTES_LENGTH} karakter.` };
    }
    return { value: text };
}

function mergeWithDefaults(base, patch) {
    const safeBase = isPlainObject(base) ? base : {};
    const safePatch = isPlainObject(patch) ? patch : {};

    const features = {
        ...DEFAULT_MOBILE_APP_CONFIG.features,
        ...(isPlainObject(safeBase.features) ? safeBase.features : {}),
        ...(isPlainObject(safePatch.features) ? safePatch.features : {}),
    };

    return {
        ...DEFAULT_MOBILE_APP_CONFIG,
        ...safeBase,
        ...safePatch,
        features,
        payment_methods: Array.isArray(safePatch.payment_methods)
            ? safePatch.payment_methods
            : Array.isArray(safeBase.payment_methods)
                ? safeBase.payment_methods
                : [...DEFAULT_MOBILE_APP_CONFIG.payment_methods],
    };
}

/**
 * Validasi dan normalisasi nilai yang dikirim admin. `base` adalah config
 * lama, dipakai supaya update parsial tidak menghapus field lain.
 *
 * @param {unknown} patch
 * @param {unknown} [base]
 * @returns {{ config: object } | { error: string }}
 */
function normalizeMobileAppConfig(patch, base) {
    if (patch !== undefined && !isPlainObject(patch)) {
        return { error: 'Konfigurasi aplikasi tidak valid.' };
    }

    const merged = mergeWithDefaults(base, patch);

    const minVersion = normalizeVersion(merged.min_version);
    if (!minVersion) {
        return { error: 'Versi minimum tidak valid. Gunakan format seperti 1.0.0.' };
    }

    const latestVersion = normalizeVersion(merged.latest_version);
    if (!latestVersion) {
        return { error: 'Versi terbaru tidak valid. Gunakan format seperti 1.0.0.' };
    }

    if (compareVersions(minVersion, latestVersion) > 0) {
        return { error: 'Versi minimum tidak boleh lebih tinggi dari versi terbaru.' };
    }

    const downloadUrl = normalizeDownloadUrl(merged.download_url);
    if (downloadUrl.error) return { error: downloadUrl.error };

    const releaseNotes = normalizeReleaseNotes(merged.release_notes);
    if (releaseNotes.error) return { error: releaseNotes.error };

    if (typeof merged.maintenance !== 'boolean') {
        return { error: 'Mode maintenance harus bernilai aktif atau nonaktif.' };
    }

    return {
        config: {
            ...merged,
            min_version: minVersion,
            latest_version: latestVersion,
            download_url: downloadUrl.value,
            release_notes: releaseNotes.value,
            maintenance: merged.maintenance,
            features: isPlainObject(merged.features)
                ? merged.features
                : { ...DEFAULT_MOBILE_APP_CONFIG.features },
            payment_methods: Array.isArray(merged.payment_methods)
                ? merged.payment_methods
                : [...DEFAULT_MOBILE_APP_CONFIG.payment_methods],
        },
    };
}

/**
 * Bentuk aman untuk dibaca aplikasi. Nilai admin yang tidak valid tidak
 * membuat aplikasi memblokir pengguna secara tidak sengaja.
 *
 * @param {unknown} stored
 * @returns {object}
 */
function sanitizeMobileAppConfigForRead(stored) {
    const merged = mergeWithDefaults(stored, null);

    const minVersion =
        normalizeVersion(merged.min_version) || DEFAULT_MOBILE_APP_CONFIG.min_version;
    let latestVersion =
        normalizeVersion(merged.latest_version) || minVersion;

    if (compareVersions(latestVersion, minVersion) < 0) {
        latestVersion = minVersion;
    }

    const downloadUrl = normalizeDownloadUrl(merged.download_url);
    const releaseNotes =
        typeof merged.release_notes === 'string'
            ? merged.release_notes.trim().slice(0, MAX_RELEASE_NOTES_LENGTH)
            : '';

    return {
        ...merged,
        min_version: minVersion,
        latest_version: latestVersion,
        download_url: downloadUrl.error ? '' : downloadUrl.value,
        release_notes: releaseNotes,
        maintenance: merged.maintenance === true,
        features: isPlainObject(merged.features)
            ? merged.features
            : { ...DEFAULT_MOBILE_APP_CONFIG.features },
        payment_methods: Array.isArray(merged.payment_methods)
            ? merged.payment_methods
            : [...DEFAULT_MOBILE_APP_CONFIG.payment_methods],
    };
}

module.exports = {
    DEFAULT_MOBILE_APP_CONFIG,
    MAX_RELEASE_NOTES_LENGTH,
    compareVersions,
    normalizeMobileAppConfig,
    sanitizeMobileAppConfigForRead,
};
