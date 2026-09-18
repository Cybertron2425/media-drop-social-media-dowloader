import axios from 'axios';
import net from 'node:net';
import mime from 'mime-types';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { assertSafeUrl, isBlockedIpv4, isBlockedIpv6 } from './urlSafety.js';

/**
 * Returns the list of configured proxies. Supports PROXY_LIST (comma-separated host:port),
 * with backward-compatible fallback to PROXY_HOST / PROXY_PORT.
 */
export function getProxyList() {
  const username = process.env.PROXY_USERNAME?.trim();
  const password = process.env.PROXY_PASSWORD?.trim();
  const auth = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';

  const proxies = [];

  if (process.env.PROXY_LIST) {
    const entries = process.env.PROXY_LIST.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const clean = entry.replace(/^https?:\/\//, '');
      proxies.push({
        display: clean,
        url: `http://${auth}${clean}`,
      });
    }
  } else if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    const host = process.env.PROXY_HOST.trim().replace(/^https?:\/\//, '');
    const port = process.env.PROXY_PORT.trim();
    proxies.push({
      display: `${host}:${port}`,
      url: `http://${auth}${host}:${port}`,
    });
  }

  return proxies;
}

/**
 * Downloads a media stream directly from a public URL using axios.
 * Enforces SSRF validation, applies custom headers, and rotates through
 * available proxies if configured.
 */
export async function downloadStream(url, options = {}) {
  const targetUrl = options.sourceUrl || url;
  const parsed = await assertSafeUrl(targetUrl);
  const customHeaders = options.meta?.headers || {};

  const proxies = getProxyList();
  // Randomized order to distribute load across pool
  const attempts = proxies.length > 0
    ? [...proxies].sort(() => Math.random() - 0.5)
    : [null]; // direct connection if no proxy configured

  let response;
  let lastError;

  for (let i = 0; i < attempts.length; i++) {
    const proxy = attempts[i];
    const proxyAgent = proxy ? new HttpsProxyAgent(proxy.url) : null;
    // Short 20s timeout per proxy attempt so dead proxies fail fast; 120s for direct
    const timeout = proxy ? 20000 : 120000;

    try {
      response = await axios.get(targetUrl, {
        responseType: 'stream',
        timeout,
        maxRedirects: 3,
        proxy: false,
        httpsAgent: proxyAgent,
        httpAgent: proxyAgent,
        beforeRedirect: (redirectOptions) => {
          const redirectUrl =
            redirectOptions.href ||
            `${redirectOptions.protocol}//${redirectOptions.hostname}${redirectOptions.path || ''}`;
          try {
            const u = new URL(redirectUrl);
            if (!['http:', 'https:'].includes(u.protocol)) {
              throw new Error('Invalid redirect protocol.');
            }
            if (u.username || u.password) {
              throw new Error('Invalid redirect credentials.');
            }
            const host = u.hostname.toLowerCase();
            if (
              host === 'localhost' ||
              host.endsWith('.localhost') ||
              host.endsWith('.local') ||
              host.endsWith('.internal')
            ) {
              throw new Error('Blocked redirect target.');
            }
            if (net.isIP(host)) {
              if (net.isIP(host) === 4 && isBlockedIpv4(host)) throw new Error('Blocked IPv4 redirect.');
              if (net.isIP(host) === 6 && isBlockedIpv6(host)) throw new Error('Blocked IPv6 redirect.');
            }
          } catch (e) {
            throw new Error('This URL cannot be processed.');
          }
        },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: '*/*',
          ...customHeaders,
        },
      });

      const contentType = (response.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml')) {
        response.data?.destroy?.();
        throw new Error('This video cannot be downloaded from this source.');
      }

      if (proxy) {
        console.log(`[Proxy] Successfully connected via ${proxy.display} for ${targetUrl.slice(0, 60)}`);
      }
      break;
    } catch (err) {
      if (err.message === 'This URL cannot be processed.') {
        throw err;
      }
      lastError = err;
      if (proxy) {
        console.warn(
          `[Proxy] Attempt ${i + 1}/${attempts.length} failed via ${proxy.display}: ${err.message} (status: ${err.response?.status || err.code})`
        );
        if (i < attempts.length - 1) {
          continue;
        }
      }
      break;
    }
  }

  if (!response) {
    const err = lastError;
    console.error(
      `[DownloadStream Error] target=${targetUrl.slice(0, 80)} status=${err?.response?.status} contentType=${err?.response?.headers?.['content-type']} code=${err?.code} err=${err?.message}`
    );
    if (
      err?.response?.status === 403 ||
      err?.response?.status === 404 ||
      err?.response?.status === 410 ||
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ENOTFOUND'
    ) {
      throw new Error('This video cannot be downloaded from this source.');
    }
    throw err || new Error('This video cannot be downloaded from this source.');
  }

  const ext = parsed.pathname.split('.').pop()?.toLowerCase() || 'bin';
  const filename = decodeURIComponent(parsed.pathname.split('/').pop() || `download.${ext}`);
  const contentRange = response.headers['content-range'];
  let sizeBytes = response.headers['content-length']
    ? parseInt(response.headers['content-length'], 10)
    : null;
  if (contentRange && typeof contentRange === 'string') {
    const totalMatch = contentRange.match(/\/(\d+)$/);
    if (totalMatch) {
      sizeBytes = parseInt(totalMatch[1], 10);
    }
  }

  return {
    stream: response.data,
    filename,
    mimeType: response.headers['content-type'] || mime.lookup(ext) || 'application/octet-stream',
    sizeBytes,
  };
}
