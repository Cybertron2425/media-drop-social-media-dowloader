import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
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
  const isDirect = options.direct === true || options.proxy === false || options.platform === 'pornhub';
  // Randomized order to distribute load across pool, or use specified proxy if provided
  const attempts = isDirect
    ? [null]
    : options.proxy
    ? [options.proxy]
    : proxies.length > 0
    ? [...proxies].sort(() => Math.random() - 0.5)
    : [null]; // direct connection if no proxy configured

  let response;
  let lastError;
  let spooledTempPath = null;
  const loopStartTime = Date.now();
  const PROXY_ATTEMPT_TIMEOUT_MS = 8000;
  const DIRECT_TIMEOUT_MS = 120000;
  const PROXY_TOTAL_BUDGET_MS = 90000;
  const PROXY_TIMEOUT_ERROR_MESSAGE =
    'This video is taking too long to download via our free servers right now. Please try a lower quality, or try again in a few minutes.';

  for (let i = 0; i < attempts.length; i++) {
    const proxy = attempts[i];

    // Check overall time budget across proxy attempts before initiating next attempt
    if (proxy) {
      const elapsedMs = Date.now() - loopStartTime;
      if (elapsedMs >= PROXY_TOTAL_BUDGET_MS) {
        console.warn(
          `[Proxy] Total wall-clock budget of ${PROXY_TOTAL_BUDGET_MS / 1000}s exceeded before attempt ${i + 1}/${attempts.length}`
        );
        throw new Error(PROXY_TIMEOUT_ERROR_MESSAGE);
      }
    }

    const proxyAgent = proxy ? new HttpsProxyAgent(proxy.url) : null;
    // Short 8s timeout per proxy attempt so dead/slow proxies fail fast; remaining budget if < 8s; 120s for direct
    let timeout = DIRECT_TIMEOUT_MS;
    if (proxy) {
      const remainingBudgetMs = Math.max(1000, PROXY_TOTAL_BUDGET_MS - (Date.now() - loopStartTime));
      timeout = Math.min(PROXY_ATTEMPT_TIMEOUT_MS, remainingBudgetMs);
    }

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

        // Monitor stream transfer for stalls. If no new chunk arrives within
        // PROXY_STALL_TIMEOUT_MS (default 10s), abort and fail over to the next proxy.
        const stallTimeoutMs = parseInt(process.env.PROXY_STALL_TIMEOUT_MS, 10) || 10000;
        const tempFilePath = path.join(os.tmpdir(), `md_proxy_${nanoid(16)}.tmp`);
        const fileWriteStream = fs.createWriteStream(tempFilePath);

        try {
          await new Promise((resolveStream, rejectStream) => {
            let stallTimer = null;
            let streamFinished = false;

            const cleanup = () => {
              if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
              }
              try {
                response.data?.unpipe?.(fileWriteStream);
                response.data?.destroy?.();
                fileWriteStream.destroy?.();
              } catch {}
            };

            const resetStallTimer = () => {
              if (stallTimer) clearTimeout(stallTimer);
              if (streamFinished) return;

              const elapsedMs = Date.now() - loopStartTime;
              if (elapsedMs >= PROXY_TOTAL_BUDGET_MS) {
                cleanup();
                rejectStream(new Error(PROXY_TIMEOUT_ERROR_MESSAGE));
                return;
              }

              const remainingBudget = PROXY_TOTAL_BUDGET_MS - elapsedMs;
              const effectiveTimeout = Math.min(stallTimeoutMs, remainingBudget);

              stallTimer = setTimeout(() => {
                if (streamFinished) return;
                cleanup();
                const stallSec = Math.round(stallTimeoutMs / 1000);
                console.warn(
                  `[Proxy] Stalled (no data for ${stallSec}s) via ${proxy.display}, switching to next proxy`
                );
                const stallErr = new Error(`Proxy stalled (no data for ${stallSec}s)`);
                stallErr.isStall = true;
                rejectStream(stallErr);
              }, effectiveTimeout);
            };

            // 1. Start stall monitoring immediately on response stream
            resetStallTimer();

            // 2. Reset stall timer on every incoming data chunk
            response.data.on('data', () => {
              resetStallTimer();
            });

            response.data.on('error', (err) => {
              cleanup();
              rejectStream(err);
            });

            fileWriteStream.on('error', (err) => {
              cleanup();
              rejectStream(err);
            });

            fileWriteStream.on('finish', () => {
              streamFinished = true;
              if (stallTimer) clearTimeout(stallTimer);
              resolveStream();
            });

            response.data.pipe(fileWriteStream);
          });

          spooledTempPath = tempFilePath;
        } catch (streamErr) {
          fs.promises.unlink(tempFilePath).catch(() => {});
          throw streamErr;
        }
      }

      break;
    } catch (err) {
      if (err.message === 'This URL cannot be processed.' || err.message === PROXY_TIMEOUT_ERROR_MESSAGE) {
        throw err;
      }
      if (err.message?.includes('exceeds the maximum allowed download size')) {
        throw err;
      }
      if (err.response?.status === 470 || err.message?.includes('HTTP 470')) {
        throw err;
      }
      // HTTP 410 (Gone / Expired) and HTTP 404 (Not Found) indicate the upstream resource itself
      // is unavailable or has an expired token. Retrying 10 other proxies will not make an expired
      // or missing resource valid; fail fast.
      if (err.response?.status === 410 || err.response?.status === 404) {
        throw err;
      }
      lastError = err;
      if (proxy) {
        if (!err.isStall) {
          console.warn(
            `[Proxy] Attempt ${i + 1}/${attempts.length} failed via ${proxy.display}: ${err.message} (status: ${err.response?.status || err.code})`
          );
        }
        // If overall time budget has expired after this attempt (or stall), fail immediately
        if (Date.now() - loopStartTime >= PROXY_TOTAL_BUDGET_MS) {
          console.warn(
            `[Proxy] Total wall-clock budget of ${PROXY_TOTAL_BUDGET_MS / 1000}s exceeded after attempt ${i + 1}`
          );
          throw new Error(PROXY_TIMEOUT_ERROR_MESSAGE);
        }
        if (i < attempts.length - 1) {
          continue;
        }
      }
      break;
    }
  }

  const proxyAttempted = !isDirect && attempts[0] !== null && proxies.length > 0;
  if (!response || (proxyAttempted && !spooledTempPath)) {
    if (proxyAttempted && Date.now() - loopStartTime >= PROXY_TOTAL_BUDGET_MS) {
      throw new Error(PROXY_TIMEOUT_ERROR_MESSAGE);
    }
    const err = lastError;
    console.error(
      `[DownloadStream Error] target=${targetUrl.slice(0, 80)} status=${err?.response?.status} contentType=${err?.response?.headers?.['content-type']} code=${err?.code} err=${err?.message || err || 'No response received'}`
    );

    // Preserve specific error types without converting them into generic source error
    if (err?.message?.includes('exceeds the maximum allowed download size')) {
      throw err;
    }
    if (err?.response?.status === 470 || err?.message?.includes('HTTP 470')) {
      throw err;
    }
    if (
      err?.code === 'ETIMEDOUT' ||
      err?.code === 'ECONNABORTED' ||
      err?.message?.includes('timed out') ||
      err?.message?.includes('timeout')
    ) {
      throw err;
    }

    if (
      isDirect ||
      options.platform === 'pornhub' ||
      err?.response?.status === 470
    ) {
      throw err;
    }

    if (
      err?.response?.status === 403 ||
      err?.response?.status === 404 ||
      err?.response?.status === 410 ||
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ENOTFOUND'
    ) {
      throw new Error('This video cannot be downloaded from this source.');
    }
    if (err && err.message) {
      throw err;
    }
    throw err || new Error('This video cannot be downloaded from this source.');
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const rawLastSegment = pathSegments.pop() || '';
  const hasExt = rawLastSegment.includes('.');
  const ext = hasExt ? rawLastSegment.split('.').pop()?.toLowerCase() || 'bin' : 'bin';
  const filename = decodeURIComponent(rawLastSegment || `download.${ext}`);
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

  if (spooledTempPath) {
    const fileReadStream = fs.createReadStream(spooledTempPath);
    fileReadStream.on('close', () => {
      fs.promises.unlink(spooledTempPath).catch(() => {});
    });
    return {
      stream: fileReadStream,
      filename,
      mimeType: response.headers['content-type'] || mime.lookup(ext) || 'application/octet-stream',
      sizeBytes,
      statusCode: response.status,
      contentRange: response.headers['content-range'],
    };
  }

  return {
    stream: response.data,
    filename,
    mimeType: response.headers['content-type'] || mime.lookup(ext) || 'application/octet-stream',
    sizeBytes,
    statusCode: response.status,
    contentRange: response.headers['content-range'],
  };
}

