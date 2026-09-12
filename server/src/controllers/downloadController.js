import fs from 'fs';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { consumeDownloadToken, peekDownloadToken } from '../services/downloadTokenStore.js';
import { storePreparedFile, consumePreparedFile } from '../services/preparedFileStore.js';
import { getAdapter, resolveAdapter } from '../platforms/registry.js';
import { PlatformLimitationError } from '../platforms/baseAdapter.js';
import { logEvent } from '../utils/logger.js';

const MAX_FILE_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024;
const MAX_DOWNLOAD_TIME_MS = (parseInt(process.env.MAX_DOWNLOAD_TIME_SECONDS, 10) || 300) * 1000;
// Prepare step includes FFmpeg remuxing which can take significantly longer for 4K content.
const MAX_PREPARE_TIME_MS = Math.max(MAX_DOWNLOAD_TIME_MS, 15 * 60 * 1000);

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150) || 'download';
}

/**
 * Sanitizes error messages before sending them to the client.
 * Strips actual stack trace lines and filesystem paths, but preserves
 * legitimate user-facing messages that happen to contain words like "at".
 */
function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== 'string') return 'Something went wrong. Please try again.';
  // Strip if the message contains actual stack-trace lines (e.g. " at Object.method"),
  // absolute filesystem paths, or node_modules references.
  if (
    msg.includes('\n') ||
    /\bat [A-Z][a-zA-Z.]*\(/.test(msg) ||   // "at Object.method("  – stack trace
    /\bat [a-z]+\.[a-zA-Z]+ \(/.test(msg) ||  // "at fs.readFile ("  – stack trace
    /([a-zA-Z]:\\|\/var\/|\/home\/|\/etc\/|\/usr\/)/.test(msg) ||
    /node_modules/i.test(msg)
  ) {
    return 'Something went wrong. Please try again.';
  }
  return msg;
}

/**
 * Confirms a downloadId is still valid WITHOUT consuming it.
 * The frontend calls this first so it can show a clear error instead of a silent failure.
 */
export function validateDownloadHandler(req, res) {
  const token = peekDownloadToken(req.params.downloadId);
  if (!token) {
    return res.status(404).json({ success: false, error: 'This download link has expired. Please analyze the media again.' });
  }
  return res.json({ success: true });
}

/**
 * Phase 1 – Prepare: consumes the download token, performs all server-side work
 * (fetching, FFmpeg remuxing) and writes the result to a temp file.  Returns a
 * short-lived streamId so the browser can immediately start streaming the result.
 *
 * The client awaits this endpoint (it may take several minutes for 4K content),
 * showing a processing spinner the whole time, so the user always has clear feedback.
 */
export async function prepareDownloadHandler(req, res) {
  const start = Date.now();
  const token = consumeDownloadToken(req.params.downloadId);

  if (!token) {
    return res.status(404).json({ success: false, error: 'This download link has expired. Please analyze the media again.' });
  }

  const adapter = getAdapter(token.platform) || resolveAdapter(token.sourceUrl || 'https://placeholder.invalid');
  if (!adapter) {
    return res.status(400).json({ success: false, error: 'This platform is currently not supported.' });
  }

  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: 'Processing timed out. Please try again.' });
    }
  }, MAX_PREPARE_TIME_MS);

  try {
    const result = await adapter.download(token.sourceUrl, {
      formatId: token.formatId,
      sourceUrl: token.sourceUrl,
      meta: token.meta,
    });

    let filePath;

    // If an adapter returns a pre-created temp file path, reuse it directly.
    if (result._tempFilePath) {
      filePath = result._tempFilePath;
      result.stream.destroy();
    } else {
      // For all other adapters (network streams), pipe to a temp file first.
      const ext = result.filename?.split('.').pop() || 'bin';
      filePath = path.join(os.tmpdir(), `md_prep_${nanoid(8)}.${ext}`);

      let bytesWritten = 0;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        result.stream.on('data', (chunk) => {
          bytesWritten += chunk.length;
          if (bytesWritten > MAX_FILE_SIZE_BYTES) {
            ws.destroy();
            result.stream.destroy();
            reject(new Error('This file exceeds the maximum allowed download size.'));
          }
        });
        result.stream.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        result.stream.on('error', reject);
      });
    }

    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      await fs.promises.unlink(filePath).catch(() => {});
      clearTimeout(timer);
      return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
    }

    const streamId = storePreparedFile({
      filePath,
      filename: result.filename,
      mimeType: result.mimeType,
      sizeBytes: stat.size,
    });

    clearTimeout(timer);
    logEvent({ requestId: req.id, platform: token.platform, operation: 'prepare', durationMs: Date.now() - start, success: true });

    return res.json({
      success: true,
      streamId,
      filename: result.filename,
      mimeType: result.mimeType,
      sizeBytes: stat.size,
    });
  } catch (err) {
    clearTimeout(timer);
    console.error('[Prepare Controller Error]:', err);
    logEvent({ requestId: req.id, platform: token.platform, operation: 'prepare', durationMs: Date.now() - start, success: false });

    if (err instanceof PlatformLimitationError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    const friendly = sanitizeErrorMessage(err.message);
    return res.status(502).json({ success: false, error: friendly });
  }
}

