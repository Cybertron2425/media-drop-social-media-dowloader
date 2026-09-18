import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { YouTubeAdapter, extractVideoId, mapYouTubeMediaDownloaderFormats } from './platforms/youtubeAdapter.js';

test('YouTube adapter detects supported URL forms', () => {
  const adapter = new YouTubeAdapter();

  assert.equal(adapter.canHandle('https://www.youtube.com/watch?v=abc12345678'), true);
  assert.equal(adapter.canHandle('https://youtube.com/watch?v=abc12345678'), true);
  assert.equal(adapter.canHandle('https://m.youtube.com/watch?v=abc12345678'), true);
  assert.equal(adapter.canHandle('https://youtu.be/abc12345678'), true);
  assert.equal(adapter.canHandle('https://www.youtube.com/shorts/abc12345678'), true);
  assert.equal(adapter.canHandle('https://example.com/watch?v=abc12345678'), false);
  assert.equal(adapter.canHandle('not-a-url'), false);
});

test('YouTube video ID extraction', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=abc12345678'), 'abc12345678');
  assert.equal(extractVideoId('https://youtube.com/watch?v=abc12345678&t=20s'), 'abc12345678');
  assert.equal(extractVideoId('https://m.youtube.com/watch?v=abc12345678'), 'abc12345678');
  assert.equal(extractVideoId('https://youtu.be/abc12345678'), 'abc12345678');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/abc12345678'), 'abc12345678');
  assert.equal(extractVideoId('https://www.youtube.com/channel/UC123456'), null);
  assert.equal(extractVideoId('https://example.com/video/abc12345678'), null);
});

test('YouTube adapter rejects URLs without video ID', async () => {
  const adapter = new YouTubeAdapter();

  await assert.rejects(
    () => adapter.analyze('https://www.youtube.com/channel/UC123456'),
    (err) => err.message === 'Please enter a valid YouTube video URL.'
  );
});

test('YouTube adapter handles missing API configuration without making a request', async () => {
  const adapter = new YouTubeAdapter();
  const oldKey = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;

  try {
    await assert.rejects(
      () => adapter.analyze('https://www.youtube.com/watch?v=abc12345678'),
      (err) => err.message === 'YouTube downloading is not configured on this server.'
    );
  } finally {
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
  }
});

test('YouTube adapter calls RapidAPI endpoint with exact videoId and urlAccess=normal parameters', async () => {
  const adapter = new YouTubeAdapter();
  const oldKey = process.env.YOUTUBE_API_KEY;
  const oldHost = process.env.YOUTUBE_API_HOST;

  process.env.YOUTUBE_API_KEY = 'test-rapidapi-key';
  process.env.YOUTUBE_API_HOST = 'youtube-media-downloader.p.rapidapi.com';

  let capturedRequest = null;
  const originalGet = axios.get;
  axios.get = async (url, config) => {
    capturedRequest = { url, config };
    return {
      status: 200,
      data: {
        title: 'Sample Video',
        videos: {
          items: [
            {
              url: 'https://rr1---sn.googlevideo.com/videoplayback?id=1',
              format: 'mp4',
              quality: '720p',
              sizeBytes: 5000000,
              hasAudio: true,
            },
          ],
        },
      },
    };
  };

  try {
    await adapter.analyze('https://www.youtube.com/watch?v=cL0KKSPjZf8');

    assert.ok(capturedRequest);
    assert.equal(capturedRequest.url, 'https://youtube-media-downloader.p.rapidapi.com/v2/video/details');
    assert.equal(capturedRequest.config.params.videoId, 'cL0KKSPjZf8');
    assert.equal(capturedRequest.config.params.urlAccess, 'normal');
    assert.equal(capturedRequest.config.params.videos, 'auto');
    assert.equal(capturedRequest.config.params.audios, 'auto');
    assert.equal(capturedRequest.config.headers['X-RapidAPI-Key'], 'test-rapidapi-key');
    assert.equal(capturedRequest.config.headers['X-RapidAPI-Host'], 'youtube-media-downloader.p.rapidapi.com');
  } finally {
    axios.get = originalGet;
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
    if (oldHost === undefined) delete process.env.YOUTUBE_API_HOST;
    else process.env.YOUTUBE_API_HOST = oldHost;
  }
});

