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
  'Referer': 'https://www.snapchat.com/',
};

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'Snapchat Media';
  return raw
    .replace(/Watch Snapchat Stories.*$/i, '')
    .replace(/Try the new Snapchat.*$/i, '')
    .replace(/\| Snapchat.*$/i, '')
    .trim() || 'Snapchat Media';
}

export class SnapchatAdapter extends BaseAdapter {
  static platformId = 'snapchat';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return host === 'snapchat.com' || host.endsWith('.snapchat.com');
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    let targetUrl = url;
    let initialRes = null;

    // Follow redirects for short links (e.g. /t/...) or share links
    try {
      const headRes = await axios.head(url, {
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

    // If still short link or no redirect detected, fetch with GET
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
        throw new Error('This Snapchat public link has expired or is no longer available.');
      }
      throw err;
    }

    if (!initialRes || initialRes.status === 404) {
      throw new Error('This Snapchat public link has expired or is no longer available.');
    }

    // Check if redirected to login
    if (targetUrl.includes('/login') || targetUrl.includes('/checkpoint')) {
      throw new PlatformLimitationError('Snapchat content is not available for unauthenticated download.');
    }

    const html = typeof initialRes.data === 'string' ? initialRes.data : '';
    if (html.includes('login_form') || html.includes('Log In to Snapchat')) {
      throw new PlatformLimitationError('Snapchat content is not available for unauthenticated download.');
    }

    const $ = cheerio.load(html);

    let nextData = null;
    try {
      const nextContent = $('#__NEXT_DATA__').html();
      if (nextContent) nextData = JSON.parse(nextContent);
    } catch {}

    const pageProps = nextData?.props?.pageProps;

    // Check if Snapchat explicitly reported expired snap
    if (pageProps?.showSnapExpiredToast === true) {
      throw new Error('This Snapchat public link has expired or is no longer available.');
    }

    let title = null;
    let author = null;
    let duration = null;
    let thumbnail = null;
    let mediaUrl = null;
    let isVideo = true;
    let width = null;
    let height = null;
    let detectedType = targetUrl.includes('/spotlight') ? 'spotlight' : 'video';

    // 1. Check videoMetadata (used by Spotlight and public video shares)
    if (pageProps?.videoMetadata) {
      const vm = pageProps.videoMetadata;
      if (vm.contentUrl) {
        mediaUrl = vm.contentUrl;
        isVideo = true;
      }
      if (vm.thumbnailUrl) thumbnail = vm.thumbnailUrl;
      if (vm.durationMs) duration = Math.round(parseInt(vm.durationMs, 10) / 1000);
      if (vm.width) width = vm.width;
      if (vm.height) height = vm.height;
      if (vm.creator?.personCreator?.name || vm.creator?.personCreator?.username) {
        author = vm.creator.personCreator.name || vm.creator.personCreator.username;
      }
      if (vm.description || vm.name) {
        title = vm.description || vm.name;
      }
    }

    // 2. Check story object (used by Public Story links and user Snap shares)
    if (!mediaUrl && pageProps?.story) {
      const story = pageProps.story;
      detectedType = 'story';
      if (story.storyTitle) title = story.storyTitle;
      if (story.thumbnailUrl) thumbnail = story.thumbnailUrl;

      const snapList = Array.isArray(story.snapList) ? story.snapList : [];
      if (snapList.length > 0) {
        // Find matching snap or use first
        let matchedSnap = snapList[0];
        for (const snap of snapList) {
          if (snap.snapId?.value && targetUrl.includes(snap.snapId.value)) {
            matchedSnap = snap;
            break;
          }
        }

        if (matchedSnap?.snapUrls?.mediaUrl) {
          mediaUrl = matchedSnap.snapUrls.mediaUrl;
          // snapMediaType: 0 is image, 1 is video
          isVideo = matchedSnap.snapMediaType === 1;
        }
        if (matchedSnap?.snapUrls?.mediaPreviewUrl?.value && !thumbnail) {
          thumbnail = matchedSnap.snapUrls.mediaPreviewUrl.value;
        }
      }
    }

    // 3. Check spotlightFeed
    if (!mediaUrl && pageProps?.spotlightFeed?.spotlightStories?.length > 0) {
      const firstStory = pageProps.spotlightFeed.spotlightStories[0]?.story;
      detectedType = 'spotlight';
      if (firstStory?.snapList?.[0]?.snapUrls?.mediaUrl) {
        mediaUrl = firstStory.snapList[0].snapUrls.mediaUrl;
        isVideo = firstStory.snapList[0].snapMediaType === 1;
      }
    }

    // 4. OpenGraph Fallbacks
    if (!mediaUrl) {
      const ogVideo =
        $('meta[property="og:video"]').attr('content') ||
        $('meta[property="og:video:secure_url"]').attr('content') ||
        $('meta[name="twitter:player:stream"]').attr('content');

      if (ogVideo && ogVideo.startsWith('http')) {
        mediaUrl = ogVideo;
        isVideo = true;
      }
    }

    if (!mediaUrl) {
      const ogImage =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content');
      // Only treat og:image as media if the page is clearly a photo/image story
      if (ogImage && ogImage.startsWith('http') && (detectedType === 'story' || /(?:image|photo)/i.test(targetUrl))) {
        mediaUrl = ogImage;
        isVideo = false;
      }
    }

    // Title extraction: prioritize specific descriptive title
    let titleCandidate =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text()?.trim();

    if (titleCandidate) {
      const parts = titleCandidate.split('|').map((p) => p.trim());
      if (parts.length >= 2) {
        const specificPart = parts.find(
          (p) =>
            !/likes|comments|shares/i.test(p) &&
            !/^spotlight$/i.test(p) &&
            !/^\s*video by/i.test(p) &&
            !/^\s*posted\s+/i.test(p)
        );
        if (specificPart && specificPart.length > 3) {
          title = specificPart;
        }
      }
      if (!title) {
        title = cleanTitle(titleCandidate);
      }
    }

    if (!title && pageProps?.videoMetadata) {
      const vm = pageProps.videoMetadata;
      if (vm.description && !vm.description.includes('Another Spotlight Snap')) {
        title = vm.description;
      } else if (vm.name && vm.name !== 'Spotlight Snap') {
        title = vm.name;
      }
    }

    if (!title && pageProps?.story?.storyTitle) {
      title = pageProps.story.storyTitle;
    }

    if (!title) {
      title = 'Snapchat Media';
    }

    if (!thumbnail) {
      thumbnail =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        null;
    }

    if (!mediaUrl) {
      throw new Error('Public Snapchat media could not be accessed.');
    }

    const formats = [];
    if (isVideo) {
      const quality = height ? `${height}p` : 'HD (720p)';
      formats.push({
        id: 'video-0',
        quality,
        resolution: width && height ? `${width}x${height}` : null,
        format: 'mp4',
        sizeBytes: null,
        mimeType: 'video/mp4',
        sourceUrl: mediaUrl,
        meta: {
          headers: {
            'Referer': 'https://www.snapchat.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
          format: 'mp4',
        },
      });
    } else {
      formats.push({
        id: 'image-0',
        quality: 'Original',
        resolution: width && height ? `${width}x${height}` : null,
        format: 'jpg',
        sizeBytes: null,
        mimeType: 'image/jpeg',
        sourceUrl: mediaUrl,
        meta: {
          headers: {
            'Referer': 'https://www.snapchat.com/',
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
          format: 'jpg',
        },
      });
    }

    return {
      platform: 'snapchat',
      title,
      author: author || null,
      duration: duration || null,
      thumbnail,
      type: isVideo ? detectedType : 'image',
      formats,
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    const result = await downloadStream(sourceUrl, {
      ...options,
      meta: {
        headers: {
          'Referer': 'https://www.snapchat.com/',
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          ...(options.meta?.headers || {}),
        },
      },
    });

    const format = options.meta?.format || (result.mimeType?.includes('video') ? 'mp4' : 'jpg');
    let filename = result.filename;
    if (!filename.includes('.') || filename.endsWith('.IRZXSOY') || filename.endsWith('.bin')) {
      const base = filename.replace(/\.IRZXSOY$/i, '').replace(/\.bin$/i, '') || 'snapchat_media';
      filename = `${base}.${format}`;
    }

    return {
      ...result,
      filename,
    };
  }
}
