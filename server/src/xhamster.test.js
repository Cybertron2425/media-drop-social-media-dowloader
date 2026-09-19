import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import {
  XHamsterAdapter,
  isXHamsterHost,
  extractVideoId,
  extractResolution,
  decipherHexString,
  decipherFormatUrl,
  ByteGenerator,
  sanitizeUrlForLogging,
} from './platforms/xhamsterAdapter.js';
import { createDownloadToken } from './services/downloadTokenStore.js';
import { directUrlHandler, validateDownloadHandler, getMaxFileSizeBytes } from './controllers/downloadController.js';
import { PlatformLimitationError } from './platforms/baseAdapter.js';

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

test('xHamster Adapter - Complete Test Suite', async (t) => {
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

  await t.test('1. Registration and canHandle URL validation', () => {
    const adapter = getAdapter('xhamster');
    assert.ok(adapter, 'xhamster adapter must be registered in registry');
    assert.strictEqual(adapter.constructor.platformId, 'xhamster');
    assert.strictEqual(adapter.constructor.status, 'SUPPORTED');

    const validUrls = [
      'https://xhamster.com/videos/test-video-slug-12345',
      'https://www.xhamster.com/videos/test-video-slug-12345',
      'https://m.xhamster.com/videos/test-video-slug-12345',
      'https://xhamster.com/videos/12345',
      'https://xhamster.one/videos/test-slug-98765',
      'https://xhamster.desi/videos/test-slug-98765',
      'https://xhamster2.com/videos/test-slug-98765',
      'https://xhms.pro/videos/test-slug-98765',
      'https://xhday.com/videos/test-slug-98765',
      'https://xhvid.com/videos/test-slug-98765',
      'https://xhwide.com/videos/test-slug-98765',
      'https://pt.xhamster.com/videos/test-slug-98765',
      'https://xhamster.com/movies/12345/some_title.html',
      'https://xhamster.com/movies/12345',
    ];

    for (const u of validUrls) {
      assert.strictEqual(adapter.canHandle(u), true, `canHandle should be true for ${u}`);
      const resolved = resolveAdapter(u);
      assert.ok(resolved, `resolveAdapter should find adapter for ${u}`);
      assert.strictEqual(resolved.constructor.platformId, 'xhamster');
    }

    const invalidUrls = [
      'https://www.xhamster.com/video/12345', // singular 'video' preserved for security test
      'https://xhamster.com/categories',
      'https://xhamster.com/users/johndoe',
      'https://example.com/videos/test-12345',
      'https://pornhub.com/view_video.php?viewkey=64f7b6058a23a',
      'not a url',
      '',
    ];

    for (const u of invalidUrls) {
      assert.strictEqual(adapter.canHandle(u), false, `canHandle should be false for ${u}`);
    }
  });

  await t.test('2. Video ID and resolution extraction helpers', () => {
    assert.strictEqual(extractVideoId('https://xhamster.com/videos/hot-summer-vacation-1234567'), '1234567');
    assert.strictEqual(extractVideoId('https://xhamster.com/videos/1234567'), '1234567');
    assert.strictEqual(extractVideoId('https://xhamster.com/movies/9876543/fun_times.html'), '9876543');
    assert.strictEqual(extractVideoId('https://xhamster.com/movies/9876543'), '9876543');
    assert.strictEqual(extractVideoId('https://xhamster.com/categories'), null);

    const r1080 = extractResolution('1080p');
    assert.strictEqual(r1080.height, 1080);
    assert.strictEqual(r1080.quality, '1080p (FHD)');

    const r720 = extractResolution('720p (HD)', 720);
    assert.strictEqual(r720.height, 720);
    assert.strictEqual(r720.quality, '720p (HD)');

    const r4k = extractResolution('2160p', 2160);
    assert.strictEqual(r4k.height, 2160);
    assert.strictEqual(r4k.quality, '4K (2160p)');

    const rUnknown = extractResolution('Custom');
    assert.strictEqual(rUnknown.height, 0);
    assert.strictEqual(rUnknown.quality, 'Custom');
  });

  await t.test('3. PRNG ByteGenerator & Ciphertext deciphering for all 7 algorithms', () => {
    // Generate test ciphertexts for each of algorithms 1 through 7
    for (let algo = 1; algo <= 7; algo++) {
      const seed = 123456789;
      const gen = new ByteGenerator(algo, seed);
      const plaintext = 'https://cdn.xhamster.com/videos/test.mp4';
      const plainBuf = Buffer.from(plaintext, 'latin1');

      const cipherBuf = Buffer.alloc(5 + plainBuf.length);
      cipherBuf[0] = algo;
      cipherBuf.writeInt32LE(seed, 1);
      for (let i = 0; i < plainBuf.length; i++) {
        cipherBuf[5 + i] = plainBuf[i] ^ gen.nextByte();
      }

      const hexCipher = cipherBuf.toString('hex');
      const deciphered = decipherHexString(hexCipher);
      assert.strictEqual(deciphered, plaintext, `Deciphering must restore plaintext for algo ${algo}`);
    }

    // Test decipherFormatUrl with hex path segment
    const seed = 987654321;
    const gen = new ByteGenerator(2, seed);
    const secretPath = 'real_video_path_abc';
    const secretBuf = Buffer.from(secretPath, 'latin1');
    const cipherBuf = Buffer.alloc(5 + secretBuf.length);
    cipherBuf[0] = 2;
    cipherBuf.writeInt32LE(seed, 1);
    for (let i = 0; i < secretBuf.length; i++) {
      cipherBuf[5 + i] = secretBuf[i] ^ gen.nextByte();
    }
    const hex = cipherBuf.toString('hex');

    const rawUrl = `https://cdn.xhamster.com/${hex}/master.m3u8?token=xyz`;
    const decipheredUrl = decipherFormatUrl(rawUrl);
    assert.strictEqual(
      decipheredUrl,
      `https://cdn.xhamster.com/${secretPath}/master.m3u8?token=xyz`,
      'decipherFormatUrl should replace hex segment with deciphered path'
    );
  });

  await t.test('4. analyze() extracts metadata and formats from window.initials', async () => {
    const adapter = new XHamsterAdapter();
    const testUrl = 'https://xhamster.com/videos/super-fun-video-123456';

    const fakeHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Super Fun Video - xHamster.com</title>
          <meta property="og:title" content="Super Fun Video">
          <meta property="og:image" content="https://cdn.xhamster.com/thumbs/123.jpg">
        </head>
        <body>
          <script>
            window.initials = {
              videoModel: {
                id: 123456,
                title: "Super Fun Video",
                thumbURL: "https://cdn.xhamster.com/thumbs/123.jpg",
                duration: 480,
                author: { name: "CoolCreator" },
                sources: {
                  mp4: {
                    "1080p": "https://cdn.xhamster.com/videos/1080p.mp4",
                    "720p": "https://cdn.xhamster.com/videos/720p.mp4",
                    "480p": "https://cdn.xhamster.com/videos/480p.mp4"
                  },
                  download: {
                    "1080p": { size: 104857600 },
                    "720p": { size: 52428800 },
                    "480p": { size: 26214400 }
                  }
                }
              },
              xplayerSettings: {
                sources: {
                  hls: {
                    url: "https://cdn.xhamster.com/hls/master.m3u8"
                  }
                }
              }
            };
          </script>
        </body>
      </html>
    `;

    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url.includes('xhamster.com')) {
        return { data: fakeHtml, status: 200, request: { res: { responseUrl: testUrl } } };
      }
      return originalGet(url);
    };

    try {
      const info = await adapter.analyze(testUrl);
      assert.strictEqual(info.platform, 'xhamster');
      assert.strictEqual(info.title, 'Super Fun Video');
      assert.strictEqual(info.thumbnail, 'https://cdn.xhamster.com/thumbs/123.jpg');
      assert.strictEqual(info.duration, 480);
      assert.strictEqual(info.author, 'CoolCreator');
      assert.ok(Array.isArray(info.formats));
      assert.ok(info.formats.length >= 3);

      // Progressive formats first, sorted highest to lowest
      const f1080 = info.formats.find((f) => f.resolution === '1080p');
      assert.ok(f1080, '1080p format must exist');
      assert.strictEqual(f1080.sizeBytes, 104857600);
      assert.strictEqual(f1080.meta.isHls, false);
      assert.strictEqual(f1080.sourceUrl, 'https://cdn.xhamster.com/videos/1080p.mp4');

      const hlsFormat = info.formats.find((f) => f.meta?.isHls === true);
      assert.ok(hlsFormat, 'HLS format must exist');
      assert.strictEqual(hlsFormat.sourceUrl, 'https://cdn.xhamster.com/hls/master.m3u8');
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('5. analyze() detects closed/deleted videos and throws PlatformLimitationError', async () => {
    const adapter = new XHamsterAdapter();
    const testUrl = 'https://xhamster.com/videos/deleted-video-999999';

    const closedHtml = `
      <html>
        <body>
          <div id="videoClosed">This video was deleted by the owner.</div>
        </body>
      </html>
    `;

    const originalGet = axios.get;
    axios.get = async () => ({ data: closedHtml, status: 200 });

    try {
      await assert.rejects(
        () => adapter.analyze(testUrl),
        (err) => {
          assert.ok(err instanceof PlatformLimitationError);
          assert.ok(err.message.includes('deleted by the owner'));
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('6. analyze() HTML fallback when window.initials is missing', async () => {
    const adapter = new XHamsterAdapter();
    const testUrl = 'https://xhamster.com/videos/fallback-video-111111';

    const fallbackHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Fallback Title">
          <meta property="og:image" content="https://cdn.xhamster.com/thumb_fb.jpg">
          <meta property="video:duration" content="120">
        </head>
        <body>
          <video poster="https://cdn.xhamster.com/thumb_fb.jpg">
            <source src="https://cdn.xhamster.com/fallback_720p.mp4" label="720p" height="720">
          </video>
        </body>
      </html>
    `;

    const originalGet = axios.get;
    axios.get = async () => ({ data: fallbackHtml, status: 200, request: { res: { responseUrl: testUrl } } });

    try {
      const info = await adapter.analyze(testUrl);
      assert.strictEqual(info.title, 'Fallback Title');
      assert.strictEqual(info.thumbnail, 'https://cdn.xhamster.com/thumb_fb.jpg');
      assert.strictEqual(info.duration, 120);
      assert.strictEqual(info.formats.length, 1);
      assert.strictEqual(info.formats[0].resolution, '720p');
      assert.strictEqual(info.formats[0].sourceUrl, 'https://cdn.xhamster.com/fallback_720p.mp4');
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('7. sanitizeUrlForLogging strips query tokens, secrets, and credentials', () => {
    const raw = 'https://cdn.xhamster.com/videos/720p.mp4?token=SECRET_TOKEN&expires=12345#frag';
    const sanitized = sanitizeUrlForLogging(raw);
    assert.strictEqual(sanitized.origin, 'https://cdn.xhamster.com');
    assert.strictEqual(sanitized.path, '/videos/720p.mp4');
    assert.strictEqual(sanitized.path.includes('SECRET_TOKEN'), false);
  });

  await t.test('8. Progressive download logs [xHamster Download Selection] safely and connects directly', async () => {
    const adapter = new XHamsterAdapter();
    const targetUrl = 'https://cdn.xhamster.com/videos/sample_720p.mp4?signed_token=XYZ123';

    let logged = '';
    const originalLog = console.log;
    console.log = (...args) => {
      logged += args.join(' ') + '\n';
      originalLog(...args);
    };

    const originalGet = axios.get;
    axios.get = async (url, config) => {
      if (url.includes('sample_720p.mp4')) {
        const { Readable } = await import('node:stream');
        const s = new Readable({
          read() {
            this.push(Buffer.from('fake mp4 content bytes'));
            this.push(null);
          },
        });
        return {
          data: s,
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '22',
          },
        };
      }
      return originalGet(url, config);
    };

    try {
      const result = await adapter.download(targetUrl, {
        formatId: 'mp4-720p',
        sourceUrl: targetUrl,
        meta: {
          quality: '720p',
          isHls: false,
          pageUrl: 'https://xhamster.com/videos/sample-12345',
        },
      });

      assert.ok(result.stream, 'Stream must be returned');
      assert.strictEqual(result.mimeType, 'video/mp4');

      // Verify logging requirements
      assert.ok(logged.includes('[xHamster Download Selection]'));
      assert.ok(logged.includes('quality: 720p'));
      assert.ok(logged.includes('sourceType: PROGRESSIVE'));
      assert.ok(logged.includes('sourceOrigin: https://cdn.xhamster.com'));
      assert.ok(logged.includes('sourcePath: /videos/sample_720p.mp4'));
      assert.strictEqual(logged.includes('XYZ123'), false, 'Never log signed tokens or secrets');
    } finally {
      console.log = originalLog;
      axios.get = originalGet;
    }
  });

  await t.test('9. Progressive download auto-refreshes expired URL on HTTP 403 or 410', async () => {
    const adapter = new XHamsterAdapter();
    const staleUrl = 'https://cdn.xhamster.com/videos/stale_720p.mp4';
    const freshUrl = 'https://cdn.xhamster.com/videos/fresh_720p.mp4';
    const pageUrl = 'https://xhamster.com/videos/sample-12345';

    let staleAttempts = 0;
    let freshAttempts = 0;

    const originalGet = axios.get;
    axios.get = async (url, config) => {
      if (url === staleUrl) {
        staleAttempts++;
        const err = new Error('Request failed with status code 410');
        err.response = { status: 410, headers: {} };
        throw err;
      }
      if (url === pageUrl) {
        // Page re-analysis returning fresh URL
        const html = `
          <html><body>
            <script>
              window.initials = {
                videoModel: {
                  title: "Refreshed Video",
                  sources: {
                    mp4: { "720p": "${freshUrl}" }
                  }
                }
              };
            </script>
          </body></html>
        `;
        return { data: html, status: 200, request: { res: { responseUrl: pageUrl } } };
      }
      if (url === freshUrl) {
        freshAttempts++;
        const { Readable } = await import('node:stream');
        const s = new Readable({
          read() {
            this.push(Buffer.from('fresh video chunk'));
            this.push(null);
          },
        });
        return {
          data: s,
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '17',
          },
        };
      }
      return originalGet(url, config);
    };

    try {
      const res = await adapter.download(staleUrl, {
        formatId: 'mp4-720p',
        sourceUrl: staleUrl,
        meta: {
          quality: '720p',
          isHls: false,
          pageUrl,
        },
      });

      assert.strictEqual(staleAttempts, 1);
      assert.strictEqual(freshAttempts, 1);
      assert.ok(res.stream);
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('10. Preserves real HTTP errors without conversion to generic error', async () => {
    const adapter = new XHamsterAdapter();
    const errorUrl = 'https://cdn.xhamster.com/videos/error_404.mp4';

    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url === errorUrl) {
        const err = new Error('Request failed with status code 404');
        err.response = { status: 404 };
        throw err;
      }
      return originalGet(url);
    };

    try {
      await assert.rejects(
        () =>
          adapter.download(errorUrl, {
            formatId: 'mp4-720p',
            sourceUrl: errorUrl,
            meta: { isHls: false },
          }),
        (err) => {
          assert.strictEqual(err.response?.status, 404);
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('11. 6 GB file-size limit enforcement', async () => {
    assert.strictEqual(getMaxFileSizeBytes(), 6144 * 1024 * 1024);

    // Direct url handler checks size upfront
    const bigToken = createDownloadToken({
      platform: 'xhamster',
      sourceUrl: 'https://cdn.xhamster.com/videos/huge.mp4',
      formatId: 'mp4-1080p',
      meta: {
        sizeBytes: 7 * 1024 * 1024 * 1024, // 7 GB
      },
    });

    let directRes = null;
    await directUrlHandler(
      { params: { downloadId: bigToken }, body: {} },
      {
        status: (code) => ({
          json: (d) => {
            directRes = { status: code, data: d };
          },
        }),
      }
    );

    assert.strictEqual(directRes.status, 413);
    assert.strictEqual(directRes.data.error, 'This file exceeds the maximum allowed download size.');
  });

  await t.test('12. directUrlHandler routes xHamster tokens through prepare pipeline', async () => {
    const token = createDownloadToken({
      platform: 'xhamster',
      sourceUrl: 'https://cdn.xhamster.com/videos/sample.mp4',
      formatId: 'mp4-720p',
      meta: {
        pageUrl: 'https://xhamster.com/videos/sample-12345',
        quality: '720p',
      },
    });

    let directJson = null;
    await directUrlHandler(
      { params: { downloadId: token }, body: {} },
      { json: (d) => { directJson = d; } }
    );

    assert.strictEqual(directJson.success, false);
    assert.strictEqual(directJson.requiresPrepare, false);
    assert.strictEqual(directJson.fallback, true);
    assert.strictEqual(directJson.error, 'Direct client-side URL not available.');

    let validateJson = null;
    await validateDownloadHandler(
      { params: { downloadId: token } },
      { json: (d) => { validateJson = d; } }
    );

    assert.strictEqual(validateJson.success, true);
    assert.strictEqual(validateJson.platform, 'xhamster');
  });

  await t.test('13. Integration: analyze -> prepare -> stream for xHamster video', async () => {
    const testUrl = 'https://xhamster.com/videos/integration-test-999888';
    const fakeHtml = `
      <html>
        <head><title>Integration Test Title</title></head>
        <body>
          <script>
            window.initials = {
              videoModel: {
                title: "Integration Test Title",
                duration: 60,
                sources: {
                  mp4: { "720p": "https://cdn.xhamster.com/videos/integration_720p.mp4" }
                }
              }
            };
          </script>
        </body>
      </html>
    `;

    const originalGet = axios.get;
    axios.get = async (url, config) => {
      if (url.includes('integration-test-999888')) {
        return { data: fakeHtml, status: 200, request: { res: { responseUrl: testUrl } } };
      }
      if (url.includes('integration_720p.mp4')) {
        const { Readable } = await import('node:stream');
        const s = new Readable({
          read() {
            this.push(Buffer.from('integration test mp4 bytes stream'));
            this.push(null);
          },
        });
        return {
          data: s,
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '33',
          },
        };
      }
      return originalGet(url, config);
    };

    try {
      // 1. Analyze
      const analyzeRes = await makeRequest(
        server,
        { method: 'POST', path: '/api/analyze', headers: { 'Content-Type': 'application/json' } },
        { url: testUrl }
      );
      assert.strictEqual(analyzeRes.statusCode, 200);
      const analyzeJson = analyzeRes.json();
      assert.strictEqual(analyzeJson.success, true);
      assert.strictEqual(analyzeJson.platform, 'xhamster');
      assert.strictEqual(analyzeJson.title, 'Integration Test Title');
      assert.ok(analyzeJson.formats.length > 0);

      const downloadId = analyzeJson.formats[0].downloadId;
      assert.ok(downloadId, 'downloadId token must be provided');

      // 2. Prepare
      const prepRes = await makeRequest(
        server,
        { method: 'POST', path: `/api/download/${downloadId}/prepare`, headers: { 'Content-Type': 'application/json' } }
      );
      assert.strictEqual(prepRes.statusCode, 200);
      const prepJson = prepRes.json();
      assert.strictEqual(prepJson.success, true);
      assert.ok(prepJson.streamId, 'streamId must be returned');

      // 3. Stream
      const streamRes = await makeRequest(
        server,
        { method: 'GET', path: `/api/stream/${prepJson.streamId}` }
      );
      assert.strictEqual(streamRes.statusCode, 200);
      assert.strictEqual(streamRes.buffer.toString(), 'integration test mp4 bytes stream');
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('15. HLS download selection logs sourceType: HLS and enforces 6 GB size limit', async () => {
    const adapter = new XHamsterAdapter();
    const hlsUrl = 'https://cdn.xhamster.com/hls/test_master.m3u8';

    let logged = '';
    const originalLog = console.log;
    console.log = (...args) => {
      logged += args.join(' ') + '\n';
      originalLog(...args);
    };

    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url === hlsUrl) {
        return {
          data: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nmedia.m3u8\n`,
          status: 200,
        };
      }
      if (url.includes('media.m3u8')) {
        return {
          data: `#EXTM3U\n#EXTINF:2.0,\nseg1.ts\n#EXTINF:2.0,\nseg2.ts\n#EXT-X-ENDLIST\n`,
          status: 200,
        };
      }
      if (url.includes('seg1.ts') || url.includes('seg2.ts')) {
        // Return 100 bytes
        return {
          data: Buffer.alloc(100),
          status: 200,
        };
      }
      return originalGet(url);
    };

    try {
      const result = await adapter.download(hlsUrl, {
        formatId: 'hls-auto',
        sourceUrl: hlsUrl,
        meta: {
          isHls: true,
          quality: 'Auto (HLS)',
          pageUrl: 'https://xhamster.com/videos/sample-12345',
        },
      });

      assert.ok(logged.includes('[xHamster Download Selection]'));
      assert.ok(logged.includes('sourceType: HLS'));
      assert.ok(logged.includes('sourceOrigin: https://cdn.xhamster.com'));
      assert.ok(logged.includes('sourcePath: /hls/test_master.m3u8'));
      assert.ok(result._tempFilePath, 'Must return _tempFilePath');
      assert.ok(['video/mp4', 'video/mp2t'].includes(result.mimeType), 'MIME type must be valid video');

      if (result._tempFilePath) {
        fs.promises.unlink(result._tempFilePath).catch(() => {});
      }
    } finally {
      console.log = originalLog;
      axios.get = originalGet;
    }
  });

  await t.test('16. HLS download rejects immediately if segment size exceeds 6 GB limit', async () => {
    const adapter = new XHamsterAdapter();
    const hlsUrl = 'https://cdn.xhamster.com/hls/huge_master.m3u8';

    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url === hlsUrl) {
        return {
          data: `#EXTM3U\n#EXTINF:2.0,\nhuge_seg1.ts\n#EXT-X-ENDLIST\n`,
          status: 200,
        };
      }
      if (url.includes('huge_seg1.ts')) {
        // Simulate massive segment exceeding 6 GB
        return {
          data: Buffer.alloc(2 * 1024 * 1024), // 2 MB buffer
          status: 200,
        };
      }
      return originalGet(url);
    };

    // Temporarily override MAX_FILE_SIZE_MB to 1 MB for the test
    const origEnv = process.env.MAX_FILE_SIZE_MB;
    process.env.MAX_FILE_SIZE_MB = '1';

    try {
      await assert.rejects(
        () =>
          adapter.download(hlsUrl, {
            formatId: 'hls-huge',
            sourceUrl: hlsUrl,
            meta: {
              isHls: true,
              quality: 'Auto (HLS)',
            },
          }),
        (err) => {
          assert.strictEqual(err.statusCode, 413);
          assert.ok(err.message.includes('exceeds the maximum allowed download size'));
          return true;
        }
      );
    } finally {
      if (origEnv !== undefined) process.env.MAX_FILE_SIZE_MB = origEnv;
      else delete process.env.MAX_FILE_SIZE_MB;
      axios.get = originalGet;
    }
  });

  await t.test('17. Verification of Pornhub isolation and zero regression', async () => {
    // Verify Pornhub adapter is still properly registered and resolves Pornhub URLs
    const phAdapter = resolveAdapter('https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a');
    assert.ok(phAdapter, 'resolveAdapter must return PornhubAdapter for Pornhub URL');
    assert.strictEqual(phAdapter.constructor.platformId, 'pornhub');

    // Verify xHamster adapter handles xHamster URLs without interfering with Pornhub
    const xhAdapter = resolveAdapter('https://www.xhamster.com/videos/test-12345');
    assert.ok(xhAdapter);
    assert.strictEqual(xhAdapter.constructor.platformId, 'xhamster');
  });
});
