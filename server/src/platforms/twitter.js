import axios from 'axios';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream } from '../utils/streamDownloader.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://x.com/',
};

function getTwitterToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'X Post';
  return (
    raw
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 100) || 'X Post'
  );
}

export class TwitterAdapter extends BaseAdapter {
  static platformId = 'twitter';
  static status = 'SUPPORTED';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (
        host === 'twitter.com' ||
        host === 'x.com' ||
        host.endsWith('.twitter.com') ||
        host.endsWith('.x.com') ||
        host === 't.co'
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    let targetUrl = url;

    // Resolve short or redirect links (e.g. t.co or share links)
    if (new URL(url).hostname.includes('t.co')) {
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
        try {
          const getRes = await axios.get(targetUrl, {
            maxRedirects: 5,
            timeout: 8000,
            headers: BROWSER_HEADERS,
            validateStatus: () => true,
          });
          const resolved = getRes.request?.res?.responseUrl;
          if (resolved) {
            await assertSafeUrl(resolved);
            targetUrl = resolved;
          }
        } catch {}
      }
    }

    // Check for Fleets / Stories
    if (/(?:fleets|stories)/i.test(targetUrl)) {
      throw new PlatformLimitationError(
        'X/Twitter Stories (Fleets) are discontinued and are not publicly available.'
      );
    }

    // Extract status ID from URL
    const match = targetUrl.match(/(?:twitter\.com|x\.com)\/(?:[^\/]+\/status\/|i\/status\/)([0-9]+)/i);
    const statusId = match ? match[1] : null;

    if (!statusId) {
      throw new Error(
        'Please enter a valid X/Twitter post URL (e.g. https://x.com/username/status/12345).'
      );
    }

