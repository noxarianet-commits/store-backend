const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const verifyAdmin = require('../middleware/verifyAdmin');

router.get('/', settingsController.list);
router.put('/:key', verifyAdmin, settingsController.update);

module.exports = router;
