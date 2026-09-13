import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { Innertube, ClientType, Platform } from 'youtubei.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { assertSafeUrl } from '../utils/urlSafety.js';
import { BaseAdapter, PlatformLimitationError } from './baseAdapter.js';

// Configure JS evaluator for youtubei.js decipher engine
Platform.shim.eval = async (data) => new Function(data.output)();

let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create({ client_type: ClientType.MWEB });
  }
  return innertubeInstance;
}

const MAX_FILE_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024;
const MAX_DOWNLOAD_TIME_MS = (parseInt(process.env.MAX_DOWNLOAD_TIME_SECONDS, 10) || 300) * 1000;

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'youtube_video';
}

/**
 * Extracts 11-character YouTube video ID from various public URL patterns:
 * - https://www.youtube.com/watch?v=ID
 * - https://youtu.be/ID
 * - https://www.youtube.com/shorts/ID
 * - https://www.youtube.com/embed/ID
 * - https://www.youtube.com/v/ID
 * - https://www.youtube.com/live/ID
 * - https://m.youtube.com/watch?v=ID
 */
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const trimmed = url.trim();

    // Direct 11-char ID check
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return trimmed;
    }

    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host.endsWith('.youtube.com')
    ) {
      // 1. watch?v=...
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return v;
      }

      // 2. /shorts/ID
      const shortsMatch = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];

      // 3. /embed/ID
      const embedMatch = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];

      // 4. /v/ID
      const vMatch = parsed.pathname.match(/\/v\/([a-zA-Z0-9_-]{11})/);
      if (vMatch) return vMatch[1];

      // 5. /live/ID
      const liveMatch = parsed.pathname.match(/\/live\/([a-zA-Z0-9_-]{11})/);
      if (liveMatch) return liveMatch[1];
    }
  } catch {
    // Ignore URL parse errors
  }

  return null;
}

export class YouTubeAdapter extends BaseAdapter {
  static platformId = 'youtube';
  static status = 'SUPPORTED';