/**
 * Executes an HTTP request (GET or POST) through the configured proxy pool (or directly
 * if no proxies are configured), with automatic failover across proxies.
 * Returns { data, status, headers, proxy } on success.
 */
export async function fetchWithProxy(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const timeout = options.timeout || 10000;
  const headers = options.headers || {};
  const data = options.data || undefined;
  const validateStatus = options.validateStatus || ((s) => s >= 200 && s < 300);

  const proxies = getProxyList();
  const isDirect = options.direct === true || options.proxy === false;
  const attempts = isDirect
    ? [null]
    : options.proxy
    ? [options.proxy]
    : proxies.length > 0
    ? [...proxies].sort(() => Math.random() - 0.5)
    : [null];

  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    const proxy = attempts[i];
    const proxyAgent = proxy ? new HttpsProxyAgent(proxy.url) : null;
    const redirects = [];
    let currentUrl = url;
    try {
      const config = {
        headers,
        timeout,
        proxy: false,
        httpsAgent: proxyAgent,
        httpAgent: proxyAgent,
        validateStatus,
        maxRedirects: 5,
        beforeRedirect: (redirectOptions, responseDetails) => {
          const redirectUrl =
            redirectOptions.href ||
            `${redirectOptions.protocol}//${redirectOptions.hostname}${redirectOptions.path || ''}`;
          redirects.push({
            status: responseDetails?.statusCode || 302,
            from: currentUrl,
            to: redirectUrl,
          });
          currentUrl = redirectUrl;
        },
        ...(options.responseType ? { responseType: options.responseType } : {}),
      };
      const res = method === 'GET'
        ? await axios.get(url, config)
        : await axios({ url, method, headers, data, ...config });

      const finalUrl =
        res.request?.res?.responseUrl ||
        res.request?.responseURL ||
        res.config?.url ||
        url;

      return {
        data: res.data,
        status: res.status,
        headers: res.headers,
        proxy,
        finalUrl,
        redirects,
      };
    } catch (err) {
      lastError = err;
      if (err.response?.status === 410 || err.response?.status === 404 || err.response?.status === 470) {
        throw err;
      }
      if (err.message?.includes('exceeds the maximum allowed download size')) {
        throw err;
      }
      if (i < attempts.length - 1) {
        continue;
      }
    }
  }
  throw lastError;
}
