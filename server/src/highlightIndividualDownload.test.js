import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import app from './app.js';
import { createDownloadToken } from './services/downloadTokenStore.js';
import { getAdapter } from './platforms/registry.js';

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

test('Instagram Highlight Individual & Bulk Downloads', async (t) => {
  let server;
  const originalDownload = getAdapter('instagram').download;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    getAdapter('instagram').download = originalDownload;
    if (server.closeAllConnections) server.closeAllConnections();
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await t.test('Successfully downloads 14 mixed Highlight items (images and videos) consecutively without hitting rate limits', async () => {
    // Mock adapter download to return alternating image and video streams
    getAdapter('instagram').download = async (url, options) => {
      const isVideo = options.meta?.mimeType === 'video/mp4' || options.formatId.includes('video');
      const stream = new Readable();
      stream.push(Buffer.from(`media_data_${options.formatId}`));
      stream.push(null);
      return {
        stream,
        filename: isVideo ? `story_${options.formatId}.mp4` : `story_${options.formatId}.jpg`,
        mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
        sizeBytes: 40,
      };
    };

    // Create 14 media tokens for an Instagram Highlight (mixed: 7 images, 7 videos)
    const highlightItems = [];
    for (let i = 1; i <= 14; i++) {
      const isVideo = i % 2 === 0;
      const type = isVideo ? 'video' : 'image';
      const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
      const downloadId = createDownloadToken({
        platform: 'instagram',
        sourceUrl: `https://instagram.com/stories/highlights/test_hl_${i}`,
        formatId: `item_${i}_${type}`,
        meta: { mimeType },
      });
      highlightItems.push({ id: i, type, mimeType, downloadId });
    }

    assert.equal(highlightItems.length, 14);

    // Download every item one by one consecutively
    for (const item of highlightItems) {
      // Phase 1: Prepare
      const prepRes = await makeRequest(server, {
        path: `/api/download/${item.downloadId}/prepare`,
        method: 'POST',
      });

      assert.equal(
        prepRes.statusCode,
        200,
        `Item ${item.id} (${item.type}) prepare failed with status ${prepRes.statusCode}: ${prepRes.buffer.toString()}`
      );

      const prepData = prepRes.json();
      assert.ok(prepData.success);
      assert.ok(prepData.streamId);
      assert.equal(prepData.mimeType, item.mimeType);

      // Phase 2: Stream
      const streamRes = await makeRequest(server, {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      });

      assert.equal(
        streamRes.statusCode,
        200,
        `Item ${item.id} (${item.type}) stream failed with status ${streamRes.statusCode}`
      );
      assert.equal(streamRes.headers['content-type'], item.mimeType);
      assert.equal(streamRes.buffer.toString('utf8'), `media_data_item_${item.id}_${item.type}`);
    }

    // Verify re-download of an individual item still works (tokens not prematurely invalidated)
    const item1 = highlightItems[0];
    const repPrepRes = await makeRequest(server, {
      path: `/api/download/${item1.downloadId}/prepare`,
      method: 'POST',
    });
    assert.equal(repPrepRes.statusCode, 200, 'Re-downloading item 1 should succeed');

    // Verify Download All ZIP still works with all 14 tokens
    const bulkRes = await makeRequest(
      server,
      {
        path: '/api/download-all',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        downloadIds: highlightItems.map((it) => it.downloadId),
        title: 'Complete Highlight',
      }
    );

    assert.equal(bulkRes.statusCode, 200);
    assert.match(bulkRes.headers['content-type'], /application\/zip/);
    assert.equal(bulkRes.buffer[0], 0x50); // 'P'
    assert.equal(bulkRes.buffer[1], 0x4b); // 'K'
  });

  await t.test('Rejects invalid tokens safely without crashing', async () => {
    const res = await makeRequest(server, {
      path: '/api/download/fake_token_12345/prepare',
      method: 'POST',
    });

    assert.equal(res.statusCode, 404);
    const data = res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /expired|no longer available/i);
  });
});
