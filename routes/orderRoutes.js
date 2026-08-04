const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
// All routes in this file require admin auth (verifyAdmin applied at mount in server.js)
router.get('/stats', orderController.getStats);
router.get('/', orderController.list);
router.put('/:id', orderController.update);
router.delete('/:id', orderController.remove);

module.exports = router;
