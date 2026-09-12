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

test('Bulk Download Flow', async (t) => {
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

  await t.test('Successfully bundles 14 media items into one ZIP file in ONE bulk request', async () => {
    // Mock adapter download to return sample media streams
    getAdapter('instagram').download = async (url, options) => {
      const stream = new Readable();
      stream.push(Buffer.from(`media content for format ${options.formatId}`));
      stream.push(null);
      return {
        stream,
        filename: `story_${options.formatId}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 30,
      };
    };

    // Simulate 14 media items from an Instagram carousel / highlight
    const downloadIds = [];
    for (let i = 1; i <= 14; i++) {
      const id = createDownloadToken({
        platform: 'instagram',
        sourceUrl: `https://instagram.com/p/test_${i}`,
        formatId: `item_${i}`,
        meta: { mimeType: 'image/jpeg' },
      });
      downloadIds.push(id);
    }

    assert.equal(downloadIds.length, 14);

    // Call POST /api/download-all
    const res = await makeRequest(
      server,
      {
        path: '/api/download-all',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      {
        downloadIds,
        title: 'My Favorite Highlights',
      }
    );

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/zip/);
    assert.match(res.headers['content-disposition'], /attachment; filename="My_Favorite_Highlights_all_media\.zip"/);

    // Verify ZIP magic bytes (PK\x03\x04 or PK\x05\x06)
    assert.equal(res.buffer[0], 0x50); // 'P'
    assert.equal(res.buffer[1], 0x4b); // 'K'

    // Verify the zip contains entries
    const zipString = res.buffer.toString('binary');
    for (let i = 1; i <= 14; i++) {
      const entryName = `${String(i).padStart(2, '0')}_story_item_${i}.jpg`;
      assert.ok(
        zipString.includes(entryName),
        `ZIP should contain entry ${entryName}`
      );
    }
  });

  await t.test('Individual download still works via prepare and stream endpoints', async () => {
    getAdapter('instagram').download = async () => {
      const stream = new Readable();
      stream.push(Buffer.from('single media content'));
      stream.push(null);
      return {
        stream,
        filename: 'single_test.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 20,
      };
    };

    const downloadId = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://instagram.com/reel/single_test',
      formatId: 'single_format',
      meta: { mimeType: 'video/mp4' },
    });

    // Phase 1: Prepare
    const prepRes = await makeRequest(
      server,
      {
        path: `/api/download/${downloadId}/prepare`,
        method: 'POST',
      }
    );
    assert.equal(prepRes.statusCode, 200);
    const prepData = prepRes.json();
    assert.ok(prepData.success);
    assert.ok(prepData.streamId);

    // Phase 2: Stream
    const streamRes = await makeRequest(
      server,
      {
        path: `/api/stream/${prepData.streamId}`,
        method: 'GET',
      }
    );
    assert.equal(streamRes.statusCode, 200);
    assert.equal(streamRes.headers['content-type'], 'video/mp4');
    assert.equal(streamRes.buffer.toString('utf8'), 'single media content');
  });

  await t.test('Handles partial/expired items safely without crashing the server', async () => {
    const validId = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://instagram.com/p/valid',
      formatId: 'valid_item',
      meta: {},
    });

    const res = await makeRequest(
      server,
      {
        path: '/api/download/bulk',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        downloadIds: ['completely_invalid_token', 'another_fake_id', validId],
      }
    );

    // Successfully bundles the available valid item without crashing
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/zip/);
    assert.match(res.headers['content-disposition'], /attachment; filename="mediadrop-download\.zip"/);
  });

  await t.test('Returns 404 when all requested tokens are invalid or expired', async () => {
    const res = await makeRequest(
      server,
      {
        path: '/api/download-all',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        downloadIds: ['expired_token_1', 'expired_token_2'],
      }
    );

    assert.equal(res.statusCode, 404);
    const data = res.json();
    assert.equal(data.success, false);
  });

  await t.test('Returns 400 when downloadIds is empty or not an array', async () => {
    const res = await makeRequest(
      server,
      {
        path: '/api/download-all',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        downloadIds: [],
      }
    );

    assert.equal(res.statusCode, 400);
  });

  await t.test('Sanitizes filenames and prevents directory traversal inside ZIP', async () => {
    getAdapter('instagram').download = async () => {
      const stream = new Readable();
      stream.push(Buffer.from('content'));
      stream.push(null);
      return {
        stream,
        filename: '../../../../etc/passwd',
        mimeType: 'text/plain',
        sizeBytes: 7,
      };
    };

    const downloadId = createDownloadToken({
      platform: 'instagram',
      sourceUrl: 'https://instagram.com/p/traversal_test',
      formatId: 'trav',
      meta: {},
    });

    const res = await makeRequest(
      server,
      {
        path: '/api/download-all',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        downloadIds: [downloadId],
      }
    );

    assert.equal(res.statusCode, 200);
    const zipString = res.buffer.toString('binary');
    // Ensure no ../ exists in entry names
    assert.ok(!zipString.includes('../'));
    assert.ok(zipString.includes('passwd'));
  });
});
