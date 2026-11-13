const crypto = require('crypto');
const supabase = require('../supabase');

function generateOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `NX-${ts}-${rand}`;
}

function generateOrderAccessToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate unique payment code (1–100) not used by any active PENDING order.
 */
async function generateUniqueCode() {
    const { data: pendingOrders } = await supabase
        .from('orders')
        .select('unique_code')
        .eq('status', 'PENDING')
        .gt('unique_code', 0)
        .limit(500);

    const usedCodes = new Set((pendingOrders || []).map(o => o.unique_code));

    let code;
    let attempts = 0;
    do {
        code = Math.floor(Math.random() * 100) + 1;
        attempts++;
    } while (usedCodes.has(code) && attempts < 200);

    if (usedCodes.has(code)) {
        code = Math.floor(Math.random() * 100) + 1;
    }

    return code;
}

module.exports = {
    generateOrderId,
    generateOrderAccessToken,
    generateUniqueCode,
};
