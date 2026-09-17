import fs from 'fs';
import path from 'path';
import os from 'os';
import { ZipArchive } from 'archiver';
import { nanoid } from 'nanoid';
import { consumeDownloadToken, peekDownloadToken } from '../services/downloadTokenStore.js';
import { storePreparedFile, consumePreparedFile } from '../services/preparedFileStore.js';
import { getAdapter, resolveAdapter } from '../platforms/registry.js';
import { PlatformLimitationError } from '../platforms/baseAdapter.js';
import axios from 'axios';
import { logEvent } from '../utils/logger.js';
import { validateMediaFile } from '../utils/mediaValidator.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');

// Set binary path so it works seamlessly in both local and production (Render) environments
if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

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
export async function validateDownloadHandler(req, res) {
  const token = peekDownloadToken(req.params.downloadId);
  if (!token) {
    return res.status(404).json({ success: false, error: 'The media is no longer available.' });
  }

  // If size is already known and exceeds the configured limit, reject upfront
  if (token.meta?.sizeBytes && token.meta.sizeBytes > MAX_FILE_SIZE_BYTES) {
    return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
  }

  // For adapters with direct media stream URLs, perform an upstream HEAD check for size limit
  if (token.meta?.videoUrl && !token.meta.sizeBytes) {
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        ...(token.meta.headers || {}),
      };

      const headRes = await axios.head(token.meta.videoUrl, {
        timeout: 4000,
        headers,
      });
      const cl = headRes.headers['content-length'];
      if (cl) {
        const sizeBytes = parseInt(cl, 10);
        token.meta.sizeBytes = sizeBytes;
        if (sizeBytes > MAX_FILE_SIZE_BYTES) {
          return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
        }
      }
    } catch {
      // If HEAD check times out or fails, allow validation to pass; streamDownload will enforce limits during pipe
    }
  }

  const requiresPrepare = false;

  return res.json({
    success: true,
    platform: token.platform,
    requiresPrepare,
  });
}

/**
 * Pipes a readable stream into a temporary file on disk with proper extension.
 */
async function pipeStreamToTempFile(stream, defaultExt = 'mp4', maxBytes = MAX_FILE_SIZE_BYTES) {
  const ext = defaultExt.toLowerCase().includes('webm') ? 'webm' : 'mp4';
  const filePath = path.join(os.tmpdir(), `md_video_${nanoid(8)}.${ext}`);
  let bytesWritten = 0;

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    stream.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        ws.destroy();
        stream.destroy();
        reject(new Error('This file exceeds the maximum allowed download size.'));
      }
    });
    stream.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    stream.on('error', reject);
  });

  return filePath;
}

/**
 * Downloads a remote URL (such as an audio track) to a temporary file on disk with proper extension.
 */
async function downloadUrlToTempFile(url, defaultExt = 'm4a', headers = {}, maxBytes = MAX_FILE_SIZE_BYTES) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: '*/*',
      ...headers,
    },
    timeout: 30000,
  });

  const ct = (response.headers['content-type'] || '').toLowerCase();
  let ext = defaultExt || 'm4a';
  if (ct.includes('audio/webm') || url.toLowerCase().includes('.webm')) {
    ext = 'webm';
  } else if (ct.includes('audio/mp3') || ct.includes('audio/mpeg') || url.toLowerCase().includes('.mp3')) {
    ext = 'mp3';
  } else if (ct.includes('audio/mp4') || ct.includes('audio/m4a') || url.toLowerCase().includes('.m4a')) {
    ext = 'm4a';
  } else {
    ext = 'm4a';
  }

  const filePath = path.join(os.tmpdir(), `md_audio_${nanoid(8)}.${ext}`);
  let bytesWritten = 0;

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    response.data.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        ws.destroy();
        response.data.destroy();
        reject(new Error('This file exceeds the maximum allowed download size.'));
      }
    });
    response.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    response.data.on('error', reject);
  });

  return filePath;
}

