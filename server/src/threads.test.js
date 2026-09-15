import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { ThreadsAdapter } from './platforms/threads.js';

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

test('Threads Adapter - Public Posts, Videos, and Photos', async (t) => {
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
    const adapter = getAdapter('threads');
    assert.ok(adapter, 'ThreadsAdapter must be registered');

    // Valid Threads URLs
    assert.equal(adapter.canHandle('https://www.threads.net/@zuck/post/DF12345'), true);
    assert.equal(adapter.canHandle('https://threads.net/@user_name.1/post/C9_xyz123'), true);
    assert.equal(adapter.canHandle('https://www.threads.net/t/C9_xyz123'), true);
    assert.equal(adapter.canHandle('https://threads.net/t/C9_xyz123?xmt=AQG...'), true);

    // Non-Threads URLs
    assert.equal(adapter.canHandle('https://instagram.com/p/123'), false);
    assert.equal(adapter.canHandle('https://twitter.com/user/status/123'), false);
    assert.equal(adapter.canHandle('https://facebook.com/reel/123'), false);
    assert.equal(adapter.canHandle('https://tiktok.com/@user/video/123'), false);
    assert.equal(adapter.canHandle('not a url'), false);

    // Registry resolution
    assert.equal(resolveAdapter('https://threads.net/@zuck/post/DF12345').constructor.platformId, 'threads');
  });

  await t.test('2. Rejects 404 or removed Threads post cleanly', async () => {
    const adapter = new ThreadsAdapter();
    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.threads.net/@user/post/notfound' } },
    });
    axios.get = async () => ({
      status: 404,
      data: '<html><body>Page Not Found</body></html>',
      request: { res: { responseUrl: 'https://www.threads.net/@user/post/notfound' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.threads.net/@user/post/notfound');
        },
        (err) => {
          assert.equal(err.message, 'This Threads post is no longer available or was removed.');
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('3. Rejects login-required or private Threads post without bypass', async () => {
    const adapter = new ThreadsAdapter();
    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.threads.net/login?next=...' } },
    });
    axios.get = async () => ({
      status: 200,
      data: '<html><body><div>This account is private</div></body></html>',
      request: { res: { responseUrl: 'https://www.threads.net/login' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.threads.net/@privateuser/post/abc123');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.match(err.message, /requires login or is from a private account/i);
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('4. Rejects text-only Threads post with no downloadable media', async () => {
    const adapter = new ThreadsAdapter();
    const originalGet = axios.get;
    const originalHead = axios.head;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.threads.net/@author/post/textonly' } },
    });
    axios.get = async () => ({
      status: 200,
      data: `
        <html>
          <head>
            <meta property="og:title" content="Just some text thoughts" />
            <meta property="og:description" content="No images or videos attached" />
          </head>
          <body></body>
        </html>
      `,
      request: { res: { responseUrl: 'https://www.threads.net/@author/post/textonly' } },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://www.threads.net/@author/post/textonly');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.match(err.message, /No downloadable public media was found/i);
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('5. Unit: extracts metadata and video formats from public video post', async () => {
    const adapter = new ThreadsAdapter();
    const originalGet = axios.get;
    const originalHead = axios.head;

    const sampleVideoHtml = `
      <html>
        <head>
          <meta property="og:title" content="Zuck on Threads" />
          <meta property="og:description" content="Check out this exciting new feature launch!" />
          <meta property="og:video" content="https://scontent.cdninstagram.com/v/t50.2886-16/threads_demo.mp4?_nc_cat=101" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/threads_thumb.jpg?_nc_cat=101" />
        </head>
        <body></body>
      </html>
    `;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.threads.net/@zuck/post/DFLaunch1' } },
    });
    axios.get = async () => ({
      status: 200,
      data: sampleVideoHtml,
      request: { res: { responseUrl: 'https://www.threads.net/@zuck/post/DFLaunch1' } },
    });

    try {
      const info = await adapter.analyze('https://www.threads.net/@zuck/post/DFLaunch1');
      assert.equal(info.platform, 'threads');
      assert.equal(info.type, 'video');
      assert.equal(info.author, 'zuck');
      assert.equal(info.title, 'Check out this exciting new feature launch!');
      assert.equal(info.thumbnail, 'https://scontent.cdninstagram.com/v/t51.2885-15/threads_thumb.jpg?_nc_cat=101');
      assert.equal(info.formats.length, 1);
      assert.equal(info.formats[0].format, 'mp4');
      assert.equal(info.formats[0].hasAudio, true);
      assert.equal(info.formats[0].sourceUrl, 'https://scontent.cdninstagram.com/v/t50.2886-16/threads_demo.mp4?_nc_cat=101');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('6. Unit: extracts metadata and photo formats from public photo post', async () => {
    const adapter = new ThreadsAdapter();
    const originalGet = axios.get;
    const originalHead = axios.head;

    const samplePhotoHtml = `
      <html>
        <head>
          <meta property="og:title" content="Nature Photographer (@nature) on Threads" />
          <meta property="og:description" content="Beautiful morning in the mountains" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/mountain_view.jpg?_nc_cat=102" />
        </head>
        <body></body>
      </html>
    `;

    axios.head = async () => ({
      request: { res: { responseUrl: 'https://www.threads.net/@nature/post/Pic123' } },
    });
    axios.get = async () => ({
      status: 200,
      data: samplePhotoHtml,
      request: { res: { responseUrl: 'https://www.threads.net/@nature/post/Pic123' } },
    });

    try {
      const info = await adapter.analyze('https://www.threads.net/@nature/post/Pic123');
      assert.equal(info.platform, 'threads');
      assert.equal(info.type, 'image');
      assert.equal(info.author, 'nature');
      assert.equal(info.title, 'Beautiful morning in the mountains');
      assert.equal(info.thumbnail, 'https://scontent.cdninstagram.com/v/t51.2885-15/mountain_view.jpg?_nc_cat=102');
      assert.equal(info.formats.length, 1);
      assert.equal(info.formats[0].format, 'jpg');
      assert.equal(info.formats[0].hasAudio, false);
      assert.equal(info.formats[0].sourceUrl, 'https://scontent.cdninstagram.com/v/t51.2885-15/mountain_view.jpg?_nc_cat=102');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });

  await t.test('7. Integration: full pipeline analyze -> prepare -> stream for Threads media', async () => {
    const originalGet = axios.get;
    const originalHead = axios.head;

    const mockHtml = `
      <html>
        <head>
          <meta property="og:title" content="Test User on Threads" />
          <meta property="og:description" content="Integration test thread video" />
          <meta property="og:video" content="https://scontent.cdninstagram.com/v/t50.2886-16/threads_test.mp4" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/threads_thumb.jpg" />
        </head>
        <body></body>
      </html>
    `;

    axios.head = async (url) => {
      if (url.includes('threads.net')) {
        return { request: { res: { responseUrl: url } } };
      }
      return {
        headers: { 'content-length': '2048' },
        request: { res: { responseUrl: url } },
      };
    };

    axios.get = async (url, config = {}) => {
      if (url.includes('threads.net')) {
        return {
          status: 200,
          data: mockHtml,
          request: { res: { responseUrl: url } },
        };
      }
      if (config.responseType === 'stream') {
        const fakeData = Buffer.from('mock threads video payload stream');
        return {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(fakeData.length),
          },
          data: Readable.from([fakeData]),
          request: { res: { responseUrl: url } },
        };
      }
      return originalGet(url, config);
    };

    try {
      // 1. /api/analyze
      const analyzeRes = await makeRequest(
        server,
        {
          path: '/api/analyze',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        { url: 'https://www.threads.net/@testuser/post/ThreadPost999' }
      );

      assert.equal(analyzeRes.statusCode, 200);
      const data = analyzeRes.json();
      assert.equal(data.success, true);
      assert.equal(data.platform, 'threads');
      assert.equal(data.title, 'Integration test thread video');
      assert.ok(data.formats.length >= 1);
      const downloadId = data.formats[0].downloadId;
      assert.ok(downloadId, 'Must return a downloadId');

      // 2. /api/download/:downloadId/prepare
      const prepRes = await makeRequest(server, {
        path: `/api/download/${downloadId}/prepare`,
        method: 'POST',
      });
      assert.equal(prepRes.statusCode, 200);
      const prepData = prepRes.json();
      assert.equal(prepData.success, true);
      assert.ok(prepData.streamId);

      // 3. /api/stream/:streamId
      const streamRes = await makeRequest(server, {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      });
      assert.equal(streamRes.statusCode, 200);
      assert.equal(streamRes.headers['content-type'], 'video/mp4');
      assert.equal(streamRes.buffer.toString('utf8'), 'mock threads video payload stream');
    } finally {
      axios.get = originalGet;
      axios.head = originalHead;
    }
  });
});
