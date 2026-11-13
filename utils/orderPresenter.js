/**
 * Remove internal vendor routing data from an order before returning it to a
 * customer client. Admins read orders directly from the database and still see
 * the full record.
 */
function sanitizeAccountDetails(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return details;

    const out = { ...details };
    delete out.vendor_ref;
    delete out.inquiry_code;
    delete out.payment_code;
    delete out.use_inquiry_ref;
    return out;
}

module.exports = { sanitizeAccountDetails };
