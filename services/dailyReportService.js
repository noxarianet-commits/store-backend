const supabase = require('../supabase');
const { logger } = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_LIMIT = 90;
const DEFAULT_HISTORY_LIMIT = 30;

// Pemisah key internal untuk peta harga modal. NUL tidak mungkin muncul di
// nama produk/varian, jadi aman dipakai sebagai delimiter.
const KEY_SEP = '\u0000';

const REPORT_COLUMNS = [
    'id',
    'report_date',
    'status',
    'total_orders',
    'completed_orders',
    'revenue',
    'refunded',
    'total_profit',
    'breakdown',
    'generated_at',
    'generated_by',
].join(', ');

class InvalidDateError extends Error {
    constructor(message = 'Parameter date wajib berformat YYYY-MM-DD.') {
        super(message);
        this.name = 'InvalidDateError';
    }
}

/**
 * Validasi + normalisasi tanggal laporan (YYYY-MM-DD).
 * Laporan memakai tanggal UTC agar konsisten dengan orders.timestamp.
 */
function normalizeDate(raw) {
    if (typeof raw !== 'string') {
        throw new InvalidDateError();
    }

    const date = raw.trim();
    if (!DATE_PATTERN.test(date)) {
        throw new InvalidDateError();
    }

    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new InvalidDateError('Tanggal tidak valid.');
    }

    return date;
}

/**
 * Nominal order yang benar-benar dibayar. Order gateway kadang menyimpan
 * price 0 dengan nominal asli di pg_total (termasuk fee + kode unik).
 */
function orderAmount(order) {
    const price = Number(order?.price) || 0;
    if (price > 0) return price;
    return Number(order?.pg_total) || 0;
}

function productKey(vendor, productName) {
    return `${vendor || 'sekalipay'}${KEY_SEP}${productName}`;
}

/**
 * Bangun indeks harga modal dari `products` + `product_variants`
 * (migration 011 — kolom JSONB lama `products.variants` sudah tidak dipakai).
 *
 * Urutan pencocokan saat menghitung COGS:
 *   1. nama produk + nama varian
 *   2. nama produk + vendor_variant_id
 *   3. rata-rata base_price seluruh varian produk tersebut
 */
function buildBasePriceIndexes(products, variants) {
    const productInfo = new Map(); // String(product.id) -> { name, vendor }

    for (const product of products || []) {
        if (product?.id == null || !product?.name) continue;
        productInfo.set(String(product.id), {
            name: product.name,
            vendor: product.vendor || 'sekalipay',
        });
    }

    const byVariantName = new Map();
    const byVendorVariantId = new Map();
    const productPrices = new Map(); // productKey -> { total, count }

    for (const variant of variants || []) {
        const info = productInfo.get(String(variant?.product_id));
        if (!info) continue;

        const basePrice = Number(variant.base_price) || 0;
        const key = productKey(info.vendor, info.name);

        if (variant.name) {
            byVariantName.set(`${key}${KEY_SEP}${variant.name}`, basePrice);
        }
        if (variant.vendor_variant_id != null) {
            byVendorVariantId.set(`${key}${KEY_SEP}${variant.vendor_variant_id}`, basePrice);
        }

        const stats = productPrices.get(key) || { total: 0, count: 0 };
        stats.total += basePrice;
        stats.count += 1;
        productPrices.set(key, stats);
    }

    const productFallback = new Map();
    for (const [key, stats] of productPrices) {
        productFallback.set(key, Math.round(stats.total / stats.count));
    }

    return { byVariantName, byVendorVariantId, productFallback };
}

/**
 * Harga modal (COGS) satu order. Selalu mengembalikan angka >= 0.
 *
 * `orders.base_price` diisi saat checkout (utils/orderCost.js) dan menjadi
 * sumber utama. Untuk order lama/manual yang kolomnya NULL, fallback ke
 * estimasi katalog (product_variants); 0 berarti data tidak ditemukan.
 */
function resolveBasePrice(order, indexes) {
    if (!order) return 0;

    if (order.base_price != null) {
        const stored = Number(order.base_price);
        if (Number.isFinite(stored)) return stored;
    }

    if (!order.product || !indexes) return 0;

    const key = productKey(order.vendor, order.product);
    const variantName = order.variant;

    if (variantName && variantName !== '-') {
        const byName = indexes.byVariantName.get(`${key}${KEY_SEP}${variantName}`);
        if (byName != null) return byName;
    }

    if (order.vendor_variant_id != null) {
        const byVendorId = indexes.byVendorVariantId.get(`${key}${KEY_SEP}${order.vendor_variant_id}`);
        if (byVendorId != null) return byVendorId;
    }

    return indexes.productFallback.get(key) || 0;
}

/**
 * Ringkas daftar order satu hari menjadi metrik laporan.
 * Pure function — sengaja tanpa akses DB supaya mudah diuji.
 */
