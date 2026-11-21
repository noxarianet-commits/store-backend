/**
 * Harga modal (COGS) yang disimpan ke orders.base_price saat checkout.
 *
 * - Varian open denom: vendor menagih sesuai nominal, jadi modal = provider_qty.
 * - Varian biasa: modal = product_variants.base_price.
 *
 * Mengembalikan null bila data tidak tersedia (mis. order lama/manual), supaya
 * laporan harian bisa fallback ke estimasi katalog alih-alih menganggap modal 0.
 */
function resolveOrderBasePrice(variant, providerQty) {
    if (variant?.provider_meta?.open_denom) {
        const qty = Number(providerQty);
        return Number.isFinite(qty) && qty > 0 ? qty : null;
    }

    const basePrice = Number(variant?.base_price);
    return Number.isFinite(basePrice) ? basePrice : null;
}

module.exports = { resolveOrderBasePrice };
