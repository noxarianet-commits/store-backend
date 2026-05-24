/**
 * ═══════════════════════════════════════════════════════
 * NOXARIANET STORE — WhatsApp Bot (Standalone)
 * ═══════════════════════════════════════════════════════
 * 
 * CARA PAKAI:
 *   1. Buka terminal di folder backend/
 *   2. Jalankan: node start-bot.js
 *   3. Scan QR Code yang muncul dengan WhatsApp
 *   4. Bot akan otomatis mendengarkan pesanan baru dari Supabase
 * 
 * CATATAN:
 *   - File ini HARUS dijalankan TERPISAH dari server.js
 *   - Bisa dijalankan di PC lokal atau VPS (bukan di Vercel)
 *   - Bot menggunakan Supabase Realtime untuk mendeteksi order baru
 *   - Ketika ada order baru masuk, bot akan:
 *     1. Kirim laporan ke Grup WA admin
 *     2. Japri (chat pribadi) ke customer
 * ═══════════════════════════════════════════════════════
 */

console.log('');
console.log('═══════════════════════════════════════════════');
console.log('   🤖 NOXARIANET STORE — WhatsApp Bot');
console.log('═══════════════════════════════════════════════');
console.log('');
console.log('⏳ Menginisialisasi bot...');
console.log('');

// Load the bot module — this will:
// 1. Initialize whatsapp-web.js client
// 2. Show QR code in terminal for scanning
// 3. Subscribe to Supabase Realtime for new orders
require('./bot');

console.log('');
console.log('💡 TIP: Jangan tutup terminal ini agar bot tetap aktif.');
console.log('💡 TIP: Jika QR Code tidak muncul, hapus folder auth_info_baileys/ lalu jalankan ulang.');
console.log('');
