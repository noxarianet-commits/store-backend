const net = require('net');

/**
 * Normalisasi alamat IP dari header/socket. Express kadang memberikan
 * IPv4-mapped IPv6 (::ffff:1.2.3.4); bentuk itu tidak boleh menjadi key yang
 * berbeda dari 1.2.3.4.
 */
function normalizeIp(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const mapped = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
    return net.isIP(mapped) ? mapped : null;
}

function isPrivateOrLoopback(value) {
    const ip = normalizeIp(value);
    if (!ip) return false;

    if (ip === '::1') return true;

    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 ||
            a === 127 ||
            (a === 192 && b === 168) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 169 && b === 254);
    }

    const lower = ip.toLowerCase();
    return lower.startsWith('fc') ||
        lower.startsWith('fd') ||
        lower.startsWith('fe80:');
}

/**
 * Alamat klien untuk key rate limit.
 *
 * Deployment sekarang: Cloudflare -> Nginx (VPS) -> Express. Kalau Nginx
 * memakai `$proxy_add_x_forwarded_for` tanpa `real_ip_header`, `req.ip` akan
 * berisi IP egress Cloudflare, bukan IP pengunjung. `CF-Connecting-IP` diisi
 * Cloudflare dengan IP asli dan hanya dipercaya kalau koneksi ke Node datang
 * dari hop lokal/reverse-proxy (bukan koneksi publik langsung).
 *
 * Lindungi origin dari akses langsung (firewall hanya izinkan IP Cloudflare)
 * agar header ini tidak bisa dipalsukan.
 */
function getClientIp(req) {
    const cloudflareIp = normalizeIp(req.headers?.['cf-connecting-ip']);
    const socketIp = req.socket?.remoteAddress;

    if (cloudflareIp && isPrivateOrLoopback(socketIp)) {
        return cloudflareIp;
    }

    return normalizeIp(req.ip) || normalizeIp(socketIp) || 'unknown';
}

module.exports = { getClientIp, isPrivateOrLoopback, normalizeIp };
