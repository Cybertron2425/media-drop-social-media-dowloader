import axios from 'axios';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream } from '../utils/streamDownloader.js';

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
      response = await axios.get(pageUrl, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
        maxRedirects: 5,
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
    let rawDefinitions = Array.isArray(flashvars?.mediaDefinitions) ? flashvars.mediaDefinitions : [];

    // Check if remote get_media endpoint is provided for progressive MP4s
    const remoteDef = rawDefinitions.find(
      (d) => d.videoUrl && typeof d.videoUrl === 'string' && d.videoUrl.includes('/video/get_media')
    );

    if (remoteDef) {
      try {
        const getMediaRes = await axios.get(remoteDef.videoUrl, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: pageUrl,
            Origin: `https://www.${parsedHost}`,
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          timeout: 10000,
          validateStatus: () => true,
        });

        if (getMediaRes.status === 200 && Array.isArray(getMediaRes.data) && getMediaRes.data.length > 0) {
          // Replace or augment with resolved media streams
          rawDefinitions = getMediaRes.data;
        }
      } catch {}
    }

    const formats = [];
    let formatIdx = 0;
    const seenUrls = new Set();

    for (const def of rawDefinitions) {
      if (!def || typeof def !== 'object') continue;
      const vUrl = def.videoUrl;
      if (!vUrl || typeof vUrl !== 'string' || !/^https?:\/\//i.test(vUrl)) continue;
      if (seenUrls.has(vUrl)) continue;
      seenUrls.add(vUrl);

      const height = Number(def.height || def.quality) || 0;
      const quality = height > 0 ? `${height}p` : (def.quality ? `${def.quality}p` : 'Standard');
      const resolution = height > 0 ? `${height}p` : null;
      const format = (def.format || 'mp4').toLowerCase() === 'hls' ? 'mp4' : 'mp4';
      const isM3u8 = vUrl.includes('.m3u8') || def.format === 'hls';

      // Check if separate audio stream is specified
      const audioUrl = def.audioUrl && /^https?:\/\//i.test(def.audioUrl) ? def.audioUrl : null;
      const needsMerge = Boolean(audioUrl);

      formats.push({
        id: `ph-${formatIdx++}`,
        quality,
        resolution,
        format,
        sizeBytes: Number(def.sizeBytes) || null,
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
          resolution,
          format,
          videoUrl: vUrl,
          audioUrl,
          needsMerge,
          isHls: isM3u8,
          pageUrl,
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: pageUrl,
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

    // Sort highest quality / resolution first
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
    const sourceUrl = options.sourceUrl || url;

    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
      throw new PlatformLimitationError('The Pornhub media URL is invalid.');
    }

    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: '*/*',
      ...(options.meta?.headers || {}),
      ...(options.headers || {}),
    };

    try {
      const result = await downloadStream(sourceUrl, {
        ...options,
        sourceUrl,
        meta: {
          ...(options.meta || {}),
          headers,
        },
      });

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

      return {
        ...result,
        filename,
      };
    } catch (err) {
      const status = err.response?.status;
      if (status === 403) {
        throw new PlatformLimitationError(
          'Access to this media stream was denied by Pornhub (HTTP 403). The link may have expired.'
        );
      }
      if (status === 404 || status === 410) {
        throw new PlatformLimitationError(
          'The media stream is no longer available on Pornhub.'
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