test('YouTube adapter maps YouTube Media Downloader response (videos and audios) to standard format', async () => {
  const adapter = new YouTubeAdapter();
  const oldKey = process.env.YOUTUBE_API_KEY;
  const oldHost = process.env.YOUTUBE_API_HOST;

  process.env.YOUTUBE_API_KEY = 'test-key';
  process.env.YOUTUBE_API_HOST = 'youtube-media-downloader.p.rapidapi.com';

  const originalGet = axios.get;
  axios.get = async () => ({
    status: 200,
    data: {
      title: 'Never Gonna Give You Up',
      channelTitle: 'Rick Astley',
      lengthSeconds: '212',
      thumbnails: [{ url: 'https://i.ytimg.com/vi/cL0KKSPjZf8/maxresdefault.jpg' }],
      videos: {
        items: [
          {
            url: 'https://rr---test.googlevideo.com/videoplayback?id=1080',
            quality: '1080p',
            extension: 'mp4',
            sizeText: '25.4 MB',
            hasAudio: true,
          },
          {
            url: 'https://rr---test.googlevideo.com/videoplayback?id=720',
            quality: '720p',
            extension: 'mp4',
            sizeText: '15.2 MB',
            hasAudio: true,
          },
        ],
      },
      audios: {
        items: [
          {
            url: 'https://rr---test.googlevideo.com/videoplayback?id=audio1',
            quality: '128kbps',
            extension: 'm4a',
            sizeText: '3.5 MB',
          },
        ],
      },
    },
  });

  try {
    const result = await adapter.analyze('https://www.youtube.com/watch?v=cL0KKSPjZf8');

    assert.equal(result.platform, 'youtube');
    assert.equal(result.title, 'Never Gonna Give You Up');
    assert.equal(result.author, 'Rick Astley');
    assert.equal(result.duration, 212);
    assert.equal(result.type, 'video');
    assert.equal(result.thumbnail, 'https://i.ytimg.com/vi/cL0KKSPjZf8/maxresdefault.jpg');
    assert.equal(result.formats.length, 3);

    const f0 = result.formats[0];
    assert.equal(f0.quality, '1080p');
    assert.equal(f0.resolution, '1080p');
    assert.equal(f0.format, 'mp4');
    assert.equal(f0.hasAudio, true);
    assert.equal(f0.hasVideo, true);
    assert.equal(f0.sourceUrl, 'https://rr---test.googlevideo.com/videoplayback?id=1080');

    const audioFormat = result.formats.find((f) => !f.hasVideo);
    assert.ok(audioFormat);
    assert.equal(audioFormat.quality, '128kbps');
    assert.equal(audioFormat.format, 'm4a');
    assert.equal(audioFormat.hasAudio, true);
    assert.equal(audioFormat.sourceUrl, 'https://rr---test.googlevideo.com/videoplayback?id=audio1');
  } finally {
    axios.get = originalGet;
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
    if (oldHost === undefined) delete process.env.YOUTUBE_API_HOST;
    else process.env.YOUTUBE_API_HOST = oldHost;
  }
});

test('YouTube adapter reports missing format fields when API response has empty stream items', async () => {
  const adapter = new YouTubeAdapter();
  const oldKey = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'test-key';

  const originalGet = axios.get;
  axios.get = async () => ({
    status: 200,
    data: {
      title: 'No Streams Video',
      videos: { items: [] },
      audios: { items: [] },
    },
  });

  try {
    await assert.rejects(
      () => adapter.analyze('https://www.youtube.com/watch?v=cL0KKSPjZf8'),
      (err) => {
        assert.match(err.message, /did not provide direct downloadable media URLs in 'videos\.items' or 'audios\.items'/i);
        return true;
      }
    );
  } finally {
    axios.get = originalGet;
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
  }
});

