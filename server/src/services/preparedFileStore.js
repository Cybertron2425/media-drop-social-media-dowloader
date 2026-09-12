import { nanoid } from 'nanoid';
import fs from 'fs';

// Files are kept for 10 minutes – enough time for the browser to initiate the
// GET /stream/:streamId request after the prepare step resolves.
const TTL_MS = 10 * 60 * 1000;
const store = new Map();

/**
 * Registers a prepared (fully-processed) file and returns a single-use stream token.
 * @param {{ filePath: string, filename: string, mimeType: string, sizeBytes: number|null }} entry
 * @returns {string} streamId
 */
export function storePreparedFile({ filePath, filename, mimeType, sizeBytes }) {
  const streamId = nanoid(16);
  const expiresAt = Date.now() + TTL_MS;
  store.set(streamId, { filePath, filename, mimeType, sizeBytes, expiresAt });

  // Auto-cleanup: delete both the map entry and the temp file if not consumed in time.
  setTimeout(() => {
    const entry = store.get(streamId);
    if (entry) {
      store.delete(streamId);
      fs.promises.unlink(entry.filePath).catch(() => {});
    }
  }, TTL_MS);

  return streamId;
}

/**
 * Retrieves and removes a prepared file entry (single-use).
 * Returns null if the token is unknown or expired.
 * @param {string} streamId
 * @returns {{ filePath: string, filename: string, mimeType: string, sizeBytes: number|null } | null}
 */
export function consumePreparedFile(streamId) {
  const entry = store.get(streamId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(streamId);
    fs.promises.unlink(entry.filePath).catch(() => {});
    return null;
  }
  store.delete(streamId);
  return entry;
}