function summarize(orders, basePriceIndexes) {
    const byStatus = {};
    const byPaymentType = {};
    const productTotals = new Map();

    let totalOrders = 0;
    let completedOrders = 0;
    let revenue = 0;
    let refunded = 0;
    let baseCostEstimate = 0;

    for (const order of orders || []) {
        totalOrders += 1;

        const status = String(order?.status || 'UNKNOWN').toUpperCase();
        const paymentType = order?.payment_type || 'gateway';
        const amount = orderAmount(order);

        byStatus[status] = (byStatus[status] || 0) + 1;
        byPaymentType[paymentType] = (byPaymentType[paymentType] || 0) + 1;

        if (status === 'COMPLETED') {
            completedOrders += 1;
            revenue += amount;
            baseCostEstimate += resolveBasePrice(order, basePriceIndexes);

            const name = order.product || '(tidak dikenal)';
            const entry = productTotals.get(name) || { name, count: 0, revenue: 0 };
            entry.count += 1;
            entry.revenue += amount;
            productTotals.set(name, entry);
        } else if (status === 'CANCELLED') {
            refunded += amount;
        }
    }

    const topProducts = Array.from(productTotals.values())
        .sort((a, b) => b.revenue - a.revenue || b.count - a.count)
        .slice(0, 5);

    return {
        total_orders: totalOrders,
        completed_orders: completedOrders,
        revenue,
        refunded,
        total_profit: revenue - baseCostEstimate,
        breakdown: {
            by_status: byStatus,
            by_payment_type: byPaymentType,
            top_products: topProducts,
            base_cost_estimate: baseCostEstimate,
        },
    };
}

async function fetchOrdersForDate(date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + DAY_MS);

    const { data, error } = await supabase
        .from('orders')
        .select('id, product, variant, vendor, vendor_variant_id, base_price, status, price, pg_total, payment_type, timestamp')
        .gte('timestamp', start.toISOString())
        .lt('timestamp', end.toISOString());

    if (error) throw error;
    return data || [];
}

/**
 * Ambil harga modal hanya untuk produk yang muncul di order hari itu.
 * Jangan select seluruh katalog: PostgREST membatasi jumlah baris (default
 * 1000), sedangkan product_variants bisa jauh lebih besar.
 */
async function fetchProductBasePrices(productNames) {
    const names = [...new Set((productNames || []).filter(Boolean))];
    if (names.length === 0) {
        return buildBasePriceIndexes([], []);
    }

    const { data: products, error: productsError } = await supabase
        .from('products')
        .select('id, name, vendor')
        .in('name', names);

    if (productsError) throw productsError;
    if (!products || products.length === 0) {
        return buildBasePriceIndexes([], []);
    }

    const productIds = products.map((product) => product.id);

    const { data: variants, error: variantsError } = await supabase
        .from('product_variants')
        .select('product_id, vendor_variant_id, name, base_price')
        .in('product_id', productIds);

    if (variantsError) throw variantsError;

    return buildBasePriceIndexes(products, variants || []);
}

async function computeStats(dateStr) {
    const date = normalizeDate(dateStr);
    const orders = await fetchOrdersForDate(date);

    // Order baru sudah menyimpan modal di orders.base_price. Query katalog
    // hanya diperlukan bila ada order COMPLETED lama yang kolomnya NULL.
    const needsCatalogueFallback = orders.some(
        (order) => String(order?.status || '').toUpperCase() === 'COMPLETED' && order.base_price == null
    );

    const basePriceIndexes = needsCatalogueFallback
        ? await fetchProductBasePrices(orders.map((order) => order.product))
        : null;

    return summarize(orders, basePriceIndexes);
}

/**
 * Ambil satu laporan berdasarkan tanggal. Null bila belum pernah dibuat.
 */
async function getDailyReport(dateStr) {
    const date = normalizeDate(dateStr);

    const { data, error } = await supabase
        .from('daily_reports')
        .select(REPORT_COLUMNS)
        .eq('report_date', date)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Generate laporan untuk satu tanggal.
 *
 * Idempoten per report_date: bila laporan sudah ada dan `force` false,
 * laporan lama dikembalikan tanpa menghitung ulang. Dengan `force` true
 * (regenerate manual admin), baris di-upsert dan status menjadi
 * 'regenerated'.
 */
async function generateDailyReport(dateStr, options = {}) {
    const date = normalizeDate(dateStr);
    const force = Boolean(options.force);
    const generatedBy = options.generatedBy != null ? String(options.generatedBy) : null;

    const existing = await getDailyReport(date);
    if (existing && !force) {
        return { report: existing, regenerated: false };
    }

    const stats = await computeStats(date);
    const row = {
        report_date: date,
        status: existing ? 'regenerated' : 'generated',
        total_orders: stats.total_orders,
        completed_orders: stats.completed_orders,
        revenue: stats.revenue,
        refunded: stats.refunded,
        total_profit: stats.total_profit,
        breakdown: stats.breakdown,
        generated_at: new Date().toISOString(),
        generated_by: generatedBy,
    };

    const { data, error } = await supabase
        .from('daily_reports')
        .upsert(row, { onConflict: 'report_date' })
        .select(REPORT_COLUMNS)
        .single();

    if (error) throw error;

    logger.info('daily_report_generated', {
        date,
        regenerated: Boolean(existing),
        totalOrders: stats.total_orders,
        completedOrders: stats.completed_orders,
        revenue: stats.revenue,
        profit: stats.total_profit,
    });

    return { report: data, regenerated: Boolean(existing) };
}

/**
 * Daftar laporan terbaru (default 30, maksimum 90).
 */
async function listDailyReports(options = {}) {
    const parsed = Number.parseInt(options.limit, 10);
    const limit = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 1), MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;

    const { data, error } = await supabase
        .from('daily_reports')
        .select(REPORT_COLUMNS)
        .order('report_date', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

module.exports = {
    DAY_MS,
    InvalidDateError,
    normalizeDate,
    orderAmount,
    buildBasePriceIndexes,
    resolveBasePrice,
    summarize,
    computeStats,
    getDailyReport,
    generateDailyReport,
    listDailyReports,
};
