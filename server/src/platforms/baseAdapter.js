/**
 * Every platform adapter must implement this shape:
 *
 *   canHandle(url: string): boolean
 *   analyze(url: string): Promise<MediaInfo>
 *   getMediaInfo(url: string): Promise<MediaInfo>   // alias used by controller
 *   download(url: string, options: { formatId: string }): Promise<DownloadStream>
 *
 * MediaInfo shape:
 *   {
 *     platform: string,
 *     title: string,
 *     thumbnail: string | null,
 *     type: 'video' | 'audio' | 'image',
 *     formats: [{ id, quality, format, sizeBytes | null, url }]
 *   }
 *
 * DownloadStream shape:
 *   { stream: Readable, filename: string, mimeType: string, sizeBytes: number | null }
 *
 * Adapters that cannot reliably resolve media (because doing so would require
 * reverse-engineering a private, frequently-changing platform API) must set
 * `status = 'SUPPORTED_WITH_LIMITATIONS'` on the class and throw a
 * PlatformLimitationError from analyze()/download() with a clear message,
 * rather than returning fabricated data.
 */

export class PlatformLimitationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformLimitationError';
  }
}

export class BaseAdapter {
  static platformId = 'base';
  static status = 'SUPPORTED'; // or 'SUPPORTED_WITH_LIMITATIONS'

  canHandle(_url) {
    throw new Error('canHandle() not implemented');
  }

  async analyze(_url) {
    throw new Error('analyze() not implemented');
  }

  async getMediaInfo(url) {
    return this.analyze(url);
  }

  async download(_url, _options) {
    throw new Error('download() not implemented');
  }
}
