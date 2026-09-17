import axios from 'axios';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';
import { downloadStream } from '../utils/streamDownloader.js';

const DEFAULT_HOST = 'youtube-media-downloader.p.rapidapi.com';

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
        return parsed.searchParams.get('v') || null;
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v') {
        return parts[1] || null;
      }
    }
  } catch {}
  return null;
}

function cleanText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseSize(item) {
  if (Number.isFinite(Number(item.sizeBytes)) && Number(item.sizeBytes) > 0) {
    return Number(item.sizeBytes);
  }
  if (Number.isFinite(Number(item.contentLength)) && Number(item.contentLength) > 0) {
    return Number(item.contentLength);
  }
  if (Number.isFinite(Number(item.size)) && Number(item.size) > 0) {
    return Number(item.size);
  }
  if (typeof item.sizeText === 'string') {
    const match = item.sizeText.match(/([\d.]+)\s*(GB|MB|KB|B)/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[2].toUpperCase();
      if (unit === 'GB') return Math.round(val * 1024 * 1024 * 1024);
      if (unit === 'MB') return Math.round(val * 1024 * 1024);
      if (unit === 'KB') return Math.round(val * 1024);
      return Math.round(val);
    }
  }
  return null;
}

function qualityFrom(item, isAudio = false) {
  const label = item.quality || item.qualityLabel || item.quality_name || item.label;
  if (typeof label === 'string' && label.trim()) return label.trim();

  const height = Number(item.height || item.videoHeight || 0);
  if (height > 0) return `${height}p`;
  return isAudio ? 'Audio' : 'Original';
}

function resolutionFrom(item) {
  const height = Number(item.height || item.videoHeight || 0);
  if (height > 0) return `${height}p`;
  const q = qualityFrom(item, false);
  const match = typeof q === 'string' ? q.match(/(\d{3,4})p/i) : null;
  return match ? `${match[1]}p` : null;
}

function extensionFrom(item, isAudio = false) {
  const ext = (item.extension || item.format || '').toLowerCase().replace(/^\./, '');
  if (['mp4', 'webm', 'm4a', 'mp3'].includes(ext)) return ext;

  const mime = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase() : '';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp3')) return 'mp3';
  if (mime.includes('m4a')) return 'm4a';
  if (mime.includes('mp4')) return 'mp4';

  const source = item.url || item.link || item.streamUrl || item.downloadUrl || '';
  try {
    const pathname = new URL(source).pathname.toLowerCase();
    const pathExt = pathname.split('.').pop();
    if (['mp4', 'webm', 'm4a', 'mp3'].includes(pathExt)) return pathExt;
  } catch {}

  return isAudio ? 'm4a' : 'mp4';
}

function mimeFrom(item, ext, isAudio = false) {
  if (typeof item.mimeType === 'string' && item.mimeType.includes('/')) {
    return item.mimeType.split(';')[0];
  }
  if (ext === 'webm') return isAudio ? 'audio/webm' : 'video/webm';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  return isAudio ? 'audio/mp4' : 'video/mp4';
}

