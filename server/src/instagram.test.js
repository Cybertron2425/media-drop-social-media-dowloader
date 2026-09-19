import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { InstagramAdapter, unescapeInstagramUrl } from './platforms/instagram.js';
import { directUrlHandler } from './controllers/downloadController.js';
import { createDownloadToken } from './services/downloadTokenStore.js';
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

test('Instagram Adapter - Production Fix Test Suite (18 Scenarios)', async (t) => {
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
    if (server) server.close();
  });

  // 1. Video detection
  await t.test('1. Video detection: detects video post, mediaType="video", hasVideo=true, hasAudio=true', async () => {
    const videoPostHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Awesome Post Video" />
          <meta property="og:video" content="https://instagram.com/cdn/post_video.mp4" />
          <meta property="og:image" content="https://instagram.com/cdn/thumb.jpg" />
        </head>
        <body>
          <video src="https://instagram.com/cdn/post_video.mp4" poster="https://instagram.com/cdn/thumb.jpg"></video>
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: videoPostHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/p/Cvid123/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'video');
    assert.ok(result.formats.length > 0);
    const fmt = result.formats[0];
    assert.equal(fmt.mediaType, 'video');
    assert.equal(fmt.hasVideo, true);
    assert.equal(fmt.hasAudio, true);
    assert.equal(fmt.format, 'mp4');
    assert.equal(fmt.mimeType, 'video/mp4');
    assert.equal(fmt.sourceUrl, 'https://instagram.com/cdn/post_video.mp4');
  });

  // 2. Reel detection
  await t.test('2. Reel detection: detects reel, mediaType="video", hasVideo=true, hasAudio=true', async () => {
    const reelHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Viral Creator Reel" />
          <meta property="og:video" content="https://instagram.com/cdn/reel_stream.mp4" />
          <meta property="og:image" content="https://instagram.com/cdn/reel_thumb.jpg" />
        </head>
        <body>
          <video src="https://instagram.com/cdn/reel_stream.mp4" poster="https://instagram.com/cdn/reel_thumb.jpg"></video>
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: reelHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/reel/Creel123/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'reel');
    assert.ok(result.formats.length > 0);
    const fmt = result.formats[0];
    assert.equal(fmt.mediaType, 'video');
    assert.equal(fmt.hasVideo, true);
    assert.equal(fmt.hasAudio, true);
    assert.equal(fmt.format, 'mp4');
    assert.equal(fmt.mimeType, 'video/mp4');
    assert.equal(fmt.sourceUrl, 'https://instagram.com/cdn/reel_stream.mp4');
  });

  // 3. Image detection
  await t.test('3. Image detection: detects image, mediaType="image", hasVideo=false, hasAudio=false, format="jpg"', async () => {
    const imagePostHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="A Beautiful Landscape Photo" />
          <meta property="og:image" content="https://instagram.com/cdn/photo.jpg" />
        </head>
        <body>
          <img class="EmbeddedMediaImage" src="https://instagram.com/cdn/photo.jpg" />
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: imagePostHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/p/Cimg123/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'image');
    assert.ok(result.formats.length > 0);
    const fmt = result.formats[0];
    assert.equal(fmt.mediaType, 'image');
    assert.equal(fmt.hasVideo, false);
    assert.equal(fmt.hasAudio, false);
    assert.equal(fmt.format, 'jpg');
    assert.equal(fmt.mimeType, 'image/jpeg');
    assert.equal(fmt.sourceUrl, 'https://instagram.com/cdn/photo.jpg');
  });

  // 4. Carousel
  await t.test('4. Carousel: preserves separate items with distinct media types', async () => {
    const carouselHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Holiday Carousel Post" />
        </head>
        <body>
          <script>
            window.__additionalDataLoaded('/p/Ccarousel123/', {
              "items": [
                {
                  "id": "slide_1",
                  "is_video": false,
                  "display_url": "https://instagram.com/cdn/carousel_image.jpg"
                },
                {
                  "id": "slide_2",
                  "is_video": true,
                  "video_versions": [{ "url": "https://instagram.com/cdn/carousel_video.mp4" }],
                  "display_url": "https://instagram.com/cdn/carousel_video_thumb.jpg"
                }
              ]
            });
          </script>
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: carouselHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/p/Ccarousel123/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'carousel');
    assert.equal(result.isHighlight, true);
    assert.equal(result.items.length, 2);

    // Slide 1: Image
    const item1 = result.items[0];
    assert.equal(item1.type, 'image');
    assert.equal(item1.mediaType, 'image');
    assert.equal(item1.hasVideo, false);
    assert.equal(item1.formats[0].mediaType, 'image');
    assert.equal(item1.formats[0].format, 'jpg');
    assert.equal(item1.formats[0].mimeType, 'image/jpeg');
    assert.equal(item1.formats[0].sourceUrl, 'https://instagram.com/cdn/carousel_image.jpg');

    // Slide 2: Video
    const item2 = result.items[1];
    assert.equal(item2.type, 'video');
    assert.equal(item2.mediaType, 'video');
    assert.equal(item2.hasVideo, true);
    assert.equal(item2.hasAudio, true);
    assert.equal(item2.formats[0].mediaType, 'video');
    assert.equal(item2.formats[0].format, 'mp4');
    assert.equal(item2.formats[0].mimeType, 'video/mp4');
    assert.equal(item2.formats[0].sourceUrl, 'https://instagram.com/cdn/carousel_video.mp4');
  });

  // 5. Multiple video candidates
  await t.test('5. Multiple video candidates: extracts all available video candidates into candidate list', async () => {
    const multiCandidateHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:video" content="https://instagram.com/cdn/og_video.mp4" />
        </head>
        <body>
          <script>
            var data = {
              "video_versions": [
                { "url": "https://instagram.com/cdn/vv_720p.mp4", "width": 720, "height": 1280 },
                { "url": "https://instagram.com/cdn/vv_1080p.mp4", "width": 1080, "height": 1920 }
              ]
            };
          </script>
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: multiCandidateHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/reel/Cmulti123/');
    assert.equal(result.type, 'reel');
    const candidates = result.formats[0].meta?.candidates || [];
    assert.ok(candidates.length >= 3, `Expected at least 3 candidates, got ${candidates.length}`);
    const urls = candidates.map((c) => c.url);
    assert.ok(urls.includes('https://instagram.com/cdn/vv_1080p.mp4'));
    assert.ok(urls.includes('https://instagram.com/cdn/vv_720p.mp4'));
    assert.ok(urls.includes('https://instagram.com/cdn/og_video.mp4'));
  });

  // 6. Candidate selection
  await t.test('6. Candidate selection: prioritizes highest resolution structured video candidate', async () => {
    const multiCandidateHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:video" content="https://instagram.com/cdn/og_video.mp4" />
        </head>
        <body>
          <script>
            var data = {
              "video_versions": [
                { "url": "https://instagram.com/cdn/vv_720p.mp4", "width": 720, "height": 1280 },
                { "url": "https://instagram.com/cdn/vv_1080p.mp4", "width": 1080, "height": 1920 }
              ]
            };
          </script>
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: multiCandidateHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/reel/Cprioritize123/');
    assert.equal(result.formats[0].sourceUrl, 'https://instagram.com/cdn/vv_1080p.mp4');
  });

  // 7. Redirect
  await t.test('7. Redirect: follows safe redirects and streams media content', async () => {
    const initialUrl = 'https://instagram.com/redirect_to_cdn';

    axios.get = async (url, config = {}) => {
      if (config.beforeRedirect) {
        config.beforeRedirect({ protocol: 'https:', hostname: 'scontent.cdninstagram.com', path: '/video.mp4' });
      }
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('video data after redirect'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '25',
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const adapter = new InstagramAdapter();
    const dlResult = await adapter.download(initialUrl, {
      meta: { mediaType: 'video' },
    });

    assert.equal(dlResult.mimeType, 'video/mp4');
    assert.ok(dlResult.filename.endsWith('.mp4'));
  });

  // 8. Range request
  await t.test('8. Range request: supports Range header and responds with 206 Partial Content', async () => {
    const token = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://scontent.cdninstagram.com/v/range_test.mp4',
      formatId: 'video-0',
      meta: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        title: 'Range_Reel',
      },
    });

    const chunkData = Buffer.from('bytes 0-16 sample');
    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable({
          read() {},
        });
        process.nextTick(() => {
          stream.push(chunkData);
          stream.push(null);
        });
        return {
          status: 206,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes 0-${chunkData.length - 1}/1000`,
            'content-length': String(chunkData.length),
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const downloadRes = await makeRequest(server, {
      path: `/api/download/${token}`,
      method: 'GET',
      headers: {
        'Range': `bytes=0-${chunkData.length - 1}`,
      },
    });

    assert.equal(downloadRes.statusCode, 206);
    assert.equal(downloadRes.headers['content-type'], 'video/mp4');
    assert.equal(downloadRes.headers['content-range'], `bytes 0-${chunkData.length - 1}/1000`);
    assert.equal(downloadRes.buffer.toString('utf8'), 'bytes 0-16 sample');
  });

  // 9. video/* validation
  await t.test('9. video/* validation: verifies video/* content type for video downloads', async () => {
    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('valid mp4 data'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4; charset=binary',
            'content-length': '14',
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const adapter = new InstagramAdapter();
    const dlResult = await adapter.download('https://example.com/video_stream', {
      meta: { mediaType: 'video' },
    });

    assert.equal(dlResult.mimeType, 'video/mp4');
    assert.ok(dlResult.filename.endsWith('.mp4'));
  });

  // 10. image/* validation
  await t.test('10. image/* validation: verifies image/* content type and enforces image extension', async () => {
    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('jpeg binary image data'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '22',
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const adapter = new InstagramAdapter();
    const dlResult = await adapter.download('https://example.com/image_stream', {
      meta: { mediaType: 'image' },
    });

    assert.equal(dlResult.mimeType, 'image/jpeg');
    assert.ok(dlResult.filename.endsWith('.jpg'), `Expected .jpg, got: ${dlResult.filename}`);
  });

  // 11. HTML rejection
  await t.test('11. HTML rejection: rejects HTML responses and does not save as .mp4', async () => {
    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('<!DOCTYPE html><html><body>Error page</body></html>'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const adapter = new InstagramAdapter();
    await assert.rejects(
      async () => {
        await adapter.download('https://example.com/bogus_stream', {
          meta: { mediaType: 'video' },
        });
      },
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.ok(err.message.includes('HTML instead of media'));
        return true;
      }
    );
  });

  // 12. 403 handling & candidate failover
  await t.test('12. 403 handling: fails over to secondary candidate on 403, and preserves 403 if exhausted', async () => {
    let callCount = 0;
    axios.get = async (url, config = {}) => {
      callCount++;
      if (url.includes('bad_candidate.mp4')) {
        const error = new Error('Request failed with status code 403');
        error.response = { status: 403, data: 'Forbidden' };
        throw error;
      }
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('good candidate mp4 data'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: { 'content-type': 'video/mp4', 'content-length': '24' },
        };
      }
      return { status: 200, data: '' };
    };

    const adapter = new InstagramAdapter();
    // A) Should fail over from bad_candidate to good_candidate
    const result = await adapter.download('https://example.com/bad_candidate.mp4', {
      meta: {
        mediaType: 'video',
        candidates: [
          { url: 'https://example.com/bad_candidate.mp4', source: 'bad' },
          { url: 'https://example.com/good_candidate.mp4', source: 'good' },
        ],
      },
    });
    assert.equal(result.mimeType, 'video/mp4');
    assert.ok(callCount >= 2);

    // B) Should throw HTTP 403 when all candidates return 403
    axios.get = async () => {
      const error = new Error('Request failed with status code 403');
      error.response = { status: 403, data: 'Forbidden' };
      throw error;
    };
    await assert.rejects(
      async () => {
        await adapter.download('https://example.com/forbidden.mp4', {
          meta: { mediaType: 'video' },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.ok(err.message.includes('403'));
        return true;
      }
    );
  });

  // 13. 404 handling
  await t.test('13. 404 handling: preserves HTTP 404 cleanly', async () => {
    axios.get = async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, data: 'Not Found' };
      throw error;
    };

    const adapter = new InstagramAdapter();
    await assert.rejects(
      async () => {
        await adapter.download('https://example.com/not_found.mp4', {
          meta: { mediaType: 'video' },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.ok(err.message.includes('404'));
        return true;
      }
    );
  });

  // 14. 410 handling
  await t.test('14. 410 handling: preserves HTTP 410 error cleanly', async () => {
    axios.get = async () => {
      const error = new Error('Request failed with status code 410');
      error.response = { status: 410, data: 'Gone' };
      throw error;
    };

    const adapter = new InstagramAdapter();
    await assert.rejects(
      async () => {
        await adapter.download('https://example.com/expired_video.mp4', {
          meta: { mediaType: 'video' },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 410);
        assert.ok(err.message.includes('410'));
        return true;
      }
    );
  });

  // 15. Failed video must not become image
  await t.test('15. Failed video must not become image: throws error if video source is missing/unverified', async () => {
    const reelNoVideoHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Reel without video tag" />
          <meta property="og:image" content="https://instagram.com/cdn/reel_thumb_only.jpg" />
        </head>
        <body>
          <img class="EmbeddedMediaImage" src="https://instagram.com/cdn/reel_thumb_only.jpg" />
        </body>
      </html>
    `;

    axios.get = async () => ({
      status: 200,
      data: reelNoVideoHtml,
      headers: { 'content-type': 'text/html' },
    });

    const adapter = new InstagramAdapter();
    await assert.rejects(
      async () => {
        await adapter.analyze('https://www.instagram.com/reel/Cbroken123/');
      },
      (err) => {
        assert.ok(err instanceof PlatformLimitationError);
        assert.equal(err.message, 'Instagram video source could not be verified.');
        return true;
      }
    );
  });

  // 16. Correct file extension
  await t.test('16. Correct file extension: ensures .mp4 for video and .jpg for image', async () => {
    const cdnUrlNoExt = 'https://scontent.cdninstagram.com/o1/v/t16/f2/AQM345hash_without_extension?token=abc123';

    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('mp4 stream raw data'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '19',
          },
        };
      }
      return { status: 200, data: 'ok', headers: {} };
    };

    const adapter = new InstagramAdapter();
    const dlResult = await adapter.download(cdnUrlNoExt, {
      meta: { mediaType: 'video', title: 'Viral Reel' },
    });

    assert.equal(dlResult.mimeType, 'video/mp4');
    assert.ok(dlResult.filename.endsWith('.mp4'), `Expected filename to end with .mp4, got: ${dlResult.filename}`);
  });

  // 17. Streaming response
  await t.test('17. Streaming response: streams media directly to client without buffering entire file in memory', async () => {
    const token = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://scontent.cdninstagram.com/v/stream_test.mp4',
      formatId: 'video-0',
      meta: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        title: 'Streaming_Video',
      },
    });

    const chunk1 = Buffer.from('chunk_part_1_');
    const chunk2 = Buffer.from('chunk_part_2');

    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable({
          read() {},
        });
        process.nextTick(() => {
          stream.push(chunk1);
          stream.push(chunk2);
          stream.push(null);
        });
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(chunk1.length + chunk2.length),
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const downloadRes = await makeRequest(server, {
      path: `/api/download/${token}`,
      method: 'GET',
    });

    assert.equal(downloadRes.statusCode, 200);
    assert.equal(downloadRes.headers['content-type'], 'video/mp4');
    assert.equal(downloadRes.buffer.toString('utf8'), 'chunk_part_1_chunk_part_2');
  });

  // 18. Content-Disposition
  await t.test('18. Content-Disposition: directUrlHandler prevents browser tab opening; stream sends attachment disposition', async () => {
    const token = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://scontent.cdninstagram.com/v/attachment_test.mp4',
      formatId: 'video-0',
      meta: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        title: 'Attachment_Reel',
      },
    });

    // A) directUrlHandler check: fallback: true, requiresPrepare: false
    let directJson;
    const directRes = {
      status: (c) => ({
        json: (j) => {
          directJson = j;
          return directRes;
        },
      }),
      json: (j) => {
        directJson = j;
        return directRes;
      },
    };
    await directUrlHandler({ params: { downloadId: token }, body: {} }, directRes);

    assert.equal(directJson.success, false);
    assert.equal(directJson.requiresPrepare, false);
    assert.equal(directJson.fallback, true);

    // B) Content-Disposition header in streaming download
    axios.get = async (_url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('mp4 binary'));
        stream.push(null);
        return {
          status: 200,
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '10',
          },
        };
      }
      return { status: 200, data: '', headers: {} };
    };

    const downloadRes = await makeRequest(server, {
      path: `/api/download/${token}`,
      method: 'GET',
    });

    assert.equal(downloadRes.statusCode, 200);
    assert.ok(
      downloadRes.headers['content-disposition']?.includes('attachment'),
      `Expected attachment in Content-Disposition: ${downloadRes.headers['content-disposition']}`
    );
    assert.ok(
      downloadRes.headers['content-disposition']?.includes('.mp4'),
      `Expected .mp4 in Content-Disposition: ${downloadRes.headers['content-disposition']}`
    );
  });
});
