/**
 * seed-admin.js
 * ─────────────────────────────────────────────────────────────
 * Seeder: Membuat akun admin default ke tabel `admins`
 * Password di-hash menggunakan bcrypt sebelum disimpan.
 *
 * Usage:
 *   node utils/seed-admin.js
 *
 * Untuk custom kredensial, set env variable sebelum menjalankan:
 *   SEED_ADMIN_USERNAME=myuser SEED_ADMIN_PASSWORD=mypass node utils/seed-admin.js
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt   = require('bcryptjs');
const supabase = require('../supabase');

const SALT_ROUNDS = 12; // Work factor bcrypt (semakin tinggi, semakin aman & lambat)

// Kredensial default — bisa di-override lewat environment variable
const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@Store2024!';

async function seedAdmin() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Seeder: Admin Default');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Username : ${ADMIN_USERNAME}`);
    console.log('Password : [HIDDEN — akan di-hash]');
    console.log('');

    // 1. Cek apakah username sudah ada
    const { data: existing, error: checkError } = await supabase
        .from('admins')
        .select('id, username')
        .eq('username', ADMIN_USERNAME)
        .maybeSingle();

    if (checkError) {
        console.error('❌ Gagal cek admin yang ada:', checkError.message);
        console.error('   Pastikan tabel `admins` sudah dibuat (migration 004_admins_table.sql)');
        process.exit(1);
    }

    if (existing) {
        console.log(`⚠️  Admin "${ADMIN_USERNAME}" sudah ada (id: ${existing.id}). Seeder dilewati.`);
        console.log('   Gunakan endpoint PUT /api/admin/password untuk ganti password.');
        process.exit(0);
    }

    // 2. Hash password menggunakan bcrypt
    console.log(`🔐 Hashing password (salt rounds: ${SALT_ROUNDS})...`);
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
    console.log('   Hash berhasil dibuat.');

    // 3. Insert ke tabel admins
    const { data, error: insertError } = await supabase
        .from('admins')
        .insert([{
            username:  ADMIN_USERNAME,
            password:  passwordHash,
            is_active: true
        }])
        .select('id, username, is_active, created_at')
        .single();

    if (insertError) {
        console.error('❌ Gagal insert admin:', insertError.message);
        process.exit(1);
    }

    console.log('');
    console.log('✅ Admin berhasil dibuat!');
    console.log('   ID         :', data.id);
    console.log('   Username   :', data.username);
    console.log('   Is Active  :', data.is_active);
    console.log('   Created At :', data.created_at);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  PENTING: Segera ganti password default setelah login pertama!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

seedAdmin().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
