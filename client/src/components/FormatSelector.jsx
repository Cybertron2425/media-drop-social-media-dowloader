import { useState, useEffect } from 'react';

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin text-white"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

const STAGE_LABELS = {
  starting: 'Processing…',
  processing: 'Processing…',
  started:  '✓ Download started',
  complete: '✓ Download started',
};

export default function FormatSelector({ formats, mediaType, isHighlight, onDownload, downloadingId, downloadStage }) {
  const [selectedDownloadId, setSelectedDownloadId] = useState(formats?.[0]?.downloadId || '');

  useEffect(() => {
    if (formats && formats.length > 0 && !formats.some((f) => f.downloadId === selectedDownloadId)) {
      setSelectedDownloadId(formats[0].downloadId);
    }
  }, [formats]);

  if (!formats || formats.length === 0) return null;

  const isBusy = !!downloadingId;
  const isThisItemDownloading = downloadingId && formats.some((f) => f.downloadId === downloadingId);
  const currentStageLabel = isThisItemDownloading ? (STAGE_LABELS[downloadStage] || 'Processing...') : 'Processing...';
  const isImage = mediaType === 'image';

  return (
    <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
      {/* Format / Quality Info or Dropdown */}
      <div className="w-full sm:w-auto min-w-0">
        {!isImage && formats.length > 1 ? (
          <div className="relative w-full sm:w-auto">
            <label htmlFor="quality-select" className="sr-only">Select Quality</label>
            <select
              id="quality-select"
              value={selectedDownloadId}
              onChange={(e) => setSelectedDownloadId(e.target.value)}
              disabled={isBusy}
              className="w-full sm:w-auto appearance-none rounded-xl border border-slate-200 bg-slate-50/80 dark:border-slate-700 dark:bg-slate-800 py-2 pl-3 pr-8 text-xs sm:text-sm font-medium text-slate-800 dark:text-slate-100 transition-colors focus:border-emerald-500 focus:outline-none cursor-pointer"
            >
              {formats.map((f) => (
                <option key={f.downloadId} value={f.downloadId}>
                  {f.quality || 'Video'} {f.resolution ? `(${f.resolution})` : ''} · {f.format?.toUpperCase()}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-slate-400">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300">
            {isImage
              ? (isHighlight ? 'Original · High Quality (JPG)' : `Original · High Quality (${formats[0]?.format?.toUpperCase() || 'JPG'})`)
              : (isHighlight ? 'Available quality' : `${formats[0]?.quality || 'Original'} · ${formats[0]?.format?.toUpperCase() || 'MP4'}${formats[0]?.size ? ` (${formats[0]?.size})` : ''}`)}
          </div>
        )}
      </div>

      {/* Download Button */}
      <button
        id={`main-download-btn-${selectedDownloadId}`}
        onClick={() => onDownload(selectedDownloadId)}
        disabled={isBusy}
        aria-label="Download media"
        className={`focus-ring inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-all shadow-sm w-full sm:w-auto shrink-0 ${
          isThisItemDownloading
            ? 'bg-emerald-600 text-white cursor-wait opacity-95'
            : isBusy
            ? 'bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-500 cursor-not-allowed'
            : 'bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white cursor-pointer hover:shadow'
        }`}
      >
        {isThisItemDownloading ? (
          <>
            <Spinner />
            <span>{currentStageLabel}</span>
          </>
        ) : (
          <>
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download</span>
          </>
        )}
      </button>
    </div>
  );
}
