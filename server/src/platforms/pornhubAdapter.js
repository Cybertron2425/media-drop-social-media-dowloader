import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import ffmpegInstaller from 'ffmpeg-static';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream, fetchWithProxy } from '../utils/streamDownloader.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');

// Set binary path if ffmpeg-static is installed and not already set
if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

// Log resolved FFmpeg executable path and version for diagnostics (Task 7)
console.log('[FFmpeg] Resolved executable path:', ffmpegInstaller || 'system ffmpeg');
if (ffmpegInstaller) {
  execFile(ffmpegInstaller, ['-version'], (err, stdout) => {
    if (!err && stdout) {
      console.log('[FFmpeg] Version:', stdout.split('\n')[0]);
    }
  });
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const CONSENT_COOKIES =
  'age_verified=1; accessAgeDisclaimerPH=1; accessAgeDisclaimerUK=1; accessPH=1; platform=pc';

const SUPPORTED_HOSTNAMES = new Set([
  'pornhub.com',
  'www.pornhub.com',
  'm.pornhub.com',
  'pornhub.org',
  'www.pornhub.org',
  'm.pornhub.org',
  'pornhubpremium.com',
  'www.pornhubpremium.com',
  'thumbzilla.com',
  'www.thumbzilla.com',
]);

function isPornhubHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (SUPPORTED_HOSTNAMES.has(host)) return true;
  return (
    host === 'pornhub.com' ||
    host.endsWith('.pornhub.com') ||
    host === 'pornhub.org' ||
    host.endsWith('.pornhub.org') ||
    host === 'pornhubpremium.com' ||
    host.endsWith('.pornhubpremium.com') ||
    host === 'thumbzilla.com' ||
    host.endsWith('.thumbzilla.com')
  );
}

/**
 * Extracts video ID (viewkey or path id) from a Pornhub or Thumbzilla URL.
 */
export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (!isPornhubHost(host)) {
      return null;
    }

    // 1. Standard /view_video.php?viewkey=... or /video/show?viewkey=...
    const viewkey = parsed.searchParams.get('viewkey');
    if (viewkey && /^[a-zA-Z0-9_-]+$/.test(viewkey)) {
      return viewkey;
    }

    // 2. Path-based embed or video: /embed/<id> or /video/<id>
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'embed' || parts[0] === 'video')) {
      const candidate = parts[1].split('?')[0];
      if (/^[a-zA-Z0-9_-]+$/.test(candidate)) {
        return candidate;
      }
    }
  } catch {}
  return null;
}

/**
 * Parses ISO 8601 duration strings like PT10M30S or PT1H2M3S into seconds.
 */
export function parseIsoDuration(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function cleanText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Downloads and packages an HLS (.m3u8) stream into a valid MP4 container using FFmpeg.
 * Uses fluent-ffmpeg safely, captures error, stderr, exit code, and signal.
 * If FFmpeg exits with SIGSEGV, fails immediately without retrying and cleans up.
 */
export function downloadHlsWithFfmpeg(hlsUrl, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeoutMs = options.timeoutMs || 300000;
    const userAgent = options.headers?.['User-Agent'] || DEFAULT_USER_AGENT;
    const referer = options.headers?.['Referer'] || 'https://www.pornhub.com/';

    const headerString = `User-Agent: ${userAgent}\r\nReferer: ${referer}\r\n`;
    const stderrLines = [];

    const command = ffmpeg(hlsUrl)
      .inputOptions([
        '-headers', headerString,
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      ])
      .outputOptions([
        '-c', 'copy',
        '-movflags', '+faststart',
      ])
      .output(outputPath);

    command.on('stderr', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > 25) stderrLines.shift();
    });

    const killProcess = () => {
      if (finished) return;
      try {
        command.kill('SIGKILL');
      } catch {}
    };

    const timer = setTimeout(() => {
      finished = true;
      killProcess();
      reject(new Error('FFmpeg HLS download timed out.'));
    }, timeoutMs);

    command
      .on('end', () => {
        finished = true;
        clearTimeout(timer);
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        finished = true;
        clearTimeout(timer);
        killProcess();

        const isSigsegv =
          err.message?.includes('SIGSEGV') ||
          err.signal === 'SIGSEGV' ||
          err.code === 'SIGSEGV' ||
          err.code === 139;

        if (isSigsegv) {
          console.error('[FFmpeg SIGSEGV Error]: FFmpeg segmentation fault during HLS processing.');
          const sigsegvErr = new PlatformLimitationError(
            'HLS processing failed on the server. Please try another quality.'
          );
          sigsegvErr.isSigsegv = true;
          return reject(sigsegvErr);
        }

        const lastErr = stderrLines.slice(-3).join(' ') || stderr || err.message;
        const ffmpegErr = new Error(`FFmpeg HLS download failed: ${err.message} (${lastErr})`);
        ffmpegErr.originalError = err;
        ffmpegErr.stderr = stderr || lastErr;
        reject(ffmpegErr);
      })
      .run();
  });
}

