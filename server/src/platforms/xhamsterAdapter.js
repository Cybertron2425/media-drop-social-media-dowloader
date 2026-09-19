import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createRequire } from 'node:module';
import ffmpegInstaller from 'ffmpeg-static';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

export function getMaxFileSizeBytes() {
  const parsed = parseInt(process.env.MAX_FILE_SIZE_MB, 10);
  const mb = !isNaN(parsed) && parsed > 0 ? parsed : 6144;
  return mb * 1024 * 1024;
}

const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': DEFAULT_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'age_verified=1; platform=pc',
};

const XHAMSTER_DOMAINS = [
  'xhamster.com',
  'xhamster.one',
  'xhamster.desi',
  'xhms.pro',
  'xhday.com',
  'xhvid.com',
  'xhwide.com',
];

const VALID_HEX_RE = /^[0-9a-fA-F]{12,}$/;

/**
 * Byte generator supporting xHamster's 7 PRNG cipher algorithms.
 */
export class ByteGenerator {
  constructor(algoId, seed) {
    this.algoId = algoId;
    this.s = seed | 0;
  }

  nextByte() {
    switch (this.algoId) {
      case 1: {
        // LCG (a=1664525, c=1013904223, m=2^32)
        this.s = (Math.imul(this.s, 1664525) + 1013904223) | 0;
        return this.s & 0xFF;
      }
      case 2: {
        // xorshift32
        let val = this.s;
        val = (val ^ (val << 13)) | 0;
        val = (val ^ (val >>> 17)) | 0;
        val = (val ^ (val << 5)) | 0;
        this.s = val;
        return val & 0xFF;
      }
      case 3: {
        // Weyl Sequence + MurmurHash3 (fmix32)
        let val = (this.s + 0x9e3779b9) | 0;
        this.s = val;
        val = (val ^ (val >>> 16)) | 0;
        val = Math.imul(val, 0x85ebca77) | 0;
        val = (val ^ (val >>> 13)) | 0;
        val = Math.imul(val, 0xc2b2ae3d) | 0;
        return ((val ^ (val >>> 16)) | 0) & 0xFF;
      }
      case 4: {
        // Custom scrambling function with ROL 7
        let val = (this.s + 0x6d2b79f5) | 0;
        this.s = val;
        val = ((val << 7) | (val >>> 25)) | 0;
        val = (val + 0x9e3779b9) | 0;
        val = (val ^ (val >>> 11)) | 0;
        return (Math.imul(val, 0x27d4eb2d) | 0) & 0xFF;
      }
      case 5: {
        // xorshift variant + addition
        let val = this.s;
        val = (val ^ (val << 7)) | 0;
        val = (val ^ (val >>> 9)) | 0;
        val = (val ^ (val << 8)) | 0;
        val = (val + 0xa5a5a5a5) | 0;
        this.s = val;
        return val & 0xFF;
      }
      case 6: {
        // LCG with variable right shift scrambler
        const val = (Math.imul(this.s, 0x2c9277b5) + 0xac564b05) | 0;
        this.s = val;
        const s2 = (val ^ (val >>> 18)) | 0;
        const shift = (val >>> 27) & 31;
        return ((s2 >>> shift) | 0) & 0xFF;
      }
      case 7: {
        // Weyl Sequence + multiply-xor-shift
        const val = (this.s + 0x9e3779b9) | 0;
        this.s = val;
        let e = (val ^ (val << 5)) | 0;
        e = Math.imul(e, 0x7feb352d) | 0;
        e = (e ^ (e >>> 15)) | 0;
        return (Math.imul(e, 0x846ca68b) | 0) & 0xFF;
      }
      default:
        throw new Error(`Unknown algorithm ID "${this.algoId}"`);
    }
  }
}

/**
 * Deciphers a hex ciphertext string using the embedded algoId and seed.
 */
export function decipherHexString(hexString) {
  if (!hexString || typeof hexString !== 'string' || hexString.length < 12) return null;
  let byteData;
  try {
    byteData = Buffer.from(hexString, 'hex');
  } catch {
    return null;
  }
  if (byteData.length < 6) return null;

  const algoId = byteData[0];
  const seed = byteData.readInt32LE(1);
  try {
    const generator = new ByteGenerator(algoId, seed);
    const deciphered = Buffer.alloc(byteData.length - 5);
    for (let i = 0; i < deciphered.length; i++) {
      deciphered[i] = byteData[5 + i] ^ generator.nextByte();
    }
    return deciphered.toString('latin1');
  } catch {
    return null;
  }
}