test('YouTube API errors do not expose the API key', async () => {
  const adapter = new YouTubeAdapter();
  const oldKey = process.env.YOUTUBE_API_KEY;
  const oldHost = process.env.YOUTUBE_API_HOST;

  const secret = 'secret-test-api-key';
  process.env.YOUTUBE_API_KEY = secret;
  process.env.YOUTUBE_API_HOST = 'youtube-media-downloader.p.rapidapi.com';

  const originalGet = axios.get;
  axios.get = async () => ({ status: 401, data: { message: `invalid key ${secret}` } });

  try {
    await assert.rejects(
      () => adapter.analyze('https://www.youtube.com/watch?v=cL0KKSPjZf8'),
      (err) => !err.message.includes(secret)
    );
  } finally {
    axios.get = originalGet;
    if (oldKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = oldKey;
    if (oldHost === undefined) delete process.env.YOUTUBE_API_HOST;
    else process.env.YOUTUBE_API_HOST = oldHost;
  }
});

test('YouTube adapter download rejects invalid source URL', async () => {
  const adapter = new YouTubeAdapter();

  await assert.rejects(
    () => adapter.download('not-a-valid-http-url'),
    (err) => err.message === 'The YouTube media URL is invalid.'
  );
});

test('YouTube adapter live endpoint connectivity for YouTube URL analysis', async (t) => {
  if (!process.env.YOUTUBE_API_KEY) {
    t.skip('Skipping live YouTube API test: YOUTUBE_API_KEY is not configured');
    return;
  }

  const adapter = new YouTubeAdapter();
  try {
    const result = await adapter.analyze('https://www.youtube.com/watch?v=jNQXAC9IVRw');

    assert.equal(result.platform, 'youtube');
    assert.ok(result.title);
    assert.equal(result.type, 'video');
    assert.ok(Array.isArray(result.formats) && result.formats.length > 0);
    assert.ok(result.formats.some((f) => f.hasVideo && f.sourceUrl));
    assert.ok(result.formats.some((f) => f.hasAudio && f.sourceUrl));
  } catch (err) {
    if (err.message?.includes('request limit has been reached')) {
      t.skip('Skipping live YouTube API test: RapidAPI quota reached');
      return;
    }
    throw err;
  }
});

test('YouTube format mapping pairs video-only adaptive streams with best audio stream for FFmpeg merging', () => {
  const sampleData = {
    title: 'Adaptive Video Sample',
    videos: {
      items: [
        {
          url: 'https://example.com/video-1080p.mp4',
          quality: '1080p',
          extension: 'mp4',
          hasAudio: false,
        },
      ],
    },
    audios: {
      items: [
        {
          url: 'https://example.com/audio-128k.m4a',
          quality: '128kbps',
          extension: 'm4a',
        },
      ],
    },
  };

  const formats = mapYouTubeMediaDownloaderFormats(sampleData, 'Adaptive Video Sample');
  const videoFormat = formats.find((f) => f.resolution === '1080p');

  assert.ok(videoFormat);
  assert.equal(videoFormat.hasAudio, true, 'User facing format should indicate audio will be present');
  assert.equal(videoFormat.meta.needsMerge, true);
  assert.equal(videoFormat.meta.audioUrl, 'https://example.com/audio-128k.m4a');
  assert.equal(videoFormat.meta.originalHasAudio, false);
});

test('mergeMediaFiles rejects gracefully on invalid inputs without crashing the server', async () => {
  const { mergeMediaFiles } = await import('./controllers/downloadController.js');
  await assert.rejects(
    () => mergeMediaFiles('nonexistent_video.mp4', 'nonexistent_audio.m4a', 'nonexistent_out.mp4', { timeoutMs: 3000 }),
    (err) => err.message.includes('Failed to merge') || err.message.includes('FFmpeg')
  );
});

test('YouTube format mapping for 1080p, 1440p, and 4K quality triggers mergeMediaFiles pipeline with videoUrl and audioUrl', () => {
  const sampleData = {
    title: '4K Ultra HD Sample',
    videos: {
      items: [
        {
          url: 'https://example.com/video-4k.mp4',
          quality: '4K',
          extension: 'mp4',
        },
        {
          url: 'https://example.com/video-1440p.mp4',
          quality: '1440p',
          extension: 'mp4',
        },
      ],
    },
    audios: {
      items: [
        {
          url: 'https://example.com/audio.m4a',
          quality: '128kbps',
          extension: 'm4a',
        },
      ],
    },
  };

  const formats = mapYouTubeMediaDownloaderFormats(sampleData, '4K Ultra HD Sample');
  const f4k = formats.find((f) => f.quality === '4K');
  const f1440 = formats.find((f) => f.quality === '1440p');

  assert.ok(f4k);
  assert.equal(f4k.meta.needsMerge, true);
  assert.equal(f4k.videoUrl, 'https://example.com/video-4k.mp4');
  assert.equal(f4k.audioUrl, 'https://example.com/audio.m4a');

  assert.ok(f1440);
  assert.equal(f1440.meta.needsMerge, true);
  assert.equal(f1440.videoUrl, 'https://example.com/video-1440p.mp4');
  assert.equal(f1440.audioUrl, 'https://example.com/audio.m4a');
});

test('FFmpeg merge outputs [FFmpeg] logs and handles .mp4 video and .m4a audio extensions', async () => {
  const { mergeMediaFiles } = await import('./controllers/downloadController.js');
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegInstaller);

  const vPath = path.join(os.tmpdir(), `test_v_${Date.now()}.mp4`);
  const aPath = path.join(os.tmpdir(), `test_a_${Date.now()}.m4a`);
  const oPath = path.join(os.tmpdir(), `test_o_${Date.now()}.mp4`);

  await new Promise((res, rej) => ffmpeg().input('color=c=black:s=160x120:d=0.5').inputFormat('lavfi').output(vPath).on('end', res).on('error', rej).run());
  await new Promise((res, rej) => ffmpeg().input('sine=f=440:d=0.5').inputFormat('lavfi').output(aPath).on('end', res).on('error', rej).run());

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  try {
    await mergeMediaFiles(vPath, aPath, oPath);
    assert.ok(fs.existsSync(oPath));
    assert.ok(logs.some((l) => l.includes('[FFmpeg] Merging video and audio...')));
    assert.ok(logs.some((l) => l.includes('[FFmpeg] Merge complete!')));
  } finally {
    console.log = originalLog;
    [vPath, aPath, oPath].forEach((f) => fs.promises.unlink(f).catch(() => {}));
  }
});

