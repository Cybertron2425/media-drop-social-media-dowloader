import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

// Explicitly blocked platforms per requirements
const BLOCKED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'pornhub.com',
  'pornhub.org',
  'xhamster.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'reddit.com',
  'vimeo.com',
  'pinterest.com',
  'terabox.com',
  'teraboxapp.com',
];

const IG_FB_HOSTS = ['instagram.com', 'instagr.am', 'facebook.com', 'fb.watch', 'fb.com'];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DIRECT_VIDEO_EXTS = ['.mp4', '.webm', '.m4v', '.mov'];

function extractResolution(text, height = null) {
  if (height) {
    const h = parseInt(height, 10);
    if (h >= 2160) return { quality: '4K (2160p)', resolution: '2160p', height: 2160 };
    if (h >= 1440) return { quality: '1440p (QHD)', resolution: '1440p', height: 1440 };
    if (h >= 1080) return { quality: '1080p (FHD)', resolution: '1080p', height: 1080 };
    if (h >= 720) return { quality: '720p (HD)', resolution: '720p', height: 720 };
    if (h >= 480) return { quality: '480p (SD)', resolution: '480p', height: 480 };
    if (h >= 360) return { quality: '360p (SD)', resolution: '360p', height: 360 };
    if (h >= 240) return { quality: '240p', resolution: '240p', height: 240 };
    if (h > 0) return { quality: `${h}p`, resolution: `${h}p`, height: h };
  }

  if (!text || typeof text !== 'string') return null;

  // Extract clean filename if text is a URL to prevent matching random hash keys
  let target = text;
  try {
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const u = new URL(text);
      target = decodeURIComponent(u.pathname.split('/').pop() || '');
    }
  } catch {}

  // Normalize delimiters (replace underscores, hyphens, and dots with spaces)
  // so that identifiers like "BigBuckBunny_720p.mp4" are properly matched by word boundaries,
  // while continuous hash strings like "KIhdDN" will not trigger false positive boundary matches.
  const str = target.toLowerCase().replace(/[-_.]/g, ' ');

  if (/\b(?:2160p|2160|3840x2160|4k)\b/i.test(str)) {
    return { quality: '4K (2160p)', resolution: '2160p', height: 2160 };
  }
  if (/\b(?:1440p|1440|2560x1440|2k|qhd)\b/i.test(str)) {
    return { quality: '1440p (QHD)', resolution: '1440p', height: 1440 };
  }
  if (/\b(?:1080p|1080|1920x1080|fhd)\b/i.test(str)) {
    return { quality: '1080p (FHD)', resolution: '1080p', height: 1080 };
  }
  if (/\b(?:720p|720|1280x720|hd)\b/i.test(str)) {
    return { quality: '720p (HD)', resolution: '720p', height: 720 };
  }
  if (/\b(?:480p|480|854x480|sd)\b/i.test(str)) {
    return { quality: '480p (SD)', resolution: '480p', height: 480 };
  }
  if (/\b(?:360p|360|640x360)\b/i.test(str)) {
    return { quality: '360p (SD)', resolution: '360p', height: 360 };
  }
  if (/\b(?:240p|240|426x240)\b/i.test(str)) {
    return { quality: '240p', resolution: '240p', height: 240 };
  }
  return null;
}

export class PublicMediaAdapter extends BaseAdapter {
  static platformId = 'public-media';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;

      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

      // Skip Instagram and Facebook (handled by their dedicated adapters)
      if (IG_FB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        return false;
      }

