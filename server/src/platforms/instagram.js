import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

const IG_HOSTS = ['instagram.com', 'instagr.am'];
const SHORTCODE_RE = /(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
const HIGHLIGHT_RE = /(?:stories\/highlights\/)([0-9A-Za-z_-]+)/;
const HIGHLIGHT_SHARE_RE = /(?:s\/)([0-9A-Za-z_=-]+)/;

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

function extractJsonObject(str, startIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return str.slice(startIndex, i + 1);
        }
      }
    }
  }
  return null;
}

export class InstagramAdapter extends BaseAdapter {
  static platformId = 'instagram';
  static status = 'SUPPORTED_WITH_LIMITATIONS';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const isIgHost = IG_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      return (
        isIgHost &&
        (SHORTCODE_RE.test(parsed.pathname) ||
          HIGHLIGHT_RE.test(parsed.pathname) ||
          HIGHLIGHT_SHARE_RE.test(parsed.pathname))
      );
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    const parsed = new URL(url);
    const highlightMatch = parsed.pathname.match(HIGHLIGHT_RE);
    const shareHighlightMatch = parsed.pathname.match(HIGHLIGHT_SHARE_RE);

    if (highlightMatch && highlightMatch[1]) {
      return this.analyzeHighlight(url, parsed, highlightMatch[1]);
    }

    if (shareHighlightMatch && shareHighlightMatch[1]) {
      let highlightId = shareHighlightMatch[1];
      try {
        const decoded = Buffer.from(shareHighlightMatch[1], 'base64').toString('utf-8');
        if (decoded.startsWith('highlight:')) {
          highlightId = decoded.replace('highlight:', '');
        }
      } catch {}
      return this.analyzeHighlight(url, parsed, highlightId);
    }

    const match = parsed.pathname.match(SHORTCODE_RE);
    if (!match || !match[1]) {
      throw new Error('Please enter a valid Instagram post, reel, or highlight URL.');
    }

    const shortcode = match[1];

    // Extraction strategy: test legitimate unauthenticated public surfaces in priority order
    const surfaces = [
      { name: 'embed_captioned_p', url: `https://www.instagram.com/p/${shortcode}/embed/captioned/` },
      { name: 'embed_captioned_reel', url: `https://www.instagram.com/reel/${shortcode}/embed/captioned/` },
      { name: 'embed_p', url: `https://www.instagram.com/p/${shortcode}/embed/` },
      { name: 'embed_reel', url: `https://www.instagram.com/reel/${shortcode}/embed/` },
      { name: 'direct_reel', url: `https://www.instagram.com/reel/${shortcode}/` },
      { name: 'direct_p', url: `https://www.instagram.com/p/${shortcode}/` },
    ];

    let extractedMedia = null;
    let isPrivate = false;
    let loginChallengeEncountered = false;
    let notFoundEncountered = false;

