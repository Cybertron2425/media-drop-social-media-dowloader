import { nanoid } from 'nanoid';

const TTL_MS = (parseInt(process.env.TEMP_FILE_TTL_MINUTES, 10) || 15) * 60 * 1000;

// Simple in-memory store, fine for a single-instance deployment. Swap for
// Redis if running multiple server instances behind a load balancer.
const tokens = new Map();

export function createDownloadToken({ platform, sourceUrl, formatId, meta }) {
  const id = nanoid(16);
  tokens.set(id, { platform, sourceUrl, formatId, meta, expiresAt: Date.now() + TTL_MS });
  return id;
}

export function consumeDownloadToken(id) {
  const entry = tokens.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(id);
    return null;
  }
  tokens.delete(id); // single-use: consuming always invalidates the token
  return entry;
}

/**
 * Read-only check used to validate a token (existence + expiry + basic
 * metadata for the UI) WITHOUT invalidating it, so the frontend can confirm
 * a download is valid before triggering the real, native browser download.
 */
export function peekDownloadToken(id) {
  const entry = tokens.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(id);
    return null;
  }
  return entry;
}

// Periodic cleanup of expired tokens.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(id);
  }
}, 60 * 1000).unref();