test('checkNeedsMerge helper accurately distinguishes formats requiring merge vs direct stream', async () => {
  const { checkNeedsMerge } = await import('./controllers/downloadController.js');

  // Format with high-res resolution and separate audioUrl -> needs merge
  const highResToken = {
    platform: 'youtube',
    meta: {
      resolution: '1080p',
      audioUrl: 'https://rr---sn.googlevideo.com/audio',
      needsMerge: true,
    },
  };
  assert.equal(checkNeedsMerge(highResToken), true);

  // 4K token without explicit needsMerge flag but has audioUrl and 4k quality
  const fourKToken = {
    platform: 'youtube',
    meta: {
      quality: '4K (2160p)',
      audioUrl: 'https://rr---sn.googlevideo.com/audio',
    },
  };
  assert.equal(checkNeedsMerge(fourKToken), true);

  // 720p format with baked-in audio (no separate audioUrl) -> NO merge needed
  const direct720pToken = {
    platform: 'youtube',
    meta: {
      resolution: '720p',
      quality: '720p',
      format: 'mp4',
      originalHasAudio: true,
      needsMerge: false,
    },
  };
  assert.equal(checkNeedsMerge(direct720pToken), false);

  // 360p format with baked-in audio -> NO merge needed
  const direct360pToken = {
    platform: 'youtube',
    meta: {
      resolution: '360p',
      quality: '360p',
      format: 'mp4',
    },
  };
  assert.equal(checkNeedsMerge(direct360pToken), false);

  // Audio-only format -> NO merge needed
  const audioOnlyToken = {
    platform: 'youtube',
    meta: {
      format: 'm4a',
      mimeType: 'audio/mp4',
    },
  };
  assert.equal(checkNeedsMerge(audioOnlyToken), false);

  // Format requesting merge via reqBody override
  assert.equal(checkNeedsMerge(direct720pToken, { audioUrl: 'https://example.com/audio' }), true);
});

test('getComputedFilename generates clean user-friendly filenames', async () => {
  const { getComputedFilename } = await import('./controllers/downloadController.js');

  const token = {
    platform: 'youtube',
    meta: {
      title: 'Amazing Song (Official Music Video) [4K]!',
      format: 'mp4',
    },
  };
  const filename = getComputedFilename(token);
  assert.equal(filename.endsWith('.mp4'), true);
  assert.ok(filename.includes('Amazing_Song'));
  assert.ok(!/[!\[\]]/.test(filename));
});

