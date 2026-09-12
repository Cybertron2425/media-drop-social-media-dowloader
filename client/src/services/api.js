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
 * Two-phase download flow with honest indeterminate status progression:
 *
 * Phase 1 – Prepare (server-side): POST /download/:downloadId/prepare
 *   The server fetches public media streams, validates size and safety,
 *   and writes to a temporary stream file.
 *
 * Phase 2 – Stream (browser): GET /stream/:streamId
 *   Triggers a native browser download directly from the prepared file.
 */
export async function downloadFormat(downloadId, onStage) {
  onStage?.('preparing');

  // Progressive indeterminate status updates while awaiting server processing
  const t1 = setTimeout(() => onStage?.('downloading'), 1000);
  const t2 = setTimeout(() => onStage?.('processing'), 3000);

  try {
    const prepareRes = await fetch(`${BASE}/download/${downloadId}/prepare`, {
      method: 'POST',
    });

    clearTimeout(t1);
    clearTimeout(t2);

    const data = await prepareRes.json().catch(() => ({}));
    if (!prepareRes.ok || !data.success) {
      throw new Error(data.error || 'Something went wrong. Please try again.');
    }

    const { streamId } = data;

    // Fetch stream as blob so any HTTP/rate-limit error is caught in React instead of raw browser navigation
    onStage?.('ready');
    const streamRes = await fetch(`${BASE}/stream/${streamId}`);
    if (!streamRes.ok) {
      const errData = await streamRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Download failed. Please try again.');
    }

    const blob = await streamRes.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.setAttribute('download', data.filename || 'download');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);

    onStage?.('complete');
  } catch (err) {
    clearTimeout(t1);
    clearTimeout(t2);
    throw err;
  }
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

