const express = require('express');
const router = express.Router();
const testimonialController = require('../controllers/testimonialController');

router.get('/', testimonialController.list);
router.post('/', testimonialController.create);

module.exports = router;