test('GET /api/download/:downloadId/direct-url handler behavior', async () => {
  const { directUrlHandler } = await import('./controllers/downloadController.js');
  const { createDownloadToken } = await import('./services/downloadTokenStore.js');

  // 1. Invalid / expired downloadId returns 404
  let status404 = null;
  let json404 = null;
  await directUrlHandler(
    { params: { downloadId: 'nonexistent-token' } },
    {
      status: (code) => {
        status404 = code;
        return { json: (d) => { json404 = d; } };
      },
    }
  );
  assert.equal(status404, 404);
  assert.equal(json404.success, false);

  // 2. Token needing merge returns requiresPrepare: true and fallback flag
  const mergeTokenId = createDownloadToken({
    platform: 'youtube',
    sourceUrl: 'https://rr---sn.googlevideo.com/videoplayback?id=1080',
    meta: {
      title: 'Merged Video',
      format: 'mp4',
      resolution: '1080p',
      audioUrl: 'https://rr---sn.googlevideo.com/audio',
      needsMerge: true,
    },
  });

  let jsonMerge = null;
  await directUrlHandler(
    { params: { downloadId: mergeTokenId } },
    {
      json: (d) => { jsonMerge = d; },
    }
  );
  assert.equal(jsonMerge.success, false);
  assert.equal(jsonMerge.requiresPrepare, true);
  assert.equal(jsonMerge.fallback, true);

  // 3. Token NOT needing merge returns direct URL and computed filename
  const directTokenId = createDownloadToken({
    platform: 'youtube',
    sourceUrl: 'https://rr---sn.googlevideo.com/videoplayback?id=720direct',
    meta: {
      title: 'Direct 720p Video',
      format: 'mp4',
      resolution: '720p',
      needsMerge: false,
    },
  });

  let jsonDirect = null;
  await directUrlHandler(
    { params: { downloadId: directTokenId } },
    {
      json: (d) => { jsonDirect = d; },
    }
  );
  assert.equal(jsonDirect.success, true);
  assert.equal(jsonDirect.requiresPrepare, false);
  assert.equal(jsonDirect.url, 'https://rr---sn.googlevideo.com/videoplayback?id=720direct');
  assert.ok(jsonDirect.filename.includes('Direct_720p_Video'));
});

test('getProxyList parses PROXY_LIST, PROXY_HOST/PORT, and handles empty env', async () => {
  const { getProxyList } = await import('./utils/streamDownloader.js');

  const oldList = process.env.PROXY_LIST;
  const oldHost = process.env.PROXY_HOST;
  const oldPort = process.env.PROXY_PORT;
  const oldUser = process.env.PROXY_USERNAME;
  const oldPass = process.env.PROXY_PASSWORD;

  try {
    // 1. When no proxy env vars are set
    delete process.env.PROXY_LIST;
    delete process.env.PROXY_HOST;
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_USERNAME;
    delete process.env.PROXY_PASSWORD;
    assert.deepEqual(getProxyList(), []);

    // 2. Comma-separated PROXY_LIST with credentials
    process.env.PROXY_LIST = '142.111.48.250:7030, 198.23.239.134:6540';
    process.env.PROXY_USERNAME = 'user123';
    process.env.PROXY_PASSWORD = 'pass!word';

    const proxies = getProxyList();
    assert.equal(proxies.length, 2);
    assert.equal(proxies[0].display, '142.111.48.250:7030');
    assert.ok(proxies[0].url.startsWith('http://user123:pass!word@142.111.48.250:7030'));
    assert.ok(proxies[1].url.startsWith('http://user123:pass!word@198.23.239.134:6540'));

    // 3. Fallback to PROXY_HOST and PROXY_PORT when PROXY_LIST is unset
    delete process.env.PROXY_LIST;
    process.env.PROXY_HOST = '1.2.3.4';
    process.env.PROXY_PORT = '8080';
    const singleProxy = getProxyList();
    assert.equal(singleProxy.length, 1);
    assert.equal(singleProxy[0].display, '1.2.3.4:8080');
  } finally {
    if (oldList !== undefined) process.env.PROXY_LIST = oldList; else delete process.env.PROXY_LIST;
    if (oldHost !== undefined) process.env.PROXY_HOST = oldHost; else delete process.env.PROXY_HOST;
    if (oldPort !== undefined) process.env.PROXY_PORT = oldPort; else delete process.env.PROXY_PORT;
    if (oldUser !== undefined) process.env.PROXY_USERNAME = oldUser; else delete process.env.PROXY_USERNAME;
    if (oldPass !== undefined) process.env.PROXY_PASSWORD = oldPass; else delete process.env.PROXY_PASSWORD;
  }
});




