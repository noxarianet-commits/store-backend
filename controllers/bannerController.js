const supabase = require('../supabase');

/**
 * POST /api/banners
 * Upload a banner image to Supabase Storage. (Protected)
 */
async function upload(req, res) {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        console.log('Uploading banner:', req.file.originalname);

        const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        const fileName = `banners/${Date.now()}-${safeOriginalName}`;
        const { error } = await supabase.storage
            .from('proofs')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (error) {
            console.error('Supabase Storage Error:', error);
            return res.status(500).json({ error: error.message });
        }

        const { data: { publicUrl } } = supabase.storage
            .from('proofs')
            .getPublicUrl(fileName);

        res.json({ url: publicUrl });
    } catch (err) {
        console.error('Banner Upload Error:', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/banners
 * List all banners.
 */
async function list(req, res) {
    try {
        const { data, error } = await supabase.storage.from('proofs').list('banners');
        if (error) throw error;
        
        const files = data.filter(f => f.name && f.name !== '.emptyFolderPlaceholder');
        const urls = files.map(f => {
            const { data: { publicUrl } } = supabase.storage.from('proofs').getPublicUrl(`banners/${f.name}`);
            return publicUrl;
        });
        
        res.json(urls);
    } catch (err) {
        console.error('Banner List Error:', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * DELETE /api/banners/:id
 * Remove a banner by index.
 */
async function remove(req, res) {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.storage.from('proofs').list('banners');
        if (error) throw error;
        
        const files = data.filter(f => f.name && f.name !== '.emptyFolderPlaceholder');
        const fileToDelete = files[id];
        
        if (!fileToDelete) return res.status(404).json({ error: 'Banner tidak ditemukan' });
        
        const { error: deleteError } = await supabase.storage.from('proofs').remove([`banners/${fileToDelete.name}`]);
        if (deleteError) throw deleteError;
        
        res.json({ success: true });
    } catch (err) {
        console.error('Banner Delete Error:', err);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { upload, list, remove };