function collectCandidates(payload) {
  const candidates = [];
  const seen = new Set();

  function walk(value, depth = 0) {
    if (!value || depth > 5) return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    if (typeof value !== 'object') return;

    const sourceUrl =
      typeof value.url === 'string'
        ? value.url
        : typeof value.link === 'string'
        ? value.link
        : typeof value.streamUrl === 'string'
        ? value.streamUrl
        : typeof value.downloadUrl === 'string'
        ? value.downloadUrl
        : null;

    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
      const mime = typeof value.mimeType === 'string' ? value.mimeType.toLowerCase() : '';
      const looksMedia =
        mime.startsWith('video/') ||
        mime.startsWith('audio/') ||
        /\.(mp4|webm|m4a|mp3)(?:[?#]|$)/i.test(sourceUrl);

      if (looksMedia && !seen.has(sourceUrl)) {
        seen.add(sourceUrl);
        candidates.push(value);
      }
    }

    for (const child of Object.values(value)) walk(child, depth + 1);
  }

  walk(payload);
  return candidates;
}

function mapYouTubeMediaDownloaderFormats(data, title) {
  const formats = [];
  let index = 0;

  // 1. Process audio items first to find best candidate for video+audio merging
  const audioItems = Array.isArray(data?.audios?.items)
    ? data.audios.items
    : Array.isArray(data?.audios)
    ? data.audios
    : [];

  const m4aAudio = audioItems.find((a) => {
    const url = a.url || a.link || a.streamUrl || a.downloadUrl;
    const ext = extensionFrom(a, true);
    return url && /^https?:\/\//i.test(url) && (ext === 'm4a' || ext === 'mp3');
  });
  const anyAudio = audioItems.find((a) => {
    const url = a.url || a.link || a.streamUrl || a.downloadUrl;
    return url && /^https?:\/\//i.test(url);
  });
  const bestAudio = m4aAudio || anyAudio;
  const bestAudioUrl = bestAudio ? (bestAudio.url || bestAudio.link || bestAudio.streamUrl || bestAudio.downloadUrl) : null;

  // 2. Process video items (data.videos.items or data.videos)
  const videoItems = Array.isArray(data?.videos?.items)
    ? data.videos.items
    : Array.isArray(data?.videos)
    ? data.videos
    : [];

  for (const item of videoItems) {
    const sourceUrl = item.url || item.link || item.streamUrl || item.downloadUrl;
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) continue;

    const baseFormat = extensionFrom(item, false);
    const quality = qualityFrom(item, false);
    const resolution = resolutionFrom(item);
    const sizeBytes = parseSize(item);
    const originalHasAudio = item.hasAudio !== undefined ? Boolean(item.hasAudio) : true;

    // High-res formats (1080p, 1440p, 4K, 8K) on YouTube are adaptive video-only streams.
    // Ensure that high-res formats or formats without audio trigger audio merging.
    const resNum = Number(resolution?.replace('p', '')) || 0;
    const isHighRes = resNum >= 1080 || /(?:1080p|1440p|2160p|4k|8k)/i.test(quality || '');
    const explicitlyNoAudio = item.hasAudio === false || item.audio === false;

    const needsMerge = Boolean((isHighRes || explicitlyNoAudio || !originalHasAudio) && bestAudioUrl);
    const audioUrl = needsMerge
      ? ((baseFormat === 'mp4' && m4aAudio)
          ? (m4aAudio.url || m4aAudio.link || m4aAudio.streamUrl || m4aAudio.downloadUrl)
          : bestAudioUrl)
      : null;

    const hasAudio = true; // Video will have audio either natively or via FFmpeg merge
    const format = needsMerge ? 'mp4' : baseFormat;
    const mimeType = needsMerge ? 'video/mp4' : mimeFrom(item, format, false);

    formats.push({
      id: `video-${index++}`,
      quality,
      resolution,
      format,
      sizeBytes,
      mimeType,
      sourceUrl,
      videoUrl: sourceUrl,
      audioUrl,
      hasAudio,
      hasVideo: true,
      meta: {
        title,
        format,
        resolution,
        quality,
        videoUrl: sourceUrl,
        audioUrl,
        needsMerge,
        originalHasAudio: !needsMerge,
        headers: {
          Accept: '*/*',
        },
      },
    });
  }

  for (const item of audioItems) {
    const sourceUrl = item.url || item.link || item.streamUrl || item.downloadUrl;
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) continue;

    const format = extensionFrom(item, true);
    const mimeType = mimeFrom(item, format, true);
    const quality = qualityFrom(item, true);
    const sizeBytes = parseSize(item);

    formats.push({
      id: `audio-${index++}`,
      quality,
      resolution: null,
      format,
      sizeBytes,
      mimeType,
      sourceUrl,
      hasAudio: true,
      hasVideo: false,
      meta: {
        title,
        format,
        headers: {
          Accept: '*/*',
        },
      },
    });
  }

  // 3. Fallback: collect any other candidate media format objects in response
  if (formats.length === 0) {
    const candidates = collectCandidates(data);
    for (const item of candidates) {
      const sourceUrl = item.url || item.link || item.streamUrl || item.downloadUrl;
      if (!sourceUrl) continue;
      const isAudio = item.mimeType?.startsWith('audio/') || !item.hasVideo;
      const format = extensionFrom(item, isAudio);
      const mimeType = mimeFrom(item, format, isAudio);
      const quality = qualityFrom(item, isAudio);
      const resolution = isAudio ? null : resolutionFrom(item);
      const sizeBytes = parseSize(item);

      formats.push({
        id: `media-${index++}`,
        quality,
        resolution,
        format,
        sizeBytes,
        mimeType,
        sourceUrl,
        hasAudio: isAudio ? true : Boolean(item.hasAudio),
        hasVideo: !isAudio,
        meta: {
          title,
          format,
          headers: {
            Accept: '*/*',
          },
        },
      });
    }
  }

  // Sort formats: progressive video with audio first (highest resolution first), then video-only, then audio
  formats.sort((a, b) => {
    if (a.hasVideo && !b.hasVideo) return -1;
    if (!a.hasVideo && b.hasVideo) return 1;
    if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
    const resA = Number(a.resolution?.replace('p', '')) || 0;
    const resB = Number(b.resolution?.replace('p', '')) || 0;
    return resB - resA;
  });

  return formats;
}

