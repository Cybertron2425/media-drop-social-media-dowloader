import axios from 'axios';
import net from 'node:net';
import mime from 'mime-types';
import { assertSafeUrl, isBlockedIpv4, isBlockedIpv6 } from './urlSafety.js';

/**
 * Downloads a media stream directly from a public URL using axios.
 * Enforces SSRF validation and applies custom headers (Referer, User-Agent).
 */
export async function downloadStream(url, options = {}) {
  const targetUrl = options.sourceUrl || url;
  const parsed = await assertSafeUrl(targetUrl);
  const customHeaders = options.meta?.headers || {};

  let response;
  try {
    response = await axios.get(targetUrl, {
      responseType: 'stream',
      timeout: 15000,
      maxRedirects: 3,
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
        'Accept': '*/*',
        ...customHeaders,
      },
    });

    const contentType = (response.headers['content-type'] || '').toLowerCase();
    if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml')) {
      response.data?.destroy?.();
      throw new Error('This video cannot be downloaded from this source.');
    }
  } catch (err) {
    console.error(
      `[DownloadStream Error] target=${targetUrl.slice(0, 80)} status=${err.response?.status} contentType=${err.response?.headers?.['content-type']} code=${err.code} err=${err.message}`
    );
    if (
      err.response?.status === 403 ||
      err.response?.status === 404 ||
      err.response?.status === 410 ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND'
    ) {
      throw new Error('This video cannot be downloaded from this source.');
    }
    throw err;
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
