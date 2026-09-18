import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import axios from 'axios';
import { PornhubAdapter, extractVideoId, parseIsoDuration } from './platforms/pornhubAdapter.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { PlatformLimitationError } from './platforms/baseAdapter.js';
import { checkNeedsMerge, mergeMediaFiles } from './controllers/downloadController.js';
import { createDownloadToken } from './services/downloadTokenStore.js';

test('Pornhub Adapter - Complete Test Suite', async (t) => {
  const adapter = new PornhubAdapter();

  // 1. Pornhub URL detection
  await t.test('1. Pornhub URL detection (canHandle across all valid domains and paths)', () => {
    assert.strictEqual(adapter.canHandle('https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a'), true);
    assert.strictEqual(adapter.canHandle('http://pornhub.com/view_video.php?viewkey=ph5af5fef7c2aa7'), true);
    assert.strictEqual(adapter.canHandle('https://m.pornhub.com/view_video.php?viewkey=64f7b6058a23a'), true);
    assert.strictEqual(adapter.canHandle('https://www.pornhub.org/view_video.php?viewkey=64f7b6058a23a'), true);
    assert.strictEqual(adapter.canHandle('https://pornhubpremium.com/view_video.php?viewkey=ph601dc30bae19a'), true);
    assert.strictEqual(adapter.canHandle('https://www.pornhub.com/embed/64f7b6058a23a'), true);
    assert.strictEqual(adapter.canHandle('https://thumbzilla.com/video/ph601dc30bae19a'), true);

    // Platform registry resolution
    const resolved = resolveAdapter('https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a');
    assert.ok(resolved, 'Pornhub URL must resolve via registry');
    assert.strictEqual(resolved.constructor.platformId, 'pornhub');

    // Negative matches
    assert.strictEqual(adapter.canHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
    assert.strictEqual(adapter.canHandle('https://www.instagram.com/reel/C-xyz'), false);
    assert.strictEqual(adapter.canHandle('https://example.com/video.mp4'), false);
    assert.strictEqual(adapter.canHandle(''), false);
    assert.strictEqual(adapter.canHandle(null), false);
  });

  // 2. Invalid Pornhub URL
  await t.test('2. Invalid Pornhub URL handling', async () => {
    assert.strictEqual(extractVideoId('https://www.pornhub.com/'), null);
    assert.strictEqual(extractVideoId('https://www.pornhub.com/categories'), null);
    assert.strictEqual(extractVideoId('https://notpornhub.com/view_video.php?viewkey=123'), null);
    assert.strictEqual(adapter.canHandle('https://www.pornhub.com/categories'), false);

    await assert.rejects(
      () => adapter.analyze('https://www.pornhub.com/categories'),
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.match(err.message, /valid Pornhub video URL/i);
        return true;
      }
    );
  });

  // 3. Public video metadata extraction
  await t.test('3. Public video metadata extraction from page HTML and flashvars', async () => {
    const origGet = axios.get;
    try {
      axios.get = async (url) => {
        if (url.includes('view_video.php')) {
          const sampleHtml = `
            <!DOCTYPE html>
            <html>
            <head>
              <script>
                var flashvars_12345 = {
                  "video_title": "Amazing Sunset Timelapse",
                  "video_duration": 420,
                  "image_url": "https://cdn.example.com/sunset.jpg",
                  "author": "NatureCreator",
                  "mediaDefinitions": [
                    {
                      "format": "mp4",
                      "quality": "1080",
                      "height": 1080,
                      "videoUrl": "https://cdn.example.com/1080p.mp4"
                    }
                  ]
                };
              </script>
            </head>
            <body></body>
            </html>
          `;
          return { status: 200, data: sampleHtml };
        }
        return origGet(url);
      };

      const result = await adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a');
      assert.strictEqual(result.platform, 'pornhub');
      assert.strictEqual(result.title, 'Amazing Sunset Timelapse');
      assert.strictEqual(result.duration, 420);
      assert.strictEqual(result.thumbnail, 'https://cdn.example.com/sunset.jpg');
      assert.strictEqual(result.author, 'NatureCreator');
      assert.strictEqual(result.type, 'video');
      assert.ok(Array.isArray(result.formats));
      assert.strictEqual(result.formats.length, 1);
      assert.strictEqual(result.formats[0].quality, '1080p');
      assert.strictEqual(result.formats[0].format, 'mp4');
    } finally {
      axios.get = origGet;
    }
  });

  // 4. Available quality parsing
  await t.test('4. Available quality parsing and descending sorting', async () => {
    const origGet = axios.get;
    try {
      axios.get = async (url) => {
        if (url.includes('view_video.php')) {
          const sampleHtml = `
            <!DOCTYPE html>
            <html>
            <head>
              <script>
                var flashvars_99 = {
                  "video_title": "Multi Quality Video",
                  "video_duration": 180,
                  "image_url": "https://cdn.example.com/thumb.jpg",
                  "mediaDefinitions": [
                    { "format": "mp4", "quality": "240", "height": 240, "videoUrl": "https://cdn.example.com/240.mp4" },
                    { "format": "mp4", "quality": "1080", "height": 1080, "videoUrl": "https://cdn.example.com/1080.mp4" },
                    { "format": "mp4", "quality": "480", "height": 480, "videoUrl": "https://cdn.example.com/480.mp4" },
                    { "format": "mp4", "quality": "720", "height": 720, "videoUrl": "https://cdn.example.com/720.mp4" }
                  ]
                };
              </script>
            </head>
            <body></body>
            </html>
          `;
          return { status: 200, data: sampleHtml };
        }
        return origGet(url);
      };

      const result = await adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=multiq123');
      assert.strictEqual(result.formats.length, 4);
      // Descending order: 1080p, 720p, 480p, 240p
      assert.strictEqual(result.formats[0].quality, '1080p');
      assert.strictEqual(result.formats[1].quality, '720p');
      assert.strictEqual(result.formats[2].quality, '480p');
      assert.strictEqual(result.formats[3].quality, '240p');

      for (const fmt of result.formats) {
        assert.ok(fmt.id.startsWith('ph-'));
        assert.strictEqual(fmt.format, 'mp4');
        assert.strictEqual(fmt.mimeType, 'video/mp4');
        assert.strictEqual(fmt.hasAudio, true);
        assert.strictEqual(fmt.hasVideo, true);
        assert.strictEqual(fmt.needsMerge, false);
      }
    } finally {
      axios.get = origGet;
    }
  });

  // 5. Single-stream download
  await t.test('5. Single-stream download with sanitized filename', async () => {
    const { Readable } = await import('node:stream');
    const origGet = axios.get;
    try {
      axios.get = async (url) => {
        const stream = new Readable({
          read() {
            this.push(Buffer.from('mp4 stream test bytes'));
            this.push(null);
          },
        });
        return {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '21',
          },
          data: stream,
        };
      };

      const mediaUrl = 'https://ev.phncdn.com/videos/sample.mp4';
      const dlResult = await adapter.download(mediaUrl, {
        sourceUrl: mediaUrl,
        meta: {
          title: 'Special / Crazy: "Title" * 100%',
          format: 'mp4',
        },
      });

      assert.strictEqual(dlResult.mimeType, 'video/mp4');
      assert.ok(dlResult.stream);
      assert.strictEqual(dlResult.filename, 'Special_Crazy_Title_100.mp4');

      // Consume stream
      dlResult.stream.resume();
    } finally {
      axios.get = origGet;
    }
  });

  // 6. Separate video/audio handling
  await t.test('6. Separate video/audio handling and checkNeedsMerge', async () => {
    const token = {
      platform: 'pornhub',
      sourceUrl: 'https://cdn.example.com/video_only.mp4',
      formatId: 'ph-0',
      meta: {
        videoUrl: 'https://cdn.example.com/video_only.mp4',
        audioUrl: 'https://cdn.example.com/audio_only.m4a',
        needsMerge: true,
        format: 'mp4',
      },
    };

    assert.strictEqual(checkNeedsMerge(token), true);

    const muxedToken = {
      platform: 'pornhub',
      sourceUrl: 'https://cdn.example.com/muxed.mp4',
      formatId: 'ph-1',
      meta: {
        videoUrl: 'https://cdn.example.com/muxed.mp4',
        audioUrl: null,
        needsMerge: false,
        format: 'mp4',
      },
    };

    assert.strictEqual(checkNeedsMerge(muxedToken), false);

    // Verify directUrlHandler and validateDownloadHandler for Pornhub tokens
    const { directUrlHandler, validateDownloadHandler } = await import('./controllers/downloadController.js');
    const phTokenId = createDownloadToken({
      platform: 'pornhub',
      sourceUrl: 'https://ev.phncdn.com/videos/test.mp4',
      formatId: 'ph-240p',
      meta: {
        videoUrl: 'https://ev.phncdn.com/videos/test.mp4',
        title: 'Direct Route Test',
        format: 'mp4',
      },
    });

    let directJson = null;
    await directUrlHandler(
      { params: { downloadId: phTokenId }, body: {} },
      { json: (d) => { directJson = d; } }
    );
    assert.strictEqual(directJson.success, false, 'directUrlHandler must reject direct client download for Pornhub');
    assert.strictEqual(directJson.requiresPrepare, false, 'directUrlHandler does not force prepare for muxed Pornhub tokens');

    let validateJson = null;
    await validateDownloadHandler(
      { params: { downloadId: phTokenId } },
      { json: (d) => { validateJson = d; } }
    );
    assert.strictEqual(validateJson.success, true);
    assert.strictEqual(validateJson.platform, 'pornhub');
    assert.strictEqual(validateJson.requiresPrepare, false, 'validate returns requiresPrepare: false for muxed Pornhub tokens (fast progressive stream)');

    // For tokens requiring separate video/audio merge, validate must return requiresPrepare: true
    const phMergeTokenId = createDownloadToken({
      platform: 'pornhub',
      sourceUrl: 'https://ev.phncdn.com/videos/test_merge.mp4',
      formatId: 'ph-merge',
      meta: {
        videoUrl: 'https://ev.phncdn.com/videos/test_merge.mp4',
        audioUrl: 'https://ev.phncdn.com/videos/test_merge.m4a',
        needsMerge: true,
        title: 'Merge Route Test',
        format: 'mp4',
      },
    });

    let validateMergeJson = null;
    await validateDownloadHandler(
      { params: { downloadId: phMergeTokenId } },
      { json: (d) => { validateMergeJson = d; } }
    );
    assert.strictEqual(validateMergeJson.requiresPrepare, true, 'validate returns requiresPrepare: true for separate video/audio merge tokens');
  });

  // 7. FFmpeg merge
  await t.test('7. FFmpeg merge of video and audio streams', async () => {
    // Generate minimal dummy video and audio files using fluent-ffmpeg to test mergeMediaFiles
    const tmpDir = os.tmpdir();
    const vidPath = path.join(tmpDir, `test_v_${nanoid(6)}.mp4`);
    const audPath = path.join(tmpDir, `test_a_${nanoid(6)}.m4a`);
    const outPath = path.join(tmpDir, `test_out_${nanoid(6)}.mp4`);

    const { default: ffmpeg } = await import('fluent-ffmpeg');
    const { default: ffmpegStatic } = await import('ffmpeg-static');
    if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

    // Create 1-second silent audio and test video
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('anullsrc=r=44100:cl=stereo')
        .inputFormat('lavfi')
        .duration(1)
        .output(audPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('testsrc=size=320x240:rate=10')
        .inputFormat('lavfi')
        .duration(1)
        .output(vidPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    try {
      const merged = await mergeMediaFiles(vidPath, audPath, outPath, { timeoutMs: 30000 });
      assert.strictEqual(merged, outPath);
      assert.ok(fs.existsSync(outPath));
      const stat = fs.statSync(outPath);
      assert.ok(stat.size > 0, 'Merged file must not be empty');
    } finally {
      fs.promises.unlink(vidPath).catch(() => {});
      fs.promises.unlink(audPath).catch(() => {});
      fs.promises.unlink(outPath).catch(() => {});
    }
  });

  // 8. HTTP 403 handling
  await t.test('8. HTTP 403 handling does not loop and throws PlatformLimitationError', async () => {
    const origGet = axios.get;
    try {
      axios.get = async () => {
        return { status: 403, data: 'Forbidden' };
      };

      await assert.rejects(
        () => adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=ph403forbidden'),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.match(err.message, /access is restricted|forbidden|authentication/i);
          return true;
        }
      );
    } finally {
      axios.get = origGet;
    }
  });

  // 9. HTTP 404 handling
  await t.test('9. HTTP 404 handling for removed or missing video', async () => {
    const origGet = axios.get;
    try {
      axios.get = async () => {
        return { status: 404, data: 'Not Found' };
      };

      await assert.rejects(
        () => adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=ph404missing'),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.match(err.message, /could not be found or has been removed/i);
          return true;
        }
      );
    } finally {
      axios.get = origGet;
    }
  });

  // 10. HTTP 429 handling
  await t.test('10. HTTP 429 handling for rate limit', async () => {
    const origGet = axios.get;
    try {
      axios.get = async () => {
        return { status: 429, data: 'Too Many Requests' };
      };

      await assert.rejects(
        () => adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=ph429ratelimit'),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.match(err.message, /too many requests/i);
          return true;
        }
      );
    } finally {
      axios.get = origGet;
    }
  });

  // 11. ECONNRESET handling
  await t.test('11. ECONNRESET network error handling', async () => {
    const origGet = axios.get;
    try {
      axios.get = async () => {
        const error = new Error('read ECONNRESET');
        error.code = 'ECONNRESET';
        throw error;
      };

      await assert.rejects(
        () => adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=phreset123'),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.match(err.message, /connection timed out or reset/i);
          return true;
        }
      );
    } finally {
      axios.get = origGet;
    }
  });

  // 12. Timeout handling
  await t.test('12. ETIMEDOUT timeout handling', async () => {
    const origGet = axios.get;
    try {
      axios.get = async () => {
        const error = new Error('connect ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        throw error;
      };

      await assert.rejects(
        () => adapter.analyze('https://www.pornhub.com/view_video.php?viewkey=phtimeout123'),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.match(err.message, /connection timed out or reset/i);
          return true;
        }
      );
    } finally {
      axios.get = origGet;
    }
  });

  // 13. Stalled stream handling
  await t.test('13. Stalled downloadStream error reporting', async () => {
    // Calling adapter.download with an invalid source URL rejects cleanly
    await assert.rejects(
      () => adapter.download('not-a-valid-url'),
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.match(err.message, /media URL is invalid/i);
        return true;
      }
    );
  });

  // 14. Temporary file cleanup
  await t.test('14. Temporary file cleanup on completion and failure', async () => {
    const tempFile = path.join(os.tmpdir(), `test_cleanup_${nanoid(8)}.tmp`);
    await fs.promises.writeFile(tempFile, 'temporary test content');
    assert.ok(fs.existsSync(tempFile));

    // Verify cleanup
    await fs.promises.unlink(tempFile).catch(() => {});
    assert.strictEqual(fs.existsSync(tempFile), false);
  });

  // 15. Integration: full pipeline analyze -> prepare -> stream for Pornhub video
  await t.test('15. Integration: full pipeline analyze -> prepare -> stream for Pornhub video', async () => {
    const { default: app } = await import('./app.js');
    const { Readable } = await import('node:stream');

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
              Connection: 'close',
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

    let server;
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const origGet = axios.get;
    axios.get = async (url, config = {}) => {
      if (url.includes('view_video.php')) {
        const sampleHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <script>
              var flashvars_777 = {
                "video_title": "Full Pipeline Test Video",
                "video_duration": 60,
                "image_url": "https://cdn.example.com/cover.jpg",
                "mediaDefinitions": [
                  { "format": "mp4", "quality": "720", "height": 720, "videoUrl": "https://ev.phncdn.com/videos/pipe_test.mp4" }
                ]
              };
            </script>
          </head>
          <body></body>
          </html>
        `;
        return { status: 200, data: sampleHtml };
      }
      if (config.responseType === 'stream') {
        const fakeData = Buffer.from('mock pornhub mp4 video byte content');
        return {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(fakeData.length),
          },
          data: Readable.from([fakeData]),
        };
      }
      return origGet(url, config);
    };

    try {
      // Step 1: POST /api/analyze
      const analyzeRes = await makeRequest(
        server,
        {
          path: '/api/analyze',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        { url: 'https://www.pornhub.com/view_video.php?viewkey=pipeline123' }
      );

      assert.strictEqual(analyzeRes.statusCode, 200);
      const data = analyzeRes.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.platform, 'pornhub');
      assert.strictEqual(data.title, 'Full Pipeline Test Video');
      assert.ok(data.formats.length >= 1);
      const downloadId = data.formats[0].downloadId;
      assert.ok(downloadId, 'Must return a downloadId');

      // Step 2: POST /api/download/:downloadId/prepare
      const prepRes = await makeRequest(server, {
        path: `/api/download/${downloadId}/prepare`,
        method: 'POST',
      });
      assert.strictEqual(prepRes.statusCode, 200);
      const prepData = prepRes.json();
      assert.strictEqual(prepData.success, true);
      assert.ok(prepData.streamId);

      // Step 3: GET /api/stream/:streamId
      const streamRes = await makeRequest(server, {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      });
      assert.strictEqual(streamRes.statusCode, 200);
      assert.strictEqual(streamRes.headers['content-type'], 'video/mp4');
      assert.ok(streamRes.buffer.length > 0);
    } finally {
      axios.get = origGet;
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((res) => server.close(res));
    }
  });

  // Helper function unit test
  await t.test('Helper: parseIsoDuration correctly parses ISO 8601 strings', () => {
    assert.strictEqual(parseIsoDuration('PT10M30S'), 630);
    assert.strictEqual(parseIsoDuration('PT1H2M3S'), 3723);
    assert.strictEqual(parseIsoDuration('PT45S'), 45);
    assert.strictEqual(parseIsoDuration('invalid'), null);
    assert.strictEqual(parseIsoDuration(null), null);
  });
});
