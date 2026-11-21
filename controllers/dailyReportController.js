const dailyReportService = require('../services/dailyReportService');
const { logger } = require('../utils/logger');

const controllerLog = logger.child({ job: 'daily-report-controller' });

function handleError(res, err, action) {
    if (err instanceof dailyReportService.InvalidDateError) {
        return res.status(400).json({
            success: false,
            code: 'VALIDATION_ERROR',
            error: err.message,
        });
    }

    controllerLog.error('daily_report_request_failed', { action, error: err });
    return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        error: 'Terjadi kesalahan server.',
    });
}

/**
 * GET /api/admin/reports/daily?date=YYYY-MM-DD
 * Ambil laporan satu tanggal. Bila belum ada, laporan di-generate otomatis
 * (idempoten — laporan yang sudah ada tidak dihitung ulang).
 */
async function getDailyReport(req, res) {
    try {
        const { report } = await dailyReportService.generateDailyReport(req.query.date);
        return res.json({ success: true, data: report });
    } catch (err) {
        return handleError(res, err, 'get');
    }
}

/**
 * POST /api/admin/reports/daily/generate?date=YYYY-MM-DD
 * Regenerate paksa laporan. Status baris menjadi 'regenerated'.
 */
async function regenerateDailyReport(req, res) {
    try {
        const { report, regenerated } = await dailyReportService.generateDailyReport(req.query.date, {
            force: true,
            generatedBy: req.admin?.id,
        });

        return res.json({ success: true, data: report, regenerated });
    } catch (err) {
        return handleError(res, err, 'regenerate');
    }
}

/**
 * GET /api/admin/reports/daily/history?limit=30
 * Daftar laporan terbaru (maksimum 90).
 */
async function listDailyReports(req, res) {
    try {
        const data = await dailyReportService.listDailyReports({ limit: req.query.limit });
        return res.json({ success: true, data });
    } catch (err) {
        return handleError(res, err, 'history');
    }
}

module.exports = {
    getDailyReport,
    regenerateDailyReport,
    listDailyReports,
};
