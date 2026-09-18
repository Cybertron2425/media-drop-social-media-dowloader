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

  const selectedFormat = formats.find((f) => f.downloadId === selectedDownloadId) || formats[0];
  const isMergeFormat = Boolean(selectedFormat?.needsMerge);

  const handleDownloadClick = () => {
    const effectiveDownloadId = selectedDownloadId || formats?.[0]?.downloadId;
    console.log('[MediaDrop Download] button clicked');
    console.log('[MediaDrop Download] downloadId:', effectiveDownloadId);
    console.log('[MediaDrop Download] quality:', selectedFormat?.quality);

    if (isBusy) {
      console.warn('[MediaDrop Download] Click ignored: download is already in progress', { downloadingId, isBusy });
      return;
    }
    if (!effectiveDownloadId) {
      console.error('[MediaDrop Download] Click error: no downloadId available for selected format');
      return;
    }
    onDownload(effectiveDownloadId);
  };

  return (
    <div className="mt-4 pt-2 border-t border-slate-100 dark:border-slate-800">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
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
                    {f.quality || 'Video'} {f.resolution ? `(${f.resolution})` : ''} · {f.format?.toUpperCase()}{f.needsMerge ? ' · May take longer' : ''}
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
            <div className="flex items-center flex-wrap gap-1.5 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300">
              <span>
                {isImage
                  ? (isHighlight ? 'Original · High Quality (JPG)' : `Original · High Quality (${formats[0]?.format?.toUpperCase() || 'JPG'})`)
                  : (isHighlight ? 'Available quality' : `${formats[0]?.quality || 'Original'} · ${formats[0]?.format?.toUpperCase() || 'MP4'}${formats[0]?.size ? ` (${formats[0]?.size})` : ''}`)}
              </span>
              {isMergeFormat && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/60">
                  <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                  May take longer
                </span>
              )}
            </div>
          )}
        </div>

        {/* Download Button */}
        <button
          id={`main-download-btn-${selectedDownloadId}`}
          onClick={handleDownloadClick}
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

      {/* Slower Merge Warning / Info Note */}
      {isMergeFormat && !isImage && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium">
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
          <span>Server-side merge required for this quality · May take longer</span>
        </div>
      )}
    </div>
  );
}
