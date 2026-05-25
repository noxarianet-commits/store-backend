const fs = require('fs');
const path = require('path');
const supabase = require('../supabase');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function migrate() {
    console.log('Starting migration...');
    
    if (!fs.existsSync(DB_FILE)) {
        console.error('db.json not found!');
        return;
    }

    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

    // 1. Migrate Products
    if (db.products && db.products.length > 0) {
        console.log(`Migrating ${db.products.length} products...`);
        // Note: Map field names to match SQL schema (e.g. badgeColor -> badge_color)
        const productsToInsert = db.products.map(p => ({
            id: p.id,
            category: p.category,
            name: p.name,
            price: p.price,
            features: p.features,
            variants: p.variants,
            subtitle: p.subtitle,
            badge: p.badge,
            badge_color: p.badgeColor,
            icon: p.icon
        }));

        const { error: pError } = await supabase
            .from('products')
            .upsert(productsToInsert);
        
        if (pError) console.error('Error migrating products:', pError);
        else console.log('Products migrated successfully!');
    }

    // 2. Migrate Testimonials
    if (db.testimonials && db.testimonials.length > 0) {
        console.log(`Migrating ${db.testimonials.length} testimonials...`);
        const { error: tError } = await supabase
            .from('testimonials')
            .upsert(db.testimonials);
        
        if (tError) console.error('Error migrating testimonials:', tError);
        else console.log('Testimonials migrated successfully!');
    }

    // 3. Migrate Orders (Optional, usually orders are fresh)
    /*
    if (db.orders && db.orders.length > 0) {
        console.log(`Migrating ${db.orders.length} orders...`);
        const { error: oError } = await supabase
            .from('orders')
            .upsert(db.orders);
        if (oError) console.error('Error migrating orders:', oError);
        else console.log('Orders migrated successfully!');
    }
    */

    console.log('Migration finished!');
}

migrate();
