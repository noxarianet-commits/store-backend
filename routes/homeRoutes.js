const express = require('express');
const router = express.Router();
const homeController = require('../controllers/homeController');

/**
 * GET /api/home
 * Unified home page data (cached).
 */
router.get('/', homeController.getHomePage);

/**
 * GET /api/home/category/:slug
 * Products for a specific category (cached).
 */
router.get('/category/:slug', homeController.getCategoryProducts);

module.exports = router;
