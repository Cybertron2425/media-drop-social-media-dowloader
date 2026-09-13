import FormatSelector from './FormatSelector.jsx';

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return null;
  const s = parseInt(seconds, 10);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getPlatformTypeLabel(platform, type, isHighlight) {
  let pName = 'Instagram';
  if (platform === 'facebook') pName = 'Facebook';
  else if (platform === 'snapchat') pName = 'Snapchat';
  else if (platform === 'tiktok') pName = 'TikTok';
  else if (platform === 'twitter' || platform === 'x') pName = 'X';
  else if (platform === 'youtube') pName = 'YouTube';
  else if (platform === 'pornhub') pName = 'Pornhub';
  else if (platform === 'public-media' || platform === 'public') pName = 'Public Media';
  else if (platform) pName = platform.charAt(0).toUpperCase() + platform.slice(1);

  let tName = 'Video';
  if (type === 'reel') tName = 'Reel';
  else if (type === 'spotlight') tName = 'Spotlight';
  else if (type === 'short' || type === 'shorts') tName = 'Short';
  else if (type === 'image' || type === 'photo') tName = 'Photo';
  else if (type === 'story') tName = 'Story';
  else if (type === 'video') tName = 'Video';

  if (isHighlight) {
    if (platform === 'twitter' || platform === 'x') {
      return `${pName} · Post · ${tName}`;
    }
    return `${pName} · Highlight · ${tName}`;
  }
  return `${pName} · ${tName}`;
}

export default function MediaPreview({
  media,
  onDownload,
  onDownloadBulk,
  downloadingId,
  downloadStage,
  isBulkDownloading,
}) {
  const durationFormatted = formatDuration(media.duration);

  // If multiple items are available (e.g. Highlight with multiple stories)
  if (media.items && Array.isArray(media.items) && media.items.length > 1) {
    function handleDownloadAll() {
      if (isBulkDownloading || downloadingId) return;
      const downloadIds = media.items
        .map((item) => item.formats?.[0]?.downloadId)
        .filter(Boolean);

      if (!downloadIds.length) return;
      if (onDownloadBulk) {
        onDownloadBulk(downloadIds, media.title);
      }
    }

    return (
      <div className="mx-auto max-w-2xl">
        {/* Result Header */}
        <div className="mb-3.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              Result
            </h2>
            <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              {media.items.length} media found
            </span>
          </div>

          <button
            type="button"
            onClick={handleDownloadAll}
            disabled={isBulkDownloading || !!downloadingId}
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 disabled:cursor-not-allowed dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300 transition-colors"
          >
            {isBulkDownloading ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Preparing download...</span>
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download All</span>
              </>
            )}
          </button>
        </div>

        {/* List of items */}
        <div className="space-y-4">
          {media.items.map((item, idx) => {
            const itemTypeLabel = getPlatformTypeLabel(media.platform, item.type, true);

            return (
              <div
                key={item.id || idx}
                className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 sm:p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex flex-col sm:flex-row gap-4 sm:gap-5">
                  {/* Media Thumbnail */}
                  {item.thumbnail && (
                    <div className="relative shrink-0 w-full sm:w-40 md:w-44 aspect-[4/5] sm:aspect-square overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-800">
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  )}

                  {/* Metadata & Action */}
                  <div className="flex flex-1 flex-col justify-between min-w-0">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        {itemTypeLabel}
                      </p>
                      <h3 className="line-clamp-2 text-sm sm:text-base font-semibold text-slate-900 dark:text-white leading-snug mt-1">
                        {item.title}
                      </h3>
                      {media.author && (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                          @{media.author}
                        </p>
                      )}
                    </div>

                    <FormatSelector
                      formats={item.formats}
                      mediaType={item.type}
                      isHighlight={true}
                      onDownload={onDownload}
                      downloadingId={downloadingId}
                      downloadStage={downloadStage}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Single media item (standard post, reel, video, photo, or single-story highlight)
  const isHighlight = media.isHighlight || media.type === 'highlight';
  const platformTypeLabel = getPlatformTypeLabel(media.platform, media.type, isHighlight);

  return (
    <div className="mx-auto max-w-2xl">
      {/* Result Header */}
      <div className="mb-3.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
            Result
          </h2>
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            1 media found
          </span>
        </div>
      </div>

      {/* Main Result Card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 sm:p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-5">
          {/* LEFT: Media Thumbnail */}
          {media.thumbnail && (
            <div className="relative shrink-0 w-full sm:w-44 md:w-48 aspect-[4/5] sm:aspect-square overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-800">
              <img
                src={media.thumbnail}
                alt={media.title}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              {durationFormatted && (
                <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white backdrop-blur-sm">
                  {durationFormatted}
                </span>
              )}
            </div>
          )}

          {/* RIGHT: Metadata & Action */}
          <div className="flex flex-1 flex-col justify-between min-w-0">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                {platformTypeLabel}
              </p>
              <h3 className="line-clamp-2 text-sm sm:text-base font-semibold text-slate-900 dark:text-white leading-snug mt-1">
                {media.title}
              </h3>
              {media.author && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                  @{media.author}
                </p>
              )}
            </div>

            <FormatSelector
              formats={media.formats}
              mediaType={media.type}
              isHighlight={isHighlight}
              onDownload={onDownload}
              downloadingId={downloadingId}
              downloadStage={downloadStage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
