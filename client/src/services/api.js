const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const BASE = (rawApiUrl ? rawApiUrl : '') + '/api';

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
 *   Server performs all heavy work (fetch, stream packaging, etc.) and
 *   writes the result to a temp file.
 *   The UI shows an honest "Processing…" spinner during this time.
 *
 * Phase 2 — Native browser handoff (GET /stream/:streamId or GET /download/:downloadId):
 *   An invisible <a download> is clicked immediately once the server confirms readiness.
 *   The browser's native Download Manager takes over the actual file transfer.
 *   The frontend resolves and resets to idle — it does NOT wait for the file to finish.
 *   No blob(), arrayBuffer(), createObjectURL(), or stream buffering is performed.
 */
export async function downloadFormat(downloadId, onStage) {
  onStage?.('starting');

  // Track 1: Direct client download for formats that don't need merging (e.g. YouTube 720p/360p).
  // Bypasses backend entirely to avoid datacenter IP blocks from YouTube.
  try {
    const directRes = await fetch(`${BASE}/download/${downloadId}/direct-url`);
    if (directRes.ok) {
      const directData = await directRes.json().catch(() => ({}));
      if (directData.success && directData.url) {
        const a = document.createElement('a');
        a.href = directData.url;
        a.setAttribute('download', directData.filename || '');
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        onStage?.('complete');
        return;
      }
    }
  } catch {
    // If direct-url check fails or throws, gracefully proceed to server-side flow
  }

  // Short server-side validate check (confirms token, checks size limit upfront)
  const validateRes = await fetch(`${BASE}/download/${downloadId}/validate`);
  const validateData = await validateRes.json().catch(() => ({}));

  if (!validateRes.ok || !validateData.success) {
    throw new Error(validateData.error || 'Failed to prepare the download. Please try again.');
  }

  if (validateData.requiresPrepare) {
    // Server-side prepare step if required by the adapter.
    onStage?.('processing');
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

    // Handoff: native browser download starts here. Frontend does NOT wait for the
    // file transfer to complete — the Download Manager handles it independently.
    const streamUrl = `${BASE}/stream/${streamId}`;
    const a = document.createElement('a');
    a.href = streamUrl;
    a.setAttribute('download', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  } else {
    // Direct native browser streaming — no prepare step needed.
    // Server streams directly from upstream CDN to the browser's Download Manager.
    const downloadUrl = `${BASE}/download/${downloadId}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }

  // Signal complete immediately — the native download is already running in the background.
  // This resets the UI (spinner → Download button) without waiting for file transfer.
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

