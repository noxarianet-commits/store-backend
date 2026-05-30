const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/serviceController');
const verifyAdmin = require('../middleware/verifyAdmin');

router.get('/', serviceController.list);
router.post('/', verifyAdmin, serviceController.create);
router.put('/:id', verifyAdmin, serviceController.update);
router.delete('/:id', verifyAdmin, serviceController.remove);

module.exports = router;
