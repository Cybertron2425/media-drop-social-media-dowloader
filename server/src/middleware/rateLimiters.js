import rateLimit from 'express-rate-limit';
import { peekDownloadToken } from '../services/downloadTokenStore.js';

const windowMs = (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 1) * 60 * 1000;

export const analyzeLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_ANALYZE, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
});

// Legacy single-step download limiter
export const downloadLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_DOWNLOAD, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
});

// Middleware for /download/:downloadId/prepare:
// Legitimate users downloading media from an analyzed Highlight/post carry a valid server-issued
// download token. This bypasses the restrictive per-minute download limiter so users can download
// all Highlight items individually without stopping, while invalid/unauthenticated requests remain strictly rate-limited.
export function preparedDownloadLimiter(req, res, next) {
  const downloadId = req.params?.downloadId;
  if (downloadId && peekDownloadToken(downloadId)) {
    return next();
  }
  return downloadLimiter(req, res, next);
}

export const bulkDownloadLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_BULK, 10) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many bulk download requests. Please slow down and try again shortly.' },
});

