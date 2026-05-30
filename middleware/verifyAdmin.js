const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET tidak ditemukan di environment variables!');
    process.exit(1);
}

/**
 * verifyAdmin — JWT Bearer token verification middleware.
 * Supports both "Bearer <token>" and raw token format (backward compat).
 */
const verifyAdmin = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
        if (!authHeader) return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });

        // Support kedua format: "Bearer <token>" atau raw token (backward compat)
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Sesi telah berakhir. Silakan login kembali.' });
        }
        res.status(403).json({ error: 'Token tidak valid.' });
    }
};

module.exports = verifyAdmin;
