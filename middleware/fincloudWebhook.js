/**
 * FinCloud is a legacy payment gateway. Its webhook can keep retrying old
 * reference IDs that no longer exist in the database.
 *
 * The gate is intentionally placed BEFORE express.json()/urlencoded() in the
 * route chain. When the provider is disabled, no body is parsed and no
 * Supabase query is made.
 */

const IGNORED_RESPONSE = {
    received: true,
    ignored: true,
    provider: 'fincloud',
};

function isFincloudWebhookEnabled() {
    return process.env.FINCLOUD_WEBHOOK_ENABLED === 'true';
}

function getIgnoredReffIds() {
    return new Set(
        String(process.env.FINCLOUD_IGNORED_REFF_IDS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
    );
}

function fincloudWebhookGate(req, res, next) {
    if (!isFincloudWebhookEnabled()) {
        return res.status(200).json(IGNORED_RESPONSE);
    }

    return next();
}

/**
 * Runs after body parsing, but before the controller. This keeps ignored
 * reference IDs from triggering any Supabase query or repeated error log.
 */
function fincloudIgnoredReffGate(req, res, next) {
    const reffId = String(
        req.body?.reff_id || req.body?.external_id || ''
    ).trim();

    if (reffId && getIgnoredReffIds().has(reffId)) {
        return res.status(200).json({
            ...IGNORED_RESPONSE,
            reason: 'ignored_reff_id',
        });
    }

    return next();
}

module.exports = {
    isFincloudWebhookEnabled,
    getIgnoredReffIds,
    fincloudWebhookGate,
    fincloudIgnoredReffGate,
    IGNORED_RESPONSE,
};