/**
 * Phase 2 – Stream: serves the already-prepared temp file to the browser.
 * This response starts immediately since all processing is complete.
 */
export function streamPreparedHandler(req, res) {
  const entry = consumePreparedFile(req.params.streamId);
  if (!entry) {
    return res.status(404).json({ success: false, error: 'This stream link has expired or is invalid. Please start the download again.' });
  }

  res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(entry.filename)}"`);
  if (entry.sizeBytes) res.setHeader('Content-Length', entry.sizeBytes);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const fileStream = fs.createReadStream(entry.filePath);

  fileStream.pipe(res);

  fileStream.on('end', () => {
    fs.promises.unlink(entry.filePath).catch(() => {});
    logEvent({ operation: 'stream', success: true });
  });

  fileStream.on('error', (err) => {
    console.error('[Stream Handler] Read error:', err.message);
    fs.promises.unlink(entry.filePath).catch(() => {});
    if (!res.headersSent) res.status(502).end();
  });
}

/**
 * Legacy direct-stream handler. Kept for the documented GET /api/download/:downloadId
 * contract and for non-browser API clients.  The browser frontend now uses the
 * prepare → stream two-phase flow instead.
 */
async function streamDownload(downloadId, req, res) {
  const start = Date.now();
  const token = consumeDownloadToken(downloadId);

  if (!token) {
    return res.status(404).json({ success: false, error: 'This download link has expired. Please analyze the media again.' });
  }

  const adapter = getAdapter(token.platform) || resolveAdapter(token.sourceUrl || 'https://placeholder.invalid');
  if (!adapter) {
    return res.status(400).json({ success: false, error: 'This platform is currently not supported.' });
  }

  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).end();
    res.destroy();
  }, MAX_DOWNLOAD_TIME_MS);

  try {
    const result = await adapter.download(token.sourceUrl, {
      formatId: token.formatId,
      sourceUrl: token.sourceUrl,
      meta: token.meta,
    });

    if (result.sizeBytes && result.sizeBytes > MAX_FILE_SIZE_BYTES) {
      clearTimeout(timer);
      result.stream.destroy?.();
      return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
    }

    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(result.filename)}"`);
    if (result.sizeBytes) res.setHeader('Content-Length', result.sizeBytes);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let bytesStreamed = 0;
    result.stream.on('data', (chunk) => {
      bytesStreamed += chunk.length;
      if (bytesStreamed > MAX_FILE_SIZE_BYTES) {
        result.stream.destroy();
        res.destroy();
      }
    });

    result.stream.pipe(res);

    result.stream.on('end', () => {
      // Clean up adapter temp file if one was produced.
      if (result._tempFilePath) {
        fs.promises.unlink(result._tempFilePath).catch(() => {});
      }
      clearTimeout(timer);
      logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: true });
    });

    result.stream.on('error', () => {
      if (result._tempFilePath) fs.promises.unlink(result._tempFilePath).catch(() => {});
      clearTimeout(timer);
      if (!res.headersSent) res.status(502).json({ success: false, error: 'Something went wrong. Please try again.' });
      logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: false });
    });
  } catch (err) {
    clearTimeout(timer);
    console.error('[Download Controller Error]:', err);
    logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: false });

    if (err instanceof PlatformLimitationError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    const friendly = sanitizeErrorMessage(err.message);
    return res.status(502).json({ success: false, error: friendly });
  }
}

// GET /api/download/:downloadId — legacy direct-stream (used by programmatic API clients).
export async function downloadStreamHandler(req, res) {
  return streamDownload(req.params.downloadId, req, res);
}

// POST /api/download — kept for the documented POST API contract.
export async function downloadHandler(req, res) {
  const { downloadId } = req.body || {};
  if (!downloadId) {
    return res.status(400).json({ success: false, error: 'Please enter a valid media URL.' });
  }
  return streamDownload(downloadId, req, res);
}
