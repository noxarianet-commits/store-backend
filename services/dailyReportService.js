const supabase = require('../supabase');
const { logger } = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_LIMIT = 90;
const DEFAULT_HISTORY_LIMIT = 30;

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

/**
 * Peta nama produk → base_price varian pertama.
 * Dipakai sebagai estimasi modal (COGS) karena orders tidak menyimpan
 * harga modal per baris.
 */
function buildBasePriceMap(products) {
    const map = new Map();

    for (const product of products || []) {
        if (!product?.name) continue;
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const firstVariant = variants[0] || {};
        map.set(product.name, Number(firstVariant.base_price) || 0);
    }

    return map;
}

/**
 * Ringkas daftar order satu hari menjadi metrik laporan.
 * Pure function — sengaja tanpa akses DB supaya mudah diuji.
 */
function summarize(orders, basePriceMap) {
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
            baseCostEstimate += basePriceMap.get(order.product) || 0;

            const key = order.product || '(tidak dikenal)';
            const entry = productTotals.get(key) || { name: key, count: 0, revenue: 0 };
            entry.count += 1;
            entry.revenue += amount;
            productTotals.set(key, entry);
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
        .select('id, product, status, price, pg_total, payment_type, timestamp')
        .gte('timestamp', start.toISOString())
        .lt('timestamp', end.toISOString());

    if (error) throw error;
    return data || [];
}

async function fetchProductBasePrices() {
    const { data, error } = await supabase
        .from('products')
        .select('name, variants');

    if (error) throw error;
    return buildBasePriceMap(data);
}

async function computeStats(dateStr) {
    const date = normalizeDate(dateStr);

    const [orders, basePriceMap] = await Promise.all([
        fetchOrdersForDate(date),
        fetchProductBasePrices(),
    ]);

    return summarize(orders, basePriceMap);
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
    buildBasePriceMap,
    summarize,
    computeStats,
    getDailyReport,
    generateDailyReport,
    listDailyReports,
};
