const supabase = require('../supabase');
const fs = require('fs');

/**
 * GET /api/orders
 * List orders with pagination, search, and status filter. (Protected)
 */
async function list(req, res) {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const search = req.query.search ? req.query.search.trim() : '';
        const status = req.query.status ? req.query.status.trim().toUpperCase() : '';

        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let query = supabase
            .from('orders')
            .select('*', { count: 'exact' });

        if (search) {
            query = query.or(`id.ilike.%${search}%,wa_number.ilike.%${search}%`);
        }

        if (status && status !== 'ALL') {
            query = query.eq('status', status);
        }

        query = query
            .order('timestamp', { ascending: false })
            .range(from, to);

        const { data, count, error } = await query;
        if (error) throw error;

        res.json({
            orders: data || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit) || 1
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/orders/stats
 * Lightweight fetch of minimal order fields for dashboard & revenue stats.
 * Avoids downloading heavy JSON account_details and image fields.
 */
async function getStats(req, res) {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('id, price, status, timestamp');
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/order
 * Create a new order (Public). Handles file upload for proof image.
 */
async function create(req, res) {
    try {
        console.log('Incoming Order Request...');

        let orderData = {};
        if (req.body.orderData) {
            try {
                orderData = JSON.parse(req.body.orderData);
            } catch (e) {
                console.error('JSON Parse Error:', e);
                return res.status(400).json({ error: 'Format data pesanan tidak valid' });
            }
        } else {
            // Fallback jika dikirim langsung tanpa dibungkus orderData
            orderData = req.body;
        }

        if (!orderData.id) {
            return res.status(400).json({ error: 'ID Pesanan tidak ditemukan' });
        }

        let publicUrl = null;
        if (req.file) {
            console.log('Uploading proof image:', req.file.originalname);
            const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
            const fileName = `proofs/${Date.now()}-${safeOriginalName}`;
            const { error: storageError } = await supabase.storage
                .from('proofs')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: false
                });

            if (storageError) {
                console.error('Storage Error (Order Proof):', storageError);
                return res.status(500).json({ error: `Gagal upload bukti: ${storageError.message}` });
            }

            const { data: urlData } = supabase.storage.from('proofs').getPublicUrl(fileName);
            publicUrl = urlData.publicUrl;
            console.log('Proof image uploaded:', publicUrl);
        }

        console.log('Inserting order into DB:', orderData.id);
        const { data, error: dbError } = await supabase
            .from('orders')
            .insert([{
                id: orderData.id,
                product: orderData.product || 'Unknown',
                variant: orderData.variant || '-',
                price: parseInt(orderData.price) || 0,
                email: orderData.email || '-',
                wa_number: orderData.wa_number || '-',
                payment_method: orderData.payment_method || '-',
                customer_name: orderData.customer_name || orderData.wa_number || '-',
                status: 'PENDING',
                timestamp: new Date().toISOString()
            }]);

        if (dbError) {
            console.error('Database Error (Order):', dbError);
            return res.status(500).json({ error: `Gagal simpan ke DB: ${dbError.message}` });
        }

        // Jika ada testimoni, masukkan ke tabel testimonials
        const rawTestimonial = orderData.testimonial || req.body.testimonial;
        const customerWA = orderData.wa_number || req.body.wa_number || 'Customer';

        if (rawTestimonial && rawTestimonial !== '-' && rawTestimonial !== '') {
            console.log('Menyimpan Testimoni Baru dari:', customerWA);
            const productName = orderData.product || '';
            const testiText = productName ? `${rawTestimonial} (${productName})` : rawTestimonial;
            const { error: testiError } = await supabase.from('testimonials').insert([{
                name: customerWA,
                text: testiText,
                rating: 5,
                created_at: new Date().toISOString()
            }]);

            if (testiError) {
                console.error('Gagal simpan testimoni:', testiError);
            } else {
                console.log('Testimoni berhasil disimpan!');
            }
        }

        console.log('Order processed successfully!');
        res.json({ success: true, data });
    } catch (err) {
        console.error('Server Catch Error (Order):', err);
        fs.appendFileSync('error.log', new Date().toISOString() + ' - ' + err.stack + '\n');
        res.status(500).json({ error: err.message });
    }
}

/**
 * PUT /api/orders/:id
 * Update an order by ID. (Protected)
 */
async function update(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('orders')
            .update(req.body)
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * DELETE /api/orders/:id
 * Delete an order by ID. (Protected)
 */
async function remove(req, res) {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list, getStats, create, update, remove };
