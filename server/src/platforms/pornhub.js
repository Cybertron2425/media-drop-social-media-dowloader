import { assertSafeUrl } from '../utils/urlSafety.js';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream } from '../utils/streamDownloader.js';

const MAX_FILE_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'pornhub_video';
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extracts the Pornhub viewkey from supported URL variations:
 * - https://www.pornhub.com/view_video.php?viewkey=KEY
 * - https://pornhub.com/view_video.php?viewkey=KEY
 * - https://www.pornhub.org/view_video.php?viewkey=KEY
 * - https://m.pornhub.com/view_video.php?viewkey=KEY
 * - https://rt.pornhub.com/view_video.php?viewkey=KEY
 * - https://www.pornhub.com/embed/KEY
 */
export function extractPornhubViewKey(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // 1. Check for viewkey query parameter
  const vkMatch = /[?&]viewkey=([a-zA-Z0-9_-]{5,35})/i.exec(trimmed);
  if (vkMatch) {
    return vkMatch[1];
  }

  // 2. Check for /embed/KEY pattern
  const embedMatch = /\/embed\/([a-zA-Z0-9_-]{5,35})/i.exec(trimmed);
  if (embedMatch) {
    return embedMatch[1];
  }

  return null;
}

export class PornhubAdapter extends BaseAdapter {
  static platformId = 'pornhub';
  static status = 'SUPPORTED';

