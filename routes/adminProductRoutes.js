const express = require('express');
const router = express.Router();
const adminProductController = require('../controllers/adminProductController');
const verifyAdmin = require('../middleware/verifyAdmin');

// Guard all admin product routes
router.use(verifyAdmin);

// Sync operations
router.post('/sync', adminProductController.sync);
router.get('/sync-status', adminProductController.syncStatus);

// Vendor info
router.get('/balance', adminProductController.getBalance);

// Products & Variants CRUD / Management
router.get('/products', adminProductController.getProducts);
router.get('/featured', adminProductController.getFeatured);
router.patch('/products/:id/markup', adminProductController.updateMarkup);
router.patch('/products/:id/toggle', adminProductController.toggleActive);
router.patch('/products/:id/featured', adminProductController.toggleFeatured);

// Variant hidden toggle (support both route patterns)
router.patch('/variants/:id/toggle-hidden', adminProductController.toggleVariantHidden);
router.patch('/products/:productId/variant/:variantId/toggle-hidden', adminProductController.toggleVariantHidden);

// Global markup
router.post('/global-markup', adminProductController.globalMarkup);

module.exports = router;
