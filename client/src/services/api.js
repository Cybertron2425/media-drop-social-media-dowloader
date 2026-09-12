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

    // Trigger native browser download of prepared file
    onStage?.('ready');
    const a = document.createElement('a');
    a.href = `${BASE}/stream/${streamId}`;
    a.setAttribute('download', data.filename || 'download');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    onStage?.('complete');
  } catch (err) {
    clearTimeout(t1);
    clearTimeout(t2);
    throw err;
  }
}
