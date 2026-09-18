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
  console.log('[MediaDrop Download] downloadFormat started for downloadId:', downloadId);
  console.log('[MediaDrop Download] API BASE URL:', BASE);

  // Track 1: Direct client download for formats that don't need merging (e.g. YouTube 720p/360p or progressive MP4).
  // Bypasses backend entirely to avoid datacenter IP blocks from CDN hosts.
  let directData = null;
  const directUrlEndpoint = `${BASE}/download/${downloadId}/direct-url`;
  console.log('[MediaDrop Download] direct-url request:', directUrlEndpoint);

  try {
    const directRes = await fetch(directUrlEndpoint);
    directData = await directRes.json().catch(() => ({}));
    console.log('[MediaDrop Download] direct-url response:', directData);
    console.log('[MediaDrop Download] requiresPrepare:', directData?.requiresPrepare);

    if (directData?.success && directData?.url) {
      console.log('[MediaDrop Download] browser direct download:', directData.url);
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
  } catch (err) {
    console.warn('[MediaDrop Download] direct-url check failed, falling back to server-side flow:', err);
  }

  // Short server-side validate check (confirms token, checks size limit upfront)
  const validateEndpoint = `${BASE}/download/${downloadId}/validate`;
  console.log('[MediaDrop Download] validate request:', validateEndpoint);
  const validateRes = await fetch(validateEndpoint);
  const validateData = await validateRes.json().catch(() => ({}));
  console.log('[MediaDrop Download] validate response:', validateData);
  console.log('[MediaDrop Download] requiresPrepare:', validateData?.requiresPrepare);

  if (!validateRes.ok || !validateData?.success) {
    const errMsg = validateData?.error || 'Failed to prepare the download. Please try again.';
    console.error('[MediaDrop Download] validate failed:', errMsg);
    throw new Error(errMsg);
  }

  if (validateData.requiresPrepare) {
    // Server-side prepare step if required by the adapter.
    onStage?.('processing');
    const prepareEndpoint = `${BASE}/download/${downloadId}/prepare`;
    console.log('[MediaDrop Download] prepare request:', prepareEndpoint);
    const prepareRes = await fetch(prepareEndpoint, {
      method: 'POST',
    });
    const prepareData = await prepareRes.json().catch(() => ({}));
    console.log('[MediaDrop Download] prepare response:', prepareData);

    if (!prepareRes.ok || !prepareData?.success) {
      const errMsg = prepareData?.error || 'Failed to prepare the download. Please try again.';
      console.error('[MediaDrop Download] prepare failed:', errMsg);
      throw new Error(errMsg);
    }
    const { streamId } = prepareData;
    if (!streamId) {
      console.error('[MediaDrop Download] Missing streamId in prepare response');
      throw new Error('Server did not return a valid stream token. Please try again.');
    }

    // Handoff: native browser download starts here. Frontend does NOT wait for the
    // file transfer to complete — the Download Manager handles it independently.
    const streamUrl = `${BASE}/stream/${streamId}`;
    console.log('[MediaDrop Download] stream:', streamUrl);
    console.log('[MediaDrop Download] browser download:', streamUrl);
    const a = document.createElement('a');
    a.href = streamUrl;
    a.setAttribute('download', prepareData.filename || '');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  } else {
    // Direct native browser streaming — no prepare step needed.
    // Server streams directly from upstream CDN to the browser's Download Manager.
    const downloadUrl = `${BASE}/download/${downloadId}`;
    console.log('[MediaDrop Download] stream (direct server):', downloadUrl);
    console.log('[MediaDrop Download] browser download:', downloadUrl);
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

