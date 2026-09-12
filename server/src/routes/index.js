import { Router } from 'express';
import { analyzeHandler } from '../controllers/analyzeController.js';
import {
  downloadHandler,
  downloadStreamHandler,
  validateDownloadHandler,
  prepareDownloadHandler,
  streamPreparedHandler,
} from '../controllers/downloadController.js';
import { analyzeLimiter, downloadLimiter } from '../middleware/rateLimiters.js';
import { listPlatforms } from '../platforms/registry.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ success: true, status: 'ok' }));
router.get('/platforms', (_req, res) => res.json({ success: true, platforms: listPlatforms() }));
router.post('/analyze', analyzeLimiter, analyzeHandler);

// ── Two-phase download (browser frontend) ───────────────────────────────────
// Phase 1: client awaits this (may take minutes for 4K); shows processing UI.
router.post('/download/:downloadId/prepare', downloadLimiter, prepareDownloadHandler);
// Phase 2: client triggers native browser download of the already-prepared file.
router.get('/stream/:streamId', downloadLimiter, streamPreparedHandler);

// ── Legacy single-step download endpoints ───────────────────────────────────
// Kept for the documented API contract and non-browser API clients.
router.get('/download/:downloadId/validate', downloadLimiter, validateDownloadHandler);
router.get('/download/:downloadId', downloadLimiter, downloadStreamHandler);
router.post('/download', downloadLimiter, downloadHandler);

export default router;
