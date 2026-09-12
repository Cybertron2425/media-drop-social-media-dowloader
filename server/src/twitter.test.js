import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { TwitterAdapter } from './platforms/twitter.js';

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

test('Twitter/X Adapter - Public Posts, Videos, Images, and Multi-Media', async (t) => {
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
    const adapter = getAdapter('twitter');
    assert.ok(adapter, 'TwitterAdapter must be registered');

    // Standard X / Twitter URLs
    assert.equal(adapter.canHandle('https://x.com/SpaceX/status/2092284173730144732'), true);
    assert.equal(adapter.canHandle('https://twitter.com/SpaceX/status/2092284173730144732'), true);
    assert.equal(adapter.canHandle('https://www.x.com/user/status/123456789'), true);
    assert.equal(adapter.canHandle('https://www.twitter.com/user/status/123456789'), true);
    assert.equal(adapter.canHandle('https://x.com/i/status/123456789'), true);
    assert.equal(adapter.canHandle('https://t.co/abc123XYZ'), true);

    // Negative tests
    assert.equal(adapter.canHandle('https://instagram.com/reel/123'), false);
    assert.equal(adapter.canHandle('https://tiktok.com/@user/video/123'), false);
    assert.equal(adapter.canHandle('https://snapchat.com/t/123'), false);
    assert.equal(adapter.canHandle('invalid-url'), false);

    // resolveAdapter resolution
    assert.equal(
      resolveAdapter('https://x.com/SpaceX/status/2092284173730144732').constructor.platformId,
      'twitter'
    );
    assert.equal(
      resolveAdapter('https://twitter.com/SpaceX/status/2092284173730144732').constructor.platformId,
      'twitter'
    );
  });

  await t.test('2. Clean error for deleted / unavailable X post (404 / tombstone)', async () => {
    const adapter = new TwitterAdapter();
    const originalGet = axios.get;

    // Test HTTP 404
    axios.get = async () => ({ status: 404, data: 'Not found' });
    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://x.com/user/status/404040404');
        },
        (err) => {
          assert.equal(
            err.message,
            'This X/Twitter post is no longer available or could not be found.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }

    // Test TweetTombstone
    axios.get = async () => ({
      status: 200,
      data: {
        __typename: 'TweetTombstone',
        tombstone: { text: { text: 'This Post is unavailable.' } },
      },
    });
    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://x.com/user/status/999999999');
        },
        (err) => {
          assert.equal(
            err.message,
            'This X/Twitter post is no longer available or could not be found.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('3. Clean error for private / protected X account', async () => {
    const adapter = new TwitterAdapter();
    const originalGet = axios.get;

    axios.get = async () => ({
      status: 200,
      data: {
        __typename: 'TweetTombstone',
        tombstone: { text: { text: 'This Post is from a protected account.' } },
      },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://x.com/privateuser/status/11111111');
        },
        (err) => {
          assert.equal(err.name, 'PlatformLimitationError');
          assert.equal(
            err.message,
            'This X/Twitter post is from a private or protected account.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('4. Clean error for post without any media', async () => {
    const adapter = new TwitterAdapter();
    const originalGet = axios.get;

    axios.get = async () => ({
      status: 200,
      data: {
        id_str: '20',
        text: 'just setting up my twttr',
        user: { name: 'jack', screen_name: 'jack' },
        mediaDetails: [],
      },
    });

    try {
      await assert.rejects(
        async () => {
          await adapter.analyze('https://x.com/jack/status/20');
        },
        (err) => {
          assert.equal(
            err.message,
            'This X/Twitter post does not contain any downloadable media.'
          );
          return true;
        }
      );
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('5. Clean error for discontinued Stories / Fleets', async () => {
    const adapter = new TwitterAdapter();
    await assert.rejects(
      async () => {
        await adapter.analyze('https://x.com/user/fleets/12345');
      },
      (err) => {
        assert.equal(err.name, 'PlatformLimitationError');
        assert.ok(err.message.includes('discontinued'));
        return true;
      }
    );
  });

  await t.test('6. Unit: extracts single video post with MP4 quality variants', async () => {
    const adapter = new TwitterAdapter();
    const originalGet = axios.get;

    const fakeTweet = {
      id_str: '2092284173730144732',
      text: 'Rocket test footage https://t.co/video',
      user: { name: 'SpaceX', screen_name: 'SpaceX' },
      mediaDetails: [
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/thumb.jpg',
          original_info: { width: 1920, height: 1080 },
          video_info: {
            aspect_ratio: [16, 9],
            duration_millis: 45000,
            variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/vid/1280x720/mid.mp4' },
              { content_type: 'video/mp4', bitrate: 10368000, url: 'https://video.twimg.com/vid/1920x1080/high.mp4' },
              { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/vid/480x270/low.mp4' },
            ],
          },
        },
      ],
    };

    axios.get = async () => ({ status: 200, data: fakeTweet });

    try {
      const result = await adapter.analyze('https://x.com/SpaceX/status/2092284173730144732');
      assert.equal(result.platform, 'twitter');
      assert.equal(result.type, 'video');
      assert.equal(result.title, 'Rocket test footage');
      assert.equal(result.author, 'SpaceX (@SpaceX)');
      assert.equal(result.duration, 45);
      assert.equal(result.thumbnail, 'https://pbs.twimg.com/thumb.jpg');

      // Check sorted MP4 variants (highest first)
      assert.equal(result.formats.length, 3);
      assert.equal(result.formats[0].quality, '1080p');
      assert.equal(result.formats[0].sourceUrl, 'https://video.twimg.com/vid/1920x1080/high.mp4');
      assert.equal(result.formats[1].quality, '720p');
      assert.equal(result.formats[2].quality, '270p');
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('7. Unit: extracts multiple media items (photos and videos)', async () => {
    const adapter = new TwitterAdapter();
    const originalGet = axios.get;

    const fakeTweet = {
      id_str: '2098154822868320479',
      text: 'Mission launch photos https://t.co/pics',
      user: { name: 'SpaceX', screen_name: 'SpaceX' },
      mediaDetails: [
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/pic1.jpg',
          original_info: { width: 2048, height: 1365 },
        },
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/pic2.jpg',
          original_info: { width: 1920, height: 1080 },
        },
      ],
    };

    axios.get = async () => ({ status: 200, data: fakeTweet });

    try {
      const result = await adapter.analyze('https://x.com/SpaceX/status/2098154822868320479');
      assert.equal(result.platform, 'twitter');
      assert.equal(result.type, 'mixed');
      assert.equal(result.items.length, 2);
      assert.equal(result.items[0].type, 'image');
      assert.equal(result.items[0].formats[0].sourceUrl, 'https://pbs.twimg.com/media/pic1.jpg?name=orig');
      assert.equal(result.items[0].formats[0].format, 'jpg');
      assert.equal(result.items[1].formats[0].sourceUrl, 'https://pbs.twimg.com/media/pic2.jpg?name=orig');
    } finally {
      axios.get = originalGet;
    }
  });

  await t.test('8. Integration: full pipeline analyze -> prepare -> stream for X video', async () => {
    const fakeVideoBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // MP4 ftyp
    const originalGet = axios.get;

    axios.get = async (url, config) => {
      if (config?.responseType === 'stream') {
        return {
          status: 200,
          data: Readable.from([fakeVideoBuffer]),
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(fakeVideoBuffer.length),
          },
          request: { res: { responseUrl: url } },
        };
      }
      return {
        status: 200,
        data: {
          id_str: '12345',
          text: 'Integration pipeline video',
          user: { name: 'Tester', screen_name: 'tester' },
          mediaDetails: [
            {
              type: 'video',
              media_url_https: 'https://pbs.twimg.com/thumb.jpg',
              video_info: {
                variants: [
                  { content_type: 'video/mp4', bitrate: 1000000, url: 'https://video.twimg.com/sample.mp4' },
                ],
              },
            },
          ],
        },
      };
    };

    try {
      // 1. Analyze
      const analyzeRes = await makeRequest(
        server,
        { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { url: 'https://x.com/tester/status/12345' }
      );
      assert.equal(analyzeRes.statusCode, 200);
      const analyzeData = analyzeRes.json();
      assert.equal(analyzeData.success, true);
      assert.equal(analyzeData.platform, 'twitter');
      const downloadId = analyzeData.formats[0].downloadId;
      assert.ok(downloadId);

      // 2. Prepare
      const prepareRes = await makeRequest(
        server,
        { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
      );
      assert.equal(prepareRes.statusCode, 200);
      const prepareData = prepareRes.json();
      assert.equal(prepareData.success, true);
      assert.ok(prepareData.streamId);
      assert.equal(prepareData.mimeType, 'video/mp4');

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
    }
  });

  // 9. Live Real-World Test: Public Video on X
  await t.test('9. Live Real-World Test: Public Video (https://x.com/SpaceX/status/2092284173730144732)', async () => {
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://x.com/SpaceX/status/2092284173730144732' }
    );
    assert.equal(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.equal(analyzeData.success, true);
    assert.equal(analyzeData.platform, 'twitter');
    assert.ok(analyzeData.formats.length > 0);
    assert.equal(analyzeData.formats[0].format, 'mp4');
    const targetFormat =
      analyzeData.formats.find((f) => f.quality === '270p' || f.quality === '480p') ||
      analyzeData.formats[analyzeData.formats.length - 1];
    const downloadId = targetFormat.downloadId;

    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
    );
    assert.equal(prepareRes.statusCode, 200);
    const prepareData = prepareRes.json();
    assert.equal(prepareData.success, true);
    assert.ok(prepareData.streamId);
    assert.equal(prepareData.mimeType, 'video/mp4');

    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'video/mp4');
    assert.ok(streamRes.buffer.length > 100000);
    const hasFtyp = streamRes.buffer.indexOf(Buffer.from('ftyp')) !== -1;
    assert.ok(hasFtyp, 'Must be valid MP4 container');
  });

  // 10. Live Real-World Test: Public Multi-Image Post on X / twitter.com
  await t.test('10. Live Real-World Test: Public Multi-Image (https://twitter.com/SpaceX/status/2098154822868320479)', async () => {
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://twitter.com/SpaceX/status/2098154822868320479' }
    );
    assert.equal(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.equal(analyzeData.success, true);
    assert.equal(analyzeData.platform, 'twitter');
    assert.ok(analyzeData.items?.length >= 4, 'Should have 4 photos');
    assert.equal(analyzeData.items[0].formats[0].format, 'jpg');

    const downloadId = analyzeData.items[0].formats[0].downloadId;
    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
    );
    assert.equal(prepareRes.statusCode, 200);
    const prepareData = prepareRes.json();
    assert.equal(prepareData.success, true);
    assert.ok(prepareData.streamId);
    assert.equal(prepareData.mimeType, 'image/jpeg');

    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'image/jpeg');
    assert.ok(streamRes.buffer.length > 50000);
    // JPEG SOI marker 0xFFD8
    assert.equal(streamRes.buffer[0], 0xff);
    assert.equal(streamRes.buffer[1], 0xd8);
  });
});