export class PornhubAdapter extends BaseAdapter {
  static platformId = 'pornhub';
  static status = 'SUPPORTED';

  canHandle(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url.trim());
      const host = parsed.hostname.toLowerCase();
      if (!isPornhubHost(host)) {
        return false;
      }
      return Boolean(extractVideoId(url));
    } catch {
      return false;
    }
  }

  async analyze(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new PlatformLimitationError('Please enter a valid Pornhub video URL.');
    }

    let parsedHost = 'pornhub.com';
    try {
      const parsedUrl = new URL(url);
      if (SUPPORTED_HOSTNAMES.has(parsedUrl.hostname.toLowerCase())) {
        parsedHost = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
      }
    } catch {}

    const pageUrl = `https://www.${parsedHost}/view_video.php?viewkey=${videoId}`;

    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: CONSENT_COOKIES,
      Referer: `https://www.${parsedHost}/`,
      Origin: `https://www.${parsedHost}`,
    };

    let response;
    try {
      response = await fetchWithProxy(pageUrl, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        throw new PlatformLimitationError(
          'Unable to reach Pornhub server. Connection timed out or reset. Please try again.'
        );
      }
      throw new PlatformLimitationError(
        `Failed to reach Pornhub: ${err.message || 'Network error'}`
      );
    }

    // Handle HTTP status codes
    if (response.status === 404 || response.status === 410) {
      throw new PlatformLimitationError('This video could not be found or has been removed.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new PlatformLimitationError(
        'This video cannot be downloaded because access is restricted or requires authentication.'
      );
    }
    if (response.status === 429) {
      throw new PlatformLimitationError(
        'Too many requests have been made to Pornhub. Please try again in a few minutes.'
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PlatformLimitationError(
        `Pornhub returned an error (HTTP ${response.status}). Please try again later.`
      );
    }

    const html = typeof response.data === 'string' ? response.data : '';

    // Parse flashvars JSON embedded in script
    let flashvars = null;
    const flashMatch = html.match(/var\s+flashvars_\d+\s*=\s*({.+?});/s);
    if (flashMatch) {
      try {
        flashvars = JSON.parse(flashMatch[1]);
      } catch {}
    }

    // Check for deleted, private, geo-blocked, locked, or protected messages
    if (
      html.includes('class="geoBlocked"') ||
      html.includes('This content is unavailable in your country') ||
      flashvars?.video_unavailable_country === true ||
      flashvars?.video_unavailable_country === 1
    ) {
      throw new PlatformLimitationError(
        'This video cannot be downloaded because it is geo-restricted in this server region.'
      );
    }

    if (
      flashvars?.video_unavailable === true ||
      flashvars?.video_unavailable === 1 ||
      html.includes('id="lockedPlayer"') ||
      html.includes('Video is locked') ||
      html.includes('class="removed"') ||
      html.includes('class="userMessageSection"') ||
      html.includes('class="noVideo"') ||
      html.includes('This video has been disabled') ||
      html.includes('flagged for verification')
    ) {
      throw new PlatformLimitationError(
        'This video cannot be downloaded because the source does not provide a publicly accessible media stream.'
      );
    }

    // Parse JSON-LD metadata if available
    let ldData = null;
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const parsed = JSON.parse(ldMatch[1]);
        ldData = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {}
    }

    // Title resolution
    let title = cleanText(flashvars?.video_title, null);
    if (!title && ldData?.name) {
      title = cleanText(ldData.name, null);
    }
    if (!title) {
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i);
      if (ogTitle && ogTitle[1]) title = cleanText(ogTitle[1], null);
    }
    if (!title) {
      const h1Title = html.match(/<h1[^>]*class=["'][^"']*title[^"']*["'][^>]*>(.*?)<\/h1>/i);
      if (h1Title && h1Title[1]) title = cleanText(h1Title[1].replace(/<[^>]+>/g, ''), null);
    }
    if (!title) {
      title = 'Pornhub Video';
    }

    // Thumbnail resolution
    let thumbnail = cleanText(flashvars?.image_url, null);
    if (!thumbnail && ldData?.thumbnailUrl) {
      thumbnail = cleanText(Array.isArray(ldData.thumbnailUrl) ? ldData.thumbnailUrl[0] : ldData.thumbnailUrl, null);
    }
    if (!thumbnail) {
      const ogImg = html.match(/<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i);
      if (ogImg && ogImg[1]) thumbnail = cleanText(ogImg[1], null);
    }

    // Duration resolution
    let duration = Number(flashvars?.video_duration) || null;
    if (!duration && ldData?.duration) {
      duration = parseIsoDuration(ldData.duration);
    }
    if (!duration) {
      const ogDur = html.match(/<meta\s+property=["']og:video:duration["']\s+content=["'](\d+)["']/i);
      if (ogDur && ogDur[1]) duration = Number(ogDur[1]) || null;
    }

    // Author resolution
    let author = cleanText(flashvars?.author || ldData?.author, null);
    if (!author) {
      const authorMatch = html.match(/<(?:a|span)[^>]*class=["'][^"']*username[^"']*["'][^>]*>(.*?)<\/(?:a|span)>/i);
      if (authorMatch && authorMatch[1]) {
        author = cleanText(authorMatch[1].replace(/<[^>]+>/g, ''), null);
      }
    }

    // Extract format definitions
    const rawDefinitions = Array.isArray(flashvars?.mediaDefinitions) ? flashvars.mediaDefinitions : [];

    // Find remote get_media endpoint for progressive MP4s
    const remoteDef = rawDefinitions.find(
      (d) => d && d.videoUrl && typeof d.videoUrl === 'string' && d.videoUrl.includes('/video/get_media')
    );

    let progressiveDefs = [];

    // Check if progressive MP4s are already present in flashvars
    for (const def of rawDefinitions) {
      if (
        def &&
        def.format === 'mp4' &&
        typeof def.videoUrl === 'string' &&
        /^https?:\/\//i.test(def.videoUrl) &&
        !def.videoUrl.includes('/video/get_media') &&
        !def.videoUrl.includes('.m3u8')
      ) {
        const height = Number(def.height || def.quality) || 0;
        if (height > 0 && !progressiveDefs.some((p) => (Number(p.height || p.quality) || 0) === height)) {
          progressiveDefs.push(def);
        }
      }
    }

    // Query remote get_media if available
    if (remoteDef) {
      try {
        const getMediaRes = await fetchWithProxy(remoteDef.videoUrl, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: pageUrl,
            Origin: `https://www.${parsedHost}`,
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          timeout: 10000,
          validateStatus: () => true,
        });

        if (getMediaRes.status === 200 && Array.isArray(getMediaRes.data)) {
          const fromMedia = getMediaRes.data.filter(
            (d) =>
              d &&
              typeof d.videoUrl === 'string' &&
              /^https?:\/\//i.test(d.videoUrl) &&
              !d.videoUrl.includes('/video/get_media') &&
              !d.videoUrl.includes('.m3u8')
          );
          for (const item of fromMedia) {
            const h = Number(item.height || item.quality) || 0;
            const existingIdx = progressiveDefs.findIndex((p) => (Number(p.height || p.quality) || 0) === h);
            if (existingIdx >= 0) {
              progressiveDefs[existingIdx] = item;
            } else {
              progressiveDefs.push(item);
            }
          }
        }
      } catch {}
    }

    // Extract HLS definitions
    const hlsDefs = rawDefinitions.filter(
      (d) =>
        d &&
        typeof d.videoUrl === 'string' &&
        /^https?:\/\//i.test(d.videoUrl) &&
        !d.videoUrl.includes('/video/get_media') &&
        (d.format === 'hls' || d.videoUrl.includes('.m3u8'))
    );

    // Group definitions by quality height.
    // Task 8: Prefer Progressive MP4 whenever Pornhub provides it (ev.phncdn.com, isHls: false).
    // HLS should only be used when no progressive MP4 exists.
    const qualityMap = new Map();

    for (const pDef of progressiveDefs) {
      const height = Number(pDef.height || pDef.quality) || 0;
      if (height > 0) {
        const entry = qualityMap.get(height) || {};
        entry.progressiveDef = pDef;
        qualityMap.set(height, entry);
      }
    }

    for (const hDef of hlsDefs) {
      const height = Number(hDef.height || hDef.quality) || 0;
      if (height > 0) {
        const entry = qualityMap.get(height) || {};
        entry.hlsDef = hDef;
        qualityMap.set(height, entry);
      }
    }

    // Fallback: if qualityMap is empty, inspect rawDefinitions (excluding get_media itself)
    if (qualityMap.size === 0) {
      for (const def of rawDefinitions) {
        if (!def || typeof def.videoUrl !== 'string' || def.videoUrl.includes('/video/get_media')) continue;
        const height = Number(def.height || def.quality) || 0;
        if (height > 0) {
          const isHls = def.format === 'hls' || def.videoUrl.includes('.m3u8');
          const entry = qualityMap.get(height) || {};
          if (isHls) entry.hlsDef = def;
          else entry.progressiveDef = def;
          qualityMap.set(height, entry);
        }
      }
    }

    const formats = [];
    let formatIdx = 0;

    for (const [height, { progressiveDef, hlsDef }] of qualityMap.entries()) {
      const selectedDef = progressiveDef || hlsDef;
      const isHls = !progressiveDef && Boolean(hlsDef);
      const vUrl = selectedDef.videoUrl;
      const audioUrl = selectedDef.audioUrl && /^https?:\/\//i.test(selectedDef.audioUrl) ? selectedDef.audioUrl : null;
      const needsMerge = Boolean(audioUrl);
      const quality = `${height}p`;

      formats.push({
        id: `ph-${formatIdx++}`,
        quality,
        resolution: quality,
        format: 'mp4',
        sizeBytes: Number(selectedDef.sizeBytes) || null,
        mimeType: 'video/mp4',
        sourceUrl: vUrl,
        videoUrl: vUrl,
        audioUrl,
        hasAudio: true,
        hasVideo: true,
        needsMerge,
        meta: {
          title,
          quality,
          resolution: quality,
          format: 'mp4',
          videoUrl: vUrl,
          audioUrl,
          needsMerge,
          isHls,
          getMediaUrl: remoteDef?.videoUrl || null,
          hlsUrl: hlsDef?.videoUrl || null,
          pageUrl,
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: `https://www.${parsedHost}/`,
            Origin: `https://www.${parsedHost}`,
          },
        },
      });
    }

    if (formats.length === 0) {
      throw new PlatformLimitationError(
        'This video cannot be downloaded because the source does not provide a publicly accessible media stream.'
      );
    }

    // Sort highest quality / resolution first (1080p -> 720p -> 480p -> 240p)
    formats.sort((a, b) => {
      const resA = Number(a.resolution?.replace('p', '')) || 0;
      const resB = Number(b.resolution?.replace('p', '')) || 0;
      return resB - resA;
    });

    return {
      platform: 'pornhub',
      title,
      author,
      thumbnail,
      type: 'video',
      duration,
      formats,
    };
  }

  async download(url, options = {}) {
    let sourceUrl = options.sourceUrl || url;

    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
      throw new PlatformLimitationError('The Pornhub media URL is invalid.');
    }

    const format = options.meta?.format || 'mp4';
    let filename = `pornhub_video.${format}`;
    if (options.meta?.title) {
      const base = options.meta.title
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 50)
        .replace(/^_+|_+$/g, '');
      if (base) filename = `${base}.${format}`;
    }

    const baseHeaders = {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: options.meta?.pageUrl || 'https://www.pornhub.com/',
      Origin: 'https://www.pornhub.com',
      Accept: '*/*',
      ...(options.meta?.headers || {}),
      ...(options.headers || {}),
    };

    const isHls = Boolean(options.meta?.isHls || sourceUrl.includes('.m3u8'));

    // Case 1: HLS format (only when progressive MP4 is not available)
    if (isHls) {
      let hlsUrl = sourceUrl;

      // Task 4: Before using FFmpeg:
      // - Verify the HLS URL is actually a .m3u8 playlist.
      // - Fetch/check the playlist through the existing proxy mechanism.
      // - If the playlist returns 403/404/410, refresh the Pornhub media URL once.
      // - Never pass an expired or invalid URL to FFmpeg.
      let playlistVerified = false;
      try {
        const checkRes = await fetchWithProxy(hlsUrl, {
          headers: baseHeaders,
          timeout: 8000,
          validateStatus: () => true,
        });

        if (
          checkRes.status === 200 &&
          typeof checkRes.data === 'string' &&
          checkRes.data.includes('#EXTM3U')
        ) {
          playlistVerified = true;
        }
      } catch {}

      // If playlist is expired, 403/404/410, or invalid, refresh via pageUrl once
      if (!playlistVerified && options.meta?.pageUrl) {
        try {
          const freshPageRes = await fetchWithProxy(options.meta.pageUrl, {
            headers: baseHeaders,
            timeout: 10000,
            validateStatus: () => true,
          });

          if (freshPageRes.status === 200 && typeof freshPageRes.data === 'string') {
            const freshHtml = freshPageRes.data;
            const flashMatch = freshHtml.match(/var\s+flashvars_\d+\s*=\s*({.+?});/s);
            if (flashMatch) {
              const freshFlashvars = JSON.parse(flashMatch[1]);
              const freshDefs = Array.isArray(freshFlashvars?.mediaDefinitions)
                ? freshFlashvars.mediaDefinitions
                : [];
              const reqQuality = (options.meta?.quality || '').replace('p', '');

              const freshHlsMatch = freshDefs.find(
                (d) =>
                  d &&
                  (String(d.quality) === reqQuality || String(d.height) === reqQuality) &&
                  typeof d.videoUrl === 'string' &&
                  (d.format === 'hls' || d.videoUrl.includes('.m3u8'))
              );

              if (freshHlsMatch?.videoUrl) {
                hlsUrl = freshHlsMatch.videoUrl;
                const freshCheck = await fetchWithProxy(hlsUrl, {
                  headers: baseHeaders,
                  timeout: 8000,
                  validateStatus: () => true,
                });
                if (
                  freshCheck.status === 200 &&
                  typeof freshCheck.data === 'string' &&
                  freshCheck.data.includes('#EXTM3U')
                ) {
                  playlistVerified = true;
                }
              }
            }
          }
        } catch {}
      }

      if (!playlistVerified) {
        throw new PlatformLimitationError(
          'The media stream is no longer available on Pornhub (HTTP 410).'
        );
      }

      // Safe to run FFmpeg with verified fresh HLS playlist
      const tempFilePath = path.join(os.tmpdir(), `md_ph_hls_${nanoid(8)}.mp4`);
      try {
        await downloadHlsWithFfmpeg(hlsUrl, tempFilePath, {
          headers: baseHeaders,
        });

        const stat = await fs.promises.stat(tempFilePath);
        if (stat.size === 0) {
          throw new Error('Downloaded HLS file is empty.');
        }

        const readStream = fs.createReadStream(tempFilePath);
        return {
          _tempFilePath: tempFilePath,
          stream: readStream,
          filename,
          mimeType: 'video/mp4',
          sizeBytes: stat.size,
          statusCode: 200,
        };
      } catch (err) {
        fs.promises.unlink(tempFilePath).catch(() => {});
        if (err.isSigsegv) {
          throw err;
        }
        if (
          err.message?.includes('4XX') ||
          err.message?.includes('410') ||
          err.message?.includes('404')
        ) {
          throw new PlatformLimitationError(
            'The media stream is no longer available on Pornhub (HTTP 410).'
          );
        }
        if (err.message?.includes('403') || err.message?.includes('401')) {
          throw new PlatformLimitationError(
            'Access to this media stream was denied by Pornhub (HTTP 403).'
          );
        }
        throw new PlatformLimitationError(
          `Failed to download HLS video stream: ${err.message}`
        );
      }
    }

    // Case 2: Progressive MP4
    // Before downloading, try fetching a fresh URL from get_media if available
    // to ensure the signed token hasn't expired or become stale
    if (options.meta?.getMediaUrl) {
      try {
        const freshRes = await fetchWithProxy(options.meta.getMediaUrl, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: options.meta?.pageUrl || 'https://www.pornhub.com/',
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          timeout: 6000,
          validateStatus: () => true,
        });

        if (freshRes.status === 200 && Array.isArray(freshRes.data)) {
          const reqQuality = (options.meta?.quality || '').replace('p', '');
          const match = freshRes.data.find(
            (d) =>
              d &&
              (String(d.quality) === reqQuality || String(d.height) === reqQuality) &&
              typeof d.videoUrl === 'string' &&
              d.videoUrl.includes('.mp4') &&
              !d.videoUrl.includes('.m3u8')
          );
          if (match?.videoUrl) {
            sourceUrl = match.videoUrl;
          }
        }
      } catch {
        // If fresh check fails, proceed with existing sourceUrl
      }
    }

    const executeDownload = async (targetUrl) => {
      return await downloadStream(targetUrl, {
        ...options,
        sourceUrl: targetUrl,
        meta: {
          ...(options.meta || {}),
          headers: baseHeaders,
        },
      });
    };

    try {
      const result = await executeDownload(sourceUrl);
      return {
        ...result,
        filename,
      };
    } catch (err) {
      const status = err.response?.status;

      // Handle 410 (Gone/Expired) or 403 / 471 (Unauthorized) with ONE-TIME token refresh
      if ((status === 410 || status === 403 || status === 471) && options.meta?.getMediaUrl) {
        try {
          const freshRes = await fetchWithProxy(options.meta.getMediaUrl, {
            headers: {
              'User-Agent': DEFAULT_USER_AGENT,
              Referer: options.meta?.pageUrl || 'https://www.pornhub.com/',
              Accept: 'application/json, text/javascript, */*; q=0.01',
            },
            timeout: 6000,
            validateStatus: () => true,
          });

          if (freshRes.status === 200 && Array.isArray(freshRes.data)) {
            const reqQuality = (options.meta?.quality || '').replace('p', '');
            const match = freshRes.data.find(
              (d) =>
                d &&
                (String(d.quality) === reqQuality || String(d.height) === reqQuality) &&
                typeof d.videoUrl === 'string' &&
                d.videoUrl.includes('.mp4') &&
                !d.videoUrl.includes('.m3u8')
            );
            if (match?.videoUrl && match.videoUrl !== sourceUrl) {
              const retryResult = await executeDownload(match.videoUrl);
              return {
                ...retryResult,
                filename,
              };
            }
          }
        } catch {
          // Fall through to error handler
        }
      }

      if (status === 403 || status === 471) {
        throw new PlatformLimitationError(
          'Access to this media stream was denied by Pornhub (HTTP 403). The link may have expired.'
        );
      }
      if (status === 404 || status === 410) {
        throw new PlatformLimitationError(
          'The media stream is no longer available on Pornhub (HTTP 410).'
        );
      }
      if (status === 429) {
        throw new PlatformLimitationError(
          'Pornhub download rate limit reached. Please try again later.'
        );
      }
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        throw new PlatformLimitationError(
          'Media stream connection was interrupted or timed out. Please try again.'
        );
      }
      throw err;
    }
  }
}
