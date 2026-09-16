import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
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

test('Third-Party Public Media Adapter', async (t) => {
  let server;
  const originalAxiosGet = axios.get;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    axios.get = originalAxiosGet;
    if (server.closeAllConnections) server.closeAllConnections();
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await t.test('Detects supported third-party URLs and ignores blocked platforms', () => {
    const publicAdapter = getAdapter('public-media');
    assert.ok(publicAdapter, 'PublicMediaAdapter should be registered');

    // Supported public web domains
    assert.equal(publicAdapter.canHandle('https://commondatastorage.googleapis.com/videos/sample.mp4'), true);
    assert.equal(publicAdapter.canHandle('https://archive.org/details/sample_video'), true);
    assert.equal(publicAdapter.canHandle('https://example.com/video-page'), true);

    // Handled by dedicated Instagram/Facebook adapters
    assert.equal(publicAdapter.canHandle('https://www.instagram.com/reel/12345'), false);
    assert.equal(publicAdapter.canHandle('https://www.facebook.com/watch/?v=12345'), false);

    // Strictly blocked platforms
    assert.equal(publicAdapter.canHandle('https://www.youtube.com/watch?v=123'), false);
    assert.equal(publicAdapter.canHandle('https://youtu.be/123'), false);
    assert.equal(publicAdapter.canHandle('https://www.pornhub.com/view_video.php?viewkey=123'), false);
    assert.equal(publicAdapter.canHandle('https://www.tiktok.com/@user/video/123'), false);
    assert.equal(publicAdapter.canHandle('https://twitter.com/user/status/123'), false);
    assert.equal(publicAdapter.canHandle('https://x.com/user/status/123'), false);
    assert.equal(publicAdapter.canHandle('https://reddit.com/r/videos/comments/123'), false);
    assert.equal(publicAdapter.canHandle('https://vimeo.com/123456'), false);
    assert.equal(publicAdapter.canHandle('https://pinterest.com/pin/123'), false);
    assert.equal(publicAdapter.canHandle('https://terabox.com/s/123'), false);
  });

  await t.test('Analyzes a direct public video URL with correct format and resolution', async () => {
    const publicAdapter = getAdapter('public-media');
    const media = await publicAdapter.analyze('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny_720p.mp4');

    assert.equal(media.platform, 'public-media');
    assert.equal(media.type, 'video');
    assert.equal(media.formats.length, 1);
    assert.equal(media.formats[0].format, 'mp4');
    assert.equal(media.formats[0].resolution, '720p');
    assert.equal(media.formats[0].quality, '720p (HD)');
  });

  await t.test('Extracts public video and multiple quality sources (1080p, 720p, 480p) from HTML page', async () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Public Creative Commons Documentary</title>
          <meta property="og:title" content="Creative Commons Film" />
          <meta property="og:image" content="https://example.com/poster.jpg" />
        </head>
        <body>
          <video poster="https://example.com/poster.jpg">
            <source src="https://example.com/video_480p.mp4" label="480p" height="480" type="video/mp4">
            <source src="https://example.com/video_1080p.mp4" label="1080p" height="1080" type="video/mp4">
            <source src="https://example.com/video_720p.mp4" label="720p" height="720" type="video/mp4">
          </video>
        </body>
      </html>
    `;

    axios.get = async (url) => {
      return {
        data: sampleHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    const publicAdapter = getAdapter('public-media');
    const media = await publicAdapter.analyze('https://example.com/cc-film');

    assert.equal(media.platform, 'public-media');
    assert.equal(media.title, 'Creative Commons Film');
    assert.equal(media.thumbnail, 'https://example.com/poster.jpg');
    assert.equal(media.formats.length, 3);

    // Quality check: preferred highest available quality first
    assert.equal(media.formats[0].resolution, '1080p');
    assert.equal(media.formats[0].quality, '1080p (FHD)');
    assert.equal(media.formats[0].sourceUrl, 'https://example.com/video_1080p.mp4');

    assert.equal(media.formats[1].resolution, '720p');
    assert.equal(media.formats[1].quality, '720p (HD)');
    assert.equal(media.formats[1].sourceUrl, 'https://example.com/video_720p.mp4');

    assert.equal(media.formats[2].resolution, '480p');
    assert.equal(media.formats[2].quality, '480p (SD)');
    assert.equal(media.formats[2].sourceUrl, 'https://example.com/video_480p.mp4');
  });

  await t.test('Returns clean error when no downloadable public source is found on the page', async () => {
    const noVideoHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>No Video Page</title></head>
        <body><p>Just plain text without video.</p></body>
      </html>
    `;

    axios.get = async () => ({
      data: noVideoHtml,
      headers: { 'content-type': 'text/html' },
    });

    const publicAdapter = getAdapter('public-media');
    await assert.rejects(
      async () => {
        await publicAdapter.analyze('https://example.com/no-video');
      },
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.match(err.message, /This video cannot be downloaded from this source/i);
        return true;
      }
    );
  });

  await t.test('Blocks unsafe and SSRF URLs (localhost, private IPs)', async () => {
    const publicAdapter = getAdapter('public-media');
    await assert.rejects(
      async () => {
        await publicAdapter.analyze('http://127.0.0.1:8080/private');
      },
      /This URL cannot be processed|Please enter a valid media URL/i
    );
  });

  await t.test('Integration: /api/analyze handles public media and issues download tokens', async () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Open Source Video" />
          <meta property="og:video" content="https://example.com/open_source.mp4" />
        </head>
        <body></body>
      </html>
    `;

    axios.get = async (url) => {
      return {
        data: sampleHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    const res = await makeRequest(
      server,
      {
        path: '/api/analyze',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        url: 'https://example.com/watch',
      }
    );

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.success, true);
    assert.equal(data.platform, 'public-media');
    assert.equal(data.title, 'Open Source Video');
    assert.ok(data.formats.length >= 1);
    assert.ok(data.formats[0].downloadId, 'Must generate secure download token');
  });

  await t.test('Integration: Successfully prepares, streams, and allows re-download of public media', async () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Test Stream Video" />
          <meta property="og:video" content="https://example.com/test_stream.mp4" />
        </head>
        <body></body>
      </html>
    `;

    axios.get = async (url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('test public media stream content'));
        stream.push(null);
        return {
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '32',
          },
        };
      }
      return {
        data: sampleHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    // Step 1: Analyze
    const analyzeRes = await makeRequest(
      server,
      {
        path: '/api/analyze',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        url: 'https://example.com/stream-video',
      }
    );
    assert.equal(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    const downloadId = analyzeData.formats[0].downloadId;

    // Step 2: Prepare
    const prepRes = await makeRequest(
      server,
      {
        path: `/api/download/${downloadId}/prepare`,
        method: 'POST',
      }
    );
    assert.equal(prepRes.statusCode, 200);
    const prepData = prepRes.json();
    assert.equal(prepData.success, true);
    assert.ok(prepData.streamId);
    assert.equal(prepData.mimeType, 'video/mp4');

    // Step 3: Stream
    const streamRes = await makeRequest(
      server,
      {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'video/mp4');
    assert.equal(streamRes.buffer.toString('utf8'), 'test public media stream content');

    // Step 4: Re-download while prepared item is still valid (must remain available)
    const streamRes2 = await makeRequest(
      server,
      {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      }
    );
    assert.equal(streamRes2.statusCode, 200);
    assert.equal(streamRes2.buffer.toString('utf8'), 'test public media stream content');
  });

  await t.test('Returns "The media is no longer available." when token or stream does not exist', async () => {
    const resToken = await makeRequest(
      server,
      {
        path: '/api/download/nonexistent_token_12345/prepare',
        method: 'POST',
      }
    );
    assert.equal(resToken.statusCode, 404);
    const tokenData = resToken.json();
    assert.equal(tokenData.success, false);
    assert.equal(tokenData.error, 'The media is no longer available.');

    const resStream = await makeRequest(
      server,
      {
        path: '/api/stream/nonexistent_stream_12345',
        method: 'GET',
      }
    );
    assert.equal(resStream.statusCode, 404);
    const streamData = resStream.json();
    assert.equal(streamData.success, false);
    assert.equal(streamData.error, 'The media is no longer available.');
  });

  await t.test('Detects HLS/DASH only pages and returns clear limitation error', async () => {
    const hlsHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>HLS Video Page</title></head>
        <body>
          <video>
            <source src="https://example.com/live/playlist.m3u8" type="application/x-mpegURL">
          </video>
        </body>
      </html>
    `;

    axios.get = async () => ({
      data: hlsHtml,
      headers: { 'content-type': 'text/html' },
    });

    const publicAdapter = getAdapter('public-media');
    await assert.rejects(
      async () => {
        await publicAdapter.analyze('https://example.com/hls-video');
      },
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.match(err.message, /HLS\/DASH streaming manifest/i);
        return true;
      }
    );
  });

  await t.test('Retries download without Referer when CDN returns 403 to cross-origin Referer', async () => {
    let callCount = 0;
    const calls = [];

    axios.get = async (url, config = {}) => {
      callCount++;
      calls.push({ url, headers: config.headers });
      if (callCount === 1) {
        // First attempt with Referer receives 403 from CDN
        const err = new Error('Request failed with status code 403');
        err.response = { status: 403, headers: { 'content-type': 'text/plain' } };
        throw err;
      }
      // Second attempt without Referer succeeds
      const stream = new Readable();
      stream.push(Buffer.from('stream without referer'));
      stream.push(null);
      return {
        data: stream,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '22',
        },
      };
    };

    const publicAdapter = getAdapter('public-media');
    const result = await publicAdapter.download('https://example.com/video.mp4', {
      sourceUrl: 'https://example.com/video.mp4',
      meta: {
        pageUrl: 'https://example.com/page',
        headers: { Referer: 'https://example.com/page' },
      },
    });

    assert.ok(result.stream);
    assert.equal(callCount, 2);
    assert.equal(calls[0].headers.Referer, 'https://example.com/page');
    assert.equal(calls[1].headers.Referer, undefined);
    assert.equal(result.mimeType, 'video/mp4');
  });

  await t.test('Instagram and Facebook adapters remain active and registered', () => {
    assert.ok(getAdapter('instagram'), 'InstagramAdapter must exist');
    assert.ok(getAdapter('facebook'), 'FacebookAdapter must exist');
    assert.equal(resolveAdapter('https://www.instagram.com/p/abc123/').constructor.platformId, 'instagram');
    assert.equal(resolveAdapter('https://www.facebook.com/watch/?v=123').constructor.platformId, 'facebook');
  });
});

