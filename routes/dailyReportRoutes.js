const express = require('express');
const router = express.Router();

const verifyAdmin = require('../middleware/verifyAdmin');
const dailyReportController = require('../controllers/dailyReportController');

// Seluruh route laporan harian hanya untuk admin (JWT type 'admin').
router.use(verifyAdmin);

// GET /api/admin/reports/daily?date=YYYY-MM-DD
// Laporan tanggal tersebut; generate otomatis bila belum ada.
router.get('/', dailyReportController.getDailyReport);

// GET /api/admin/reports/daily/history?limit=30
// Daftar laporan terbaru.
router.get('/history', dailyReportController.listDailyReports);

// POST /api/admin/reports/daily/generate?date=YYYY-MM-DD
// Generate ulang paksa (status menjadi 'regenerated').
router.post('/generate', dailyReportController.regenerateDailyReport);

module.exports = router;