    for (const surface of surfaces) {
      try {
        const res = await axios.get(surface.url, {
          timeout: 10000,
          headers: BROWSER_HEADERS,
          maxRedirects: 5,
          validateStatus: () => true,
        });

        const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
        const html = typeof res.data === 'string' ? res.data : '';

        if (res.status === 404 || html.includes('This photo or video has been removed') || html.includes('Page Not Found')) {
          notFoundEncountered = true;
          continue;
        }

        // Check if redirected to login
        if (finalUrl.includes('/accounts/login/') || /login/i.test(finalUrl)) {
          loginChallengeEncountered = true;
          continue;
        }

        // Check if content explicitly indicates a private account
        if (html.includes('"is_private":true') || html.includes('This account is private') || html.includes('This Account is Private')) {
          isPrivate = true;
        }

        const $ = cheerio.load(html);

        // 1. Caption and author
        const $caption = $('.Caption').clone();
        $caption.find('.CaptionUsername, .CaptionComments').remove();
        const caption = $caption.text().trim();
        const author = $('.CaptionUsername').first().text().trim();

        // 2. OpenGraph metadata
        const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:secure_url"]').attr('content') || null;
        const ogImage = $('meta[property="og:image"]').attr('content') || null;
        const ogTitle = $('meta[property="og:title"]').attr('content') || null;

        // 3. JSON-LD metadata
        let jsonLdVideo = null;
        let jsonLdImage = null;
        try {
          const jsonLdContent = $('script[type="application/ld+json"]').html();
          if (jsonLdContent) {
            const parsedLd = JSON.parse(jsonLdContent);
            jsonLdVideo = parsedLd.video?.contentUrl || parsedLd.contentUrl || null;
            jsonLdImage = parsedLd.image?.contentUrl || parsedLd.thumbnailUrl || null;
          }
        } catch {}

        // 4. Direct video / image tags
        let videoUrl = $('video').attr('src') || $('video source').attr('src') || ogVideo || jsonLdVideo || null;
        let thumbnailUrl = $('video').attr('poster') || $('.EmbeddedMediaImage').attr('src') || ogImage || jsonLdImage || null;

        // 5. Script hydration data with multi-level unescaping
        if (!videoUrl) {
          const cleaned = html
            .replace(/\\+(\/)/g, '/')
            .replace(/\\+u0026/g, '&')
            .replace(/\\+u003C/g, '<')
            .replace(/\\+u003E/g, '>')
            .replace(/\\+u0022/g, '"')
            .replace(/\\+"/g, '"');

          const vMatch = cleaned.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
            cleaned.match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/);
          if (vMatch) {
            videoUrl = vMatch[1];
          }

          if (!thumbnailUrl) {
            const dMatch = cleaned.match(/"display_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
              cleaned.match(/(https?:\/\/[^"'\s\\]+\.jpg[^"'\s\\]*)/);
            if (dMatch) {
              thumbnailUrl = dMatch[1];
            }
          }
        }

        if (videoUrl || thumbnailUrl) {
          const title = caption
            ? caption.slice(0, 100)
            : ogTitle
            ? ogTitle.slice(0, 100)
            : author
            ? `Instagram post by @${author}`
            : `Instagram Post (${shortcode})`;

          extractedMedia = {
            videoUrl,
            thumbnailUrl,
            title,
            surface: surface.name,
          };
          break;
        }
      } catch {
        // Try next surface
      }
    }

    if (!extractedMedia) {
      if (isPrivate) {
        // CASE A: Post is genuinely private
        throw new PlatformLimitationError(
          'This Instagram post or reel requires login or is from a private account and cannot be accessed publicly.'
        );
      }

      if (notFoundEncountered) {
        throw new Error('This Instagram post or reel is no longer available or was removed.');
      }

      if (loginChallengeEncountered) {
        // CASE C: Public content, but server-side request was blocked/challenged by Instagram
        throw new PlatformLimitationError(
          'Instagram is currently requiring an authenticated or challenged server-side request for this public URL. This downloader does not bypass Instagram authentication or security challenges.'
        );
      }

      throw new PlatformLimitationError(
        'Instagram is currently requiring an authenticated or challenged server-side request for this public URL. This downloader does not bypass Instagram authentication or security challenges.'
      );
    }

    // CASE B: Public media extracted successfully
    const formats = [];

    if (extractedMedia.videoUrl) {
      formats.push({
        id: 'video-0',
        quality: 'Original',
        format: 'mp4',
        sizeBytes: null,
        mimeType: 'video/mp4',
        sourceUrl: extractedMedia.videoUrl,
        meta: {
          headers: {
            'Referer': 'https://www.instagram.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
      });
    } else if (extractedMedia.thumbnailUrl) {
      formats.push({
        id: 'image-0',
        quality: 'Original',
        format: 'jpg',
        sizeBytes: null,
        mimeType: 'image/jpeg',
        sourceUrl: extractedMedia.thumbnailUrl,
        meta: {
          headers: {
            'Referer': 'https://www.instagram.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
      });
    }

    return {
      platform: 'instagram',
      title: extractedMedia.title,
      thumbnail: extractedMedia.thumbnailUrl,
      type: extractedMedia.videoUrl
        ? (/(?:reel|reels)/i.test(parsed.pathname) ? 'reel' : 'video')
        : 'image',
      formats,
    };
  }

  async analyzeHighlight(url, parsed, highlightId) {
    const storyMediaId = parsed.searchParams?.get('story_media_id');

    // Extraction strategy for public highlights
    const highlightEndpoints = [
      {
        name: 'direct_url',
        url: url,
        headers: BROWSER_HEADERS,
      },
      {
        name: 'highlight_page',
        url: `https://www.instagram.com/stories/highlights/${highlightId}/`,
        headers: BROWSER_HEADERS,
      },
      {
        name: 'web_reels_media',
        url: `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight%3A${highlightId}`,
        headers: {
          ...BROWSER_HEADERS,
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.instagram.com/',
        },
      },
      {
        name: 'app_reels_media',
        url: `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight%3A${highlightId}`,
        headers: {
          'User-Agent': 'Instagram 278.0.0.19.115 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 457422401)',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-IG-App-ID': '936619743392459',
        },
      },
    ];

    const extractedItems = [];
    let highlightTitle = 'Instagram Highlight';
    let author = null;

    for (const ep of highlightEndpoints) {
      try {
        const res = await axios.get(ep.url, {
          timeout: 10000,
          headers: ep.headers,
          maxRedirects: 5,
          validateStatus: () => true,
        });

        // 1. Check HTML embedded relay data
        if (typeof res.data === 'string' && res.data.length > 0) {
          const html = res.data;
          const $ = cheerio.load(html);
          const ogTitle = $('meta[property="og:title"]').attr('content');
          if (ogTitle) highlightTitle = ogTitle;

          const key = '"xdt_api__v1__feed__reels_media__connection"';
          const keyIdx = html.indexOf(key);
          if (keyIdx !== -1) {
            const braceIdx = html.indexOf('{', keyIdx + key.length);
            const jsonStr = extractJsonObject(html, braceIdx);
            if (jsonStr) {
              try {
                const data = JSON.parse(jsonStr);
                const edges = data.edges || [];
                for (const edge of edges) {
                  const reelItems = edge.node?.items || [];
                  for (const [idx, item] of reelItems.entries()) {
                    const isVideo = item.media_type === 2 || !!item.video_versions;
                    const videoUrl = item.video_versions?.[0]?.url || null;
                    const imageUrl = item.image_versions2?.candidates?.[0]?.url || item.display_url || null;
                    const itemId = String(item.pk || idx);

                    if (isVideo && videoUrl) {
                      extractedItems.push({
                        id: itemId,
                        title: `${highlightTitle} · Story #${idx + 1}`,
                        thumbnail: imageUrl || videoUrl,
                        type: 'video',
                        sourceUrl: videoUrl,
                      });
                    } else if (imageUrl) {
                      extractedItems.push({
                        id: itemId,
                        title: `${highlightTitle} · Story #${idx + 1}`,
                        thumbnail: imageUrl,
                        type: 'image',
                        sourceUrl: imageUrl,
                      });
                    }
                  }
                }
              } catch {}
            }
          }

          if (extractedItems.length > 0) break;
        }

        // 2. JSON reels_media response
        if (res.data && typeof res.data === 'object') {
          const reels = res.data.reels || {};
          const reelData = reels[`highlight:${highlightId}`] || reels[highlightId] || Object.values(reels)[0];

          if (reelData && reelData.items && Array.isArray(reelData.items) && reelData.items.length > 0) {
            highlightTitle = reelData.title || `Instagram Highlight (${highlightId})`;
            author = reelData.user?.username || null;

            for (const [idx, item] of reelData.items.entries()) {
              const isVideo = item.media_type === 2 || !!item.video_versions;
              const videoUrl = item.video_versions?.[0]?.url || null;
              const imageUrl = item.image_versions2?.candidates?.[0]?.url || item.display_url || null;
              const itemId = String(item.pk || item.id || idx);

              if (isVideo && videoUrl) {
                extractedItems.push({
                  id: itemId,
                  title: `${highlightTitle} · Story #${idx + 1}`,
                  thumbnail: imageUrl || videoUrl,
                  type: 'video',
                  sourceUrl: videoUrl,
                });
              } else if (imageUrl) {
                extractedItems.push({
                  id: itemId,
                  title: `${highlightTitle} · Story #${idx + 1}`,
                  thumbnail: imageUrl,
                  type: 'image',
                  sourceUrl: imageUrl,
                });
              }
            }

            if (extractedItems.length > 0) break;
          }
        }

        // 3. HTML page regex fallback
        if (typeof res.data === 'string' && res.data.length > 0) {
          const html = res.data;
          const cleaned = html
            .replace(/\\+(\/)/g, '/')
            .replace(/\\+u0026/g, '&');

          const vMatches = cleaned.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/g) || [];
          const dMatches = cleaned.match(/"display_url"\s*:\s*"(https?:\/\/[^"]+)"/g) || [];

          if (vMatches.length > 0 || dMatches.length > 0) {
            const seen = new Set();
            for (const vm of vMatches) {
              const m = vm.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/);
              if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                extractedItems.push({
                  id: `hl-v-${extractedItems.length}`,
                  title: `${highlightTitle} · Story #${extractedItems.length + 1}`,
                  thumbnail: m[1],
                  type: 'video',
                  sourceUrl: m[1],
                });
              }
            }
            for (const dm of dMatches) {
              const m = dm.match(/"display_url"\s*:\s*"(https?:\/\/[^"]+)"/);
              if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                extractedItems.push({
                  id: `hl-img-${extractedItems.length}`,
                  title: `${highlightTitle} · Story #${extractedItems.length + 1}`,
                  thumbnail: m[1],
                  type: 'image',
                  sourceUrl: m[1],
                });
              }
            }
            if (extractedItems.length > 0) break;
          }
        }
      } catch {
        // Try next endpoint
      }
    }

    if (storyMediaId && extractedItems.length > 1) {
      const target = extractedItems.find((it) => it.id === storyMediaId || it.id.includes(storyMediaId));
      if (target) {
        const remaining = extractedItems.filter((it) => it !== target);
        extractedItems.length = 0;
        extractedItems.push(target, ...remaining);
      }
    }

    if (extractedItems.length === 0) {
      throw new PlatformLimitationError(
        'This Instagram Highlight is private or requires login and cannot be downloaded.'
      );
    }

    const items = extractedItems.map((item, idx) => ({
      id: item.id || `hl-story-${idx}`,
      title: item.title,
      thumbnail: item.thumbnail,
      type: item.type,
      isHighlight: true,
      formats: [
        {
          id: `${item.type}-${idx}`,
          quality: 'Original',
          format: item.type === 'video' ? 'mp4' : 'jpg',
          sizeBytes: null,
          mimeType: item.type === 'video' ? 'video/mp4' : 'image/jpeg',
          sourceUrl: item.sourceUrl,
          meta: {
            headers: {
              'Referer': 'https://www.instagram.com/',
              'User-Agent': BROWSER_HEADERS['User-Agent'],
            },
          },
        },
      ],
    }));

    return {
      platform: 'instagram',
      isHighlight: true,
      title: highlightTitle,
      author,
      thumbnail: items[0]?.thumbnail || null,
      type: items.length === 1 ? items[0].type : 'highlight',
      items,
      formats: items[0]?.formats || [],
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    return downloadStream(sourceUrl, {
      ...options,
      meta: {
        headers: {
          'Referer': 'https://www.instagram.com/',
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          ...(options.meta?.headers || {}),
        },
      },
    });
  }
}
