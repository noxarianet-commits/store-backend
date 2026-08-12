const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const verifyAdmin = require('../middleware/verifyAdmin');

router.get('/', productController.list);
router.get('/:id', productController.getById);
router.post('/', verifyAdmin, productController.create);
router.put('/:id', verifyAdmin, productController.update);
router.delete('/:id', verifyAdmin, productController.remove);

module.exports = router;
