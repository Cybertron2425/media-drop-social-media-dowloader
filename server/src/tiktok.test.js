import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { TikTokAdapter } from './platforms/tiktok.js';

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

test('TikTok Adapter - Public Media, Short Links, and Error Handling', async (t) => {
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

  await t.test('1. Adapter registration and canHandle URL detection', () => {
    const adapter = getAdapter('tiktok');
    assert.ok(adapter, 'TikTokAdapter must be registered in platform registry');

    // Standard URLs
    assert.equal(
      adapter.canHandle('https://www.tiktok.com/@scout2015/video/6718335390845095173'),
      true
    );
    assert.equal(
      adapter.canHandle('https://tiktok.com/@username/video/7416379009996459269'),
      true
    );

    // Short/share URLs
    assert.equal(adapter.canHandle('https://vm.tiktok.com/ZMhF879k2/'), true);
    assert.equal(adapter.canHandle('https://vt.tiktok.com/ZS2xJqL9b/'), true);
    assert.equal(adapter.canHandle('https://www.tiktok.com/t/ZT8R1mNpq/'), true);

    // Negative / other platforms
    assert.equal(adapter.canHandle('https://instagram.com/reel/12345'), false);
    assert.equal(adapter.canHandle('https://facebook.com/reel/12345'), false);
    assert.equal(adapter.canHandle('https://snapchat.com/t/12345'), false);
    assert.equal(adapter.canHandle('https://youtube.com/watch?v=123'), false);
    assert.equal(adapter.canHandle('invalid-url'), false);

    // resolveAdapter resolution
    assert.equal(
      resolveAdapter('https://www.tiktok.com/@user/video/123').constructor.platformId,
      'tiktok'
    );
    assert.equal(
      resolveAdapter('https://vm.tiktok.com/ZMhF879k2/').constructor.platformId,
      'tiktok'
    );
  });

  await t.test('2. Rejects 404 or unavailable TikTok video cleanly', async () => {
    const adapter = new TikTokAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/@user/video/4040404' } },
    });

    axios.get = async () => ({
      status: 404,
      data: 'Not Found',
      request: { res: { responseUrl: 'https://www.tiktok.com/@user/video/4040404' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.tiktok.com/@user/video/4040404');
        },
        (err) => {
          assert.equal(
            err.message,
            'This TikTok video is no longer available or could not be found.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('3. Rejects login-required / private TikTok content with clean error', async () => {
    const adapter = new TikTokAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/login?redirect_url=...' } },
    });

    axios.get = async () => ({
      status: 200,
      data: '<html><body><div class="login-container">Log in to TikTok</div></body></html>',
      request: { res: { responseUrl: 'https://www.tiktok.com/login' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.tiktok.com/@privateuser/video/123');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.equal(
            err.message,
            'TikTok content requires authentication or is private.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('4. Rejects regional restriction with clean error', async () => {
    const adapter = new TikTokAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/in/about' } },
    });

    axios.get = async () => ({
      status: 200,
      data: '<html><body>Government of India has issued an interim order under section 69A</body></html>',
      request: { res: { responseUrl: 'https://www.tiktok.com/in/about' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.tiktok.com/@user/video/123');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.equal(
            err.message,
            'TikTok is currently not accessible or is restricted in this server region.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('5. Rejects when public media cannot be extracted from HTML', async () => {
    const adapter = new TikTokAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/@user/video/99999' } },
    });

    axios.get = async () => ({
      status: 200,
      data: '<html><head><title>TikTok</title></head><body>No media content here</body></html>',
      request: { res: { responseUrl: 'https://www.tiktok.com/@user/video/99999' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.tiktok.com/@user/video/99999');
        },
        (err) => {
          assert.equal(err.message, 'Public TikTok media could not be accessed.');
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('6. Unit: extracts metadata from __UNIVERSAL_DATA_FOR_REHYDRATION__', async () => {
    const adapter = new TikTokAdapter();

    const sampleUniversalData = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          statusCode: 0,
          itemInfo: {
            itemStruct: {
              id: '7416379009996459269',
              desc: 'Hilarious Golden Retriever Reaction #dogs #cute',
              author: {
                nickname: 'DogLover',
                uniqueId: 'doglover101',
              },
              video: {
                duration: 15,
                width: 1080,
                height: 1920,
                cover: 'https://p16-sign.tiktokcdn.com/cover.jpg',
                playAddr: 'https://v16-webapp-prime.tiktok.com/video.mp4?token=abc',
              },
            },
          },
        },
      },
    };

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/@doglover101/video/7416379009996459269' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `
        <html>
          <head>
            <title>DogLover on TikTok</title>
          </head>
          <body>
            <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
              ${JSON.stringify(sampleUniversalData)}
            </script>
          </body>
        </html>
      `,
      request: { res: { responseUrl: 'https://www.tiktok.com/@doglover101/video/7416379009996459269' } },
    });

    try {
      const result = await adapter.analyze('https://www.tiktok.com/@doglover101/video/7416379009996459269');
      assert.equal(result.platform, 'tiktok');
      assert.equal(result.type, 'video');
      assert.equal(result.title, 'Hilarious Golden Retriever Reaction #dogs #cute');
      assert.equal(result.author, 'DogLover');
      assert.equal(result.duration, 15);
      assert.equal(result.thumbnail, 'https://p16-sign.tiktokcdn.com/cover.jpg');
      assert.equal(result.formats.length, 1);
      assert.equal(result.formats[0].format, 'mp4');
      assert.equal(result.formats[0].quality, '1920p');
      assert.equal(result.formats[0].resolution, '1080x1920');
      assert.equal(result.formats[0].mimeType, 'video/mp4');
      assert.equal(result.formats[0].sourceUrl, 'https://v16-webapp-prime.tiktok.com/video.mp4?token=abc');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('7. Unit: extracts metadata from OpenGraph and SIGI_STATE fallback', async () => {
    const adapter = new TikTokAdapter();

    const sampleSigi = {
      ItemModule: {
        '7319362981349887237': {
          id: '7319362981349887237',
          desc: 'Amazing travel moments in Bali',
          author: 'wanderlust',
          video: {
            duration: 22,
            width: 720,
            height: 1280,
            cover: 'https://p16-sign.tiktokcdn.com/bali.jpg',
            playAddr: 'https://v16-webapp-prime.tiktok.com/bali.mp4',
          },
        },
      },
    };

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/@wanderlust/video/7319362981349887237' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `
        <html>
          <head>
            <meta property="og:title" content="Amazing travel moments in Bali | TikTok" />
            <meta property="og:image" content="https://p16-sign.tiktokcdn.com/bali.jpg" />
          </head>
          <body>
            <script id="SIGI_STATE" type="application/json">
              ${JSON.stringify(sampleSigi)}
            </script>
          </body>
        </html>
      `,
      request: { res: { responseUrl: 'https://www.tiktok.com/@wanderlust/video/7319362981349887237' } },
    });

    try {
      const result = await adapter.analyze('https://www.tiktok.com/@wanderlust/video/7319362981349887237');
      assert.equal(result.platform, 'tiktok');
      assert.equal(result.title, 'Amazing travel moments in Bali');
      assert.equal(result.author, 'wanderlust');
      assert.equal(result.duration, 22);
      assert.equal(result.formats[0].quality, '1280p');
      assert.equal(result.formats[0].resolution, '720x1280');
      assert.equal(result.formats[0].sourceUrl, 'https://v16-webapp-prime.tiktok.com/bali.mp4');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('8. Integration: full pipeline analyze -> prepare -> stream for TikTok video', async () => {
    const fakeVideoBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // MP4 magic

    const sampleUniversalData = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          statusCode: 0,
          itemInfo: {
            itemStruct: {
              id: '1234567890',
              desc: 'Testing MediaDrop TikTok Pipeline',
              author: { nickname: 'tester' },
              video: {
                duration: 10,
                width: 720,
                height: 1280,
                cover: 'https://tiktokcdn.com/thumb.jpg',
                playAddr: 'https://v16-webapp-prime.tiktok.com/stream.mp4',
              },
            },
          },
        },
      },
    };

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.tiktok.com/@tester/video/1234567890' } },
    });

    axios.get = async (url, config) => {
      if (config?.responseType === 'stream') {
        const stream = Readable.from([fakeVideoBuffer]);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(fakeVideoBuffer.length),
          },
          request: { res: { responseUrl: url } },
        };
      }
      return {
        status: 200,
        data: `
          <html>
            <body>
              <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
                ${JSON.stringify(sampleUniversalData)}
              </script>
            </body>
          </html>
        `,
        request: { res: { responseUrl: url } },
      };
    };

    try {
      // 1. Analyze
      const analyzeRes = await makeRequest(
        server,
        { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { url: 'https://www.tiktok.com/@tester/video/1234567890' }
      );
      assert.equal(analyzeRes.statusCode, 200);
      const analyzeData = analyzeRes.json();
      assert.equal(analyzeData.success, true);
      assert.equal(analyzeData.platform, 'tiktok');
      assert.equal(analyzeData.title, 'Testing MediaDrop TikTok Pipeline');
      assert.ok(analyzeData.formats[0].downloadId);

      // 2. Prepare
      const downloadId = analyzeData.formats[0].downloadId;
      const prepareRes = await makeRequest(
        server,
        { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
      );
      assert.equal(prepareRes.statusCode, 200);
      const prepareData = prepareRes.json();
      assert.equal(prepareData.success, true);
      assert.ok(prepareData.streamId);
      assert.equal(prepareData.mimeType, 'video/mp4');
      assert.equal(prepareData.sizeBytes, fakeVideoBuffer.length);

      // 3. Stream
      const streamRes = await makeRequest(
        server,
        { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
      );
      assert.equal(streamRes.statusCode, 200);
      assert.equal(streamRes.headers['content-type'], 'video/mp4');
      assert.equal(streamRes.buffer.length, fakeVideoBuffer.length);
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('9. Verified header and cookie propagation to downloadStream', async () => {
    const adapter = new TikTokAdapter();
    const originalGet = axios.get;
    let capturedHeaders = null;

    axios.get = async (url, config) => {
      if (url.includes('cdn-test.tiktok.com')) {
        capturedHeaders = config?.headers;
        return {
          status: 206,
          data: Readable.from([Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])]),
          headers: {
            'content-type': 'video/mp4',
            'content-length': '8',
          },
          request: { res: { responseUrl: url } },
        };
      }
      return originalGet(url, config);
    };

    try {
      await adapter.download('https://cdn-test.tiktok.com/video.mp4', {
        meta: {
          headers: {
            Cookie: 'ttwid=test_ttwid; tt_chain_token=test_chain;',
            Referer: 'https://www.tiktok.com/',
          },
        },
      });

      assert.ok(capturedHeaders, 'Headers must be passed to downloadStream');
      assert.equal(capturedHeaders.Referer, 'https://www.tiktok.com/');
      assert.equal(capturedHeaders.Range, 'bytes=0-');
      assert.ok(capturedHeaders.Cookie.includes('ttwid=test_ttwid'));
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('10. Live Real-World TikTok Video End-to-End Pipeline', async () => {
    // Tests real URL https://vm.tiktok.com/ZMhF879k2/
    // Checks analyze -> prepare -> stream returning real playable MP4 bytes
    try {
      const analyzeRes = await makeRequest(
        server,
        { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { url: 'https://vm.tiktok.com/ZMhF879k2/' }
      );

      // If analyzed successfully
      if (analyzeRes.statusCode === 200) {
        const analyzeData = analyzeRes.json();
        assert.equal(analyzeData.success, true);
        assert.equal(analyzeData.platform, 'tiktok');
        const downloadId = analyzeData.formats?.[0]?.downloadId;
        assert.ok(downloadId, 'DownloadId must be returned');

        const prepareRes = await makeRequest(
          server,
          { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
        );
        assert.equal(prepareRes.statusCode, 200);
        const prepareData = prepareRes.json();
        assert.equal(prepareData.success, true);
        assert.ok(prepareData.streamId, 'StreamId must be returned');

        const streamRes = await makeRequest(
          server,
          { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
        );
        assert.equal(streamRes.statusCode, 200);
        assert.equal(streamRes.headers['content-type'], 'video/mp4');
        assert.ok(streamRes.buffer.length > 100000, 'Must contain real video data');
        const hasFtyp = streamRes.buffer.indexOf(Buffer.from('ftyp')) !== -1;
        assert.ok(hasFtyp, 'Must contain valid MP4 ftyp box signature');
      } else {
        // If region-blocked by government directive
        const data = analyzeRes.json();
        assert.ok(
          data.error?.includes('restricted in this server region') ||
          data.error?.includes('longer available'),
          `Expected clean limitation message, got: ${data.error}`
        );
      }
    } catch (err) {
      assert.fail(`Live test threw unexpected error: ${err.message}`);
    }
  });
});