/**
 * Deciphers an xHamster format URL or path.
 */
export function decipherFormatUrl(formatUrl) {
  if (!formatUrl || typeof formatUrl !== 'string') return null;

  // Case 1: entire string is hex ciphertext
  if (VALID_HEX_RE.test(formatUrl)) {
    return decipherHexString(formatUrl);
  }

  // Case 2: URL contains a hex ciphertext path segment, e.g. /HEX_STRING/file.mp4 or /HEX_STRING,file.mp4
  try {
    const parsed = new URL(formatUrl);
    const match = parsed.pathname.match(/^\/([0-9a-fA-F]{12,})([/,].+)$/);
    if (match) {
      const hex = match[1];
      const remainder = match[2];
      const deciphered = decipherHexString(hex);
      if (deciphered) {
        parsed.pathname = `/${deciphered}${remainder}`;
        return parsed.href;
      }
    }
    return formatUrl;
  } catch {
    // If not a full URL, check relative path
    const match = formatUrl.match(/^\/([0-9a-fA-F]{12,})([/,].+)$/);
    if (match) {
      const hex = match[1];
      const remainder = match[2];
      const deciphered = decipherHexString(hex);
      if (deciphered) {
        return `/${deciphered}${remainder}`;
      }
    }
    return formatUrl;
  }
}

/**
 * Checks if a hostname matches known xHamster domains.
 */
