import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { SnapchatAdapter } from './platforms/snapchat.js';

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

test('Snapchat Adapter - Spotlight, Stories, and Public Media', async (t) => {
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

  await t.test('Adapter registration and canHandle detection', () => {
    const adapter = getAdapter('snapchat');
    assert.ok(adapter, 'SnapchatAdapter must be registered');

    // Hostname and short link detection
    assert.equal(adapter.canHandle('https://snapchat.com/t/78JUUxyK'), true);
    assert.equal(adapter.canHandle('https://www.snapchat.com/t/V4l19BZf'), true);
    assert.equal(adapter.canHandle('https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYmhveGl6ZWVnAaBLmEVdAaBLmBhWAAAAAQ'), true);
    assert.equal(adapter.canHandle('https://story.snapchat.com/s/sample123'), true);
    assert.equal(adapter.canHandle('https://www.snapchat.com/@username/spotlight/123'), true);

    // Invalid URLs
    assert.equal(adapter.canHandle('https://instagram.com/p/123'), false);
    assert.equal(adapter.canHandle('https://facebook.com/reel/123'), false);
    assert.equal(adapter.canHandle('not a url'), false);

    // resolveAdapter resolution
    assert.equal(resolveAdapter('https://snapchat.com/t/78JUUxyK').constructor.platformId, 'snapchat');
  });

  await t.test('Rejects expired or not found Snapchat links', async () => {
    const adapter = new SnapchatAdapter();

    // Mock expired response with showSnapExpiredToast
    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.snapchat.com/@user/expired' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `
        <html>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {"props":{"pageProps":{"showSnapExpiredToast":true}}}
            </script>
          </body>
        </html>
      `,
      request: { res: { responseUrl: 'https://www.snapchat.com/@user/expired' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.snapchat.com/@user/expired');
        },
        (err) => {
          assert.equal(err.message, 'This Snapchat public link has expired or is no longer available.');
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('Rejects authentication-required / login-gated Snapchat content', async () => {
    const adapter = new SnapchatAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.snapchat.com/login?next=...' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `<html><body><form id="login_form"></form></body></html>`,
      request: { res: { responseUrl: 'https://www.snapchat.com/login' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.snapchat.com/private-snap');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.equal(err.message, 'Snapchat content is not available for unauthenticated download.');
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('Rejects when public media cannot be accessed', async () => {
    const adapter = new SnapchatAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.snapchat.com/empty-page' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `<html><head><title>Empty</title></head><body>No media</body></html>`,
      request: { res: { responseUrl: 'https://www.snapchat.com/empty-page' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.snapchat.com/empty-page');
        },
        (err) => {
          assert.equal(err.message, 'Public Snapchat media could not be accessed.');
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('Unit: extracts and formats video metadata correctly', async () => {
    const adapter = new SnapchatAdapter();

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.snapchat.com/spotlight/12345' } },
    });

    axios.get = async () => ({
      status: 200,
      data: `
        <html>
          <head>
            <meta property="og:title" content="Amazing Stunt Caught on Camera | User | Spotlight" />
            <meta property="og:image" content="https://story.snapchat.com/spotlight/thumb.jpg" />
          </head>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "videoMetadata": {
                      "name": "Spotlight Snap",
                      "description": "Amazing Stunt Caught on Camera",
                      "thumbnailUrl": "https://bolt-gcdn.sc-cdn.net/thumb.jpg",
                      "contentUrl": "https://bolt-gcdn.sc-cdn.net/video.27.IRZXSOY?mo=123",
                      "durationMs": "12000",
                      "width": 1080,
                      "height": 1920,
                      "creator": {
                        "personCreator": { "name": "Stunt Creator", "username": "stuntman" }
                      }
                    }
                  }
                }
              }
            </script>
          </body>
        </html>
      `,
      request: { res: { responseUrl: 'https://www.snapchat.com/spotlight/12345' } },
    });

    try {
      const result = await adapter.analyze('https://www.snapchat.com/spotlight/12345');
      assert.equal(result.platform, 'snapchat');
      assert.equal(result.type, 'spotlight');
      assert.equal(result.title, 'Amazing Stunt Caught on Camera');
      assert.equal(result.author, 'Stunt Creator');
      assert.equal(result.duration, 12);
      assert.equal(result.formats.length, 1);
      assert.equal(result.formats[0].format, 'mp4');
      assert.equal(result.formats[0].quality, '1920p');
      assert.equal(result.formats[0].resolution, '1080x1920');
      assert.equal(result.formats[0].sourceUrl, 'https://bolt-gcdn.sc-cdn.net/video.27.IRZXSOY?mo=123');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('Integration: full pipeline analyze -> prepare -> stream for Snapchat video', async () => {
    const fakeVideoBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // MP4 magic

    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.snapchat.com/@user/spotlight/test123' } },
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
            <head>
              <meta property="og:title" content="Test Video | Spotlight" />
              <meta property="og:image" content="https://sc-cdn.net/thumb.jpg" />
            </head>
            <body>
              <script id="__NEXT_DATA__" type="application/json">
                {
                  "props": {
                    "pageProps": {
                      "videoMetadata": {
                        "name": "Test Video",
                        "contentUrl": "https://bolt-gcdn.sc-cdn.net/video.mp4",
                        "thumbnailUrl": "https://sc-cdn.net/thumb.jpg",
                        "width": 720,
                        "height": 1280
                      }
                    }
                  }
                }
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
        { url: 'https://snapchat.com/t/sample' }
      );
      assert.equal(analyzeRes.statusCode, 200);
      const analyzeData = analyzeRes.json();
      assert.equal(analyzeData.success, true);
      assert.equal(analyzeData.platform, 'snapchat');
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

  // Mandatory real-world URLs end-to-end testing
  await t.test('Real-world Mandatory Test Link #1: https://snapchat.com/t/78JUUxyK', async () => {
    const adapter = new SnapchatAdapter();
    const result = await adapter.analyze('https://snapchat.com/t/78JUUxyK');
    assert.equal(result.platform, 'snapchat');
    assert.equal(result.type, 'image');
    assert.ok(result.formats.length > 0);
    assert.equal(result.formats[0].format, 'jpg');

    const dl = await adapter.download(result.formats[0].sourceUrl, {
      sourceUrl: result.formats[0].sourceUrl,
      meta: result.formats[0].meta,
    });
    assert.equal(dl.mimeType, 'image/jpeg');
    assert.ok(dl.sizeBytes > 10000);
  });

  await t.test('Real-world Mandatory Test Link #2: https://snapchat.com/t/V4l19BZf', async () => {
    const adapter = new SnapchatAdapter();
    const result = await adapter.analyze('https://snapchat.com/t/V4l19BZf');
    assert.equal(result.platform, 'snapchat');
    assert.equal(result.type, 'spotlight');
    assert.ok(result.formats.length > 0);
    assert.equal(result.formats[0].format, 'mp4');

    const dl = await adapter.download(result.formats[0].sourceUrl, {
      sourceUrl: result.formats[0].sourceUrl,
      meta: result.formats[0].meta,
    });
    assert.equal(dl.mimeType, 'video/mp4');
    assert.ok(dl.sizeBytes > 100000);
  });
});
