import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { YouTubeAdapter, extractYouTubeVideoId } from './platforms/youtube.js';

function makeRequest(server, options, bodyData = null) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const port = address.port;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        agent: false,
        headers: {
          'Connection': 'close',
          ...(options.headers || {}),
        },
        ...options,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            buffer,
            json: () => JSON.parse(buffer.toString('utf8')),
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyData) {
      req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    }
    req.end();
  });
}

function probeMediaFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeInstaller.path, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height',
      '-of', 'json',
      filePath,
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
    proc.on('error', reject);
  });
}

test('YouTube Adapter - High Quality Video & Shorts Downloading', async (t) => {
  let server;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    if (server.closeAllConnections) server.closeAllConnections();
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await t.test('1. Adapter registration and URL detection (canHandle & videoId extraction)', () => {
    const adapter = getAdapter('youtube');
    assert.ok(adapter, 'YouTubeAdapter must be registered in platform registry');
    assert.strictEqual(adapter.constructor.platformId, 'youtube');

    // Standard watch URLs
    assert.strictEqual(adapter.canHandle('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), true);
    assert.strictEqual(adapter.canHandle('https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=10s'), true);
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'aqz-KE-bpKQ');

    // youtu.be short URLs
    assert.strictEqual(adapter.canHandle('https://youtu.be/jNQXAC9IVRw'), true);
    assert.strictEqual(extractYouTubeVideoId('https://youtu.be/jNQXAC9IVRw'), 'jNQXAC9IVRw');

    // Shorts URLs
    assert.strictEqual(adapter.canHandle('https://www.youtube.com/shorts/v6-3TBOTTak'), true);
    assert.strictEqual(extractYouTubeVideoId('https://www.youtube.com/shorts/v6-3TBOTTak'), 'v6-3TBOTTak');

    // Mobile and embed URLs
    assert.strictEqual(adapter.canHandle('https://m.youtube.com/watch?v=jNQXAC9IVRw'), true);
    assert.strictEqual(adapter.canHandle('https://www.youtube.com/embed/jNQXAC9IVRw'), true);

    // Platform resolver
    const resolved = resolveAdapter('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    assert.ok(resolved, 'resolveAdapter should return YouTubeAdapter for youtube.com');
    assert.strictEqual(resolved.constructor.platformId, 'youtube');

    // Invalid / other platforms
    assert.strictEqual(adapter.canHandle('https://example.com/watch?v=123'), false);
    assert.strictEqual(adapter.canHandle('https://instagram.com/p/123'), false);
    assert.strictEqual(adapter.canHandle('https://facebook.com/reel/123'), false);
    assert.strictEqual(adapter.canHandle('not-a-url'), false);
  });

  await t.test('2. Clean error handling for invalid or unavailable YouTube URLs', async () => {
    // Non-existent 11-char video ID -> adapter limitation error (422)
    const resUnavailable = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.youtube.com/watch?v=00000000000' }
    );
    assert.ok(resUnavailable.statusCode === 422 || resUnavailable.statusCode === 502, `Expected 422 or 502, got ${resUnavailable.statusCode}`);
    const dataUnavailable = resUnavailable.json();
    assert.strictEqual(dataUnavailable.success, false);
    assert.ok(dataUnavailable.error, 'Should contain a friendly error message');

    // Invalid format / malformed URL -> controller bad request (400)
    const resInvalid = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.youtube.com/watch?v=invalid' }
    );
    assert.strictEqual(resInvalid.statusCode, 400);
    const dataInvalid = resInvalid.json();
    assert.strictEqual(dataInvalid.success, false);
  });

  await t.test('3. Analyze: Metadata extraction & quality prioritization (4K/1080p/720p)', async () => {
    const adapter = new YouTubeAdapter();
    const info = await adapter.analyze('https://www.youtube.com/watch?v=aqz-KE-bpKQ');

    assert.strictEqual(info.platform, 'youtube');
    assert.ok(info.title.includes('Big Buck Bunny'), 'Title should be present');
    assert.strictEqual(info.author, 'Blender');
    assert.strictEqual(typeof info.duration, 'number');
    assert.ok(info.duration > 0, 'Duration should be > 0');
    assert.ok(info.thumbnail, 'Thumbnail should be present');

    assert.ok(Array.isArray(info.formats), 'Formats should be an array');
    assert.ok(info.formats.length >= 3, 'Multiple quality tiers should be exposed');

    // Verify ordering: highest resolution must be first
    const firstFormat = info.formats[0];
    assert.ok(
      firstFormat.quality.includes('2160p') || firstFormat.quality.includes('4K'),
      `Highest quality format should be 2160p (4K), got: ${firstFormat.quality}`
    );
    assert.strictEqual(firstFormat.resolution, '3840x2160');
    assert.strictEqual(firstFormat.format, 'mp4');
    assert.strictEqual(firstFormat.hasAudio, true);

    // Verify presence of 1080p and 720p options
    const has1080p = info.formats.some((f) => f.quality.includes('1080p') && f.resolution === '1920x1080');
    const has720p = info.formats.some((f) => f.quality.includes('720p') && f.resolution === '1280x720');
    assert.ok(has1080p, '1080p quality option must be present');
    assert.ok(has720p, '720p quality option must be present');
  });

  await t.test('4. Full Integration Pipeline: Analyze -> Prepare -> Stream for youtu.be link', async () => {
    // 1. Analyze
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://youtu.be/jNQXAC9IVRw' }
    );
    assert.strictEqual(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.strictEqual(analyzeData.success, true);
    assert.strictEqual(analyzeData.platform, 'youtube');
    assert.strictEqual(analyzeData.title, 'Me at the zoo');
    assert.ok(analyzeData.formats.length > 0);

    const targetFormat = analyzeData.formats[0];
    assert.ok(targetFormat.downloadId, 'Must have a downloadId token');

    // 2. Prepare
    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${targetFormat.downloadId}/prepare`, method: 'POST' }
    );
    assert.strictEqual(prepareRes.statusCode, 200);
    const prepareData = prepareRes.json();
    assert.strictEqual(prepareData.success, true);
    assert.ok(prepareData.streamId, 'Must return a valid streamId');
    assert.strictEqual(prepareData.mimeType, 'video/mp4');
    assert.ok(prepareData.sizeBytes > 0, 'sizeBytes must be positive');

    // 3. Stream
    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.strictEqual(streamRes.statusCode, 200);
    assert.strictEqual(streamRes.headers['content-type'], 'video/mp4');
    assert.strictEqual(streamRes.headers['x-content-type-options'], 'nosniff');
    assert.ok(streamRes.buffer.length > 0, 'Downloaded buffer must not be empty');
    assert.strictEqual(streamRes.buffer.length, prepareData.sizeBytes);

    // Verify MP4 signature: ftyp box at byte 4
    const ftyp = streamRes.buffer.toString('ascii', 4, 8);
    assert.strictEqual(ftyp, 'ftyp', 'Must be a valid MP4 file containing ftyp header box');
  });

  await t.test('5. Live Real-World Test: YouTube Shorts with 1080p Resolution & Audio verification', async () => {
    // Analyze YouTube Short URL
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.youtube.com/shorts/v6-3TBOTTak' }
    );
    assert.strictEqual(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.strictEqual(analyzeData.success, true);
    assert.strictEqual(analyzeData.platform, 'youtube');
    assert.strictEqual(analyzeData.type, 'short');

    // Find 1080p format or top format
    const fmt1080 = analyzeData.formats.find((f) => f.quality.includes('1080')) || analyzeData.formats[0];
    assert.ok(fmt1080, 'Must have high-quality format option');
    assert.ok(fmt1080.resolution.includes('1080') || fmt1080.resolution.includes('1920'), 'Resolution must reflect 1080p');

    // Prepare
    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${fmt1080.downloadId}/prepare`, method: 'POST' }
    );
    assert.strictEqual(prepareRes.statusCode, 200);
    const prepareData = prepareRes.json();
    assert.strictEqual(prepareData.success, true);
    assert.ok(prepareData.sizeBytes > 1000000, 'Short video should be of realistic size (>1MB)');

    // Stream
    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.strictEqual(streamRes.statusCode, 200);
    assert.strictEqual(streamRes.headers['content-type'], 'video/mp4');

    // Write temp file to probe streams with ffprobe
    const tmpFile = path.join(os.tmpdir(), `test_short_${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, streamRes.buffer);

    try {
      const probe = await probeMediaFile(tmpFile);
      assert.ok(Array.isArray(probe.streams), 'Streams must be present');

      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      const audioStream = probe.streams.find((s) => s.codec_type === 'audio');

      assert.ok(videoStream, 'Output MP4 must contain video stream');
      assert.ok(audioStream, 'Output MP4 must contain audio stream');

      // Verify exact resolution matches source 1080p
      assert.strictEqual(videoStream.width, 1080, 'Video width must be 1080');
      assert.strictEqual(videoStream.height, 1920, 'Video height must be 1920');
      assert.strictEqual(videoStream.codec_name, 'h264', 'Video codec must be h264');
      assert.strictEqual(audioStream.codec_name, 'aac', 'Audio codec must be aac');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  await t.test('6. Live Real-World Test: Standard 1080p Public Video Resolution Verification (1920x1080)', async () => {
    const adapter = new YouTubeAdapter();
    const info = await adapter.analyze('https://www.youtube.com/watch?v=M7FIvfx5J10');

    // Explicitly locate the 1080p quality option
    const fmt1080 = info.formats.find((f) => f.quality.includes('1080p'));
    assert.ok(fmt1080, '1080p format option must be found');
    assert.strictEqual(fmt1080.resolution, '1920x1080', 'Reported source resolution must be 1920x1080');

    // Download format
    const downloadResult = await adapter.download('https://www.youtube.com/watch?v=M7FIvfx5J10', {
      formatId: fmt1080.id,
      meta: fmt1080.meta,
    });

    assert.ok(downloadResult._tempFilePath, 'Should return a prepared temp file');
    assert.strictEqual(downloadResult.mimeType, 'video/mp4');

    try {
      const probe = await probeMediaFile(downloadResult._tempFilePath);
      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      const audioStream = probe.streams.find((s) => s.codec_type === 'audio');

      assert.ok(videoStream, 'Downloaded file must contain video stream');
      assert.ok(audioStream, 'Downloaded file must contain audio stream');

      // Crucial requirement: Downloaded resolution MUST match selected source resolution
      assert.strictEqual(videoStream.width, 1920, 'Downloaded video width must be 1920');
      assert.strictEqual(videoStream.height, 1080, 'Downloaded video height must be 1080');
      assert.strictEqual(videoStream.codec_name, 'h264', 'Downloaded video codec must be h264');
      assert.strictEqual(audioStream.codec_name, 'aac', 'Downloaded audio codec must be aac');
    } finally {
      downloadResult.stream.destroy();
      fs.unlinkSync(downloadResult._tempFilePath);
    }
  });
});
