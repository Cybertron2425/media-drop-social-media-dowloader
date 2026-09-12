import axios from 'axios';
import * as cheerio from 'cheerio';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream } from '../utils/streamDownloader.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.tiktok.com/',
};

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'TikTok Video';
  return (
    raw
      .replace(/\| TikTok.*$/i, '')
      .replace(/- TikTok.*$/i, '')
      .replace(/Watch .* on TikTok.*$/i, '')
      .trim() || 'TikTok Video'
  );
}

export class TikTokAdapter extends BaseAdapter {
  static platformId = 'tiktok';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      return (
        host === 'tiktok.com' ||
        host.endsWith('.tiktok.com') ||
        host === 'vm.tiktok.com' ||
        host === 'vt.tiktok.com'
      );
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    let targetUrl = url;
    let initialRes = null;

    // Follow redirects for short links (e.g. vm.tiktok.com, vt.tiktok.com, /t/...)
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

    try {
      const res = await axios.get(targetUrl, {
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
      initialRes = res;
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new Error('This TikTok video is no longer available or could not be found.');
      }
      throw err;
    }

    if (!initialRes || initialRes.status === 404) {
      throw new Error('This TikTok video is no longer available or could not be found.');
    }

    // Check for regional blocking (e.g. /in/about or geo-restriction notice)
    if (targetUrl.includes('/in/about')) {
      throw new PlatformLimitationError(
        'TikTok is currently not accessible or is restricted in this server region.'
      );
    }

    // Check for login / authentication required
    if (targetUrl.includes('/login') || targetUrl.includes('/checkpoint')) {
      throw new PlatformLimitationError(
        'TikTok content requires authentication or is private.'
      );
    }

    const html = typeof initialRes.data === 'string' ? initialRes.data : '';

    if (
      html.includes('Government of India') ||
      html.includes('interim order under section 69A') ||
      html.includes('blocked 59 apps')
    ) {
      throw new PlatformLimitationError(
        'TikTok is currently not accessible or is restricted in this server region.'
      );
    }

    if (html.includes('login-container') || html.includes('Log in to TikTok')) {
      if (!html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') && !html.includes('SIGI_STATE')) {
        throw new PlatformLimitationError(
          'TikTok content requires authentication or is private.'
        );
      }
    }

    const $ = cheerio.load(html);

    let title = null;
    let author = null;
    let duration = null;
    let thumbnail = null;
    let mediaUrl = null;
    let width = null;
    let height = null;

    // 1. Check __UNIVERSAL_DATA_FOR_REHYDRATION__
    try {
      const universalScript = $('#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();
      if (universalScript) {
        const universalData = JSON.parse(universalScript);
        const defaultScope = universalData?.['__DEFAULT_SCOPE__'];
        const videoDetail = defaultScope?.['webapp.video-detail'];
        const statusCode = videoDetail?.statusCode;

        if (statusCode === 10204 || statusCode === 10205) {
          throw new Error('This TikTok video is no longer available or could not be found.');
        }
        if (statusCode === 10216) {
          throw new PlatformLimitationError('TikTok content requires authentication or is private.');
        }

        const itemStruct = videoDetail?.itemInfo?.itemStruct;
        if (itemStruct) {
          title = itemStruct.desc || null;
          author = itemStruct.author?.nickname || itemStruct.author?.uniqueId || null;
          if (itemStruct.video) {
            duration = itemStruct.video.duration ? Math.round(Number(itemStruct.video.duration)) : null;
            thumbnail = itemStruct.video.cover || itemStruct.video.dynamicCover || null;
            mediaUrl = itemStruct.video.playAddr || itemStruct.video.downloadAddr || null;
            width = itemStruct.video.width || null;
            height = itemStruct.video.height || null;
          }
        }
      }
    } catch (err) {
      if (err instanceof PlatformLimitationError || err.message?.includes('longer available')) {
        throw err;
      }
    }

    // 2. Check SIGI_STATE
    if (!mediaUrl) {
      try {
        const sigiScript = $('#SIGI_STATE').html();
        if (sigiScript) {
          const sigiData = JSON.parse(sigiScript);
          const itemModule = sigiData?.ItemModule;
          if (itemModule) {
            const firstKey = Object.keys(itemModule)[0];
            const item = firstKey ? itemModule[firstKey] : null;
            if (item) {
              if (!title) title = item.desc || null;
              if (!author) author = item.author || null;
              if (item.video) {
                if (!duration) duration = item.video.duration ? Math.round(Number(item.video.duration)) : null;
                if (!thumbnail) thumbnail = item.video.cover || item.video.dynamicCover || null;
                mediaUrl = item.video.playAddr || item.video.downloadAddr || null;
                if (!width) width = item.video.width || null;
                if (!height) height = item.video.height || null;
              }
            }
          }
        }
      } catch {}
    }

    // 3. Check JSON-LD (application/ld+json)
    if (!mediaUrl) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const content = $(el).html();
          if (content) {
            const parsed = JSON.parse(content);
            const schema = parsed['@graph'] ? parsed['@graph'].find((item) => item['@type'] === 'VideoObject') : parsed;
            if (schema && schema['@type'] === 'VideoObject') {
              if (!title) title = schema.name || schema.description || null;
              if (!thumbnail) {
                thumbnail = Array.isArray(schema.thumbnailUrl) ? schema.thumbnailUrl[0] : schema.thumbnailUrl || null;
              }
              if (!author && schema.creator) {
                author = typeof schema.creator === 'string' ? schema.creator : schema.creator.name || null;
              }
              if (schema.contentUrl && schema.contentUrl.startsWith('http')) {
                mediaUrl = schema.contentUrl;
              }
            }
          }
        } catch {}
      });
    }

    // 4. Check OpenGraph / Twitter meta tags
    if (!mediaUrl) {
      const ogVideo =
        $('meta[property="og:video"]').attr('content') ||
        $('meta[property="og:video:secure_url"]').attr('content') ||
        $('meta[name="twitter:player:stream"]').attr('content');

      if (ogVideo && ogVideo.startsWith('http')) {
        mediaUrl = ogVideo;
      }
    }

    // Extract title fallback
    if (!title) {
      const ogTitle =
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        $('title').text()?.trim();
      if (ogTitle) {
        title = cleanTitle(ogTitle);
      }
    }
    title = title || 'TikTok Video';

    // Extract thumbnail fallback
    if (!thumbnail) {
      thumbnail =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        null;
    }

    if (!mediaUrl) {
      // If the page indicates video unavailable
      if (
        html.includes('Video currently unavailable') ||
        html.includes("Couldn't find this video") ||
        html.includes('video-unavailable')
      ) {
        throw new Error('This TikTok video is no longer available or could not be found.');
      }
      throw new Error('Public TikTok media could not be accessed.');
    }

    const setCookies = initialRes.headers?.['set-cookie'] || [];
    const cookieHeader = Array.isArray(setCookies)
      ? setCookies.map((c) => c.split(';')[0]).join('; ')
      : (typeof setCookies === 'string' ? setCookies.split(';')[0] : '');

    const quality = height ? `${height}p` : 'HD (720p)';
    const formats = [
      {
        id: 'video-0',
        quality,
        resolution: width && height ? `${width}x${height}` : null,
        format: 'mp4',
        sizeBytes: null,
        mimeType: 'video/mp4',
        sourceUrl: mediaUrl,
        meta: {
          headers: {
            'Referer': 'https://www.tiktok.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
            'Range': 'bytes=0-',
            ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
          },
          title: title || 'TikTok Video',
          format: 'mp4',
        },
      },
    ];

    return {
      platform: 'tiktok',
      title,
      author: author || null,
      duration: duration || null,
      thumbnail,
      type: 'video',
      formats,
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    const customHeaders = options.meta?.headers || {};
    const headers = {
      'Referer': 'https://www.tiktok.com/',
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Range': 'bytes=0-',
      ...customHeaders,
    };

    if (!headers['Cookie']) {
      try {
        const freshRes = await axios.get('https://www.tiktok.com/', {
          headers: BROWSER_HEADERS,
          timeout: 5000,
          validateStatus: () => true,
        });
        const freshCookies = freshRes.headers?.['set-cookie'] || [];
        if (Array.isArray(freshCookies) && freshCookies.length > 0) {
          headers['Cookie'] = freshCookies.map((c) => c.split(';')[0]).join('; ');
        }
      } catch {}
    }

    const result = await downloadStream(sourceUrl, {
      ...options,
      meta: {
        ...options.meta,
        headers,
      },
    });

    let filename = 'tiktok_video.mp4';
    if (options.meta?.title) {
      const base = options.meta.title
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 50)
        .replace(/^_+|_+$/g, '');
      if (base) filename = `${base}.mp4`;
    } else if (result.filename && typeof result.filename === 'string') {
      const sanitized = result.filename.replace(/[/\\?%*:|"<>]/g, '_').trim();
      const base = sanitized.replace(/\.(mp4|bin|download)$/i, '').replace(/^[._]+/, '');
      filename = `${base || 'tiktok_video'}.mp4`;
    }

    return {
      ...result,
      filename,
    };
  }
}
