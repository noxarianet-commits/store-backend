const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
require('dotenv').config();

// Konfigurasi Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Konfigurasi Bot WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const ADMIN_NUMBER = '6285199605580@c.us';

client.on('qr', (qr) => {
    console.log('SCAN QR CODE INI DI PANEL FINCLOUD:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot WA noxarianet store sudah STANDBY di Fincloud!');
});

// Fungsi Kirim Laporan ke Admin/CS
const sendOrderToAdmin = async (orderData) => {
    try {
        let message = `🔔 *LAPORAN PESANAN BARU*\n\n`;
        message += `🆔 ID: ${orderData.id}\n`;
        message += `📦 Produk: ${orderData.product}\n`;
        message += `💎 Varian: ${orderData.variant || '-'}\n`;
        message += `💰 Total: Rp ${Number(orderData.price).toLocaleString('id-ID')}\n`;
        message += `📱 WA User: ${orderData.wa_number}\n`;
        message += `✉️ Email: ${orderData.email || '-'}\n`;
        message += `\n--------------------------------\n`;
        message += `🔥 *BUKTI TRANSFER TERLAMPIR*`;

        // Kirim detail teks dulu
        await client.sendMessage(ADMIN_NUMBER, message);

        // Jika ada bukti gambar, kirim sebagai pesan biasa (media)
        if (orderData.proof_image) {
            const response = await axios.get(orderData.proof_image, { responseType: 'arraybuffer' });
            const media = new MessageMedia(
                'image/jpeg',
                Buffer.from(response.data).toString('base64'),
                'bukti-transfer.jpg'
            );
            await client.sendMessage(ADMIN_NUMBER, media);
        }

        console.log(`✅ Laporan pesanan ${orderData.id} terkirim ke Admin/CS!`);
    } catch (err) {
        console.error('Gagal kirim laporan ke Admin:', err);
    }
};

// Fungsi Japri Customer
const japriCustomer = async (orderData) => {
    try {
        let number = orderData.wa_number.replace(/\D/g, ''); // Hapus semua karakter non-angka

        // Pastikan format internasional (awali dengan 62)
        if (number.startsWith('0')) {
            number = '62' + number.slice(1);
        } else if (!number.startsWith('62')) {
            number = '62' + number;
        }

        const chatId = number + "@c.us";

        let message = `Halo Kak! 👋\n\n`;
        message += `Terima kasih telah berbelanja di *noxarianet store*. Pesanan Kakak dengan ID *${orderData.id}* sedang kami proses ya. Mohon ditunggu sebentar. ⏳\n\n`;
        message += `Jika ada kendala atau pertanyaan, jangan ragu untuk hubungi Admin segera dan jelaskan masalah Kakak.\n\n`;
        message += `Terima kasih atas kesabarannya! 🙏✨`;

        await client.sendMessage(chatId, message);
        console.log(`✅ Chat Japri terkirim ke customer: ${number}`);
    } catch (err) {
        console.error('Gagal Japri customer:', err);
    }
};

// ════ LISTEN KE SUPABASE REALTIME ════
console.log('⏳ Menunggu pesanan baru dari Supabase...');

supabase
    .channel('public:orders')
    .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'orders'
    }, (payload) => {
        console.log('🔔 Ada Pesanan Baru Masuk ke DB!');
        // 1. Lapor ke Admin/CS
        sendOrderToAdmin(payload.new);
        // 2. Japri Customer
        japriCustomer(payload.new);
    })
    .subscribe();

// ════ EVENT: MEMBER BARU JOIN GRUP ════
client.on('group_join', async (notification) => {
    try {
        const targetGroupId = '120363424077781671@g.us';
        const chat = await notification.getChat();

        // Cek berdasarkan ID atau Nama Grup spesifik
        if (notification.chatId === targetGroupId || chat.name === 'noxarianet || offical comunity') {
            // Ambil nomor member baru (biasanya array)
            for (let participantId of notification.recipientIds) {
                const contact = await client.getContactById(participantId);
                const name = contact.pushname || 'Kak';

                let welcomeMsg = `Halo *${name}*! 👋 Selamat datang di grup *noxarianet || offical comunity*.\n\n`;
                welcomeMsg += `Senang melihatmu bergabung! Cek produk digital premium & promo terbaru kami di sini:\n`;
                welcomeMsg += `🌐 https://www.noxarianet.web.id\n\n`;
                welcomeMsg += `Selamat berbelanja! 💙✨`;

                await client.sendMessage(notification.chatId, welcomeMsg);
            }
        }
    } catch (err) {
        console.error('Gagal kirim pesan sambutan:', err);
    }
});

client.initialize();