/**
 * Merges video and audio streams into an MP4 container with AAC audio.
 * - Uses `-c:v copy -c:a aac` for fast multiplexing without video re-encoding.
 * - Handles timeouts gracefully with SIGKILL to avoid hanging background processes.
 */
export function mergeMediaFiles(videoPath, audioPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const timeoutMs = options.timeoutMs || 180000;

    console.log('[FFmpeg] Merging video and audio...');

    const command = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-shortest',
        '-movflags +faststart',
      ])
      .output(outputPath);

    const timer = setTimeout(() => {
      killed = true;
      try {
        command.kill('SIGKILL');
      } catch {}
      console.error('[FFmpeg] Merge timed out.');
      reject(new Error('FFmpeg audio/video merge timed out. Please try again.'));
    }, timeoutMs);

    command
      .on('end', () => {
        clearTimeout(timer);
        console.log('[FFmpeg] Merge complete!');
        resolve(outputPath);
      })
      .on('error', (err) => {
        clearTimeout(timer);
        if (killed) return;
        console.error(`[FFmpeg] Merge error: ${err.message}`);
        reject(new Error(`Failed to merge audio and video streams: ${err.message}`));
      })
      .run();
  });
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
    return res.status(404).json({ success: false, error: 'The media is no longer available.' });
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
    const intermediateTempFiles = [];

    // Pre-stream size check: if the adapter already knows the file size (from
    // Content-Length), reject immediately before wasting bandwidth or disk space.
    if (result.sizeBytes && result.sizeBytes > MAX_FILE_SIZE_BYTES) {
      result.stream?.destroy?.();
      clearTimeout(timer);
      return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
    }

    try {
      const audioUrl = req.body?.audioUrl || token.meta?.audioUrl;
      const isHighRes = /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.format || '') ||
        /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.resolution || '') ||
        /(?:1080p|1440p|2160p|4k|8k)/i.test(token.formatId || '') ||
        /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.quality || '');

      const needsMerge = Boolean(
        (audioUrl && isHighRes) ||
        (audioUrl && token.meta?.needsMerge) ||
        (audioUrl && token.platform === 'youtube') ||
        (audioUrl && req.body?.audioUrl)
      );

      if (needsMerge && audioUrl) {
        // 1. Obtain video file with proper .mp4 extension
        let videoFilePath;
        if (result._tempFilePath) {
          videoFilePath = result._tempFilePath;
          result.stream?.destroy?.();
        } else {
          const videoExt = result.mimeType?.includes('webm') ? 'webm' : 'mp4';
          videoFilePath = await pipeStreamToTempFile(result.stream, videoExt);
        }
        intermediateTempFiles.push(videoFilePath);

        // 2. Obtain audio file
        const audioFilePath = await downloadUrlToTempFile(
          audioUrl,
          'm4a',
          token.meta?.headers || {}
        );
        intermediateTempFiles.push(audioFilePath);

        // 3. Merge video and audio into an MP4 container with AAC audio
        const mergedFilePath = path.join(os.tmpdir(), `md_prep_${nanoid(8)}.mp4`);
        await mergeMediaFiles(videoFilePath, audioFilePath, mergedFilePath);
        filePath = mergedFilePath;

        // Update output filename and MIME type to reflect merged MP4 container
        result.filename = result.filename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp4';
        result.mimeType = 'video/mp4';
      } else {
        // If an adapter returns a pre-created temp file path, reuse it directly.
        if (result._tempFilePath) {
          filePath = result._tempFilePath;
          result.stream?.destroy?.();
        } else {
          // For all other adapters (network streams), pipe to a temp file first.
          const ext = result.filename?.split('.').pop() || 'bin';
          filePath = await pipeStreamToTempFile(result.stream, ext);
        }
      }
    } finally {
      // Immediately clean up intermediate separated video and audio temp files
      for (const tempFile of intermediateTempFiles) {
        fs.promises.unlink(tempFile).catch(() => {});
      }
    }

    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      await fs.promises.unlink(filePath).catch(() => { });
      clearTimeout(timer);
      return res.status(502).json({ success: false, error: 'Downloaded file is empty. Please try again.' });
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      await fs.promises.unlink(filePath).catch(() => { });
      clearTimeout(timer);
      return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
    }

    // Verify media container and duration integrity
    const validation = await validateMediaFile(filePath, {
      duration: token.meta?.duration,
    });
    if (!validation.valid) {
      await fs.promises.unlink(filePath).catch(() => { });
      clearTimeout(timer);
      console.error('[File Validation Error]:', validation.error);
      return res.status(502).json({
        success: false,
        error: validation.error || 'The downloaded media file is corrupted or incomplete. Please try again.',
      });
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
  if (!entry || !fs.existsSync(entry.filePath)) {
    return res.status(404).json({ success: false, error: 'The media is no longer available.' });
  }

  res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(entry.filename)}"`);
  if (entry.sizeBytes) res.setHeader('Content-Length', entry.sizeBytes);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const fileStream = fs.createReadStream(entry.filePath);

  fileStream.pipe(res);

  fileStream.on('end', () => {
    logEvent({ operation: 'stream', success: true });
  });

  fileStream.on('error', (err) => {
    console.error('[Stream Handler] Read error:', err.message);
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
    return res.status(404).json({ success: false, error: 'The media is no longer available.' });
  }

  const adapter = getAdapter(token.platform) || resolveAdapter(token.sourceUrl || 'https://placeholder.invalid');
  if (!adapter) {
    return res.status(400).json({ success: false, error: 'This platform is currently not supported.' });
  }

  let stallTimer = setTimeout(() => {
    if (!res.headersSent) res.status(504).end();
    res.destroy();
  }, MAX_DOWNLOAD_TIME_MS);

  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!res.headersSent) res.status(504).end();
      res.destroy();
    }, MAX_DOWNLOAD_TIME_MS);
  };

  try {
    const audioUrl = req.body?.audioUrl || token.meta?.audioUrl;
    const isHighRes = /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.format || '') ||
      /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.resolution || '') ||
      /(?:1080p|1440p|2160p|4k|8k)/i.test(token.formatId || '') ||
      /(?:1080p|1440p|2160p|4k|8k)/i.test(token.meta?.quality || '');

    const needsMerge = Boolean(
      (audioUrl && isHighRes) ||
      (audioUrl && token.meta?.needsMerge) ||
      (audioUrl && token.platform === 'youtube') ||
      (audioUrl && req.body?.audioUrl)
    );

    if (needsMerge && audioUrl) {
      const result = await adapter.download(token.sourceUrl, {
        formatId: token.formatId,
        sourceUrl: token.sourceUrl,
        meta: token.meta,
      });

      let videoFilePath;
      const intermediateTempFiles = [];
      let mergedFilePath = null;

      try {
        if (result._tempFilePath) {
          videoFilePath = result._tempFilePath;
          result.stream?.destroy?.();
        } else {
          const videoExt = result.mimeType?.includes('webm') ? 'webm' : 'mp4';
          videoFilePath = await pipeStreamToTempFile(result.stream, videoExt);
        }
        intermediateTempFiles.push(videoFilePath);

        const audioFilePath = await downloadUrlToTempFile(
          audioUrl,
          'm4a',
          token.meta?.headers || {}
        );
        intermediateTempFiles.push(audioFilePath);

        mergedFilePath = path.join(os.tmpdir(), `md_direct_${nanoid(8)}.mp4`);
        await mergeMediaFiles(videoFilePath, audioFilePath, mergedFilePath);
      } finally {
        for (const tempFile of intermediateTempFiles) {
          fs.promises.unlink(tempFile).catch(() => {});
        }
      }

      const stat = await fs.promises.stat(mergedFilePath);
      const filename = result.filename.replace(/\.[a-zA-Z0-9]+$/, '') + '.mp4';

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const fileStream = fs.createReadStream(mergedFilePath);
      fileStream.pipe(res);

      let cleaned = false;
      const cleanupMerged = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(stallTimer);
        if (mergedFilePath) fs.promises.unlink(mergedFilePath).catch(() => {});
      };

      fileStream.on('end', () => {
        cleanupMerged();
        logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: true });
      });

      fileStream.on('error', (err) => {
        cleanupMerged();
        console.error('[Download Controller Stream Error]:', err?.message || err);
        if (!res.headersSent) res.status(502).json({ success: false, error: 'Something went wrong. Please try again.' });
        logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: false });
      });

      res.on('close', cleanupMerged);
      return;
    }

    const result = await adapter.download(token.sourceUrl, {
      formatId: token.formatId,
      sourceUrl: token.sourceUrl,
      meta: token.meta,
    });

    if (result.sizeBytes && result.sizeBytes > MAX_FILE_SIZE_BYTES) {
      clearTimeout(stallTimer);
      result.stream.destroy?.();
      return res.status(413).json({ success: false, error: 'This file exceeds the maximum allowed download size.' });
    }

    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(result.filename)}"`);
    if (result.sizeBytes) res.setHeader('Content-Length', result.sizeBytes);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let bytesStreamed = 0;
    result.stream.on('data', (chunk) => {
      resetStallTimer();
      bytesStreamed += chunk.length;
      if (bytesStreamed > MAX_FILE_SIZE_BYTES) {
        clearTimeout(stallTimer);
        result.stream.destroy();
        res.destroy();
      }
    });

    result.stream.pipe(res);

    result.stream.on('end', () => {
      // Clean up adapter temp file if one was produced.
      if (result._tempFilePath) {
        fs.promises.unlink(result._tempFilePath).catch(() => { });
      }
      clearTimeout(stallTimer);
      logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: true });
    });

    result.stream.on('error', (err) => {
      console.error('[Download Controller Stream Error]:', err?.message || err);
      if (result._tempFilePath) fs.promises.unlink(result._tempFilePath).catch(() => { });
      clearTimeout(stallTimer);
      if (!res.headersSent) res.status(502).json({ success: false, error: 'Something went wrong. Please try again.' });
      logEvent({ requestId: req.id, platform: token.platform, operation: 'download', durationMs: Date.now() - start, success: false });
    });
  } catch (err) {
    clearTimeout(stallTimer);
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

/**
 * Bulk download handler – streams a ZIP archive containing all requested media items.
 * Accepts { downloadIds: string[], title?: string }
 */
export async function bulkDownloadHandler(req, res) {
  const start = Date.now();
  const { downloadIds, title } = req.body || {};

  if (!Array.isArray(downloadIds) || downloadIds.length === 0) {
    return res.status(400).json({ success: false, error: 'Please provide a valid list of media items to download.' });
  }

  if (downloadIds.length > 50) {
    return res.status(400).json({ success: false, error: 'Cannot download more than 50 items at once.' });
  }

  // Create an isolated temporary directory for downloading and bundling the files
  const bulkDir = path.join(os.tmpdir(), `md_bulk_${nanoid(8)}`);
  let dirCreated = false;

  const cleanup = async () => {
    if (dirCreated) {
      try {
        await fs.promises.rm(bulkDir, { recursive: true, force: true });
      } catch (err) {
        console.error('[Bulk Download] Cleanup error:', err.message);
      }
    }
  };

  try {
    await fs.promises.mkdir(bulkDir, { recursive: true });
    dirCreated = true;

    // Validate and consume tokens (single-use)
    const validItems = [];
    for (const id of downloadIds) {
      if (typeof id !== 'string') continue;
      const token = consumeDownloadToken(id);
      if (token) {
        validItems.push({ id, token });
      }
    }

    if (validItems.length === 0) {
      await cleanup();
      return res.status(404).json({
        success: false,
        error: 'The media is no longer available.',
      });
    }

    const preparedFiles = [];
    let totalBytesWritten = 0;

    // Download each item into the temporary directory
    for (let i = 0; i < validItems.length; i++) {
      const { id, token } = validItems[i];
      try {
        const adapter = getAdapter(token.platform) || resolveAdapter(token.sourceUrl || 'https://placeholder.invalid');
        if (!adapter) {
          console.warn(`[Bulk Download] Unsupported platform adapter for item ${id}`);
          continue;
        }

        const result = await adapter.download(token.sourceUrl, {
          formatId: token.formatId,
          sourceUrl: token.sourceUrl,
          meta: token.meta,
        });

        // Determine safe filename and prevent path traversal
        let rawFilename = result.filename || `media_${i + 1}`;
        // Strips any directory components (e.g. ../ or /)
        rawFilename = path.basename(rawFilename);
        const ext = path.extname(rawFilename) || (result.mimeType?.includes('video') ? '.mp4' : '.jpg');
        const baseWithoutExt = path.basename(rawFilename, ext);
        const safeBase = sanitizeFilename(baseWithoutExt).slice(0, 60) || `media_${i + 1}`;
        const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || '.bin';
        const entryName = `${String(i + 1).padStart(2, '0')}_${safeBase}${safeExt.startsWith('.') ? safeExt : `.${safeExt}`}`;
        const tempFilePath = path.join(bulkDir, entryName);

        if (result._tempFilePath) {
          // Move/copy the pre-existing temp file
          await fs.promises.copyFile(result._tempFilePath, tempFilePath);
          fs.promises.unlink(result._tempFilePath).catch(() => { });
          result.stream?.destroy?.();
        } else {
          // Pipe network stream to file
          let fileBytes = 0;
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(tempFilePath);
            result.stream.on('data', (chunk) => {
              fileBytes += chunk.length;
              if (totalBytesWritten + fileBytes > MAX_FILE_SIZE_BYTES * 2) {
                ws.destroy();
                result.stream.destroy();
                reject(new Error('Bulk download exceeds maximum allowed size.'));
              }
            });
            result.stream.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
            result.stream.on('error', reject);
          });
          totalBytesWritten += fileBytes;
        }

        preparedFiles.push({ path: tempFilePath, entryName });
      } catch (err) {
        console.warn(`[Bulk Download] Failed to prepare item ${id}:`, err.message);
        // Continue processing remaining items to avoid failing the whole batch
      }
    }

    if (preparedFiles.length === 0) {
      await cleanup();
      return res.status(502).json({
        success: false,
        error: 'Failed to retrieve media items. Please try again.',
      });
    }

    // Set up ZIP streaming response
    const zipBase = title ? `${sanitizeFilename(title)}_all_media` : 'mediadrop-download';
    const safeZipName = `${zipBase}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const archive = new ZipArchive({
      zlib: { level: 5 },
    });

    let cleanedUp = false;
    const safeCleanup = () => {
      if (!cleanedUp) {
        cleanedUp = true;
        cleanup();
      }
    };

    archive.on('error', (err) => {
      console.error('[Bulk Download Archive Error]:', err.message);
      safeCleanup();
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to compress media items.' });
      } else {
        res.destroy(err);
      }
    });

    res.on('finish', () => {
      safeCleanup();
      logEvent({ requestId: req.id, operation: 'bulk_download', durationMs: Date.now() - start, success: true, count: preparedFiles.length });
    });

    res.on('close', () => {
      safeCleanup();
    });

    archive.pipe(res);

    for (const file of preparedFiles) {
      archive.file(file.path, { name: file.entryName });
    }

    await archive.finalize();
  } catch (err) {
    console.error('[Bulk Download Handler Error]:', err);
    await cleanup();
    if (!res.headersSent) {
      const friendly = sanitizeErrorMessage(err.message);
      return res.status(500).json({ success: false, error: friendly });
    } else {
      res.destroy(err);
    }
  }
}

