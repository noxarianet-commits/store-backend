const verifyUser = require('./verifyUser');

/**
 * verifyAppUser — require a valid customer JWT minted by the Android app login
 * or app registration-verify endpoint.
 *
 * The web login flow issues tokens without a `client` claim (or with
 * client=web). Those tokens must not be able to use app-only endpoints or buy
 * app-only products. This is a business gate, not a substitute for Play
 * Integrity: an account owner can still call the mobile login endpoint.
 */
const verifyAppUser = (req, res, next) => {
    if (!req.headers?.authorization) {
        return res.status(401).json({
            success: false,
            code: 'AUTH_REQUIRED',
            error: 'Token aplikasi tidak ditemukan.',
        });
    }

    verifyUser(req, res, () => {
        const client = String(req.user?.client || 'web').toLowerCase();

        if (client !== 'android' && client !== 'app') {
            return res.status(403).json({
                success: false,
                code: 'APP_ONLY',
                error: 'Endpoint ini hanya dapat digunakan dari aplikasi Android.',
            });
        }

        req.channel = 'app';
        return next();
    });
};

module.exports = verifyAppUser;
