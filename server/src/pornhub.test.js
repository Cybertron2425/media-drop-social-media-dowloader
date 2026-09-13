import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { PornhubAdapter, extractPornhubViewKey } from './platforms/pornhub.js';

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

test('Pornhub Adapter - Public Video Downloading', async (t) => {
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

  await t.test('1. Adapter registration and URL detection (canHandle & viewkey extraction)', () => {
    const adapter = getAdapter('pornhub');
    assert.ok(adapter, 'PornhubAdapter must be registered in platform registry');
    assert.strictEqual(adapter.constructor.platformId, 'pornhub');

    // Standard view_video.php URLs
    assert.strictEqual(adapter.canHandle('https://www.pornhub.com/view_video.php?viewkey=6a930d26621ad'), true);
    assert.strictEqual(adapter.canHandle('https://pornhub.com/view_video.php?viewkey=6a930d26621ad&pkey=123'), true);
    assert.strictEqual(adapter.canHandle('https://www.pornhub.org/view_video.php?viewkey=ph63503ff5891b9'), true);
    assert.strictEqual(adapter.canHandle('https://m.pornhub.com/view_video.php?viewkey=6a930d26621ad'), true);
    assert.strictEqual(adapter.canHandle('https://rt.pornhub.com/view_video.php?viewkey=6a930d26621ad'), true);

    // Embed URLs
    assert.strictEqual(adapter.canHandle('https://www.pornhub.com/embed/6a930d26621ad'), true);

    // Viewkey extraction
    assert.strictEqual(extractPornhubViewKey('https://www.pornhub.com/view_video.php?viewkey=6a930d26621ad'), '6a930d26621ad');
    assert.strictEqual(extractPornhubViewKey('https://www.pornhub.com/embed/ph63503ff5891b9'), 'ph63503ff5891b9');

    // Platform resolver
    const resolved = resolveAdapter('https://www.pornhub.com/view_video.php?viewkey=6a930d26621ad');
    assert.ok(resolved, 'resolveAdapter should return PornhubAdapter for pornhub.com');
    assert.strictEqual(resolved.constructor.platformId, 'pornhub');

    // Other platforms / invalid
    assert.strictEqual(adapter.canHandle('https://example.com/view_video.php?viewkey=12345'), false);
    assert.strictEqual(adapter.canHandle('https://youtube.com/watch?v=12345678901'), false);
    assert.strictEqual(adapter.canHandle('not-a-url'), false);
  });

  await t.test('2. Clean error handling for invalid or malformed URLs', async () => {
    // Malformed viewkey -> 400 Bad Request
    const resInvalid = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.pornhub.com/view_video.php?viewkey=' }
    );
    assert.ok(resInvalid.statusCode === 422 || resInvalid.statusCode === 400, `Expected 422 or 400, got ${resInvalid.statusCode}`);
    const dataInvalid = resInvalid.json();
    assert.strictEqual(dataInvalid.success, false);
  });

  await t.test('3. Clean error handling for unavailable or deleted videos', async () => {
    // Non-existent viewkey -> 422 with clear message
    const resUnavailable = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.pornhub.com/view_video.php?viewkey=ph00000000000' }
    );
    assert.strictEqual(resUnavailable.statusCode, 422);
    const dataUnavailable = resUnavailable.json();
    assert.strictEqual(dataUnavailable.success, false);
    assert.ok(dataUnavailable.error.includes('unavailable') || dataUnavailable.error.includes('removed'));
  });

  await t.test('4. Full Integration Pipeline: Analyze -> Prepare -> Stream for live public Pornhub video', async () => {
    const testUrl = 'https://www.pornhub.com/view_video.php?viewkey=6a930d26621ad';

    // 1. Analyze
    const analyzeRes = await makeRequest(
      server,
      { path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { url: testUrl }
    );
    assert.strictEqual(analyzeRes.statusCode, 200);
    const analyzeData = analyzeRes.json();
    assert.strictEqual(analyzeData.success, true);
    assert.strictEqual(analyzeData.platform, 'pornhub');
    assert.strictEqual(analyzeData.type, 'video');
    assert.ok(analyzeData.title, 'Title should be present');
    assert.ok(analyzeData.thumbnail, 'Thumbnail should be present');
    assert.ok(typeof analyzeData.duration === 'number' && analyzeData.duration > 0, 'Duration should be positive number');
    assert.ok(Array.isArray(analyzeData.formats) && analyzeData.formats.length > 0, 'Should return formats array');

    // Verify format quality ordering (highest quality first)
    const topFormat = analyzeData.formats[0];
    assert.ok(topFormat.quality.includes('1080p') || topFormat.quality.includes('720p'), `Top format should be high quality, got: ${topFormat.quality}`);
    assert.strictEqual(topFormat.format, 'mp4');
    assert.strictEqual(topFormat.hasAudio, true);
    assert.ok(topFormat.downloadId, 'Must have a downloadId token');

    // 2. Prepare (use lowest resolution for rapid automated test pipeline)
    const formatToPrepare = analyzeData.formats[analyzeData.formats.length - 1];
    const prepareRes = await makeRequest(
      server,
      { path: `/api/download/${formatToPrepare.downloadId}/prepare`, method: 'POST' }
    );
    assert.strictEqual(prepareRes.statusCode, 200);
    const prepareData = prepareRes.json();
    assert.strictEqual(prepareData.success, true);
    assert.ok(prepareData.streamId, 'Must return streamId');
    assert.strictEqual(prepareData.mimeType, 'video/mp4');
    assert.ok(prepareData.sizeBytes > 1000000, 'Video file should be larger than 1MB');

    // 3. Stream
    const streamRes = await makeRequest(
      server,
      { path: `/api/stream/${prepareData.streamId}`, method: 'GET' }
    );
    assert.strictEqual(streamRes.statusCode, 200);
    assert.strictEqual(streamRes.headers['content-type'], 'video/mp4');
    assert.strictEqual(streamRes.headers['x-content-type-options'], 'nosniff');
    assert.ok(streamRes.headers['content-disposition'].includes('.mp4'));
    assert.strictEqual(streamRes.buffer.length, prepareData.sizeBytes);

    // Verify valid MP4 container (ftyp header box at byte offset 4)
    const ftyp = streamRes.buffer.toString('ascii', 4, 8);
    assert.strictEqual(ftyp, 'ftyp', 'Downloaded stream must be a valid MP4 file with ftyp header');
  });

  await t.test('5. Non-regression: Other platform adapters remain active', () => {
    assert.ok(getAdapter('instagram'));
    assert.ok(getAdapter('facebook'));
    assert.ok(getAdapter('snapchat'));
    assert.ok(getAdapter('tiktok'));
    assert.ok(getAdapter('twitter'));
    assert.ok(getAdapter('youtube'));
    assert.ok(getAdapter('public-media'));
  });
});
