import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

const THREADS_HOSTS = ['threads.net', 'threads.com'];
const POST_RE = /(?:@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)|t\/([A-Za-z0-9_-]+))/i;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

function cleanTitle(raw, author) {
  if (raw && typeof raw === 'string') {
    const cleaned = raw
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (cleaned.length > 0) return cleaned.slice(0, 120);
  }
  return author ? `Threads post by @${author}` : 'Threads Media';
}

export class ThreadsAdapter extends BaseAdapter {
  static platformId = 'threads';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const isThreadsHost = THREADS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      if (!isThreadsHost) return false;
      return POST_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    let targetUrl = url;

    // Follow redirects for short links (e.g. /t/...) or share links
    try {
      const headRes = await axios.head(targetUrl, {
        maxRedirects: 5,
        timeout: 8000,
        headers: BROWSER_HEADERS,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const resolved = headRes.request?.res?.responseUrl;
      if (resolved) {
        await assertSafeUrl(resolved);
        targetUrl = resolved;
      }
    } catch {
      // Continue to GET
    }

    let res;
    try {
      res = await axios.get(targetUrl, {
        maxRedirects: 5,
        timeout: 10000,
        headers: BROWSER_HEADERS,
        validateStatus: () => true,
      });
      const finalUrl = res.request?.res?.responseUrl || targetUrl;
      if (finalUrl) {
        await assertSafeUrl(finalUrl);
        targetUrl = finalUrl;
      }
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new Error('This Threads link is currently unreachable.');
      }
      throw err;
    }

    if (!res || res.status === 404) {
      throw new Error('This Threads post is no longer available or was removed.');
    }

    const html = typeof res.data === 'string' ? res.data : '';

    if (
      html.includes('Page Not Found') ||
      html.includes("Sorry, this page isn't available") ||
      html.includes('This post is unavailable') ||
      html.includes('The link you followed may be broken')
    ) {
      throw new Error('This Threads post is no longer available or was removed.');
    }

    if (
      targetUrl.includes('/login') ||
      targetUrl.includes('/accounts/login') ||
      html.includes('"is_private":true') ||
      html.includes('This account is private') ||
      html.includes('This Account is Private')
    ) {
      throw new PlatformLimitationError(
        'This Threads post requires login or is from a private account and cannot be accessed publicly.'
      );
    }

    const $ = cheerio.load(html);

    // Extract author
    const postMatch = targetUrl.match(/@([A-Za-z0-9._]+)/);
    let author = postMatch ? postMatch[1] : null;

    // OpenGraph & Meta
    const ogTitle = $('meta[property="og:title"]').attr('content') || null;
    const ogDescription =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      null;

    if (!author && ogTitle) {
      const authMatch = ogTitle.match(/@([A-Za-z0-9._]+)/);
      if (authMatch) author = authMatch[1];
    }

    const title = cleanTitle(ogDescription || ogTitle, author);

    // Extract Video URLs
    let videoUrl =
      $('meta[property="og:video"]').attr('content') ||
      $('meta[property="og:video:url"]').attr('content') ||
      $('meta[property="og:video:secure_url"]').attr('content') ||
      $('meta[name="twitter:player:stream"]').attr('content') ||
      $('video source').attr('src') ||
      $('video').attr('src') ||
      null;

    // Extract Image / Thumbnail URLs
    let imageUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[property="og:image:url"]').attr('content') ||
      $('meta[property="og:image:secure_url"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null;

    // Check JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html();
        if (text) {
          const ld = JSON.parse(text);
          if (ld.video?.contentUrl) videoUrl = videoUrl || ld.video.contentUrl;
          if (ld.image?.contentUrl) imageUrl = imageUrl || ld.image.contentUrl;
          if (Array.isArray(ld.image) && ld.image[0]) {
            imageUrl = imageUrl || (typeof ld.image[0] === 'string' ? ld.image[0] : ld.image[0].contentUrl);
          }
        }
      } catch {}
    });

    // Check embedded script hydration data if direct metadata was not found
    if (!videoUrl) {
      const cleaned = html
        .replace(/\\+(\/)/g, '/')
        .replace(/\\+u0026/g, '&')
        .replace(/\\+u003C/g, '<')
        .replace(/\\+u003E/g, '>')
        .replace(/\\+u0022/g, '"')
        .replace(/\\+"/g, '"');

      const vMatch =
        cleaned.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
        cleaned.match(/"playable_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
        cleaned.match(/(https?:\/\/[^"'\s\\]*(?:cdninstagram\.com|fbcdn\.net)[^"'\s\\]*\.mp4[^"'\s\\]*)/i);
      if (vMatch) {
        videoUrl = vMatch[1];
      }

      if (!imageUrl) {
        const dMatch =
          cleaned.match(/"display_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/(https?:\/\/[^"'\s\\]*(?:cdninstagram\.com|fbcdn\.net)[^"'\s\\]*\.(?:jpg|jpeg|png|webp)[^"'\s\\]*)/i);
        if (dMatch) {
          imageUrl = dMatch[1];
        }
      }
    }

    const isVideo = Boolean(videoUrl);
    const primaryMediaUrl = videoUrl || imageUrl;

    if (!primaryMediaUrl) {
      throw new PlatformLimitationError('No downloadable public media was found in this Threads post.');
    }

    const type = isVideo ? 'video' : 'image';
    const thumbnail = imageUrl || (isVideo ? videoUrl : null);

    const formats = [];
    if (isVideo) {
      formats.push({
        id: 'threads-video-hd',
        quality: 'HD (MP4)',
        resolution: '1080p',
        format: 'mp4',
        mimeType: 'video/mp4',
        sourceUrl: videoUrl,
        hasAudio: true,
      });
    } else {
      let ext = 'jpg';
      try {
        const p = new URL(imageUrl).pathname;
        const matchExt = p.match(/\.(jpg|jpeg|png|webp)/i);
        if (matchExt) ext = matchExt[1].toLowerCase();
      } catch {}
      formats.push({
        id: `threads-photo-${ext}`,
        quality: 'Original',
        resolution: 'HD',
        format: ext,
        mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        sourceUrl: imageUrl,
        hasAudio: false,
      });
    }

    return {
      platform: 'threads',
      title,
      author,
      thumbnail,
      type,
      formats,
    };
  }

  async download(url, options = {}) {
    return downloadStream(url, options);
  }
}
