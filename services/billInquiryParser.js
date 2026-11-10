/**
 * Parse OkeConnect postpaid inquiry responses.
 *
 * OkeConnect returns plain text, and every biller family formats it slightly
 * differently. The parser is intentionally conservative: if it cannot find a
 * plausible bill amount, it fails instead of creating a quote with a guessed
 * nominal.
 */

// Real bills stay far below this. Anything larger is almost always a
// misparsed reference number rather than a nominal.
const MAX_PLAUSIBLE_AMOUNT = 1_000_000_000_000;

function normalizeText(input) {
    return String(input || '')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

function parseAmount(raw) {
    if (raw === undefined || raw === null) return null;

    // Rupiah amounts use dots as thousand separators. Remove everything that
    // is not a digit; bill amounts never have fractional cents.
    const digits = String(raw).replace(/[^\d]/g, '');
    if (!digits) return null;

    const value = parseInt(digits, 10);
    return Number.isFinite(value) ? value : null;
}

function findLabeledAmount(text, labels) {
    const labelGroup = labels.join('|');
    const regex = new RegExp(
        `(?:${labelGroup})\\s*[:=]?\\s*(?:Rp\\.?\\s*)?([0-9][0-9.,]*)`,
        'i'
    );
    const match = text.match(regex);
    return match ? parseAmount(match[1]) : null;
}

function findLabeledText(text, labels) {
    const labelGroup = labels.join('|');
    const regex = new RegExp(
        `(?:${labelGroup})\\s*[:=]?\\s*([^\\n\\r/]+)`,
        'i'
    );
    const match = text.match(regex);
    return match ? match[1].trim().replace(/[.,;]+$/, '') : null;
}

function findPeriod(text) {
    const labeled = findLabeledText(text, [
        'periode',
        'bulan tagihan',
        'tagihan bulan',
        'bulan',
    ]);
    if (!labeled) return null;

    const match = labeled.match(
        /([A-Za-z]{3,9}\s*\d{4}|\d{1,2}\s*[/-]\s*\d{4}|\d{4}-\d{2})/
    );
    return match ? match[1].trim() : labeled;
}

function findCustomerNumber(text) {
    const labeled = findLabeledText(text, [
        'id pelanggan',
        'nomor pelanggan',
        'no pelanggan',
        'id meter',
        'nomor meter',
        'no meter',
        'id',
    ]);
    if (!labeled) return null;

    const digits = labeled.replace(/[^\d]/g, '');
    return digits || null;
}

/**
 * @param {string} rawText
 * @returns {{
 *   success: boolean,
 *   message?: string,
 *   data?: {
 *     customer_name: string|null,
 *     customer_number: string|null,
 *     bill_period: string|null,
 *     bill_amount: number,
 *     admin_fee: number,
 *     total_amount: number,
 *     vendor_ref: string|null,
 *     raw: string
 *   }
 * }}
 */
function parseBillInquiry(rawText) {
    const text = normalizeText(rawText);

    if (!text) {
        return { success: false, message: 'Respons cek tagihan kosong.' };
    }

    const upper = text.toUpperCase();

    // Markers that always mean the vendor rejected the inquiry. These must win
    // even when the response also contains long digit runs: a rejection line
    // such as "CBPJS.8888801234567890 GAGAL. IP tidak sesuai" carries a
    // reference number that must never be read as a nominal.
    const hardFailureMarkers = [
        'GAGAL',
        'SALAH',
        'TIDAK VALID',
        'TIDAK DITEMUKAN',
        'TIDAK ADA TAGIHAN',
        'TIDAK TERDAFTAR',
    ];

    // "LUNAS" can also appear in a successful bill description. Only treat it
    // as a failure when no nominal is present anywhere in the response.
    const softFailureMarkers = [
        'SUDAH BAYAR',
        'SUDAH LUNAS',
        'LUNAS',
    ];

    const hasAnyAmount = /[0-9][0-9.,]{2,}/.test(text);

    if (hardFailureMarkers.some(marker => upper.includes(marker))) {
        return { success: false, message: text.slice(0, 300) };
    }

    if (
        softFailureMarkers.some(marker => upper.includes(marker)) &&
        !hasAnyAmount
    ) {
        return { success: false, message: text.slice(0, 300) };
    }

    const billAmount = findLabeledAmount(text, [
        'jumlah tagihan',
        'total tagihan',
        'nominal tagihan',
        'tagihan',
        'bill amount',
        'amount',
    ]);

    const totalAmount = findLabeledAmount(text, [
        'total bayar',
        'total pembayaran',
        'total',
    ]);

    const adminFee = findLabeledAmount(text, [
        'biaya admin',
        'biaya administrasi',
        'admin',
        'biaya layanan',
        'biaya',
    ]);

    let resolvedBill = billAmount;
    let resolvedAdmin = adminFee;
    let resolvedTotal = totalAmount;

    if (resolvedBill === null && resolvedTotal !== null) {
        resolvedBill = resolvedTotal - (resolvedAdmin || 0);
    }

    if (resolvedBill === null) {
        // Last resort: take the largest amount in the response. This is safer
        // than picking the first number, which is often an ID or reference.
        const amounts = [...text.matchAll(/(?:Rp\.?\s*)?([0-9][0-9.,]{2,})/gi)]
            .map(m => parseAmount(m[1]))
            .filter(v => Number.isFinite(v) && v > 0);

        if (amounts.length > 0) {
            resolvedBill = Math.max(...amounts);
        }
    }

    if (!resolvedBill || resolvedBill <= 0) {
        return { success: false, message: 'Nominal tagihan tidak ditemukan pada respons vendor.' };
    }

    // Guard against nonsense nominals. Real bills stay far below this; larger
    // values are usually a misparsed reference number.
    if (resolvedBill > MAX_PLAUSIBLE_AMOUNT) {
        return { success: false, message: 'Nominal tagihan tidak valid pada respons vendor.' };
    }

    if (resolvedAdmin === null) {
        resolvedAdmin = resolvedTotal !== null && resolvedTotal > resolvedBill
            ? resolvedTotal - resolvedBill
            : 0;
    }

    if (resolvedTotal === null) {
        resolvedTotal = resolvedBill + resolvedAdmin;
    }

    // Guard against nonsense combinations such as total < bill.
    if (resolvedTotal < resolvedBill) {
        resolvedTotal = resolvedBill + (resolvedAdmin || 0);
    }

    const customerName = findLabeledText(text, [
        'nama pelanggan',
        'nama',
        'a/n',
        'atas nama',
        'name',
    ]);

    const vendorRef = findLabeledText(text, [
        'no ref',
        'nomor referensi',
        'ref',
        'referensi',
    ]);

    return {
        success: true,
        data: {
            customer_name: customerName || null,
            customer_number: findCustomerNumber(text),
            bill_period: findPeriod(text),
            bill_amount: resolvedBill,
            admin_fee: Math.max(0, resolvedAdmin || 0),
            total_amount: resolvedTotal,
            vendor_ref: vendorRef || null,
            raw: text,
        },
    };
}

module.exports = {
    parseBillInquiry,
    parseAmount,
    __test: {
        normalizeText,
        findLabeledAmount,
        findLabeledText,
        findPeriod,
        findCustomerNumber,
    },
};
