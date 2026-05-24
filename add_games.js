const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../backend/.env' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function addGameProducts() {
    const gameProducts = [
        {
            id: 'mobile-legends',
            category: 'Top Up Game',
            name: 'Mobile Legends',
            price: 1500,
            features: [
                'Proses 1-5 Menit',
                'Legal 100%',
                'Aman & Terpercaya',
                'Via ID & Server'
            ],
            variants: [
                { name: '5 Diamonds', price: 1500 },
                { name: '12 Diamonds', price: 3500 },
                { name: '28 Diamonds', price: 8000 },
                { name: '59 Diamonds', price: 16000 },
                { name: '85 Diamonds', price: 23000 },
                { name: '170 Diamonds', price: 45000 },
                { name: 'Weekly Diamond Pass', price: 26000 }
            ],
            subtitle: 'Top Up MLBB Murah',
            badge: 'Hot',
            badge_color: 'orange',
            icon: 'swords'
        },
        {
            id: 'free-fire',
            category: 'Top Up Game',
            name: 'Free Fire',
            price: 1000,
            features: [
                'Proses Cepat',
                'Legal 100%',
                'Aman & Terpercaya',
                'Hanya via ID'
            ],
            variants: [
                { name: '5 Diamonds', price: 1000 },
                { name: '12 Diamonds', price: 2000 },
                { name: '50 Diamonds', price: 6500 },
                { name: '70 Diamonds', price: 9000 },
                { name: '140 Diamonds', price: 18000 },
                { name: 'Weekly Membership', price: 27000 }
            ],
            subtitle: 'Top Up FF Murah',
            badge: 'Fast',
            badge_color: 'red',
            icon: 'target'
        },
        {
            id: 'pubg-mobile',
            category: 'Top Up Game',
            name: 'PUBG Mobile',
            price: 3500,
            features: [
                'Proses Instan',
                'Legal 100%',
                'Aman & Terpercaya',
                'Via Player ID'
            ],
            variants: [
                { name: '25 UC', price: 3500 },
                { name: '50 UC', price: 7000 },
                { name: '250 UC', price: 35000 },
                { name: '500 UC', price: 70000 }
            ],
            subtitle: 'Top Up UC Murah',
            badge: 'Game',
            badge_color: 'yellow',
            icon: 'gamepad'
        }
    ];

    console.log('Adding game products...');
    
    // Check if they already exist
    const { data: existing } = await supabase.from('products').select('id');
    const existingIds = existing.map(p => p.id);
    
    for (const product of gameProducts) {
        if (!existingIds.includes(product.id)) {
            const { error } = await supabase.from('products').insert([product]);
            if (error) {
                console.error(`Error adding ${product.name}:`, error);
            } else {
                console.log(`Successfully added ${product.name}`);
            }
        } else {
            console.log(`Product ${product.name} already exists. Skipping.`);
        }
    }
    console.log('Done.');
}

addGameProducts();