  canHandle(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const trimmed = url.trim();
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

      return (
        host === 'pornhub.com' ||
        host === 'pornhub.org' ||
        host.endsWith('.pornhub.com') ||
        host.endsWith('.pornhub.org')
      );
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    const viewkey = extractPornhubViewKey(url);
    if (!viewkey) {
      throw new PlatformLimitationError('Please provide a valid Pornhub video URL.');
    }

    const canonicalUrl = `https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(viewkey)}`;

    let res;
    try {
      res = await fetch(canonicalUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cookie': 'accessAgeDisclaimerPH=1; hasVisited=1; platform=pc',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlatformLimitationError('Unable to connect to Pornhub. Please verify the URL and your connection.');
    }

    if (res.status === 404 || res.status === 410) {
      throw new PlatformLimitationError('This Pornhub video is unavailable or has been removed.');
    }

    if (res.status === 403 || res.status === 451) {
      throw new PlatformLimitationError('Pornhub requires verification or authentication for this content.');
    }

    if (!res.ok) {
      throw new PlatformLimitationError(`Pornhub responded with status ${res.status}.`);
    }

    const html = await res.text();

    // Check for common availability / restriction banners
    if (
      html.includes('Video has been flagged for review') ||
      html.includes('video has been disabled') ||
      html.includes('This video has been removed') ||
      html.includes('video is unavailable') ||
      html.includes('id="videoUnavailableForm"')
    ) {
      throw new PlatformLimitationError('This Pornhub video is unavailable or has been removed.');
    }

    if (
      html.includes('class="geoBlocked"') ||
      html.includes('id="geoBlocked"') ||
      html.includes('is not available in your country') ||
      html.includes('class="premiumOnly"') ||
      html.includes('id="lockedVideo"')
    ) {
      throw new PlatformLimitationError(
        'This Pornhub video requires authentication or is restricted in this region and cannot be downloaded publicly.'
      );
    }

    // Extract flashvars player configuration JSON block
    const flashvarsMatch = html.match(/flashvars_\d+\s*=\s*(\{[\s\S]*?\});\s*(?:var|\n|<)/);
    if (!flashvarsMatch) {
      throw new PlatformLimitationError('No publicly accessible media source was found for this Pornhub video.');
    }

    let flashvars;
    try {
      flashvars = JSON.parse(flashvarsMatch[1]);
    } catch (err) {
      throw new PlatformLimitationError('Failed to parse Pornhub media player configuration.');
    }

    const isFlagTrue = (val) => {
      if (val === true || val === 1) return true;
      if (typeof val === 'string') {
        const s = val.toLowerCase().trim();
        return s === 'true' || s === '1';
      }
      return false;
    };

    if (isFlagTrue(flashvars.video_unavailable) || isFlagTrue(flashvars.is_premium) || isFlagTrue(flashvars.video_unavailable_country)) {
      throw new PlatformLimitationError('This Pornhub video is not publicly downloadable.');
    }

    const rawTitle = flashvars.video_title || html.match(/<title>([^<]+)<\/title>/i)?.[1] || 'Pornhub Video';
    const title = decodeHtmlEntities(rawTitle.replace(/\s*-\s*Pornhub(?:\.com)?$/i, '').trim());
    const duration = typeof flashvars.video_duration === 'number' ? flashvars.video_duration : parseInt(flashvars.video_duration, 10) || 0;
    const thumbnail = flashvars.image_url || html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] || null;

    // Extract author / uploader name
    let author = flashvars.uploader || '';
    if (!author) {
      const uploaderMatch = html.match(/<a[^>]+class="[^"]*bolded[^"]*"[^>]*>([^<]+)<\/a>/i);
      if (uploaderMatch) {
        author = uploaderMatch[1].trim();
      }
    }

    // Retrieve progressive MP4 media definitions
    const mediaDefinitions = flashvars.mediaDefinitions || [];
    let progressiveFormats = [];

    // Check for get_media endpoint (which returns direct progressive MP4 streams)
    const getMediaDef = mediaDefinitions.find((m) => m.format === 'mp4' && typeof m.videoUrl === 'string' && m.videoUrl.includes('get_media'));

    if (getMediaDef) {
      try {
        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') : '';
        const cookieHeader = ['accessAgeDisclaimerPH=1', 'hasVisited=1', 'platform=pc', setCookies].filter(Boolean).join('; ');

        const gmRes = await fetch(getMediaDef.videoUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': res.url || canonicalUrl,
            'Cookie': cookieHeader,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (gmRes.ok) {
          const gmData = await gmRes.json();
          if (Array.isArray(gmData)) {
            progressiveFormats = gmData.filter((item) => item.format === 'mp4' && item.videoUrl);
          }
        }
      } catch {
        // Fall back to direct mediaDefinitions
      }
    }

    // If get_media did not yield formats, inspect mediaDefinitions directly for direct MP4 entries
    if (progressiveFormats.length === 0) {
      progressiveFormats = mediaDefinitions.filter(
        (m) => m.format === 'mp4' && typeof m.videoUrl === 'string' && !m.videoUrl.includes('get_media')
      );
    }

    if (progressiveFormats.length === 0) {
      throw new PlatformLimitationError('No publicly accessible media source was found for this Pornhub video.');
    }

    // Group and sort formats by resolution descending (1080p > 720p > 480p > 240p)
    const qualityMap = new Map();
    for (const fmt of progressiveFormats) {
      const height = fmt.height || parseInt(fmt.quality, 10) || 480;
      const width = fmt.width || Math.round((height * 16) / 9);
      const qualityStr = `${height}p`;

      if (!qualityMap.has(qualityStr)) {
        qualityMap.set(qualityStr, {
          height,
          width,
          quality: qualityStr,
          videoUrl: fmt.videoUrl,
        });
      }
    }

    const sortedFormats = Array.from(qualityMap.values()).sort((a, b) => b.height - a.height);

    const formats = sortedFormats.map((f, idx) => ({
      id: `ph_${f.quality}`,
      quality: f.quality,
      resolution: `${f.width}x${f.height}`,
      format: 'mp4',
      sizeBytes: null,
      hasAudio: true,
      sourceUrl: canonicalUrl,
      meta: {
        viewkey,
        quality: f.quality,
        title,
        videoUrl: f.videoUrl,
        width: f.width,
        height: f.height,
        isBest: idx === 0,
      },
    }));

    const bestFormat = formats[0];

    return {
      platform: 'pornhub',
      type: 'video',
      title,
      author,
      duration,
      thumbnail,
      width: bestFormat.meta.width,
      height: bestFormat.meta.height,
      resolution: bestFormat.resolution,
      quality: bestFormat.quality,
      formats,
    };
  }

  async download(url, options = {}) {
    await assertSafeUrl(url);

    let videoUrl = options.meta?.videoUrl;
    let title = options.meta?.title;
    let quality = options.meta?.quality || 'video';

    // If options did not contain a pre-resolved video URL, re-analyze to get fresh media definitions
    if (!videoUrl) {
      const info = await this.analyze(url);
      const target = info.formats.find((f) => f.id === options.formatId) || info.formats[0];
      if (!target?.meta?.videoUrl) {
        throw new PlatformLimitationError('The requested Pornhub video stream is no longer available.');
      }
      videoUrl = target.meta.videoUrl;
      title = info.title;
      quality = target.quality;
    }

    await assertSafeUrl(videoUrl);

    const safeTitle = sanitizeFilename(title || 'Pornhub_Video');
    const filename = `${safeTitle}_${sanitizeFilename(quality)}.mp4`;

    const result = await downloadStream(videoUrl, {
      ...options,
      sourceUrl: videoUrl,
      meta: {
        ...options.meta,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': 'https://www.pornhub.org/',
          ...(options.meta?.headers || {}),
        },
      },
    });

    return {
      stream: result.stream,
      filename,
      mimeType: 'video/mp4',
      sizeBytes: result.sizeBytes,
    };
  }
}
