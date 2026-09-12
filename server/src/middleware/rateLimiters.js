import rateLimit from 'express-rate-limit';

const windowMs = (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 1) * 60 * 1000;

export const analyzeLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_ANALYZE, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
});

export const downloadLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_DOWNLOAD, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
});
