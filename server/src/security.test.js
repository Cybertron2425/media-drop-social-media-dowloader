import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from './app.js';
import { resolveAdapter, getAdapter } from './platforms/registry.js';
import { assertSafeUrl, isBlockedIpv4, isBlockedIpv6 } from './utils/urlSafety.js';

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

test('Security Hardening & Platform Removal Verification', async (t) => {
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

  await t.test('1. Pornhub is unhandled and YouTube is registered', async () => {
    assert.strictEqual(getAdapter('pornhub'), undefined, 'PornhubAdapter must not exist in registry');
    assert.ok(getAdapter('youtube'), 'YouTubeAdapter must be registered');

    const phAdapter = resolveAdapter('https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a');
    assert.strictEqual(phAdapter, undefined, 'resolveAdapter must return undefined for Pornhub URL');

    const ytAdapter = resolveAdapter('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.ok(ytAdapter, 'resolveAdapter must return YouTubeAdapter for YouTube URL');

    // /api/analyze returns 400 for Pornhub
    const phRes = await makeRequest(
      server,
      { method: 'POST', path: '/api/analyze', headers: { 'Content-Type': 'application/json' } },
      { url: 'https://www.pornhub.com/view_video.php?viewkey=64f7b6058a23a' }
    );
    assert.strictEqual(phRes.statusCode, 400);
    const phJson = phRes.json();
    assert.strictEqual(phJson.success, false);
    assert.strictEqual(phJson.error, 'This platform is currently not supported.');

  });

  await t.test('2. SSRF protection strictly blocks all private/internal and metadata IP ranges', async () => {
    // Loopback
    assert.strictEqual(isBlockedIpv4('127.0.0.1'), true);
    assert.strictEqual(isBlockedIpv4('127.255.255.255'), true);

    // Private RFC1918
    assert.strictEqual(isBlockedIpv4('10.0.0.1'), true);
    assert.strictEqual(isBlockedIpv4('172.16.0.1'), true);
    assert.strictEqual(isBlockedIpv4('192.168.1.1'), true);

    // Cloud metadata (AWS / GCP / Azure)
    assert.strictEqual(isBlockedIpv4('169.254.169.254'), true);

    // Reserved & Broadcast
    assert.strictEqual(isBlockedIpv4('0.0.0.0'), true);
    assert.strictEqual(isBlockedIpv4('240.0.0.1'), true);
    assert.strictEqual(isBlockedIpv4('255.255.255.255'), true);

    // IPv6 loopback & link-local
    assert.strictEqual(isBlockedIpv6('::1'), true);
    assert.strictEqual(isBlockedIpv6('::'), true);
    assert.strictEqual(isBlockedIpv6('fe80::1'), true);
    assert.strictEqual(isBlockedIpv6('fc00::1'), true);

    // IPv4-mapped IPv6 address (e.g. ::ffff:169.254.169.254)
    assert.strictEqual(isBlockedIpv6('::ffff:169.254.169.254'), true);
    assert.strictEqual(isBlockedIpv6('::ffff:127.0.0.1'), true);
    assert.strictEqual(isBlockedIpv6('::ffff:10.0.0.1'), true);

    // assertSafeUrl tests
    await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'));
    await assert.rejects(() => assertSafeUrl('http://127.0.0.1:5000/api/health'));
    await assert.rejects(() => assertSafeUrl('http://localhost:5000/'));
    await assert.rejects(() => assertSafeUrl('http://user:pass@example.com/video.mp4'));
    await assert.rejects(() => assertSafeUrl('http://example.com:22/video.mp4')); // Disallowed port
    await assert.rejects(() => assertSafeUrl('file:///etc/passwd'));
    await assert.rejects(() => assertSafeUrl('javascript:alert(1)'));
  });

  await t.test('3. DoS Protection: Bulk download limits payload to <= 50 items', async () => {
    const hugeList = Array.from({ length: 51 }, (_, i) => `token_${i}`);
    const res = await makeRequest(
      server,
      { method: 'POST', path: '/api/download-all', headers: { 'Content-Type': 'application/json' } },
      { downloadIds: hugeList }
    );
    assert.strictEqual(res.statusCode, 400);
    const json = res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.error, 'Cannot download more than 50 items at once.');
  });

  await t.test('4. CORS and Security Headers: X-Powered-By is hidden and security headers are present', async () => {
    const res = await makeRequest(
      server,
      { method: 'GET', path: '/api/health' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-powered-by'], undefined, 'x-powered-by header must be hidden');
    assert.ok(res.headers['x-content-type-options'], 'nosniff header should be present');
  });
});
