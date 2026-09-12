import { InstagramAdapter } from './instagram.js';
import { FacebookAdapter } from './facebook.js';

/**
 * Platform registry strictly supporting only Instagram and Facebook.
 * No other platform or fallback is registered.
 */
const adapters = [
  new InstagramAdapter(),
  new FacebookAdapter(),
];

export function resolveAdapter(url) {
  return adapters.find((adapter) => adapter.canHandle(url));
}

export function getAdapter(platformId) {
  return adapters.find((adapter) => adapter.constructor.platformId === platformId);
}

export function listPlatforms() {
  return adapters.map((a) => ({
    id: a.constructor.platformId,
    status: a.constructor.status,
  }));
}
