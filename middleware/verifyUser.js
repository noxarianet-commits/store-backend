const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET tidak ditemukan di environment variables!');
    process.exit(1);
}

/**
 * verifyUser — JWT Bearer token verification middleware for users.
 */
const verifyUser = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });

        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.type !== 'user') {
             return res.status(403).json({ error: 'Token tidak valid untuk user.' });
        }
        
        req.user = { id: decoded.id, email: decoded.email, display_name: decoded.display_name };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Sesi telah berakhir. Silakan login kembali.' });
        }
        res.status(403).json({ error: 'Token tidak valid.' });
    }
};

module.exports = verifyUser;
