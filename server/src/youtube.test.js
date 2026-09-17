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
  const result = await adapter.analyze('https://www.youtube.com/watch?v=jNQXAC9IVRw');

  assert.equal(result.platform, 'youtube');
  assert.ok(result.title);
  assert.equal(result.type, 'video');
  assert.ok(Array.isArray(result.formats) && result.formats.length > 0);
  assert.ok(result.formats.some((f) => f.hasVideo && f.sourceUrl));
  assert.ok(result.formats.some((f) => f.hasAudio && f.sourceUrl));
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