  canHandle(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const trimmed = url.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return false; // Raw ID alone without URL is handled only if valid URL
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

      if (
        host === 'youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'music.youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtu.be' ||
        host.endsWith('.youtu.be')
      ) {
        return !!extractYouTubeVideoId(trimmed);
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(url) {
    await assertSafeUrl(url);

    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      throw new PlatformLimitationError('Please enter a valid public YouTube video URL.');
    }

    const yt = await getInnertube();
    let info;

    try {
      info = await yt.getBasicInfo(videoId);
    } catch (err) {
      console.error(`[YouTube Adapter] Failed to get video info for ${videoId}:`, err.message);
      if (err.message?.includes('Video unavailable') || err.message?.includes('not found')) {
        throw new PlatformLimitationError('This YouTube video is unavailable or has been removed.');
      }
      throw new PlatformLimitationError('Unable to access this YouTube video. It may be restricted or unavailable.');
    }

    // Check playability status
    const playStatus = info.playability_status?.status;
    if (playStatus && playStatus !== 'OK') {
      const reason = info.playability_status?.reason || '';
      console.warn(`[YouTube Adapter] Video ${videoId} playability status: ${playStatus} - ${reason}`);

      if (
        playStatus === 'LOGIN_REQUIRED' ||
        reason.toLowerCase().includes('private') ||
        reason.toLowerCase().includes('sign in') ||
        reason.toLowerCase().includes('age')
      ) {
        throw new PlatformLimitationError(
          'This YouTube video requires login or is age-restricted and cannot be downloaded publicly.'
        );
      }

      if (playStatus === 'UNPLAYABLE' || reason.toLowerCase().includes('unavailable')) {
        throw new PlatformLimitationError('This YouTube video is unavailable or has been removed.');
      }

      throw new PlatformLimitationError(
        reason ? `YouTube error: ${reason}` : 'This YouTube video is not publicly accessible.'
      );
    }

    const basic = info.basic_info || {};
    const title = basic.title || 'YouTube Video';
    const author = basic.author || '';
    const duration = basic.duration || 0;

    // Highest resolution thumbnail
    let thumbnail = null;
    if (Array.isArray(basic.thumbnail)) {
      const sortedThumbs = [...basic.thumbnail].sort((a, b) => (b.width || 0) - (a.width || 0));
      thumbnail = sortedThumbs[0]?.url || null;
    }

    // Fallback thumbnail URL
    if (!thumbnail) {
      thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    }

    const isShort =
      url.includes('/shorts/') ||
      (duration > 0 && duration <= 60 && basic.aspect_ratio && basic.aspect_ratio < 1);

    const allFormats = [
      ...(info.streaming_data?.formats || []),
      ...(info.streaming_data?.adaptive_formats || []),
    ];

    const videoFormats = allFormats.filter((f) => f.has_video && (f.url || f.signature_cipher || f.cipher));
    const audioFormats = allFormats.filter((f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher));

    if (videoFormats.length === 0) {
      throw new PlatformLimitationError('No downloadable public video streams found for this YouTube video.');
    }

    // Select the best audio track (prefer MP4 / AAC for lossless remuxing, then Opus)
    let bestAudio =
      audioFormats.find((f) => f.mime_type?.includes('mp4') && f.audio_quality?.includes('MEDIUM')) ||
      audioFormats.find((f) => f.mime_type?.includes('mp4')) ||
      audioFormats[0] ||
      null;

    // Group video formats by effective resolution (e.g. min(width, height) to handle both landscape & portrait shorts)
    const qualityMap = new Map();

    for (const fmt of videoFormats) {
      const width = fmt.width || 0;
      const height = fmt.height || 0;
      const effectiveRes = Math.min(width, height) || height || width;
      if (effectiveRes <= 0) continue;

      // Classify standard resolution buckets
      let tier = '360p';
      let displayQuality = '360p';

      if (effectiveRes >= 2160 || Math.max(width, height) >= 3840) {
        tier = '2160p';
        displayQuality = '2160p (4K)';
      } else if (effectiveRes >= 1440 || Math.max(width, height) >= 2560) {
        tier = '1440p';
        displayQuality = '1440p (2K)';
      } else if (effectiveRes >= 1080 || Math.max(width, height) >= 1920) {
        tier = '1080p';
        displayQuality = '1080p';
      } else if (effectiveRes >= 720 || Math.max(width, height) >= 1280) {
        tier = '720p';
        displayQuality = '720p';
      } else if (effectiveRes >= 480) {
        tier = '480p';
        displayQuality = '480p';
      } else if (effectiveRes >= 360) {
        tier = '360p';
        displayQuality = '360p';
      } else if (effectiveRes >= 240) {
        tier = '240p';
        displayQuality = '240p';
      } else {
        tier = '144p';
        displayQuality = '144p';
      }

      if (fmt.fps && fmt.fps >= 50) {
        displayQuality += ' 60fps';
      }

      const isMp4 = fmt.mime_type?.includes('mp4');
      const current = qualityMap.get(tier);

      // We prefer MP4 container, and higher fps/bitrate
      if (!current) {
        qualityMap.set(tier, { fmt, effectiveRes, displayQuality });
      } else {
        const currentIsMp4 = current.fmt.mime_type?.includes('mp4');
        if (!currentIsMp4 && isMp4) {
          qualityMap.set(tier, { fmt, effectiveRes, displayQuality });
        } else if (currentIsMp4 === isMp4 && (fmt.fps || 0) > (current.fmt.fps || 0)) {
          qualityMap.set(tier, { fmt, effectiveRes, displayQuality });
        }
      }
    }

    // Sort quality tiers from highest resolution to lowest resolution
    const sortedTiers = Array.from(qualityMap.values()).sort((a, b) => b.effectiveRes - a.effectiveRes);

    if (sortedTiers.length === 0) {
      throw new PlatformLimitationError('No playable quality options available for this video.');
    }

    const formats = sortedTiers.map(({ fmt, displayQuality }) => {
      const isMuxed = fmt.has_audio;
      const audioItag = isMuxed ? null : bestAudio?.itag || null;
      const vSize = fmt.content_length ? Number(fmt.content_length) : null;
      const aSize = !isMuxed && bestAudio?.content_length ? Number(bestAudio.content_length) : 0;
      const totalSizeBytes = vSize ? vSize + aSize : null;

      return {
        id: `yt_${fmt.itag}_${audioItag || 'muxed'}`,
        quality: displayQuality,
        resolution: `${fmt.width}x${fmt.height}`,
        format: 'mp4',
        sizeBytes: totalSizeBytes,
        hasAudio: isMuxed || !!bestAudio,
        sourceUrl: url,
        meta: {
          videoId,
          videoItag: fmt.itag,
          audioItag,
          width: fmt.width,
          height: fmt.height,
          fps: fmt.fps,
          quality: displayQuality,
          title,
        },
      };
    });

    const bestFormat = formats[0];

    return {
      platform: 'youtube',
      type: isShort ? 'short' : 'video',
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

    const videoId = options.meta?.videoId || extractYouTubeVideoId(url);
    if (!videoId) {
      throw new PlatformLimitationError('Please provide a valid YouTube video URL.');
    }

    const yt = await getInnertube();
    const info = await yt.getBasicInfo(videoId);
    const allFormats = [
      ...(info.streaming_data?.formats || []),
      ...(info.streaming_data?.adaptive_formats || []),
    ];

    const requestedVideoItag = options.meta?.videoItag;
    const requestedAudioItag = options.meta?.audioItag;

    // Find requested video format or default to highest resolution available
    let videoFmt = null;
    if (requestedVideoItag) {
      videoFmt = allFormats.find((f) => f.itag === Number(requestedVideoItag));
    }
    if (!videoFmt) {
      const videoFormats = allFormats.filter((f) => f.has_video && (f.url || f.signature_cipher || f.cipher));
      videoFormats.sort((a, b) => {
        const resA = Math.min(a.width || 0, a.height || 0);
        const resB = Math.min(b.width || 0, b.height || 0);
        return resB - resA;
      });
      videoFmt = videoFormats[0];
    }

    if (!videoFmt) {
      throw new PlatformLimitationError('The requested YouTube video stream is no longer available.');
    }

    // Decipher video URL
    const videoUrl = await videoFmt.decipher(yt.session.player);
    if (!videoUrl) {
      throw new PlatformLimitationError('Failed to obtain streaming URL for this YouTube video.');
    }

    const title = options.meta?.title || info.basic_info?.title || 'YouTube_Video';
    const quality = options.meta?.quality || videoFmt.quality_label || 'video';
    const safeTitle = sanitizeFilename(title);
    const filename = `${safeTitle}_${sanitizeFilename(quality)}.mp4`;

    // Case 1: Video stream already contains audio (pre-muxed format)
    if (videoFmt.has_audio) {
      const tempFilePath = path.join(os.tmpdir(), `md_yt_${nanoid(8)}.mp4`);
      await this.#downloadStreamToFile(videoUrl, videoFmt.content_length, tempFilePath);

      const stat = await fs.promises.stat(tempFilePath);
      return {
        stream: fs.createReadStream(tempFilePath),
        _tempFilePath: tempFilePath,
        filename,
        mimeType: 'video/mp4',
        sizeBytes: stat.size,
      };
    }

    // Case 2: Adaptive format (video and audio are separate streams)
    let audioFmt = null;
    if (requestedAudioItag) {
      audioFmt = allFormats.find((f) => f.itag === Number(requestedAudioItag));
    }
    if (!audioFmt) {
      const audioFormats = allFormats.filter((f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher));
      audioFmt =
        audioFormats.find((f) => f.mime_type?.includes('mp4') && f.audio_quality?.includes('MEDIUM')) ||
        audioFormats.find((f) => f.mime_type?.includes('mp4')) ||
        audioFormats[0] ||
        null;
    }

    const vTemp = path.join(os.tmpdir(), `md_yt_v_${nanoid(8)}.mp4`);
    const aTemp = path.join(os.tmpdir(), `md_yt_a_${nanoid(8)}.${audioFmt?.mime_type?.includes('mp4') ? 'm4a' : 'webm'}`);
    const outTemp = path.join(os.tmpdir(), `md_yt_out_${nanoid(8)}.mp4`);

    try {
      // 1. Download video stream
      await this.#downloadStreamToFile(videoUrl, videoFmt.content_length, vTemp);

      // 2. Download audio stream if available
      let hasAudio = false;
      if (audioFmt) {
        const audioUrl = await audioFmt.decipher(yt.session.player);
        if (audioUrl) {
          await this.#downloadStreamToFile(audioUrl, audioFmt.content_length, aTemp);
          hasAudio = true;
        }
      }

      // 3. Mux using FFmpeg without re-encoding
      await this.#muxMedia(vTemp, hasAudio ? aTemp : null, outTemp, videoFmt, audioFmt);

      const stat = await fs.promises.stat(outTemp);
      return {
        stream: fs.createReadStream(outTemp),
        _tempFilePath: outTemp,
        filename,
        mimeType: 'video/mp4',
        sizeBytes: stat.size,
      };
    } finally {
      // Clean up the intermediate partial files
      await fs.promises.unlink(vTemp).catch(() => {});
      await fs.promises.unlink(aTemp).catch(() => {});
    }
  }

  async #downloadStreamToFile(url, contentLength, targetPath) {
    const totalLength = contentLength ? Number(contentLength) : null;
    const writeStream = fs.createWriteStream(targetPath);
    let bytesWritten = 0;

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
    };

    // 1. Try direct streaming fetch with mobile browser headers
    let res = await fetch(url, { headers });
    if (res.ok) {
      return new Promise((resolve, reject) => {
        res.body
          .pipeTo(
            new WritableStream({
              write(chunk) {
                bytesWritten += chunk.length;
                if (bytesWritten > MAX_FILE_SIZE_BYTES) {
                  writeStream.destroy();
                  throw new Error('This video exceeds the maximum allowed download size.');
                }
                writeStream.write(chunk);
              },
              close() {
                writeStream.end(resolve);
              },
              abort(err) {
                writeStream.destroy();
                reject(err);
              },
            })
          )
          .catch(reject);
      });
    }

    // 2. Fallback: chunked Range download using safe 1MB slices
    const CHUNK_SIZE = 1024 * 1024;
    let start = 0;
    while (!totalLength || start < totalLength) {
      const end = totalLength ? Math.min(start + CHUNK_SIZE - 1, totalLength - 1) : start + CHUNK_SIZE - 1;
      const chunkRes = await fetch(url, {
        headers: {
          ...headers,
          'Range': `bytes=${start}-${end}`,
        },
      });

      if (!chunkRes.ok) {
        if ((chunkRes.status === 416 || chunkRes.status === 403) && bytesWritten > 0) {
          // Reached end of stream
          break;
        }
        writeStream.destroy();
        throw new Error(`Upstream stream request failed with status ${chunkRes.status}`);
      }

      for await (const chunk of chunkRes.body) {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_FILE_SIZE_BYTES) {
          writeStream.destroy();
          throw new Error('This video exceeds the maximum allowed download size.');
        }
        writeStream.write(chunk);
      }

      if (totalLength && end >= totalLength - 1) break;
      start = end + 1;
    }

    return new Promise((resolve) => writeStream.end(resolve));
  }

  async #muxMedia(videoPath, audioPath, outputPath, videoFmt, audioFmt) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = ffmpegInstaller.path;
      const isVideoMp4 = videoFmt?.mime_type?.includes('mp4');
      const isAudioMp4 = audioFmt?.mime_type?.includes('mp4');

      const args = ['-y', '-i', videoPath];

      if (audioPath) {
        args.push('-i', audioPath);
      }

      // Preserving original quality with stream copy
      if (isVideoMp4 && (isAudioMp4 || !audioPath)) {
        // Pure stream copy into MP4
        args.push('-c', 'copy');
      } else if (audioPath) {
        // If audio is Opus or video is VP9, copy video stream and convert audio to AAC for standard MP4 compatibility
        args.push('-c:v', 'copy', '-c:a', 'aac');
      } else {
        args.push('-c', 'copy');
      }

      args.push('-movflags', '+faststart', outputPath);

      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Muxing process timed out.'));
      }, MAX_DOWNLOAD_TIME_MS);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          console.error(`[YouTube FFmpeg Error] Exit ${code}:`, stderr.slice(-300));
          reject(new Error(`FFmpeg muxing failed with exit code ${code}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
