import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { downloadStream } from '../utils/streamDownloader.js';

const IG_HOSTS = ['instagram.com', 'instagr.am'];
const SHORTCODE_RE = /(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
const HIGHLIGHT_RE = /(?:stories\/highlights\/)([0-9A-Za-z_-]+)/;
const HIGHLIGHT_SHARE_RE = /(?:^|\/)s\/([0-9A-Za-z_=-]+)/;

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

const CRAWLER_HEADERS = {
  'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Robust URL unescaper for Instagram signed URLs.
 * Resolves HTML, JSON, and unicode-escaped parameter tokens (e.g. \u00253D -> %3D).
 */
export function unescapeInstagramUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let clean = rawUrl.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1);
  }
  return clean
    .replace(/\\+(\/)/g, '/')
    .replace(/\\u00253D/gi, '%3D')
    .replace(/\\u00252F/gi, '%2F')
    .replace(/\\u002525/gi, '%25')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .trim();
}

/**
 * Extracts a safe hostname from a URL string without leaking secrets or query tokens.
 */
function getHostnameSafe(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * REQUIREMENT 11: Production debug logging.
 * Logs only media metadata without leaking tokens, cookies, or signatures.
 */
export function logInstagramCandidate(c) {
  console.log(`[xInstagram Media Candidate]
mediaType: ${c.mediaType}
source: ${c.source}
hostname: ${getHostnameSafe(c.url)}
mimeType: ${c.mimeType}
width: ${c.width || 'unknown'}
height: ${c.height || 'unknown'}`);
}

export function logInstagramDownload(d) {
  console.log(`[xInstagram Download]
status: ${d.status}
contentType: ${d.contentType || 'unknown'}
contentLength: ${d.contentLength || 'unknown'}
httpStatus: ${d.httpStatus || 'unknown'}
candidateIndex: ${d.candidateIndex !== undefined ? d.candidateIndex : 0}`);
}

export function logInstagram403(d) {
  console.log(`[xInstagram CDN 403]
hostname: ${getHostnameSafe(d.url)}
candidateIndex: ${d.candidateIndex !== undefined ? d.candidateIndex : 0}
hasAlternativeCandidate: ${Boolean(d.hasAlternativeCandidate)}
status: 403`);
}

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

/**
 * Probes the upstream Instagram CDN URL to verify content type and availability.
 * Rejects HTML responses and validates media types safely.
 */
export async function probeMediaContentType(url, options = {}) {
  const headers = {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    'Referer': 'https://www.instagram.com/',
    ...(options.headers || {}),
  };

  try {
    const headRes = await axios.head(url, {
      headers,
      timeout: 6000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (headRes.status === 403 || headRes.status === 404 || headRes.status === 410) {
      return { status: headRes.status, isError: true, contentType: null };
    }

    const ct = (headRes.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    if (ct && ct !== 'application/octet-stream') {
      return {
        status: headRes.status,
        isError: false,
        contentType: ct,
        contentLength: headRes.headers['content-length'] ? parseInt(headRes.headers['content-length'], 10) : null,
      };
    }
  } catch (err) {
    if (err.response && [403, 404, 410].includes(err.response.status)) {
      return { status: err.response.status, isError: true, contentType: null };
    }
  }

  try {
    const rangeRes = await axios.get(url, {
      headers: { ...headers, Range: 'bytes=0-1024' },
      timeout: 6000,
      maxRedirects: 5,
      responseType: 'stream',
      validateStatus: () => true,
    });

    if (rangeRes.status === 403 || rangeRes.status === 404 || rangeRes.status === 410) {
      rangeRes.data?.destroy?.();
      return { status: rangeRes.status, isError: true, contentType: null };
    }

    const ct = (rangeRes.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    const chunk = await new Promise((resolve) => {
      rangeRes.data.once('data', (c) => {
        rangeRes.data.destroy?.();
        resolve(c);
      });
      rangeRes.data.once('error', () => resolve(null));
      rangeRes.data.once('end', () => resolve(null));
    });

    let detectedCt = ct;
    if (chunk && Buffer.isBuffer(chunk)) {
      const snippet = chunk.slice(0, 100).toString('utf8').trim().toLowerCase();
      if (snippet.startsWith('<!doctype') || snippet.startsWith('<html')) {
        detectedCt = 'text/html';
      } else if (chunk.slice(4, 8).toString('ascii') === 'ftyp' || chunk.slice(0, 16).toString('hex').includes('66747970')) {
        detectedCt = 'video/mp4';
      } else if (chunk[0] === 0xff && chunk[1] === 0xd8 && chunk[2] === 0xff) {
        detectedCt = 'image/jpeg';
      } else if (chunk.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
        detectedCt = 'image/png';
      } else if (chunk.slice(0, 4).toString('ascii') === 'RIFF' && chunk.slice(8, 12).toString('ascii') === 'WEBP') {
        detectedCt = 'image/webp';
      }
    }

    return {
      status: rangeRes.status,
      isError: false,
      contentType: detectedCt || ct || 'application/octet-stream',
    };
  } catch (err) {
    if (err.response && [403, 404, 410].includes(err.response.status)) {
      return { status: err.response.status, isError: true, contentType: null };
    }
  }

  return { status: 200, isError: false, contentType: null };
}

/**
 * REQUIREMENT 1: Reworked Instagram Media Extraction.
 * Collects legitimate media candidates from all available metadata surfaces and normalizes them.
 */
export function extractMediaCandidates(html, { defaultTitle = 'Instagram Media', isReel = false } = {}) {
  const candidates = [];
  const seenUrls = new Set();

  function addCandidate(c) {
    if (!c.url || typeof c.url !== 'string') return;
    const cleanUrl = unescapeInstagramUrl(c.url);
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl) || seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);

    const norm = {
      mediaType: c.mediaType,
      url: cleanUrl,
      mimeType: c.mimeType || (c.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
      hasVideo: c.mediaType === 'video',
      hasAudio: c.hasAudio !== undefined ? c.hasAudio : c.mediaType === 'video',
      width: c.width || null,
      height: c.height || null,
      source: c.source || 'metadata',
    };

    candidates.push(norm);
    logInstagramCandidate(norm);
  }

  const $ = cheerio.load(html || '');

  // 1. OpenGraph video
  const ogVideo =
    $('meta[property="og:video"]').attr('content') ||
    $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo) {
    addCandidate({
      mediaType: 'video',
      url: ogVideo,
      mimeType: 'video/mp4',
      hasVideo: true,
      hasAudio: true,
      source: 'og:video',
    });
  }

  // 2. Direct HTML video tags
  const videoTag = $('video').attr('src') || $('video source').attr('src');
  if (videoTag) {
    addCandidate({
      mediaType: 'video',
      url: videoTag,
      mimeType: 'video/mp4',
      hasVideo: true,
      hasAudio: true,
      source: 'video_tag',
    });
  }

  // 3. JSON-LD metadata
  try {
    const jsonLd = $('script[type="application/ld+json"]').html();
    if (jsonLd) {
      const parsedLd = JSON.parse(jsonLd);
      const vUrl = parsedLd.video?.contentUrl || parsedLd.contentUrl;
      const iUrl = parsedLd.image?.contentUrl || parsedLd.thumbnailUrl;
      if (vUrl) {
        addCandidate({
          mediaType: 'video',
          url: vUrl,
          mimeType: 'video/mp4',
          hasVideo: true,
          hasAudio: true,
          source: 'json_ld_video',
        });
      }
      if (iUrl) {
        addCandidate({
          mediaType: 'image',
          url: iUrl,
          mimeType: 'image/jpeg',
          hasVideo: false,
          hasAudio: false,
          source: 'json_ld_image',
        });
      }
    }
  } catch {}

  // 4. Cleaned HTML unescaping for embedded JSON
  const cleaned = (html || '')
    .replace(/\\+(\/)/g, '/')
    .replace(/\\+u0026/g, '&')
    .replace(/\\+u003C/g, '<')
    .replace(/\\+u003E/g, '>')
    .replace(/\\+u0022/g, '"')
    .replace(/\\+"/g, '"');

  // 5. Structured video_versions
  const vvMatches = [...cleaned.matchAll(/"video_versions"\s*:\s*\[([\s\S]*?)\]/g)];
  for (const m of vvMatches) {
    try {
      const rawArray = JSON.parse(`[${m[1]}]`);
      for (const item of rawArray) {
        if (item && item.url) {
          addCandidate({
            mediaType: 'video',
            url: item.url,
            mimeType: 'video/mp4',
            hasVideo: true,
            hasAudio: true,
            width: item.width || null,
            height: item.height || null,
            source: 'video_versions',
          });
        }
      }
    } catch {}
  }

  // 6. Regex video_url / playable_url
  const vUrls = [
    ...cleaned.matchAll(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/g),
    ...cleaned.matchAll(/"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\/\/[^"]+)"/g),
  ];
  for (const vu of vUrls) {
    addCandidate({
      mediaType: 'video',
      url: vu[1],
      mimeType: 'video/mp4',
      hasVideo: true,
      hasAudio: true,
      source: 'video_url',
    });
  }

  // 7. Progressive MP4 regex
  const mp4Matches = [...cleaned.matchAll(/(https?:\/\/[^"'\s\\]+?\.mp4[^"'\s\\]*)/gi)];
  for (const m of mp4Matches) {
    addCandidate({
      mediaType: 'video',
      url: m[1],
      mimeType: 'video/mp4',
      hasVideo: true,
      hasAudio: true,
      source: 'progressive_mp4_regex',
    });
  }

  // 8. Image candidates (only for image posts or fallback thumbnails)
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) {
    addCandidate({
      mediaType: 'image',
      url: ogImage,
      mimeType: 'image/jpeg',
      hasVideo: false,
      hasAudio: false,
      source: 'og:image',
    });
  }

  const embeddedImg = $('.EmbeddedMediaImage').attr('src');
  if (embeddedImg) {
    addCandidate({
      mediaType: 'image',
      url: embeddedImg,
      mimeType: 'image/jpeg',
      hasVideo: false,
      hasAudio: false,
      source: 'embedded_image',
    });
  }

  const dMatches = [...cleaned.matchAll(/"display_url"\s*:\s*"(https?:\/\/[^"]+)"/g)];
  for (const dm of dMatches) {
    addCandidate({
      mediaType: 'image',
      url: dm[1],
      mimeType: 'image/jpeg',
      hasVideo: false,
      hasAudio: false,
      source: 'display_url',
    });
  }

  return candidates;
}

/**
 * REQUIREMENT 8: Extracts multi-item carousels preserving each item's media type.
 */
function extractCarouselItems(html, cleaned, baseTitle = 'Instagram Post') {
  const items = [];

  const sidecarKey = '"edge_sidecar_to_children"';
  const sidecarIdx = html.indexOf(sidecarKey);
  if (sidecarIdx !== -1) {
    const braceIdx = html.indexOf('{', sidecarIdx + sidecarKey.length);
    const jsonStr = extractJsonObject(html, braceIdx);
    if (jsonStr) {
      try {
        const data = JSON.parse(jsonStr);
        const edges = data.edges || [];
        for (const [idx, edge] of edges.entries()) {
          const node = edge.node || {};
          const isVideo = Boolean(node.is_video || node.__typename === 'GraphVideo' || node.video_url);
          const videoUrl = node.video_url ? unescapeInstagramUrl(node.video_url) : null;
          const imageUrl = node.display_url ? unescapeInstagramUrl(node.display_url) : null;
          const itemId = String(node.id || idx);

          if (isVideo && videoUrl) {
            items.push({
              id: `carousel-${itemId}`,
              title: `${baseTitle} · Slide #${idx + 1}`,
              thumbnail: imageUrl || videoUrl,
              type: 'video',
              mediaType: 'video',
              hasVideo: true,
              hasAudio: true,
              sourceUrl: videoUrl,
              format: 'mp4',
              mimeType: 'video/mp4',
              width: node.dimensions?.width || null,
              height: node.dimensions?.height || null,
            });
          } else if (imageUrl) {
            items.push({
              id: `carousel-${itemId}`,
              title: `${baseTitle} · Slide #${idx + 1}`,
              thumbnail: imageUrl,
              type: 'image',
              mediaType: 'image',
              hasVideo: false,
              hasAudio: false,
              sourceUrl: imageUrl,
              format: 'jpg',
              mimeType: 'image/jpeg',
              width: node.dimensions?.width || null,
              height: node.dimensions?.height || null,
            });
          }
        }
      } catch {}
    }
  }

  if (items.length <= 1) {
    const cMediaKey = '"carousel_media"';
    const cMediaIdx = html.indexOf(cMediaKey);
    if (cMediaIdx !== -1) {
      const startIdx = html.indexOf('[', cMediaIdx + cMediaKey.length);
      if (startIdx !== -1) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === '[') depth++;
          else if (html[i] === ']') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (endIdx !== -1) {
          try {
            const arr = JSON.parse(html.slice(startIdx, endIdx + 1));
            items.length = 0;
            for (const [idx, m] of arr.entries()) {
              const isVideo = m.media_type === 2 || Boolean(m.video_versions);
              const videoUrl = m.video_versions?.[0]?.url ? unescapeInstagramUrl(m.video_versions[0].url) : null;
              const imageUrl = m.image_versions2?.candidates?.[0]?.url
                ? unescapeInstagramUrl(m.image_versions2.candidates[0].url)
                : m.display_url ? unescapeInstagramUrl(m.display_url) : null;
              const itemId = String(m.pk || m.id || idx);

              if (isVideo && videoUrl) {
                items.push({
                  id: `carousel-${itemId}`,
                  title: `${baseTitle} · Slide #${idx + 1}`,
                  thumbnail: imageUrl || videoUrl,
                  type: 'video',
                  mediaType: 'video',
                  hasVideo: true,
                  hasAudio: true,
                  sourceUrl: videoUrl,
                  format: 'mp4',
                  mimeType: 'video/mp4',
                  width: m.original_width || null,
                  height: m.original_height || null,
                });
              } else if (imageUrl) {
                items.push({
                  id: `carousel-${itemId}`,
                  title: `${baseTitle} · Slide #${idx + 1}`,
                  thumbnail: imageUrl,
                  type: 'image',
                  mediaType: 'image',
                  hasVideo: false,
                  hasAudio: false,
                  sourceUrl: imageUrl,
                  format: 'jpg',
                  mimeType: 'image/jpeg',
                  width: m.original_width || null,
                  height: m.original_height || null,
                });
              }
            }
          } catch {}
        }
      }
    }
  }

  if (items.length <= 1) {
    const itemsKey = '"items"';
    let searchFrom = 0;
    while (searchFrom < html.length) {
      const itemsIdx = html.indexOf(itemsKey, searchFrom);
      if (itemsIdx === -1) break;
      const startIdx = html.indexOf('[', itemsIdx + itemsKey.length);
      if (startIdx !== -1 && startIdx - (itemsIdx + itemsKey.length) < 10) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === '[') depth++;
          else if (html[i] === ']') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (endIdx !== -1) {
          try {
            const arr = JSON.parse(html.slice(startIdx, endIdx + 1));
            if (Array.isArray(arr) && arr.length > 1) {
              items.length = 0;
              for (const [idx, m] of arr.entries()) {
                const isVideo = Boolean(m.is_video || m.media_type === 2 || m.video_versions || m.video_url);
                const videoUrl = m.video_versions?.[0]?.url
                  ? unescapeInstagramUrl(m.video_versions[0].url)
                  : m.video_url ? unescapeInstagramUrl(m.video_url) : null;
                const imageUrl = m.image_versions2?.candidates?.[0]?.url
                  ? unescapeInstagramUrl(m.image_versions2.candidates[0].url)
                  : m.display_url ? unescapeInstagramUrl(m.display_url) : null;
                const itemId = String(m.pk || m.id || idx);

                if (isVideo && videoUrl) {
                  items.push({
                    id: `carousel-${itemId}`,
                    title: `${baseTitle} · Slide #${idx + 1}`,
                    thumbnail: imageUrl || videoUrl,
                    type: 'video',
                    mediaType: 'video',
                    hasVideo: true,
                    hasAudio: true,
                    sourceUrl: videoUrl,
                    format: 'mp4',
                    mimeType: 'video/mp4',
                    width: m.original_width || m.dimensions?.width || null,
                    height: m.original_height || m.dimensions?.height || null,
                  });
                } else if (imageUrl) {
                  items.push({
                    id: `carousel-${itemId}`,
                    title: `${baseTitle} · Slide #${idx + 1}`,
                    thumbnail: imageUrl,
                    type: 'image',
                    mediaType: 'image',
                    hasVideo: false,
                    hasAudio: false,
                    sourceUrl: imageUrl,
                    format: 'jpg',
                    mimeType: 'image/jpeg',
                    width: m.original_width || m.dimensions?.width || null,
                    height: m.original_height || m.dimensions?.height || null,
                  });
                }
              }
              if (items.length > 1) break;
            }
          } catch {}
        }
      }
      searchFrom = itemsIdx + itemsKey.length;
    }
  }

  return items;
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
    const shortcodeMatch = parsed.pathname.match(SHORTCODE_RE);
    const highlightMatch = parsed.pathname.match(HIGHLIGHT_RE);
    const shareHighlightMatch = !shortcodeMatch && parsed.pathname.match(HIGHLIGHT_SHARE_RE);

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

    const match = shortcodeMatch;
    if (!match || !match[1]) {
      throw new Error('Please enter a valid Instagram post, reel, or highlight URL.');
    }

    const shortcode = match[1];
    const isReel = /(?:reel|reels|tv)/i.test(parsed.pathname);

    // Prioritize public surfaces with preview headers
    const surfaces = [
      { name: 'direct_crawler', url: `https://www.instagram.com/reel/${shortcode}/`, headers: CRAWLER_HEADERS },
      { name: 'embed_captioned_reel', url: `https://www.instagram.com/reel/${shortcode}/embed/captioned/`, headers: BROWSER_HEADERS },
      { name: 'embed_captioned_p', url: `https://www.instagram.com/p/${shortcode}/embed/captioned/`, headers: BROWSER_HEADERS },
      { name: 'embed_reel', url: `https://www.instagram.com/reel/${shortcode}/embed/`, headers: BROWSER_HEADERS },
      { name: 'embed_p', url: `https://www.instagram.com/p/${shortcode}/embed/`, headers: BROWSER_HEADERS },
      { name: 'direct_p_crawler', url: `https://www.instagram.com/p/${shortcode}/`, headers: CRAWLER_HEADERS },
      { name: 'direct_browser', url: `https://www.instagram.com/reel/${shortcode}/`, headers: BROWSER_HEADERS },
    ];

    let extractedCandidates = [];
    let title = isReel ? `Instagram Reel (${shortcode})` : `Instagram Post (${shortcode})`;
    let author = null;
    let isPrivate = false;
    let loginChallengeEncountered = false;
    let notFoundEncountered = false;
    let isIdentifiedVideo = isReel;

    for (const surface of surfaces) {
      try {
        const res = await axios.get(surface.url, {
          timeout: 10000,
          headers: surface.headers,
          maxRedirects: 5,
          validateStatus: () => true,
        });

        const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
        const html = typeof res.data === 'string' ? res.data : '';

        if (
          res.status === 404 ||
          html.includes('This photo or video has been removed') ||
          html.includes('Page Not Found') ||
          html.includes('The link you followed may be broken')
        ) {
          notFoundEncountered = true;
          continue;
        }

        if (finalUrl.includes('/accounts/login/') || /login/i.test(finalUrl)) {
          loginChallengeEncountered = true;
          continue;
        }

        if (
          html.includes('"is_private":true') ||
          html.includes('This account is private') ||
          html.includes('This Account is Private')
        ) {
          isPrivate = true;
        }

        const $ = cheerio.load(html);

        const $caption = $('.Caption').clone();
        $caption.find('.CaptionUsername, .CaptionComments').remove();
        const caption = $caption.text().trim();
        const foundAuthor = $('.CaptionUsername').first().text().trim();
        if (foundAuthor) author = foundAuthor;

        const ogTitle = $('meta[property="og:title"]').attr('content') || null;
        if (caption) title = caption.slice(0, 100);
        else if (ogTitle) title = ogTitle.slice(0, 100);

        const cleaned = html
          .replace(/\\+(\/)/g, '/')
          .replace(/\\+u0026/g, '&')
          .replace(/\\+u003C/g, '<')
          .replace(/\\+u003E/g, '>')
          .replace(/\\+u0022/g, '"')
          .replace(/\\+"/g, '"');

        // Check for Carousel items
        const carouselItems = extractCarouselItems(html, cleaned, title);
        if (carouselItems.length > 1) {
          const items = carouselItems.map((item, idx) => ({
            id: item.id || `carousel-${idx}`,
            title: item.title,
            thumbnail: item.thumbnail,
            type: item.type,
            mediaType: item.mediaType,
            hasVideo: item.hasVideo,
            hasAudio: item.hasAudio,
            width: item.width,
            height: item.height,
            formats: [
              {
                id: `${item.type}-${idx}`,
                quality: 'Original',
                format: item.format,
                mimeType: item.mimeType,
                mediaType: item.mediaType,
                hasVideo: item.hasVideo,
                hasAudio: item.hasAudio,
                sizeBytes: null,
                sourceUrl: item.sourceUrl,
                meta: {
                  mediaType: item.mediaType,
                  hasVideo: item.hasVideo,
                  hasAudio: item.hasAudio,
                  format: item.format,
                  title: item.title,
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
            title,
            author,
            thumbnail: items[0]?.thumbnail || null,
            type: 'carousel',
            items,
            formats: items[0]?.formats || [],
          };
        }

        // Determine if post is video vs image
        const hasVideoIndicator = Boolean(
          isReel ||
          $('meta[property="og:video"]').length > 0 ||
          $('meta[property="og:video:secure_url"]').length > 0 ||
          $('video').length > 0 ||
          /"is_video"\s*:\s*true/i.test(cleaned) ||
          /"media_type"\s*:\s*2/i.test(cleaned) ||
          /"video_versions"/i.test(cleaned) ||
          /"video_url"/i.test(cleaned) ||
          /playable_url/i.test(cleaned)
        );

        if (hasVideoIndicator) {
          isIdentifiedVideo = true;
        }

        const candidates = extractMediaCandidates(html, { defaultTitle: title, isReel: isIdentifiedVideo });
        if (candidates.length > 0) {
          extractedCandidates = candidates;
          break;
        }
      } catch {
        // Proceed to next surface
      }
    }

    // REQUIREMENT 2: Candidate prioritization
    const videoCandidates = extractedCandidates.filter((c) => c.mediaType === 'video');
    const imageCandidates = extractedCandidates.filter((c) => c.mediaType === 'image');

    // Sort video candidates by priority: video_versions with dimensions first, then og:video, then progressive regex
    videoCandidates.sort((a, b) => {
      if (a.source === 'video_versions' && b.source !== 'video_versions') return -1;
      if (b.source === 'video_versions' && a.source !== 'video_versions') return 1;
      const resA = (a.width || 0) * (a.height || 0);
      const resB = (b.width || 0) * (b.height || 0);
      return resB - resA;
    });

    if (isIdentifiedVideo) {
      if (videoCandidates.length === 0) {
        // REQUIREMENT 2: NEVER fall back from video to image
        throw new PlatformLimitationError('Instagram video source could not be verified.');
      }

      const topVideo = videoCandidates[0];
      const thumbnailCandidate = imageCandidates[0]?.url || topVideo.url;

      return {
        platform: 'instagram',
        title,
        author,
        thumbnail: thumbnailCandidate,
        type: isReel ? 'reel' : 'video',
        formats: [
          {
            id: 'video-0',
            quality: 'Original',
            format: 'mp4',
            mimeType: 'video/mp4',
            mediaType: 'video',
            hasVideo: true,
            hasAudio: topVideo.hasAudio,
            sizeBytes: null,
            sourceUrl: topVideo.url,
            meta: {
              mediaType: 'video',
              hasVideo: true,
              hasAudio: topVideo.hasAudio,
              format: 'mp4',
              title,
              candidates: videoCandidates.map((c) => ({ url: c.url, source: c.source, width: c.width, height: c.height })),
              headers: {
                'Referer': 'https://www.instagram.com/',
                'User-Agent': BROWSER_HEADERS['User-Agent'],
              },
            },
          },
        ],
      };
    }

    // Pure image post
    if (imageCandidates.length > 0) {
      const topImage = imageCandidates[0];
      const imgUrl = topImage.url.toLowerCase();
      const ext = imgUrl.includes('.png') ? 'png' : imgUrl.includes('.webp') ? 'webp' : 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      return {
        platform: 'instagram',
        title,
        author,
        thumbnail: topImage.url,
        type: 'image',
        formats: [
          {
            id: 'image-0',
            quality: 'Original',
            format: ext,
            mimeType,
            mediaType: 'image',
            hasVideo: false,
            hasAudio: false,
            sizeBytes: null,
            sourceUrl: topImage.url,
            meta: {
              mediaType: 'image',
              hasVideo: false,
              hasAudio: false,
              format: ext,
              title,
              candidates: imageCandidates.map((c) => ({ url: c.url, source: c.source })),
              headers: {
                'Referer': 'https://www.instagram.com/',
                'User-Agent': BROWSER_HEADERS['User-Agent'],
              },
            },
          },
        ],
      };
    }

    if (isPrivate) {
      throw new PlatformLimitationError(
        'This Instagram post or reel requires login or is from a private account and cannot be accessed publicly.'
      );
    }

    if (notFoundEncountered) {
      throw new Error('This Instagram post or reel is no longer available or was removed.');
    }

    if (loginChallengeEncountered) {
      throw new PlatformLimitationError(
        'Instagram is currently requiring an authenticated or challenged server-side request for this public URL. This downloader does not bypass Instagram authentication or security challenges.'
      );
    }

    throw new PlatformLimitationError('Instagram video source could not be verified.');
  }

  async analyzeHighlight(url, parsed, highlightId) {
    const storyMediaId = parsed.searchParams?.get('story_media_id');

    const highlightEndpoints = [
      { name: 'direct_url', url: url, headers: BROWSER_HEADERS },
      { name: 'highlight_page', url: `https://www.instagram.com/stories/highlights/${highlightId}/`, headers: BROWSER_HEADERS },
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
          'User-Agent':
            'Instagram 278.0.0.19.115 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 457422401)',
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
                    const videoUrl = item.video_versions?.[0]?.url ? unescapeInstagramUrl(item.video_versions[0].url) : null;
                    const imageUrl = item.image_versions2?.candidates?.[0]?.url
                      ? unescapeInstagramUrl(item.image_versions2.candidates[0].url)
                      : item.display_url ? unescapeInstagramUrl(item.display_url) : null;
                    const itemId = String(item.pk || idx);

                    if (isVideo && videoUrl) {
                      extractedItems.push({
                        id: itemId,
                        title: `${highlightTitle} · Story #${idx + 1}`,
                        thumbnail: imageUrl || videoUrl,
                        type: 'video',
                        mediaType: 'video',
                        hasVideo: true,
                        hasAudio: true,
                        sourceUrl: videoUrl,
                        format: 'mp4',
                        mimeType: 'video/mp4',
                      });
                    } else if (imageUrl) {
                      extractedItems.push({
                        id: itemId,
                        title: `${highlightTitle} · Story #${idx + 1}`,
                        thumbnail: imageUrl,
                        type: 'image',
                        mediaType: 'image',
                        hasVideo: false,
                        hasAudio: false,
                        sourceUrl: imageUrl,
                        format: 'jpg',
                        mimeType: 'image/jpeg',
                      });
                    }
                  }
                }
              } catch {}
            }
          }

          if (extractedItems.length > 0) break;
        }

        if (res.data && typeof res.data === 'object') {
          const reels = res.data.reels || {};
          const reelData = reels[`highlight:${highlightId}`] || reels[highlightId] || Object.values(reels)[0];

          if (reelData && reelData.items && Array.isArray(reelData.items) && reelData.items.length > 0) {
            highlightTitle = reelData.title || `Instagram Highlight (${highlightId})`;
            author = reelData.user?.username || null;

            for (const [idx, item] of reelData.items.entries()) {
              const isVideo = item.media_type === 2 || !!item.video_versions;
              const videoUrl = item.video_versions?.[0]?.url ? unescapeInstagramUrl(item.video_versions[0].url) : null;
              const imageUrl = item.image_versions2?.candidates?.[0]?.url
                ? unescapeInstagramUrl(item.image_versions2.candidates[0].url)
                : item.display_url ? unescapeInstagramUrl(item.display_url) : null;
              const itemId = String(item.pk || item.id || idx);

              if (isVideo && videoUrl) {
                extractedItems.push({
                  id: itemId,
                  title: `${highlightTitle} · Story #${idx + 1}`,
                  thumbnail: imageUrl || videoUrl,
                  type: 'video',
                  mediaType: 'video',
                  hasVideo: true,
                  hasAudio: true,
                  sourceUrl: videoUrl,
                  format: 'mp4',
                  mimeType: 'video/mp4',
                });
              } else if (imageUrl) {
                extractedItems.push({
                  id: itemId,
                  title: `${highlightTitle} · Story #${idx + 1}`,
                  thumbnail: imageUrl,
                  type: 'image',
                  mediaType: 'image',
                  hasVideo: false,
                  hasAudio: false,
                  sourceUrl: imageUrl,
                  format: 'jpg',
                  mimeType: 'image/jpeg',
                });
              }
            }

            if (extractedItems.length > 0) break;
          }
        }
      } catch {}
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
      mediaType: item.mediaType,
      hasVideo: item.hasVideo,
      hasAudio: item.hasAudio,
      isHighlight: true,
      formats: [
        {
          id: `${item.type}-${idx}`,
          quality: 'Original',
          format: item.format,
          mimeType: item.mimeType,
          mediaType: item.mediaType,
          hasVideo: item.hasVideo,
          hasAudio: item.hasAudio,
          sizeBytes: null,
          sourceUrl: item.sourceUrl,
          meta: {
            mediaType: item.mediaType,
            hasVideo: item.hasVideo,
            hasAudio: item.hasAudio,
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

  /**
   * REQUIREMENT 3 & 4: Robust Instagram media download helper.
   * Handles candidate failover on 403/404/410, content verification, and stream piping.
   */
  async download(url, options = {}) {
    const rawTarget = options.sourceUrl || url;
    const candidates = options.meta?.candidates && Array.isArray(options.meta.candidates) && options.meta.candidates.length > 0
      ? options.meta.candidates
      : [{ url: rawTarget, source: 'primary' }];

    const expectedMediaType = options.meta?.mediaType || (options.formatId?.includes('image') ? 'image' : 'video');
    let lastError = null;

    for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
      const candidate = candidates[cIdx];
      const candidateUrl = unescapeInstagramUrl(candidate.url);
      await assertSafeUrl(candidateUrl);

      try {
        const result = await downloadStream(candidateUrl, {
          ...options,
          platform: 'instagram',
          meta: {
            headers: {
              'Referer': 'https://www.instagram.com/',
              'User-Agent': BROWSER_HEADERS['User-Agent'],
              ...(options.meta?.headers || {}),
              ...(options.headers || {}),
            },
          },
        });

        const rawMime = (result.mimeType || '').toLowerCase().split(';')[0].trim();

        // REQUIREMENT 5: Reject HTML responses immediately
        if (rawMime === 'text/html' || rawMime.startsWith('text/')) {
          result.stream?.destroy?.();
          throw new PlatformLimitationError('Instagram CDN returned an invalid response (HTML instead of media).');
        }

        // REQUIREMENT 2 & 5: Strict media type validation
        if (expectedMediaType === 'video') {
          if (rawMime.startsWith('image/')) {
            result.stream?.destroy?.();
            throw new PlatformLimitationError('Instagram video source could not be verified.');
          }
        } else if (expectedMediaType === 'image') {
          if (rawMime.startsWith('video/')) {
            result.stream?.destroy?.();
            throw new PlatformLimitationError('Instagram media type mismatch.');
          }
        }

        logInstagramDownload({
          status: 'SUCCESS',
          contentType: rawMime,
          contentLength: result.sizeBytes,
          httpStatus: result.statusCode || 200,
          candidateIndex: cIdx,
        });

        const extMap = {
          'video/mp4': '.mp4',
          'video/webm': '.webm',
          'image/jpeg': '.jpg',
          'image/jpg': '.jpg',
          'image/png': '.png',
          'image/webp': '.webp',
        };

        let ext = extMap[rawMime];
        if (!ext) {
          ext = expectedMediaType === 'video' ? '.mp4' : '.jpg';
        }

        let cleanFilename = result.filename || `instagram_${expectedMediaType}${ext}`;
        const curExt = path.extname(cleanFilename);
        if (curExt.toLowerCase() !== ext) {
          cleanFilename = `${cleanFilename.replace(/\.[a-zA-Z0-9]+$/, '')}${ext}`;
        }

        return {
          stream: result.stream,
          filename: cleanFilename,
          mimeType: rawMime || (expectedMediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
          sizeBytes: result.sizeBytes,
          statusCode: result.statusCode,
          contentRange: result.contentRange,
        };
      } catch (err) {
        lastError = err;
        const status = err.response?.status || err.status || err.statusCode;

        if (status === 403) {
          const hasAlternative = cIdx < candidates.length - 1;
          logInstagram403({
            url: candidateUrl,
            candidateIndex: cIdx,
            hasAlternativeCandidate: hasAlternative,
          });

          // REQUIREMENT 4 & 10: Try next public candidate once if available
          if (hasAlternative) {
            continue;
          }

          const error = new Error('Instagram media access was denied or the link has expired (HTTP 403).');
          error.statusCode = 403;
          error.status = 403;
          throw error;
        }

        if (status === 404) {
          if (cIdx < candidates.length - 1) continue;
          const error = new Error('This Instagram media is no longer available (HTTP 404).');
          error.statusCode = 404;
          error.status = 404;
          throw error;
        }

        if (status === 410) {
          if (cIdx < candidates.length - 1) continue;
          const error = new Error('This Instagram media link has expired (HTTP 410).');
          error.statusCode = 410;
          error.status = 410;
          throw error;
        }

        if (err instanceof PlatformLimitationError) {
          throw err;
        }

        if (cIdx < candidates.length - 1) continue;
        throw err;
      }
    }

    throw lastError || new PlatformLimitationError('Instagram video source could not be verified.');
  }
}