export function isXHamsterHost(host) {
  if (!host || typeof host !== 'string') return false;
  const clean = host.toLowerCase().replace(/^www\./, '');
  for (const domain of XHAMSTER_DOMAINS) {
    if (clean === domain || clean.endsWith(`.${domain}`)) {
      return true;
    }
  }
  // Also match xhamster\d+.(com|desi|one)
  if (/^xhamster\d+\.(com|desi|one)$/.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Parses height and produces standardized resolution metadata.
 */
export function extractResolution(label, height = null) {
  let h = height ? parseInt(height, 10) : null;
  if (!h && typeof label === 'string') {
    const m = label.match(/(\d+)[pP]/);
    if (m) h = parseInt(m[1], 10);
  }

  if (h) {
    if (h >= 2160) return { quality: '4K (2160p)', resolution: '2160p', height: 2160, qualityLabel: `${h}p` };
    if (h >= 1440) return { quality: '1440p (QHD)', resolution: '1440p', height: 1440, qualityLabel: `${h}p` };
    if (h >= 1080) return { quality: '1080p (FHD)', resolution: '1080p', height: 1080, qualityLabel: `${h}p` };
    if (h >= 720) return { quality: '720p (HD)', resolution: '720p', height: 720, qualityLabel: `${h}p` };
    if (h >= 480) return { quality: '480p (SD)', resolution: '480p', height: 480, qualityLabel: `${h}p` };
    if (h >= 360) return { quality: '360p (SD)', resolution: '360p', height: 360, qualityLabel: `${h}p` };
    if (h >= 240) return { quality: '240p', resolution: '240p', height: 240, qualityLabel: `${h}p` };
    return { quality: `${h}p`, resolution: `${h}p`, height: h, qualityLabel: `${h}p` };
  }

  return { quality: label || 'Original', resolution: null, height: 0, qualityLabel: label || 'Original' };
}

/**
 * Extracts video ID from an xHamster video URL.
 */
export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (!isXHamsterHost(parsed.hostname)) return null;

    // Pattern 1: /videos/slug-id or /videos/id
    const videoMatch = parsed.pathname.match(/^\/videos\/(?:[a-zA-Z0-9_-]+-)?([a-zA-Z0-9]+)\/?$/);
    if (videoMatch) return videoMatch[1];

    // Pattern 2: /movies/id/slug.html or /movies/id
    const movieMatch = parsed.pathname.match(/^\/movies\/([a-zA-Z0-9]+)(?:\/[^/]*)?(?:\.html)?\/?$/);
    if (movieMatch) return movieMatch[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes URL for logging by returning origin + pathname without credentials or query params.
 */
export function sanitizeUrlForLogging(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      origin: u.origin,
      path: u.pathname,
    };
  } catch {
    return {
      origin: 'unknown',
      path: 'unknown',
    };
  }
}

/**
 * Extracts and parses window.initials JSON object with balanced brace parsing.
 */
export function extractInitialsJson(html) {
  if (!html || typeof html !== 'string') return null;
  const startIdx = html.indexOf('window.initials');
  if (startIdx === -1) return null;
  const braceIdx = html.indexOf('{', startIdx);
  if (braceIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let stringChar = '';
  let isEscaped = false;

  for (let i = braceIdx; i < html.length; i++) {
    const char = html[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\') {
      isEscaped = true;
      continue;
    }

    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = html.slice(braceIdx, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          try {
            return Function(`'use strict'; return (${jsonStr})`)();
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

export class XHamsterAdapter extends BaseAdapter {
  static platformId = 'xhamster';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      if (!isXHamsterHost(parsed.hostname)) return false;

      // Must have a valid video path (e.g. /videos/slug-id or /movies/id)
      const pathname = parsed.pathname;
      return (
        /^\/videos\/(?:[a-zA-Z0-9_-]+-)?([a-zA-Z0-9]+)\/?$/.test(pathname) ||
        /^\/movies\/([a-zA-Z0-9]+)(?:\/[^/]*)?(?:\.html)?\/?$/.test(pathname)
      );
    } catch {
      return false;
    }
  }

  /**
   * Fetches public xHamster page and extracts metadata and available video formats.
   */
  async analyze(url) {
    await assertSafeUrl(url);

    // Normalize mobile URL to desktop
    const desktopUrl = url.replace(/^(https?:\/\/)(?:[a-zA-Z0-9_-]+\.)?m\./i, '$1');

    let html;
    let finalUrl = desktopUrl;
    try {
      const res = await axios.get(desktopUrl, {
        headers: BROWSER_HEADERS,
        timeout: 12000,
        maxRedirects: 5,
        responseType: 'text',
      });
      html = res.data;
      if (res.request?.res?.responseUrl) {
        finalUrl = res.request.res.responseUrl;
      }
    } catch (err) {
      if (err.response?.status === 404) {
        throw new PlatformLimitationError('This xHamster video was not found or has been removed.');
      }
      if (err.response?.status === 403 || err.response?.status === 410) {
        throw new PlatformLimitationError('This xHamster video is restricted or unavailable.');
      }
      throw err;
    }

    if (typeof html !== 'string' || html.length === 0) {
      throw new PlatformLimitationError('Failed to fetch xHamster webpage.');
    }

    // Check for explicit closed or deleted video notices
    const $ = cheerio.load(html);
    if ($('#videoClosed').length > 0 || $('.video-closed').length > 0) {
      const closedMsg = $('#videoClosed').text().trim() || 'This video has been removed or is unavailable.';
      throw new PlatformLimitationError(closedMsg);
    }

    // Try extracting initials JSON object: window.initials = {...};
    const initials = extractInitialsJson(html);
    const videoModel = initials?.videoModel;

    // Title extraction
    const title =
      videoModel?.title ||
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'xHamster Video';

    // Thumbnail extraction
    const thumbnail =
      videoModel?.thumbURL ||
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('video').attr('poster') ||
      null;

    // Duration extraction
    let duration = null;
    if (Number.isFinite(videoModel?.duration)) {
      duration = Math.round(videoModel.duration);
    } else {
      const durationMeta = $('meta[property="video:duration"]').attr('content') || $('meta[itemprop="duration"]').attr('content');
      if (durationMeta) {
        const parsedDur = parseInt(durationMeta, 10);
        if (!isNaN(parsedDur)) duration = parsedDur;
      }
    }

    const author = videoModel?.author?.name || $('a.author').first().text().trim() || null;

    // Formats extraction
    const rawFormats = [];
    const seenUrls = new Set();

    // 1. Check videoModel.sources.mp4 and download size mapping
    const downloadSources = videoModel?.sources?.download || {};
    const mp4Sources = videoModel?.sources?.mp4 || {};

    for (const [qualityKey, formatVal] of Object.entries(mp4Sources)) {
      if (!formatVal || typeof formatVal !== 'string') continue;
      const deciphered = decipherFormatUrl(formatVal);
      if (!deciphered) continue;

      let sourceUrl = deciphered;
      try {
        sourceUrl = new URL(deciphered, finalUrl).href;
      } catch {
        continue;
      }

      if (seenUrls.has(sourceUrl)) continue;
      seenUrls.add(sourceUrl);

      const resInfo = extractResolution(qualityKey);
      const downloadInfo = downloadSources[qualityKey];
      const sizeBytes = downloadInfo?.size ? Math.round(Number(downloadInfo.size)) : null;

      rawFormats.push({
        id: `mp4-${resInfo.qualityLabel || qualityKey}`,
        quality: resInfo.quality,
        resolution: resInfo.resolution,
        height: resInfo.height,
        qualityLabel: resInfo.qualityLabel,
        format: 'mp4',
        sizeBytes,
        sourceUrl,
        isHls: false,
      });
    }

    // 2. Check xplayerSettings.sources (standard and hls)
    const xplayerSettings = initials?.xplayerSettings?.sources || {};

    // 2a. Standard formats (prioritize h264 for universal compatibility and seamless remuxing)
    if (xplayerSettings.standard && typeof xplayerSettings.standard === 'object') {
      const standardKeys = Object.keys(xplayerSettings.standard).sort((a, b) => {
        if (a === 'h264') return -1;
        if (b === 'h264') return 1;
        return 0;
      });
      for (const identifier of standardKeys) {
        const formatList = xplayerSettings.standard[identifier];
        const items = Array.isArray(formatList) ? formatList : [formatList];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          for (const key of ['url', 'fallback']) {
            const rawUrl = item[key];
            if (!rawUrl) continue;
            const deciphered = decipherFormatUrl(rawUrl);
            if (!deciphered) continue;

            let sourceUrl;
            try {
              sourceUrl = new URL(deciphered, finalUrl).href;
            } catch {
              continue;
            }

            if (seenUrls.has(sourceUrl)) continue;
            seenUrls.add(sourceUrl);

            const isM3u8 = sourceUrl.toLowerCase().includes('.m3u8');
            const qualityStr = item.quality || item.label || identifier || '';
            const resInfo = extractResolution(qualityStr);
            const sizeBytes = item.size ? Math.round(Number(item.size)) : null;

            rawFormats.push({
              id: isM3u8 ? `hls-${resInfo.qualityLabel || 'stream'}` : `mp4-${resInfo.qualityLabel || 'standard'}`,
              quality: resInfo.quality,
              resolution: resInfo.resolution,
              height: resInfo.height,
              qualityLabel: resInfo.qualityLabel,
              format: 'mp4',
              sizeBytes,
              sourceUrl,
              isHls: isM3u8,
            });

            // If master HLS contains _TPL_ and multi=, expand resolution variants
            if (isM3u8 && sourceUrl.includes('_TPL_')) {
              const multiMatch = sourceUrl.match(/multi=([^/]+)/);
              if (multiMatch) {
                const parts = multiMatch[1].split(',');
                for (const part of parts) {
                  const [dim, label] = part.split(':');
                  if (dim && label) {
                    const [w, h] = dim.split('x');
                    const variantUrl = sourceUrl.replace('_TPL_', label);
                    if (!seenUrls.has(variantUrl)) {
                      seenUrls.add(variantUrl);
                      const varRes = extractResolution(label, h);
                      rawFormats.push({
                        id: `hls-${varRes.qualityLabel || label}`,
                        quality: varRes.quality,
                        resolution: `${w}x${h}`,
                        height: parseInt(h, 10) || 0,
                        qualityLabel: varRes.qualityLabel,
                        format: 'mp4',
                        sizeBytes: null,
                        sourceUrl: variantUrl,
                        isHls: true,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 2b. HLS master manifest sources
    if (xplayerSettings.hls && typeof xplayerSettings.hls === 'object') {
      for (const key of ['url', 'fallback']) {
        const rawHlsUrl = xplayerSettings.hls[key];
        if (!rawHlsUrl) continue;
        const deciphered = decipherFormatUrl(rawHlsUrl);
        if (!deciphered) continue;

        let sourceUrl;
        try {
          sourceUrl = new URL(deciphered, finalUrl).href;
        } catch {
          continue;
        }

        if (seenUrls.has(sourceUrl)) continue;
        seenUrls.add(sourceUrl);

        rawFormats.push({
          id: `hls-${key}`,
          quality: 'Auto (HLS)',
          resolution: null,
          height: 0,
          qualityLabel: 'hls',
          format: 'mp4',
          sizeBytes: null,
          sourceUrl,
          isHls: true,
        });
      }
    }

    // 3. Fallback HTML tags if no formats found in initials
    if (rawFormats.length === 0) {
      // 3a. <video> and <source>
      $('video source, video').each((_, elem) => {
        const src = $(elem).attr('src');
        if (src) {
          try {
            const resolved = new URL(src, finalUrl).href;
            if (!seenUrls.has(resolved)) {
              seenUrls.add(resolved);
              const label = $(elem).attr('label') || $(elem).attr('data-quality') || $(elem).attr('title') || 'Original';
              const resInfo = extractResolution(label, $(elem).attr('height'));
              const isHls = resolved.toLowerCase().includes('.m3u8');
              rawFormats.push({
                id: isHls ? 'hls-fallback' : 'mp4-fallback',
                quality: resInfo.quality,
                resolution: resInfo.resolution,
                height: resInfo.height,
                qualityLabel: resInfo.qualityLabel,
                format: 'mp4',
                sizeBytes: null,
                sourceUrl: resolved,
                isHls,
              });
            }
          } catch {}
        }
      });

      // 3b. OpenGraph / Twitter video tags
      const ogVideo =
        $('meta[property="og:video:secure_url"]').attr('content') ||
        $('meta[property="og:video:url"]').attr('content') ||
        $('meta[property="og:video"]').attr('content');
      if (ogVideo) {
        try {
          const resolved = new URL(ogVideo, finalUrl).href;
          if (!seenUrls.has(resolved)) {
            seenUrls.add(resolved);
            const isHls = resolved.toLowerCase().includes('.m3u8');
            rawFormats.push({
              id: isHls ? 'hls-og' : 'mp4-og',
              quality: 'Original',
              resolution: null,
              height: 0,
              qualityLabel: 'Original',
              format: 'mp4',
              sizeBytes: null,
              sourceUrl: resolved,
              isHls,
            });
          }
        } catch {}
      }
    }

    if (rawFormats.length === 0) {
      throw new PlatformLimitationError('No downloadable video formats found for this xHamster video.');
    }

    // Validate that each candidate format has a valid web URL
    const validFormats = [];
    for (const fmt of rawFormats) {
      try {
        const u = new URL(fmt.sourceUrl);
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) continue;
        validFormats.push(fmt);
      } catch {
        // Skip invalid format URLs
      }
    }

    if (validFormats.length === 0) {
      throw new PlatformLimitationError('No safe downloadable formats found for this xHamster video.');
    }

    // Sort formats: prefer highest resolution to lowest, then active HLS streams, then h264 codec
    validFormats.sort((a, b) => {
      if ((b.height || 0) !== (a.height || 0)) {
        return (b.height || 0) - (a.height || 0);
      }
      const aIsH264 = a.sourceUrl?.includes('h264') ? 1 : 0;
      const bIsH264 = b.sourceUrl?.includes('h264') ? 1 : 0;
      if (bIsH264 !== aIsH264) {
        return bIsH264 - aIsH264;
      }
      if (a.isHls !== b.isHls) {
        return a.isHls ? -1 : 1;
      }
      return 0;
    });

    return {
      platform: 'xhamster',
      title,
      thumbnail,
      duration,
      author,
      type: 'video',
      formats: validFormats.map((f, idx) => ({
        id: f.id || `xh-${idx}`,
        quality: f.quality,
        resolution: f.resolution,
        height: f.height,
        format: f.format || 'mp4',
        sizeBytes: f.sizeBytes,
        mimeType: 'video/mp4',
        sourceUrl: f.sourceUrl,
        hasAudio: true,
        meta: {
          pageUrl: url,
          quality: f.qualityLabel,
          isHls: f.isHls,
          headers: {
            Referer: url,
            'User-Agent': DEFAULT_USER_AGENT,
          },
        },
      })),
    };
  }

  /**
   * Refreshes a media URL from the public page when expired (403/410).
   */
  async refreshMediaUrl(pageUrl, requestedQuality = null, isHls = false) {
    try {
      console.log(`[xHamster Expiry Refresh] Re-analyzing page ${pageUrl.slice(0, 60)} for fresh URL...`);
      const freshInfo = await this.analyze(pageUrl);
      if (!freshInfo?.formats || freshInfo.formats.length === 0) {
        return null;
      }
      // Match by requested quality or same type (HLS vs progressive)
      if (requestedQuality) {
        const matched = freshInfo.formats.find(
          (f) => f.meta?.quality === requestedQuality || f.quality === requestedQuality
        );
        if (matched?.sourceUrl) return matched.sourceUrl;
      }
      const sameType = freshInfo.formats.find((f) => Boolean(f.meta?.isHls) === isHls);
      return sameType?.sourceUrl || freshInfo.formats[0].sourceUrl;
    } catch (err) {
      console.warn(`[xHamster Expiry Refresh] Failed to refresh URL: ${err.message}`);
      return null;
    }
  }

  /**
   * Dedicated xHamster HLS stream/segment downloader.
   * Downloads segments directly with Referer headers and enforces the 6 GB size limit.
   */
  async downloadHlsToFile(m3u8Url, options = {}) {
    const pageUrl = options.meta?.pageUrl;
    const maxSizeBytes = getMaxFileSizeBytes();
    const referer = options.meta?.headers?.Referer || pageUrl || 'https://xhamster.com/';
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: referer,
      ...(options.meta?.headers || {}),
    };

    let playlistUrl = m3u8Url;

    // Helper to fetch playlist with single expiry refresh retry
    const fetchPlaylist = async (urlToFetch) => {
      try {
        const res = await axios.get(urlToFetch, {
          headers,
          timeout: 10000,
          responseType: 'text',
        });
        return { data: res.data, url: urlToFetch };
      } catch (err) {
        if ((err.response?.status === 403 || err.response?.status === 410) && pageUrl) {
          const fresh = await this.refreshMediaUrl(pageUrl, options.meta?.quality, true);
          if (fresh && fresh !== urlToFetch) {
            playlistUrl = fresh;
            const retryRes = await axios.get(fresh, {
              headers,
              timeout: 10000,
              responseType: 'text',
            });
            return { data: retryRes.data, url: fresh };
          }
        }
        throw err;
      }
    };

    const initialFetch = await fetchPlaylist(playlistUrl);
    let playlistText = initialFetch.data;
    playlistUrl = initialFetch.url;

    if (!playlistText.includes('#EXTM3U')) {
      throw new PlatformLimitationError('Invalid HLS playlist received from xHamster.');
    }

    // If master playlist, pick best variant
    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      const lines = playlistText.split('\n').map((l) => l.trim());
      let bestBandwidth = -1;
      let chosenSubUrl = null;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.startsWith('#')) {
            if (bw > bestBandwidth || chosenSubUrl === null) {
              bestBandwidth = bw;
              chosenSubUrl = nextLine;
            }
          }
        }
      }

      if (chosenSubUrl) {
        const mediaPlaylistUrl = new URL(chosenSubUrl, playlistUrl).href;
        const mediaFetch = await fetchPlaylist(mediaPlaylistUrl);
        playlistText = mediaFetch.data;
        playlistUrl = mediaFetch.url;
      }
    }

    // Extract media segment URLs
    const lines = playlistText.split('\n').map((l) => l.trim());
    const segmentUrls = [];
    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        segmentUrls.push(new URL(line, playlistUrl).href);
      }
    }

    if (segmentUrls.length === 0) {
      throw new PlatformLimitationError('No segments found in xHamster HLS playlist.');
    }

    const tempTsPath = path.join(os.tmpdir(), `xh_hls_${nanoid(12)}.ts`);
    const tempMp4Path = path.join(os.tmpdir(), `xh_hls_${nanoid(12)}.mp4`);
    const tsWriteStream = fs.createWriteStream(tempTsPath);

    let totalBytes = 0;

    try {
      for (let i = 0; i < segmentUrls.length; i++) {
        const segUrl = segmentUrls[i];
        let segRes;

        try {
          segRes = await axios.get(segUrl, {
            headers,
            timeout: 15000,
            responseType: 'arraybuffer',
          });
        } catch (segErr) {
          if ((segErr.response?.status === 403 || segErr.response?.status === 410) && pageUrl) {
            // Attempt to refresh playlist and get updated segments
            const fresh = await this.refreshMediaUrl(pageUrl, options.meta?.quality, true);
            if (fresh) {
              const freshFetch = await fetchPlaylist(fresh);
              const freshLines = freshFetch.data.split('\n').map((l) => l.trim());
              const freshSegUrls = [];
              for (const fl of freshLines) {
                if (fl && !fl.startsWith('#')) {
                  freshSegUrls.push(new URL(fl, freshFetch.url).href);
                }
              }
              if (freshSegUrls[i]) {
                segRes = await axios.get(freshSegUrls[i], {
                  headers,
                  timeout: 15000,
                  responseType: 'arraybuffer',
                });
              } else {
                throw segErr;
              }
            } else {
              throw segErr;
            }
          } else {
            throw segErr;
          }
        }

        const buffer = Buffer.from(segRes.data);
        totalBytes += buffer.length;

        if (totalBytes > maxSizeBytes) {
          tsWriteStream.destroy();
          await fs.promises.unlink(tempTsPath).catch(() => {});
          const sizeErr = new Error('This file exceeds the maximum allowed download size.');
          sizeErr.statusCode = 413;
          throw sizeErr;
        }

        tsWriteStream.write(buffer);
      }

      await new Promise((resolve) => tsWriteStream.end(resolve));

      let finalFilePath = tempMp4Path;
      await new Promise((resolve, reject) => {
        ffmpeg(tempTsPath)
          .outputOptions(['-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'])
          .output(tempMp4Path)
          .on('end', () => {
            fs.promises.unlink(tempTsPath).catch(() => {});
            resolve();
          })
          .on('error', (remuxErr) => {
            if (fs.existsSync(tempTsPath)) {
              finalFilePath = tempTsPath;
              fs.promises.unlink(tempMp4Path).catch(() => {});
              return resolve();
            }
            fs.promises.unlink(tempTsPath).catch(() => {});
            fs.promises.unlink(tempMp4Path).catch(() => {});
            reject(remuxErr);
          })
          .run();
      });

      const stat = await fs.promises.stat(finalFilePath);
      return {
        _tempFilePath: finalFilePath,
        filename: `${options.meta?.title || 'xhamster_video'}.${finalFilePath.endsWith('.ts') ? 'ts' : 'mp4'}`,
        mimeType: finalFilePath.endsWith('.ts') ? 'video/mp2t' : 'video/mp4',
        sizeBytes: stat.size,
      };
    } catch (err) {
      tsWriteStream.destroy();
      await fs.promises.unlink(tempTsPath).catch(() => {});
      await fs.promises.unlink(tempMp4Path).catch(() => {});
      throw err;
    }
  }

  /**
   * Downloads an xHamster video stream (progressive MP4 or HLS).
   */
  async download(url, options = {}) {
    const targetUrl = options.sourceUrl || url;
    const isHls = Boolean(options.meta?.isHls || targetUrl.toLowerCase().includes('.m3u8'));
    const quality = options.meta?.quality || options.formatId || 'Original';

    const { origin: sourceOrigin, path: sourcePath } = sanitizeUrlForLogging(targetUrl);

    // Required log format without sensitive query params or cookies
    console.log(`[xHamster Download Selection]
quality: ${quality}
sourceType: ${isHls ? 'HLS' : 'PROGRESSIVE'}
sourceOrigin: ${sourceOrigin}
sourcePath: ${sourcePath}`);

    // If HLS, use xHamster-specific HLS flow
    if (isHls) {
      return this.downloadHlsToFile(targetUrl, options);
    }

    // Direct progressive MP4 download
    const pageUrl = options.meta?.pageUrl;
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: options.meta?.headers?.Referer || pageUrl || 'https://xhamster.com/',
      ...(options.meta?.headers || {}),
    };

    try {
      return await downloadStream(targetUrl, {
        ...options,
        direct: true,
        proxy: false,
        platform: 'xhamster',
        meta: {
          ...options.meta,
          headers,
        },
      });
    } catch (err) {
      // If 403 or 410 and pageUrl is available, attempt a fresh media URL refresh
      if ((err.response?.status === 403 || err.response?.status === 410) && pageUrl) {
        const freshUrl = await this.refreshMediaUrl(pageUrl, options.meta?.quality, false);
        if (freshUrl && freshUrl !== targetUrl) {
          const freshLog = sanitizeUrlForLogging(freshUrl);
          console.log(`[xHamster Download Selection]
quality: ${quality}
sourceType: PROGRESSIVE
sourceOrigin: ${freshLog.origin}
sourcePath: ${freshLog.path}`);

          return downloadStream(freshUrl, {
            ...options,
            direct: true,
            proxy: false,
            platform: 'xhamster',
            sourceUrl: freshUrl,
            meta: {
              ...options.meta,
              headers,
            },
          });
        }
      }

      // Preserve real HTTP errors without conversion
      throw err;
    }
  }
}
