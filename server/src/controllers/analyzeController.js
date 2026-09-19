import { resolveAdapter } from '../platforms/registry.js';
import { PlatformLimitationError } from '../platforms/baseAdapter.js';
import { createDownloadToken } from '../services/downloadTokenStore.js';
import { logEvent } from '../utils/logger.js';

function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== 'string') return 'Something went wrong. Please try again.';
  if (msg.includes('\n') || msg.includes('at ') || /([a-zA-Z]:\\|\/var|\/home|\/etc|\/usr)/i.test(msg) || /node_modules/i.test(msg)) {
    return 'Something went wrong. Please try again.';
  }
  return msg;
}

export async function analyzeHandler(req, res) {
  const start = Date.now();
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Please enter a valid media URL.' });
  }

  const adapter = resolveAdapter(url);
  if (!adapter) {
    return res.status(400).json({ success: false, error: 'This platform is currently not supported.' });
  }

  const platform = adapter.constructor.platformId;

  try {
    const info = await adapter.analyze(url);

    // If adapter returned multiple items (e.g. Highlight with multiple stories)
    if (info.items && Array.isArray(info.items) && info.items.length > 0) {
      const items = info.items.map((item, idx) => ({
        id: item.id || `item-${idx}`,
        title: item.title,
        thumbnail: item.thumbnail,
        type: item.type,
        isHighlight: true,
        formats: item.formats.map((f) => ({
          id: f.id,
          quality: f.quality,
          resolution: f.resolution || null,
          format: f.format,
          size: f.sizeBytes ? `${(f.sizeBytes / (1024 * 1024)).toFixed(1)}MB` : null,
          sizeBytes: f.sizeBytes || null,
          hasAudio: f.hasAudio !== undefined ? f.hasAudio : true,
          needsMerge: Boolean(f.meta?.needsMerge || f.needsMerge),
          downloadId: createDownloadToken({
            platform,
            sourceUrl: f.sourceUrl,
            formatId: f.id,
            meta: { mimeType: f.mimeType, ...(f.meta || {}) },
          }),
        })),
      }));

      logEvent({ requestId: req.id, platform, operation: 'analyze', durationMs: Date.now() - start, success: true });

      return res.json({
        success: true,
        platform,
        isHighlight: true,
        title: info.title,
        author: info.author || null,
        duration: info.duration || null,
        thumbnail: info.thumbnail || items[0]?.thumbnail,
        type: info.type || 'highlight',
        items,
        formats: items[0]?.formats || [],
      });
    }

    // Attach a short-lived download token to each format instead of exposing
    // the raw source URL to the client.
    const formats = info.formats.map((f) => ({
      id: f.id,
      quality: f.quality,
      resolution: f.resolution || null,
      format: f.format,
      size: f.sizeBytes ? `${(f.sizeBytes / (1024 * 1024)).toFixed(1)}MB` : null,
      sizeBytes: f.sizeBytes || null,
      hasAudio: f.hasAudio !== undefined ? f.hasAudio : true,
      hasVideo: f.hasVideo !== undefined ? f.hasVideo : true,
      needsMerge: Boolean(f.meta?.needsMerge || f.needsMerge),
      downloadId: createDownloadToken({
        platform,
        sourceUrl: f.sourceUrl,
        formatId: f.id,
        meta: { mimeType: f.mimeType, ...(f.meta || {}) },
      }),
    }));

    logEvent({ requestId: req.id, platform, operation: 'analyze', durationMs: Date.now() - start, success: true });

    return res.json({
      success: true,
      platform,
      isHighlight: info.isHighlight || false,
      title: info.title,
      author: info.author || null,
      duration: info.duration || null,
      thumbnail: info.thumbnail,
      type: info.type,
      formats,
    });
  } catch (err) {
    console.error(`[ANALYZE ERROR] platform=${platform} error=${err.message}`, err.stack);
    logEvent({ requestId: req.id, platform, operation: 'analyze', durationMs: Date.now() - start, success: false });

    if (err instanceof PlatformLimitationError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    const friendly = sanitizeErrorMessage(err.message);
    return res.status(502).json({ success: false, error: friendly });
  }
}
