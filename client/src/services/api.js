const BASE = (import.meta.env.VITE_API_URL || '') + '/api';

async function handle(res) {
  const data = await res.json().catch(() => ({ success: false, error: 'Something went wrong. Please try again.' }));
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data;
}

export async function analyzeUrl(url) {
  const res = await fetch(`${BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return handle(res);
}

/**
 * Two-phase download flow:
 *
 * Phase 1 — Prepare (POST /download/:downloadId/prepare):
 *   Server performs all heavy work (fetch, FFmpeg mux for adaptive YouTube, etc.) and
 *   writes the result to a temp file.  This may take several minutes for large 4K content.
 *   The UI shows an honest "Processing…" spinner during this time.
 *
 * Phase 2 — Stream (GET /stream/:streamId):
 *   Immediately returns response headers and streams the already-prepared file.
 *   The browser's native download manager takes over from here, showing real progress.
 *   No file content is ever buffered into JavaScript memory on the frontend.
 *
 * Why two phases?
 *   For adaptive YouTube videos (normal videos with separate video+audio streams),
 *   the server must download video chunks, download audio chunks, and mux them with
 *   FFmpeg before a single byte can be served.  Doing all of this inline inside a
 *   single GET request causes HTTP 504 timeouts for anything over ~2 minutes.
 *   Shorts and other small/pre-muxed formats complete fast enough that the old
 *   single-phase approach happened to work.  The two-phase approach works for all
 *   content types and all sizes without any timeout risk.
 */
export async function downloadFormat(downloadId, onStage) {
  onStage?.('starting');

  // Phase 1: Server-side prepare (download + mux).
  // This may take several minutes for large adaptive YouTube videos — that is expected.
  const prepareRes = await fetch(`${BASE}/download/${downloadId}/prepare`, {
    method: 'POST',
  });

  const prepareData = await prepareRes.json().catch(() => ({}));

  if (!prepareRes.ok || !prepareData.success) {
    throw new Error(prepareData.error || 'Failed to prepare the download. Please try again.');
  }

  const { streamId } = prepareData;
  if (!streamId) {
    throw new Error('Server did not return a valid stream token. Please try again.');
  }

  // Phase 2: Trigger native browser download using the ready-made stream.
  // The server responds immediately with headers since the file is already prepared.
  onStage?.('started');

  const streamUrl = `${BASE}/stream/${streamId}`;
  const a = document.createElement('a');
  a.href = streamUrl;
  a.setAttribute('download', '');
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Brief confirmation display before resetting UI state
  await new Promise((resolve) => setTimeout(resolve, 2500));
  onStage?.('complete');
}

/**
 * Bulk download flow – sends one request to bundle all requested items into a ZIP
 */
export async function downloadBulk(downloadIds, title) {
  const res = await fetch(`${BASE}/download-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadIds, title }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to download files. Please try again.');
  }

  let filename = 'mediadrop-download.zip';
  const disposition = res.headers.get('Content-Disposition');
  if (disposition) {
    const match = disposition.match(/filename="?([^";]+)"?/);
    if (match && match[1]) {
      filename = match[1];
    }
  }

  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.setAttribute('download', filename);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(blobUrl);
}

