import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { FacebookAdapter } from './platforms/facebook.js';

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

test('Facebook Adapter - Post, Share, and Reel Handling', async (t) => {
  let server;
  const originalAxiosGet = axios.get;
  const originalAxiosHead = axios.head;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    axios.get = originalAxiosGet;
    axios.head = originalAxiosHead;
    if (server.closeAllConnections) server.closeAllConnections();
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await t.test('canHandle detects standard and share Facebook URLs', () => {
    const adapter = new FacebookAdapter();
    assert.equal(adapter.canHandle('https://www.facebook.com/share/1KZd1aBQP1/?mibextid=wwXIfr'), true);
    assert.equal(adapter.canHandle('https://fb.com/share/123'), true);
    assert.equal(adapter.canHandle('https://www.facebook.com/reel/10153231379946729'), true);
    assert.equal(adapter.canHandle('https://www.facebook.com/photo.php?fbid=123'), true);
    assert.equal(adapter.canHandle('https://www.instagram.com/p/C_abc123/'), false);
  });

  await t.test('resolves and analyzes a public Facebook share / post URL', async () => {
    const adapter = new FacebookAdapter();
    const testShareUrl = 'https://www.facebook.com/share/1KZd1aBQP1/?mibextid=wwXIfr';

    // Mock GET requests for this test
    axios.head = async () => ({
      request: { res: { responseUrl: testShareUrl } },
      headers: {},
    });

    axios.get = async (url, config) => {
      if (url.includes('plugins/video.php')) {
        return {
          status: 200,
          data: '<html><head><title>Facebook</title></head><body><div>No video</div></body></html>',
          request: { res: { responseUrl: url } },
        };
      }
      if (config?.headers?.['User-Agent']?.includes('iPhone')) {
        return {
          status: 200,
          data: `
            <html>
              <head>
                <title>F1 Lead - Monza lessons learned.</title>
                <meta property="og:title" content="F1 Lead - Monza lessons learned." />
                <meta property="og:type" content="article" />
                <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/sample.jpg" />
                <link rel="canonical" href="https://www.facebook.com/photo.php?fbid=1638354378305911" />
              </head>
              <body>
                <div>Public Post</div>
              </body>
            </html>
          `,
          request: { res: { responseUrl: 'https://www.facebook.com/photo.php?fbid=1638354378305911' } },
        };
      }
      return { status: 200, data: '<html></html>', request: { res: { responseUrl: url } } };
    };

    const result = await adapter.analyze(testShareUrl);
    assert.equal(result.platform, 'facebook');
    assert.equal(result.type, 'image');
    assert.equal(result.title, 'F1 Lead - Monza lessons learned.');
    assert.equal(result.formats.length, 1);
    assert.equal(result.formats[0].id, 'image-0');
    assert.equal(result.formats[0].format, 'jpg');
    assert.equal(result.formats[0].sourceUrl, 'https://scontent.xx.fbcdn.net/v/t39.30808-6/sample.jpg');
  });

  await t.test('Integration: full pipeline analyze -> prepare -> stream for Facebook share post', async () => {
    // Restore axios functions for endpoint routing
    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.facebook.com/photo.php?fbid=1638354378305911' } },
      headers: {},
    });

    const fakeImageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    axios.get = async (url, config) => {
      if (config?.responseType === 'stream') {
        const stream = Readable.from([fakeImageBuffer]);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(fakeImageBuffer.length),
          },
          request: { res: { responseUrl: url } },
        };
      }
      if (config?.headers?.['User-Agent']?.includes('iPhone')) {
        return {
          status: 200,
          data: `
            <html>
              <head>
                <meta property="og:title" content="F1 Lead - Monza lessons learned." />
                <meta property="og:type" content="article" />
                <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/sample.jpg" />
                <link rel="canonical" href="https://www.facebook.com/photo.php?fbid=1638354378305911" />
              </head>
              <body></body>
            </html>
          `,
          request: { res: { responseUrl: 'https://www.facebook.com/photo.php?fbid=1638354378305911' } },
        };
      }
      return { status: 200, data: '<html></html>', request: { res: { responseUrl: url } } };
    };

    // 1. Analyze
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.facebook.com/share/1KZd1aBQP1/?mibextid=wwXIfr' }
    );
    assert.equal(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.equal(analyzeData.success, true);
    assert.equal(analyzeData.platform, 'facebook');
    assert.equal(analyzeData.type, 'image');
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
    assert.equal(prepareData.mimeType, 'image/jpeg');

    // 3. Stream
    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'image/jpeg');
    assert.equal(streamRes.buffer.length, fakeImageBuffer.length);
  });
});
