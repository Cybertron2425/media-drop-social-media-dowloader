import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import app from './app.js';
import { InstagramAdapter } from './platforms/instagram.js';

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

test('Instagram Adapter - Reel and Video Stream Prioritization', async (t) => {
  let server;
  const originalAxiosGet = axios.get;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    axios.get = originalAxiosGet;
    if (server) server.close();
  });

  await t.test('1. canHandle detects Instagram post and reel URLs', () => {
    const adapter = new InstagramAdapter();
    assert.equal(adapter.canHandle('https://www.instagram.com/reel/C123abc/'), true);
    assert.equal(adapter.canHandle('https://instagram.com/reels/C123abc/'), true);
    assert.equal(adapter.canHandle('https://www.instagram.com/p/C123abc/'), true);
    assert.equal(adapter.canHandle('https://twitter.com/p/C123abc/'), false);
  });

  await t.test('2. Instagram Reel URL explicitly selects video stream (.mp4) over thumbnail/image formats', async () => {
    const reelHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Viral Reel by Creator" />
          <meta property="og:image" content="https://instagram.com/thumb.jpg" />
          <meta property="og:video" content="https://instagram.com/reel_video.mp4" />
        </head>
        <body>
          <img class="EmbeddedMediaImage" src="https://instagram.com/thumb.jpg" />
          <video src="https://instagram.com/reel_video.mp4" poster="https://instagram.com/thumb.jpg"></video>
        </body>
      </html>
    `;

    axios.get = async (url) => {
      return {
        status: 200,
        data: reelHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/reel/C123abc/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'reel');
    assert.ok(result.formats.length > 0);
    assert.equal(result.formats[0].format, 'mp4');
    assert.equal(result.formats[0].mimeType, 'video/mp4');
    assert.equal(result.formats[0].sourceUrl, 'https://instagram.com/reel_video.mp4');
  });

  await t.test('3. Instagram Reel with carousel or multi-media data defaults to video stream', async () => {
    const carouselHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Carousel Reel Post" />
          <meta property="og:image" content="https://instagram.com/cover.jpg" />
        </head>
        <body>
          <script>
            window.__additionalDataLoaded('/reel/Ccarousel123/', {
              "items": [
                { "display_url": "https://instagram.com/slide1.jpg" },
                { "video_versions": [{ "url": "https://instagram.com/carousel_video.mp4" }] }
              ]
            });
          </script>
        </body>
      </html>
    `;

    axios.get = async (url) => {
      return {
        status: 200,
        data: carouselHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    const adapter = new InstagramAdapter();
    const result = await adapter.analyze('https://www.instagram.com/reels/Ccarousel123/');

    assert.equal(result.platform, 'instagram');
    assert.equal(result.type, 'reel');
    assert.ok(result.formats.length > 0);
    assert.equal(result.formats[0].format, 'mp4');
    assert.equal(result.formats[0].sourceUrl, 'https://instagram.com/carousel_video.mp4');
  });

  await t.test('4. End-to-end analyze -> prepare -> stream for Instagram Reel yields mp4 video stream', async () => {
    const reelHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="E2E Reel Test" />
          <meta property="og:video" content="https://example.com/cdn/reel_stream.mp4" />
          <meta property="og:image" content="https://example.com/cdn/reel_thumb.jpg" />
        </head>
        <body>
          <video src="https://example.com/cdn/reel_stream.mp4"></video>
        </body>
      </html>
    `;

    axios.get = async (url, config = {}) => {
      if (config.responseType === 'stream') {
        const stream = new Readable();
        stream.push(Buffer.from('mp4 reel video stream content'));
        stream.push(null);
        return {
          data: stream,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '30',
          },
        };
      }
      return {
        status: 200,
        data: reelHtml,
        headers: { 'content-type': 'text/html' },
      };
    };

    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.instagram.com/reel/Ce2eTest/' }
    );
    assert.equal(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.equal(analyzeData.type, 'reel');
    assert.equal(analyzeData.formats[0].format, 'mp4');

    const downloadId = analyzeData.formats[0].downloadId;
    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${downloadId}/prepare`, method: 'POST' }
    );
    assert.equal(prepareRes.statusCode, 200);
    const prepData = prepareRes.json();
    assert.equal(prepData.mimeType, 'video/mp4');

    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepData.streamId}`, method: 'GET' }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'video/mp4');
    assert.equal(streamRes.buffer.toString('utf8'), 'mp4 reel video stream content');
  });
});