      // Strictly skip blocked platforms
      if (BLOCKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    const parsed = new URL(url);
    const pathnameLower = parsed.pathname.toLowerCase();
    const isDirectVideo = DIRECT_VIDEO_EXTS.some((ext) => pathnameLower.endsWith(ext));

    // Case 1: Direct link to a media file
    if (isDirectVideo) {
      const filename = decodeURIComponent(parsed.pathname.split('/').pop() || 'video.mp4');
      const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
      const resInfo = extractResolution(filename);

      return {
        platform: 'public-media',
        title: filename.replace(/\.[^.]+$/, ''),
        thumbnail: null,
        type: 'video',
        formats: [
          {
            id: 'original',
            quality: resInfo?.quality || 'Original',
            resolution: resInfo?.resolution || null,
            height: resInfo?.height || 0,
            format: ext,
            sizeBytes: null,
            mimeType: ext === 'webm' ? 'video/webm' : 'video/mp4',
            sourceUrl: url,
            hasAudio: true,
            meta: {
              pageUrl: url,
              headers: {
                'Referer': url,
                'Origin': parsed.origin,
              },
            },
          },
        ],
      };
    }

    // Case 2: Public webpage containing media sources
    let html;
    try {
      const res = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: 12000,
        maxContentLength: 8 * 1024 * 1024,
        maxRedirects: 3,
        responseType: 'text',
      });
      html = res.data;
    } catch (err) {
      console.warn(`[PublicMediaAdapter] Page fetch failed for ${url}:`, err.message);
      throw new PlatformLimitationError('This video cannot be downloaded from this source.');
    }

    if (typeof html !== 'string' || html.length === 0) {
      throw new PlatformLimitationError('This video cannot be downloaded from this source.');
    }

    const $ = cheerio.load(html);

    // Metadata extraction
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text().trim() ||
      'Public Video';

    const thumbnail =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('video').attr('poster') ||
      null;

    const rawCandidates = [];

    // 1. Scan <video> and <source> tags
    $('video').each((_, vid) => {
      const vSrc = $(vid).attr('src');
      if (vSrc) {
        rawCandidates.push({
          src: vSrc,
          type: $(vid).attr('type'),
          height: $(vid).attr('height'),
          label: $(vid).attr('title') || $(vid).attr('data-quality'),
        });
      }

      $(vid)
        .find('source')
        .each((_, srcElem) => {
          const sSrc = $(srcElem).attr('src');
          if (sSrc) {
            rawCandidates.push({
              src: sSrc,
              type: $(srcElem).attr('type'),
              height: $(srcElem).attr('height') || $(srcElem).attr('res'),
              label: $(srcElem).attr('label') || $(srcElem).attr('data-quality') || $(srcElem).attr('title'),
            });
          }
        });
    });

    // 2. OpenGraph / Twitter meta tags
    const ogVideo =
      $('meta[property="og:video:secure_url"]').attr('content') ||
      $('meta[property="og:video:url"]').attr('content') ||
      $('meta[property="og:video"]').attr('content') ||
      $('meta[name="twitter:player:stream"]').attr('content');

    if (ogVideo) {
      rawCandidates.push({
        src: ogVideo,
        type: $('meta[property="og:video:type"]').attr('content') || 'video/mp4',
        label: 'Original',
      });
    }

    // 3. JSON-LD Schema
    $('script[type="application/ld+json"]').each((_, script) => {
      try {
        const json = JSON.parse($(script).text());
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item['@type'] === 'VideoObject' || item.contentUrl) {
            if (item.contentUrl) {
              rawCandidates.push({
                src: item.contentUrl,
                type: item.encodingFormat || 'video/mp4',
                label: 'Original',
              });
            }
          }
        }
      } catch {}
    });

    // 4. Standalone direct links to video files in body
    $('a[href$=".mp4"], a[href$=".webm"]').each((_, a) => {
      const href = $(a).attr('href');
      if (href) {
        rawCandidates.push({
          src: href,
          label: $(a).text().trim(),
        });
      }
    });

    // Process, validate, and deduplicate candidates
    const validFormats = [];
    const seenUrls = new Set();

    for (const cand of rawCandidates) {
      if (!cand.src || typeof cand.src !== 'string') continue;

      let resolvedUrl;
      try {
        resolvedUrl = new URL(cand.src, url).href;
      } catch {
        continue;
      }

      if (seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);

      // Verify safe URL (SSRF defense)
      try {
        await assertSafeUrl(resolvedUrl);
      } catch {
        continue;
      }

      const lowerUrl = resolvedUrl.toLowerCase();
      // Skip live streams or manifest files requiring external remuxing
      if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.mpd')) {
        continue;
      }

      const ext = lowerUrl.includes('.webm') ? 'webm' : 'mp4';
      const cleanFilename = decodeURIComponent(new URL(resolvedUrl).pathname.split('/').pop() || '');
      const resInfo =
        extractResolution(cand.label, cand.height) ||
        extractResolution(cleanFilename, cand.height) ||
        extractResolution(resolvedUrl, cand.height);

      validFormats.push({
        id: `fmt-${validFormats.length}`,
        quality: resInfo?.quality || 'Original',
        resolution: resInfo?.resolution || null,
        height: resInfo?.height || 0,
        format: ext,
        sizeBytes: null,
        mimeType: ext === 'webm' ? 'video/webm' : 'video/mp4',
        sourceUrl: resolvedUrl,
        hasAudio: true,
        meta: {
          pageUrl: url,
          headers: {
            'Referer': url,
            'Origin': parsed.origin,
          },
        },
      });
    }

    if (validFormats.length === 0) {
      throw new PlatformLimitationError('This video cannot be downloaded from this source.');
    }

    // Sort formats from highest resolution to lowest resolution
    validFormats.sort((a, b) => b.height - a.height);

    return {
      platform: 'public-media',
      title,
      thumbnail,
      type: 'video',
      formats: validFormats,
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    const pageUrl = options.meta?.pageUrl;
    const referer = options.meta?.headers?.Referer || pageUrl || url;
    const origin = options.meta?.headers?.Origin || (pageUrl ? new URL(pageUrl).origin : undefined);

    const headers = {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Referer': referer,
      ...(origin ? { 'Origin': origin } : {}),
      ...(options.meta?.headers || {}),
    };

    return downloadStream(sourceUrl, {
      ...options,
      meta: {
        ...options.meta,
        headers,
      },
    });
  }
}
