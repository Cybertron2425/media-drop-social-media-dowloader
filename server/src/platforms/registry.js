import { InstagramAdapter } from './instagram.js';
import { FacebookAdapter } from './facebook.js';
import { SnapchatAdapter } from './snapchat.js';
import { TikTokAdapter } from './tiktok.js';
import { TwitterAdapter } from './twitter.js';
import { YouTubeAdapter } from './youtube.js';
import { PublicMediaAdapter } from './publicMedia.js';

/**
 * Platform registry:
 * - Dedicated adapters: Instagram, Facebook, Snapchat, TikTok, Twitter/X, and YouTube
 * - Generic adapter: PublicMediaAdapter for legitimate third-party public media
 */
const adapters = [
  new InstagramAdapter(),
  new FacebookAdapter(),
  new SnapchatAdapter(),
  new TikTokAdapter(),
  new TwitterAdapter(),
  new YouTubeAdapter(),
  new PublicMediaAdapter(),
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
