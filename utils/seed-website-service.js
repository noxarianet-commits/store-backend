/**
 * Seed script: Tambah produk "Jasa Pembuatan Website" ke tabel services
 * Run: node utils/seed-website-service.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function seed() {
    try {
        // Cek apakah sudah ada
        const { data: existing } = await supabase
            .from('services')
            .select('id')
            .ilike('name', '%jasa pembuatan website%')
            .single();

        if (existing) {
            console.log('✅ Produk "Jasa Pembuatan Website" sudah ada (id:', existing.id + ')');
            return;
        }

        const { data, error } = await supabase
            .from('services')
            .insert([{
                category: 'Layanan Jasa',
                name: 'Jasa Pembuatan Website',
                icon: 'globe',
                subtitle: 'Website profesional sesuai kebutuhan Anda',
                is_active: true,
                variants: [
                    { name: 'Paket Basic', price: 500000 },
                    { name: 'Paket Standard', price: 1500000 },
                    { name: 'Paket Premium', price: 3500000 },
                    { name: 'Paket Enterprise', price: 7500000 }
                ],
                features: [
                    'Desain modern & responsive',
                    'SEO friendly',
                    'Free konsultasi',
                    'Revisi hingga puas',
                    'Garansi maintenance'
                ]
            }]);

        if (error) throw error;
        console.log('✅ Produk "Jasa Pembuatan Website" berhasil ditambahkan!');
        console.log('   Link client: /website-order');
    } catch (err) {
        console.error(' Gagal seed:', err.message);
    }
}

seed();
