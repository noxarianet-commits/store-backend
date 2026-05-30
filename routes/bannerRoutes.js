const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const bannerController = require('../controllers/bannerController');
const verifyAdmin = require('../middleware/verifyAdmin');

router.post('/', verifyAdmin, upload.single('banner'), bannerController.upload);
router.get('/', verifyAdmin, bannerController.list);
router.delete('/:id', verifyAdmin, bannerController.remove);

module.exports = router;
