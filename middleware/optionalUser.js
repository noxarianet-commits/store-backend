const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * optionalUser — Middleware that sets req.user if a valid token is present, 
 * but allows the request to proceed without error if not.
 */
const optionalUser = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && JWT_SECRET) {
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.type === 'user') {
                req.user = { id: decoded.id, email: decoded.email, display_name: decoded.display_name };
            }
        }
    } catch (err) {
        // Abaikan error (token tidak valid/expired), tetapkan req.user undefined, lanjut
    }
    next();
};

module.exports = optionalUser;
