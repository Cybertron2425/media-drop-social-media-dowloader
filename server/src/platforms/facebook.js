import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

const FB_HOSTS = ['facebook.com', 'fb.watch', 'm.facebook.com', 'web.facebook.com'];

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

export class FacebookAdapter extends BaseAdapter {
  static platformId = 'facebook';
  static status = 'SUPPORTED_WITH_LIMITATIONS';

  canHandle(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return FB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    let targetUrl = url;

    // Follow redirects for shortlinks (e.g. fb.watch) using browser navigation headers
    try {
      const headRes = await axios.head(url, {
        maxRedirects: 5,
        timeout: 8000,
        headers: BROWSER_HEADERS,
      });
      const resolved = headRes.request?.res?.responseUrl;
      if (resolved) {
        await assertSafeUrl(resolved);
        targetUrl = resolved;
      }
    } catch {
      // Continue with targetUrl if HEAD fails
    }

    // Reject Facebook Stories
    if (/(?:stories)\//i.test(targetUrl) || /(?:stories)\//i.test(url)) {
      throw new PlatformLimitationError('Facebook Stories are currently not supported.');
    }

    // Extraction strategy: evaluate legitimate public surfaces in order
    const surfaces = [
      { name: 'direct', url: targetUrl },
      { name: 'mobile', url: targetUrl.replace('://www.facebook.com', '://m.facebook.com') },
      { name: 'plugin', url: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(targetUrl)}` },
    ];

    let extractedData = null;
    let isExplicitlyPrivate = false;
    let loginChallengeEncountered = false;
    let notFoundEncountered = false;

    for (const surface of surfaces) {
      try {
        const res = await axios.get(surface.url, {
          timeout: 10000,
          maxRedirects: 5,
          headers: BROWSER_HEADERS,
          validateStatus: () => true,
        });

        const finalUrl = res.request?.res?.responseUrl || surface.url;
        const html = typeof res.data === 'string' ? res.data : '';

        if (res.status === 404 || html.includes("This content isn't available right now") || html.includes('Page Not Found')) {
          notFoundEncountered = true;
          continue;
        }

        // Check if redirected to login / checkpoint
        if (finalUrl.includes('/login') || finalUrl.includes('/checkpoint')) {
          loginChallengeEncountered = true;
          continue;
        }

        // Check for explicit private group or profile indications
        if (html.includes('"is_private":true') || html.includes('This group is private') || html.includes('Only members can see')) {
          isExplicitlyPrivate = true;
        }

        const $ = cheerio.load(html);

        const title =
          $('meta[property="og:title"]').attr('content') ||
          $('title').text()?.trim() ||
          'Facebook Video';

        const thumbnail =
          $('meta[property="og:image"]').attr('content') ||
          $('meta[property="og:image:url"]').attr('content') ||
          null;

        // Multi-level unescaping of slashes and unicode
        const cleaned = html
          .replace(/\\+(\/)/g, '/')
          .replace(/\\+u0026/g, '&')
          .replace(/\\+u003C/g, '<')
          .replace(/\\+u003E/g, '>')
          .replace(/\\+u0022/g, '"')
          .replace(/\\+"/g, '"');

        let hdUrl = null;
        let sdUrl = null;

        // Look for HD video URL
        const hdMatch =
          cleaned.match(/"browser_native_hd_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"playable_url_quality_hd"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"hd_src"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"hd_src_no_ratelimit"\s*:\s*"(https?:\/\/[^"]+)"/);
        if (hdMatch) hdUrl = hdMatch[1];

        // Look for SD video URL
        const sdMatch =
          cleaned.match(/"browser_native_sd_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"playable_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"sd_src"\s*:\s*"(https?:\/\/[^"]+)"/) ||
          cleaned.match(/"sd_src_no_ratelimit"\s*:\s*"(https?:\/\/[^"]+)"/);
        if (sdMatch) sdUrl = sdMatch[1];

        // OpenGraph fallback
        if (!hdUrl && !sdUrl) {
          const ogVideo =
            $('meta[property="og:video:secure_url"]').attr('content') ||
            $('meta[property="og:video:url"]').attr('content') ||
            $('meta[property="og:video"]').attr('content');
          if (ogVideo && ogVideo.startsWith('http')) {
            sdUrl = ogVideo;
          }
        }

        // JSON-LD fallback
        if (!hdUrl && !sdUrl) {
          try {
            const ldContent = $('script[type="application/ld+json"]').html();
            if (ldContent) {
              const ld = JSON.parse(ldContent);
              const contentUrl = ld.contentUrl || ld.video?.contentUrl;
              if (contentUrl && contentUrl.startsWith('http')) {
                sdUrl = contentUrl;
              }
            }
          } catch {}
        }

        // Generic fbcdn mp4 fallback
        if (!hdUrl && !sdUrl) {
          const mp4Matches = cleaned.match(/https?:\/\/[^"'\s\\]*fbcdn\.net[^"'\s\\]*\.mp4[^"'\s\\]*/g);
          if (mp4Matches && mp4Matches.length > 0) {
            sdUrl = mp4Matches[0];
          }
        }

        if (hdUrl || sdUrl) {
          extractedData = {
            title,
            thumbnail,
            hdUrl,
            sdUrl,
            surface: surface.name,
          };
          break;
        }

        if (thumbnail && (/(?:photo|photos)/i.test(targetUrl) || /(?:photo|photos)/i.test(url))) {
          extractedData = {
            title: title || 'Facebook Photo',
            thumbnail,
            imageUrl: thumbnail,
            surface: surface.name,
          };
          break;
        }
      } catch {
        // Try next surface
      }
    }

    if (!extractedData) {
      if (isExplicitlyPrivate) {
        // CASE A: Video is genuinely from a private group or profile
        throw new PlatformLimitationError(
          'This Facebook video requires account login or is from a private group/profile.'
        );
      }

      if (notFoundEncountered) {
        throw new Error('This Facebook video is no longer available or has been removed.');
      }

      if (loginChallengeEncountered) {
        // CASE C: Public video, but Facebook blocks unauthenticated server requests
        throw new PlatformLimitationError(
          'Facebook is currently blocking unauthenticated server-side access to this public video. This downloader does not bypass Facebook authentication or security challenges.'
        );
      }

      throw new PlatformLimitationError(
        'Facebook is currently blocking unauthenticated server-side access to this public video. This downloader does not bypass Facebook authentication or security challenges.'
      );
    }

    // CASE B: Public video media extracted successfully
    const formats = [];

    if (extractedData.hdUrl) {
      formats.push({
        id: 'video-hd',
        quality: 'HD (720p)',
        format: 'mp4',
        sizeBytes: null,
        mimeType: 'video/mp4',
        sourceUrl: extractedData.hdUrl,
        meta: {
          headers: {
            'Referer': 'https://www.facebook.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
      });
    }

    if (extractedData.sdUrl && extractedData.sdUrl !== extractedData.hdUrl) {
      formats.push({
        id: 'video-sd',
        quality: 'SD (360p)',
        format: 'mp4',
        sizeBytes: null,
        mimeType: 'video/mp4',
        sourceUrl: extractedData.sdUrl,
        meta: {
          headers: {
            'Referer': 'https://www.facebook.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
      });
    }

    if (extractedData.imageUrl) {
      formats.push({
        id: 'image-0',
        quality: 'Original',
        format: 'jpg',
        sizeBytes: null,
        mimeType: 'image/jpeg',
        sourceUrl: extractedData.imageUrl,
        meta: {
          headers: {
            'Referer': 'https://www.facebook.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
      });
    }

    const mediaType = extractedData.imageUrl
      ? 'image'
      : (/(?:reel|reels)/i.test(targetUrl) || /(?:reel|reels)/i.test(url))
      ? 'reel'
      : 'video';

    return {
      platform: 'facebook',
      title: extractedData.title,
      thumbnail: extractedData.thumbnail,
      type: mediaType,
      formats,
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    return downloadStream(sourceUrl, {
      ...options,
      meta: {
        headers: {
          'Referer': 'https://www.facebook.com/',
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          ...(options.meta?.headers || {}),
        },
      },
    });
  }
}
