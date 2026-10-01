const express = require('express');
const router = express.Router();
const balanceController = require('../controllers/balanceController');

router.get('/', balanceController.getBalance);
router.post('/topup', balanceController.createTopup);
router.get('/topup/pending', balanceController.getPendingTopup);
router.post('/topup/cancel', balanceController.cancelPendingTopup);
router.get('/topup/:id/status', balanceController.getTopupStatus);
router.get('/history', balanceController.getHistory);

module.exports = router;
