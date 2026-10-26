/**
 * ticketStreamService.js — Server-Sent Events hub untuk percakapan tiket.
 *
 * Kenapa SSE dan bukan Supabase Realtime di frontend?
 * - Frontend tidak punya @supabase/supabase-js, dan service_role key backend
 *   TIDAK BOLEH pernah dikirim ke browser.
 * - Backend sekarang long-running di VPS (bukan serverless), jadi SSE aman.
 * - Tanpa dependency baru: browser punya EventSource bawaan.
 *
 * Dua jenis subscriber:
 * - Pelanggan  : subscribe(ticketId) → hanya event untuk tiket itu.
 * - Admin      : subscribe({ admin: true }) → menerima SEMUA event (feed inbox).
 *
 * Heartbeat 25 detik sengaja di bawah default proxy_read_timeout nginx (60s)
 * supaya koneksi tidak diputus. Header X-Accel-Buffering: no mematikan
 * buffering nginx untuk response ini tanpa perlu ubah config server.
 */

class TicketStreamService {
    constructor() {
        this.clients = new Set();

        this.heartbeatTimer = setInterval(() => this.pingAll(), 25000);
        // Jangan tahan proses tetap hidup hanya karena heartbeat (untuk shutdown rapi).
        if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    /**
     * Daftarkan sebuah response sebagai SSE stream.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {{ ticketId?: string|null, admin?: boolean }} options
     * @returns {Function} cleanup — panggil untuk melepas client (idempoten).
     */
    subscribe(req, res, { ticketId = null, admin = false } = {}) {
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        if (res.socket) res.socket.setNoDelay(true);

        // Komentar awal supaya EventSource langsung menganggap koneksi terbuka.
        res.write(': connected\n\n');

        const client = { res, ticketId, admin };
        this.clients.add(client);

        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            this.clients.delete(client);
        };

        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
        res.on('close', cleanup);

        return cleanup;
    }

    /**
     * Kirim event ke satu client. Gagal tulis = client mati, langsung dibuang.
     */
    _send(client, event, data) {
        try {
            client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
            this.clients.delete(client);
        }
    }

    /**
     * Publish event ke semua subscriber yang berhak:
     * subscriber admin (semua) + subscriber pelanggan tiket tersebut.
     *
     * @param {string} ticketId
     * @param {string} event — nama event SSE ('message', 'status', 'created')
     * @param {object} data
     */
    publish(ticketId, event, data) {
        for (const client of this.clients) {
            if (client.admin || (client.ticketId && client.ticketId === ticketId)) {
                this._send(client, event, data);
            }
        }
    }

    /**
     * Publish hanya ke feed admin (mis. perubahan status/prioritas tiket lain).
     */
    publishAdmin(event, data) {
        for (const client of this.clients) {
            if (client.admin) this._send(client, event, data);
        }
    }

    pingAll() {
        for (const client of this.clients) {
            try {
                client.res.write(': ping\n\n');
            } catch (err) {
                this.clients.delete(client);
            }
        }
    }

    getStats() {
        let admin = 0;
        let customers = 0;
        for (const client of this.clients) {
            if (client.admin) admin++;
            else customers++;
        }
        return { total: this.clients.size, admin, customers };
    }

    /** Untuk shutdown/test — tutup semua koneksi. */
    closeAll() {
        for (const client of this.clients) {
            try {
                client.res.end();
            } catch (err) { /* abaikan */ }
        }
        this.clients.clear();
    }
}

module.exports = new TicketStreamService();
