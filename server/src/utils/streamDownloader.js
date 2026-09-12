import axios from 'axios';
import mime from 'mime-types';
import { assertSafeUrl } from './urlSafety.js';

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
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        ...customHeaders,
      },
    });
  } catch (err) {
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
  const sizeBytes = response.headers['content-length']
    ? parseInt(response.headers['content-length'], 10)
    : null;

  return {
    stream: response.data,
    filename,
    mimeType: response.headers['content-type'] || mime.lookup(ext) || 'application/octet-stream',
    sizeBytes,
  };
}