export class YouTubeAdapter extends BaseAdapter {
  static platformId = 'youtube';
  static status = 'SUPPORTED_WITH_LIMITATIONS';

  canHandle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
    } catch {
      return false;
    }
  }

  async analyze(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new PlatformLimitationError(
        'Please enter a valid YouTube video URL.'
      );
    }

    const envHost = process.env.YOUTUBE_API_HOST?.trim();
    // Default to the confirmed YouTube Media Downloader host if unset or set to legacy host
    const host = envHost && !envHost.includes('youtube138') ? envHost : DEFAULT_HOST;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      throw new PlatformLimitationError(
        'YouTube downloading is not configured on this server.'
      );
    }

    // Exact documented endpoint for YouTube Media Downloader V2
    const endpoint = `https://${host}/v2/video/details`;

    let response;
    try {
      response = await axios.get(endpoint, {
        params: {
          videoId,
          urlAccess: 'normal',
          videos: 'auto',
          audios: 'auto',
        },
        headers: {
          'X-RapidAPI-Host': host,
          'X-RapidAPI-Key': apiKey,
          Accept: 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
      });
    } catch {
      throw new PlatformLimitationError(
        'The YouTube service could not be reached. Please try again later.'
      );
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        const msg = typeof response.data?.message === 'string' ? response.data.message : '';
        if (msg && !msg.toLowerCase().includes('key') && !msg.includes(apiKey)) {
          throw new PlatformLimitationError(`The YouTube service returned an error: ${msg}`);
        }
        throw new PlatformLimitationError(
          'The YouTube API key or subscription is invalid or unauthorized.'
        );
      }
      if (response.status === 429) {
        throw new PlatformLimitationError(
          'The YouTube API request limit has been reached. Please try again later.'
        );
      }
      throw new PlatformLimitationError(
        'The YouTube service could not process this video.'
      );
    }

    const data = response.data;
    const title = cleanText(
      data?.title || data?.videoTitle || data?.videoDetails?.title,
      'YouTube Video'
    );
    const author = cleanText(
      data?.channelTitle ||
        data?.author ||
        data?.channel?.title ||
        data?.channel ||
        data?.videoDetails?.author,
      null
    );

    const thumbnail =
      (Array.isArray(data?.thumbnails) ? data.thumbnails.slice(-1)[0]?.url : null) ||
      data?.thumbnail ||
      data?.thumbnailUrl ||
      data?.thumbnails?.[0]?.url ||
      data?.videoDetails?.thumbnail?.url ||
      null;

    const duration =
      Number(
        data?.lengthSeconds ||
          data?.durationSeconds ||
          data?.duration ||
          data?.videoDetails?.lengthSeconds ||
          0
      ) || null;

    const formats = mapYouTubeMediaDownloaderFormats(data, title);

    if (formats.length === 0) {
      const missingReason =
        data?.videos || data?.audios
          ? "The YouTube RapidAPI response returned video details but did not provide direct downloadable media URLs in 'videos.items' or 'audios.items'."
          : "No downloadable media format was returned in the YouTube RapidAPI response (missing 'videos' / 'audios' stream fields).";
      throw new PlatformLimitationError(missingReason);
    }

    const videoFormats = formats.filter((f) => f.hasVideo);
    const type = videoFormats.length > 0 ? 'video' : 'audio';

    return {
      platform: 'youtube',
      title,
      author,
      thumbnail,
      type,
      duration,
      formats,
    };
  }

  async download(url, options = {}) {
    const sourceUrl = options.sourceUrl || url;

    if (!/^https?:\/\//i.test(sourceUrl)) {
      throw new PlatformLimitationError(
        'The YouTube media URL is invalid.'
      );
    }

    const result = await downloadStream(sourceUrl, {
      ...options,
      sourceUrl,
      meta: {
        ...(options.meta || {}),
        headers: {
          Accept: '*/*',
          ...(options.meta?.headers || {}),
        },
      },
    });

    const format = options.meta?.format || (result.mimeType?.includes('audio') ? 'm4a' : 'mp4');
    let filename = `youtube_video.${format}`;
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
  }
}

export { extractVideoId, mapYouTubeMediaDownloaderFormats };
