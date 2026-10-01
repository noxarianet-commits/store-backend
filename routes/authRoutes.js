const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const verifyUser = require('../middleware/verifyUser');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/profile', verifyUser, authController.getProfile);
router.put('/profile', verifyUser, authController.updateProfile);
router.put('/password', verifyUser, authController.changePassword);
router.get('/orders', verifyUser, authController.getUserOrders);

module.exports = router;
