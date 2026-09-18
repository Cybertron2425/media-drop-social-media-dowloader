import { Router } from 'express';
import { analyzeHandler } from '../controllers/analyzeController.js';
import {
  downloadHandler,
  downloadStreamHandler,
  validateDownloadHandler,
  directUrlHandler,
  prepareDownloadHandler,
  streamPreparedHandler,
  bulkDownloadHandler,
} from '../controllers/downloadController.js';
import {
  analyzeLimiter,
  downloadLimiter,
  bulkDownloadLimiter,
  preparedDownloadLimiter,
} from '../middleware/rateLimiters.js';
import { listPlatforms } from '../platforms/registry.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ success: true, status: 'ok' }));
router.get('/platforms', (_req, res) => res.json({ success: true, platforms: listPlatforms() }));
router.post('/analyze', analyzeLimiter, analyzeHandler);

// ── Bulk download endpoint (Download All ZIP) ───────────────────────────────
router.post('/download-all', bulkDownloadLimiter, bulkDownloadHandler);
router.post('/download/bulk', bulkDownloadLimiter, bulkDownloadHandler);

// ── Two-phase download (browser frontend) ───────────────────────────────────
// Phase 1: legitimate download-tokens bypass the restrictive 5/min limit; invalid tokens get throttled.
router.post('/download/:downloadId/prepare', preparedDownloadLimiter, prepareDownloadHandler);
// Phase 2: serves already-prepared file using single-use streamId token without rate-limit lockout.
router.get('/stream/:streamId', streamPreparedHandler);

// ── Direct download endpoint (bypasses server for formats not needing merge) ─
router.get('/download/:downloadId/direct-url', preparedDownloadLimiter, directUrlHandler);

// ── Legacy single-step download endpoints ───────────────────────────────────
router.get('/download/:downloadId/validate', preparedDownloadLimiter, validateDownloadHandler);
router.get('/download/:downloadId', preparedDownloadLimiter, downloadStreamHandler);
router.post('/download', downloadLimiter, downloadHandler);

export default router;