    const token = getTwitterToken(statusId);
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&lang=en&token=${token}`;

    let res;
    try {
      res = await axios.get(apiUrl, {
        headers: {
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          'Accept': 'application/json',
          'Referer': 'https://platform.twitter.com/',
        },
        timeout: 10000,
        validateStatus: () => true,
      });
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new Error('This X/Twitter post is no longer available or could not be found.');
      }
      throw err;
    }

    if (!res || res.status === 404) {
      throw new Error('This X/Twitter post is no longer available or could not be found.');
    }

    const tweet = res.data;

    // Check for Twitter tombstone (deleted or protected accounts)
    if (tweet?.__typename === 'TweetTombstone') {
      const tombstoneText = tweet.tombstone?.text?.text || '';
      if (/protected/i.test(tombstoneText)) {
        throw new PlatformLimitationError(
          'This X/Twitter post is from a private or protected account.'
        );
      }
      throw new Error('This X/Twitter post is no longer available or could not be found.');
    }

    if (!tweet || !tweet.id_str) {
      throw new Error('This X/Twitter post is no longer available or could not be found.');
    }

    const title = cleanTitle(tweet.text) || 'X Post';
    const author = tweet.user?.name
      ? `${tweet.user.name} (@${tweet.user.screen_name})`
      : tweet.user?.screen_name
      ? `@${tweet.user.screen_name}`
      : null;

    const mediaDetails = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails : [];

    if (mediaDetails.length === 0) {
      throw new Error('This X/Twitter post does not contain any downloadable media.');
    }

    const thumbnail =
      mediaDetails[0]?.media_url_https ||
      mediaDetails[0]?.video_info?.variants?.[0]?.url ||
      null;

    // If single media item
    if (mediaDetails.length === 1) {
      const item = mediaDetails[0];
      const isVideo = item.type === 'video' || item.type === 'animated_gif';

      if (isVideo) {
        const mp4Variants = (item.video_info?.variants || [])
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (mp4Variants.length === 0) {
          throw new Error('Public X/Twitter video stream could not be accessed.');
        }

        const duration = item.video_info?.duration_millis
          ? Math.round(item.video_info.duration_millis / 1000)
          : null;

        const formats = mp4Variants.map((v, idx) => {
          let resolution = null;
          const resMatch = v.url.match(/\/vid\/(?:[^\/]+\/)?(\d+x\d+)\//);
          if (resMatch) resolution = resMatch[1];
          else if (item.original_info?.width && item.original_info?.height) {
            resolution = `${item.original_info.width}x${item.original_info.height}`;
          }
          const height = resolution ? resolution.split('x')[1] : null;
          const quality = height ? `${height}p` : idx === 0 ? 'HD' : 'Standard';

          return {
            id: `video-${idx}`,
            quality,
            resolution,
            format: 'mp4',
            sizeBytes: null,
            mimeType: 'video/mp4',
            sourceUrl: v.url,
            meta: {
              headers: {
                'Referer': 'https://x.com/',
                'User-Agent': BROWSER_HEADERS['User-Agent'],
              },
              title,
              format: 'mp4',
            },
          };
        });

        return {
          platform: 'twitter',
          title,
          author,
          duration,
          thumbnail,
          type: 'video',
          formats,
        };
      } else {
        // Single Photo
        const sourceUrl = item.media_url_https
          ? `${item.media_url_https}?name=orig`
          : item.media_url_https;
        const resolution = item.original_info
          ? `${item.original_info.width}x${item.original_info.height}`
          : null;

        const formats = [
          {
            id: 'image-0',
            quality: 'Original',
            resolution,
            format: 'jpg',
            sizeBytes: null,
            mimeType: 'image/jpeg',
            sourceUrl,
            meta: {
              headers: {
                'Referer': 'https://x.com/',
                'User-Agent': BROWSER_HEADERS['User-Agent'],
              },
              title,
              format: 'jpg',
            },
          },
        ];

        return {
          platform: 'twitter',
          title,
          author,
          duration: null,
          thumbnail,
          type: 'image',
          formats,
        };
      }
    }

    // Multiple Media Items (Photos / Videos)
    const items = mediaDetails.map((detail, idx) => {
      const isVid = detail.type === 'video' || detail.type === 'animated_gif';
      const itemThumb = detail.media_url_https;
      const itemTitle = `${title} (Item ${idx + 1})`;

      if (isVid) {
        const mp4Variants = (detail.video_info?.variants || [])
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const bestVariant = mp4Variants[0] || detail.video_info?.variants?.[0];

        let resolution = null;
        const resMatch = bestVariant?.url?.match(/\/vid\/(?:[^\/]+\/)?(\d+x\d+)\//);
        if (resMatch) resolution = resMatch[1];
        else if (detail.original_info?.width && detail.original_info?.height) {
          resolution = `${detail.original_info.width}x${detail.original_info.height}`;
        }
        const height = resolution ? resolution.split('x')[1] : null;

        return {
          id: `item-${idx}`,
          title: itemTitle,
          thumbnail: itemThumb,
          type: 'video',
          formats: [
            {
              id: `item-${idx}-video`,
              quality: height ? `${height}p` : 'HD',
              resolution,
              format: 'mp4',
              sizeBytes: null,
              mimeType: 'video/mp4',
              sourceUrl: bestVariant.url,
              meta: {
                headers: {
                  'Referer': 'https://x.com/',
                  'User-Agent': BROWSER_HEADERS['User-Agent'],
                },
                title: itemTitle,
                format: 'mp4',
              },
            },
          ],
        };
      } else {
        const imgUrl = detail.media_url_https
          ? `${detail.media_url_https}?name=orig`
          : detail.media_url_https;
        const resolution = detail.original_info
          ? `${detail.original_info.width}x${detail.original_info.height}`
          : null;

        return {
          id: `item-${idx}`,
          title: itemTitle,
          thumbnail: itemThumb,
          type: 'image',
          formats: [
            {
              id: `item-${idx}-photo`,
              quality: 'Original',
              resolution,
              format: 'jpg',
              sizeBytes: null,
              mimeType: 'image/jpeg',
              sourceUrl: imgUrl,
              meta: {
                headers: {
                  'Referer': 'https://x.com/',
                  'User-Agent': BROWSER_HEADERS['User-Agent'],
                },
                title: itemTitle,
                format: 'jpg',
              },
            },
          ],
        };
      }
    });

    return {
      platform: 'twitter',
      title,
      author,
      duration: null,
      thumbnail,
      type: 'mixed',
      items,
      formats: items[0]?.formats || [],
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;
    const customHeaders = options.meta?.headers || {};
    const headers = {
      'Referer': 'https://x.com/',
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      ...customHeaders,
    };

    const result = await downloadStream(sourceUrl, {
      ...options,
      meta: {
        ...options.meta,
        headers,
      },
    });

    const format = options.meta?.format || (result.mimeType?.includes('video') ? 'mp4' : 'jpg');
    let filename = `twitter_media.${format}`;
    if (options.meta?.title) {
      const base = options.meta.title
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 50)
        .replace(/^_+|_+$/g, '');
      if (base) filename = `${base}.${format}`;
    } else if (result.filename && typeof result.filename === 'string') {
      const sanitized = result.filename.replace(/[/\\?%*:|"<>]/g, '_').trim();
      const base = sanitized.replace(/\.(mp4|jpg|jpeg|png|bin|download)$/i, '').replace(/^[._]+/, '');
      filename = `${base || 'twitter_media'}.${format}`;
    }

    return {
      ...result,
      filename,
    };
  }
}
